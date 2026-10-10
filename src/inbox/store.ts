import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../platform/atomic-write';
import type { InboxEvent, InboxState, SourceCheckpoint, SourceKind } from './types';

/** Inbox cannot reuse MessageLedger: it must atomically commit source cursors,
 * changed defect versions and independently reviewed artifacts in one snapshot. */
export class InboxStore {
  private state: InboxState = { schema: 1, items: [], sources: {}, health: {} };
  private saving: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string, private readonly write = writeFileAtomic) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as InboxState;
      if (raw.schema !== 1 || !Array.isArray(raw.items) || !raw.sources || !raw.health) {
        throw new Error('收件箱存储格式无效，保留文件并停止启动');
      }
      this.state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  snapshot(): InboxState { return structuredClone(this.state); }

  async update<T>(edit: (draft: InboxState) => T): Promise<T> {
    const task = this.saving.then(async () => {
      const draft = this.snapshot();
      const value = edit(draft);
      await this.write(this.path, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      this.state = draft;
      return value;
    });
    this.saving = task.catch(() => {});
    return task;
  }

  async recover(): Promise<void> {
    await this.update((state) => {
      for (const item of state.items) {
        if (item.status === 'running') {
          item.status = 'interrupted';
          item.error = '上次执行被中断，请检查现有会话与代码后再重试';
          item.revision++;
        }
        for (const artifact of item.artifacts) {
          if (artifact.status === 'sending') {
            artifact.status = 'send_unknown';
            item.revision++;
          }
        }
      }
    });
  }

  async ingest(source: SourceKind, events: InboxEvent[], checkpoint: SourceCheckpoint): Promise<void> {
    await this.update((state) => {
      const previous = state.sources[source];
      for (const event of events) {
        if (previous?.versions[event.id] === event.version) continue;
        // Defect history is a baseline, not hundreds of newly assigned tasks.
        if (source === 'defect' && !previous?.baseline) continue;
        let item = state.items.find((row) => !row.mergedInto && (row.key === event.key || row.events.some((existing) => existing.key === event.key)));
        if (!item) {
          item = { id: randomUUID(), key: event.key, revision: 0, status: 'queued',
            title: event.title, events: [], artifacts: [], updatedAt: event.observedAt };
          state.items.push(item);
        }
        const existing = item.events.findIndex((row) => row.id === event.id);
        if (existing >= 0) item.events[existing] = event;
        else item.events.push(event);
        item.title = event.title;
        item.revision++;
        item.updatedAt = event.observedAt;
        // An in-flight run retains its claim. Its result commit detects revision
        // changes and requeues without making outdated drafts reviewable.
        if (item.status !== 'running') item.status = 'queued';
        item.artifacts = item.artifacts.filter((artifact) => ['sending', 'sent', 'send_unknown'].includes(artifact.status));
        item.error = undefined;
      }
      state.sources[source] = checkpoint;
      state.health[source] = { checkedAt: Date.now() };
    });
  }
}
