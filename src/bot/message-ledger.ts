import { readFile } from 'node:fs/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

interface LedgerEntry {
  messageId: string;
  status: 'received' | 'queued' | 'done';
  updatedAt: number;
  message?: NormalizedMessage;
}

const MAX_ENTRIES = 2000;
const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Persisted inbound dedup ledger. Unfinished normalized messages survive a
 * bridge restart and are put back through the normal command/queue policy. */
export class MessageLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      for (const candidate of raw) {
        const entry = normalizeEntry(candidate);
        if (entry) this.entries.set(entry.messageId, entry);
      }
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('message-ledger', 'load-failed', { error: errorMessage(error) });
      }
    }
  }

  claim(message: NormalizedMessage): boolean {
    if (this.entries.has(message.messageId)) return false;
    this.entries.set(message.messageId, {
      messageId: message.messageId,
      status: 'received',
      updatedAt: Date.now(),
      message,
    });
    this.schedulePersist();
    return true;
  }

  markQueued(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry || entry.status === 'done') return;
    this.entries.set(messageId, { ...entry, status: 'queued', updatedAt: Date.now() });
    this.schedulePersist();
  }

  markDone(messageId: string): void {
    const entry = this.entries.get(messageId);
    this.entries.set(messageId, {
      messageId,
      status: 'done',
      updatedAt: Date.now(),
      ...(entry?.message ? { message: entry.message } : {}),
    });
    this.prune();
    this.schedulePersist();
  }

  recoverable(): NormalizedMessage[] {
    return [...this.entries.values()]
      .filter((entry): entry is LedgerEntry & { message: NormalizedMessage } =>
        entry.status !== 'done' && Boolean(entry.message))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((entry) => entry.message);
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private prune(now = Date.now()): void {
    for (const [id, entry] of this.entries.entries()) {
      if (entry.status === 'done' && now - entry.updatedAt > DONE_TTL_MS) this.entries.delete(id);
    }
    // Never evict unfinished messages to satisfy the history cap: those are
    // precisely the entries needed for restart recovery. Cap only terminal
    // dedup history, matching Hermes' durable-delivery ledger semantics.
    const done = [...this.entries.values()]
      .filter((entry) => entry.status === 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of done.slice(MAX_ENTRIES)) this.entries.delete(entry.messageId);
  }

  private schedulePersist(): void {
    this.saving = this.saving.then(() => this.persist()).catch((error) => {
      log.warn('message-ledger', 'persist-failed', { error: errorMessage(error) });
    });
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(
      this.path,
      `${JSON.stringify([...this.entries.values()], null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

function normalizeEntry(input: unknown): LedgerEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<LedgerEntry>;
  if (
    typeof raw.messageId !== 'string' ||
    (raw.status !== 'received' && raw.status !== 'queued' && raw.status !== 'done') ||
    typeof raw.updatedAt !== 'number'
  ) return undefined;
  return {
    messageId: raw.messageId,
    status: raw.status,
    updatedAt: raw.updatedAt,
    ...(raw.message && typeof raw.message === 'object' ? { message: raw.message } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
