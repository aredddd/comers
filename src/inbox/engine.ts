import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionPoolBusy } from '../scheduler/session-pool';
import { ProcessPool } from '../bot/process-pool';
import { InboxCliError } from './cli-client';
import { InboxStore } from './store';
import type { InboxSources } from './sources';
import type { InboxAgent } from './agent';
import type { InboxConfig, InboxItem } from './types';
import { ensureCodeWorkspace, codeSnapshot, cleanupReleasedWorktrees, git } from './workspace';

export class InboxEngine {
  private polling?: Promise<void>;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  private readonly pool: ProcessPool;
  private stopped = false;
  private lastCleanup = 0;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  constructor(readonly store: InboxStore, private readonly sources: InboxSources,
    private readonly agent: InboxAgent, readonly config: InboxConfig, readonly stateDir: string) {
    this.pool = new ProcessPool(() => config.maxConcurrentRuns);
  }
  async start(): Promise<void> {
    await this.sources.preflight();
    await this.store.recover();
    this.schedulePoll(0); this.scheduleWork(0);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await this.agent.close();
    await Promise.allSettled([this.polling, ...this.workers.values()]);
  }
  async pollOnce(now = Date.now()): Promise<void> {
    if (this.polling) return this.polling;
    const task = (async () => {
      await Promise.all(this.config.sources.map(async (source) => {
        const snapshot = this.store.snapshot();
        if ((snapshot.health[source]?.nextPollAt ?? 0) > now) return;
        try {
          const result = await this.sources.poll(source, snapshot.sources[source], now);
          await this.store.ingest(source, result.events, result.checkpoint);
          this.failures.delete(source);
        } catch (error) {
          const failures = (this.failures.get(source) ?? 0) + 1;
          this.failures.set(source, failures);
          const delay = error instanceof InboxCliError && error.kind === 'auth' ? 5 * 60_000
            : Math.max(error instanceof InboxCliError ? error.retryAfterMs ?? 0 : 0,
              Math.min(5 * 60_000, this.config.intervalMs * 2 ** Math.min(failures, 5)));
          await this.store.update((state) => {
            state.health[source] = { checkedAt: now, nextPollAt: now + delay,
              error: error instanceof InboxCliError ? error.message : '采集失败，请检查 CLI 与本地存储状态' };
          });
        }
      }));
    })();
    this.polling = task;
    try { await task; } finally { this.polling = undefined; }
  }
  async workOnce(): Promise<void> {
    if (Date.now() - this.lastCleanup >= 60_000) {
      this.lastCleanup = Date.now();
      const released = await cleanupReleasedWorktrees(this.store.snapshot().items, this.stateDir);
      if (released.length) await this.store.update((state) => {
        for (const item of state.items) if (released.includes(item.id)) { item.worktree = undefined; item.revision++; }
      });
    }
    for (const item of this.store.snapshot().items.filter((row) => row.status === 'queued' && !row.mergedInto)) {
      if (this.workers.has(item.id) || this.stopped) continue;
      const release = this.pool.tryAcquire();
      if (!release) break;
      const task = this.process(item.id).finally(() => { release(); this.workers.delete(item.id); });
      this.workers.set(item.id, task);
    }
    await Promise.allSettled([...this.workers.values()]);
  }
  private async process(id: string): Promise<void> {
    let claimed: InboxItem | undefined;
    try {
      claimed = await this.store.update((state) => {
        const item = state.items.find((row) => row.id === id);
        if (!item || item.status !== 'queued' || item.mergedInto) return undefined;
        item.status = 'running'; item.revision++;
        return structuredClone(item);
      });
      if (!claimed) return;
      const routes = await this.agent.routes();
      const recent = this.store.snapshot().items.filter((row) => row.id !== id && !row.mergedInto && ['queued', 'review'].includes(row.status)).slice(-30);
      const decision = await this.agent.classify(claimed, routes, recent);
      if (decision.relatedItemId) {
        await this.store.update((state) => {
          const item = state.items.find((row) => row.id === id)!;
          const related = state.items.find((row) => row.id === decision.relatedItemId);
          if (!related || related.status === 'running' || item.revision !== claimed!.revision) {
            item.status = 'queued'; return;
          }
          for (const event of item.events) {
            const index = related.events.findIndex((row) => row.id === event.id);
            if (index >= 0) related.events[index] = event; else related.events.push(event);
          }
          related.status = 'queued'; related.revision++; related.updatedAt = Date.now();
          related.artifacts = related.artifacts.filter((artifact) => ['sending', 'sent', 'send_unknown'].includes(artifact.status));
          item.status = 'ignored'; item.mergedInto = related.id; item.revision++;
        });
        return;
      }
      if (decision.action === 'ignore') {
        await this.store.update((state) => {
          const item = state.items.find((row) => row.id === id)!;
          item.status = item.revision === claimed!.revision ? 'ignored' : 'queued';
          item.title = decision.title; item.revision++;
        });
        return;
      }
      const route = routes.find((row) => row.id === decision.routeId);
      let cwd = route?.cwd ?? join(this.stateDir, 'workspace');
      if (decision.action === 'code') {
        if (!route) throw new Error('需要代码修改但未匹配到可信仓库，请补充路由后重试');
        cwd = await ensureCodeWorkspace(cwd, this.stateDir, id, claimed.worktree);
      } else { await mkdir(cwd, { recursive: true, mode: 0o700 }); }
      const stillCurrent = await this.store.update((state) => {
        const item = state.items.find((row) => row.id === id)!;
        item.routeId = route?.id; item.sourceSessionId = route?.sourceSessionId;
        if (decision.action === 'code') item.worktree = cwd;
        if (item.revision !== claimed!.revision) { item.status = 'queued'; return false; }
        return true;
      });
      if (!stillCurrent || this.stopped) return;
      const initialHead = decision.action === 'code' ? await git(cwd, ['rev-parse', 'HEAD']) : undefined;
      const result = await this.agent.prepare(claimed, route, cwd, decision, async (sessionId) => {
        await this.store.update((state) => { state.items.find((row) => row.id === id)!.executionSessionId = sessionId; });
      });
      if (decision.action === 'code') {
        if (await git(cwd, ['rev-parse', 'HEAD']) !== initialHead) throw new Error('AI 改变了提交历史，请检查工作区后重试');
        const code = await codeSnapshot(cwd);
        for (const artifact of result.artifacts) {
          if (artifact.kind === 'code') artifact.codeFingerprint = code.fingerprint;
        }
      }
      await this.store.update((state) => {
        const item = state.items.find((row) => row.id === id)!;
        item.executionSessionId = result.sessionId ?? item.executionSessionId;
        item.title = decision.title;
        if (item.revision !== claimed!.revision) { item.status = 'queued'; return; }
        item.status = 'review'; item.revision++; item.updatedAt = Date.now();
        item.artifacts.push(...result.artifacts);
        item.error = undefined;
      });
    } catch (error) {
      if (!claimed) return;
      await this.store.update((state) => {
        const item = state.items.find((row) => row.id === id)!;
        const changed = item.revision !== claimed!.revision;
        item.status = changed || error instanceof SessionPoolBusy ? 'queued' : this.stopped ? 'interrupted' : 'failed';
        item.error = error instanceof Error ? error.message.slice(0, 300) : '执行失败';
        item.revision++;
      });
    }
  }
  private schedulePoll(delay: number): void {
    const timer = setTimeout(async () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
      const started = Date.now();
      try { await this.pollOnce(); } catch { /* Persist failure: stop rather than run without a durable cursor. */ this.stopped = true; }
      if (!this.stopped) this.schedulePoll(Math.max(0, this.config.intervalMs - (Date.now() - started)));
    }, delay);
    this.timers.push(timer);
  }
  private scheduleWork(delay: number): void {
    const timer = setTimeout(async () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
      try { await this.workOnce(); } catch { this.stopped = true; }
      if (!this.stopped) this.scheduleWork(1000);
    }, delay);
    this.timers.push(timer);
  }
}
