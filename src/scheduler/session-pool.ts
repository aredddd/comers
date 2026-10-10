import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActiveRuns } from '../bot/active-runs';
import { writeFileAtomic } from '../platform/atomic-write';

export class SessionPoolBusy extends Error {
  constructor() { super('处理会话池暂时没有空闲会话，事项保留排队'); }
}
interface Slot { index: number; sessionId?: string; lastUsed: number; blockedUntil: number }
export interface SessionLease {
  index: number; scopeId: string; sessionId?: string;
  saveSession(id: string): Promise<void>;
  block(): void;
  release(): void;
}
/** Uses the same live reservations/handles as the Comers run scheduler.
 * Only thread IDs and the fixed project are durable; busy status is live. */
export class SchedulerSessionPool {
  private slots: Slot[] = [];
  private loading?: Promise<void>;
  private persistenceError?: Error;
  private saving: Promise<void> = Promise.resolve();
  private readonly leased = new Set<number>();
  constructor(private readonly stateDir: string, private readonly projectDir: string,
    readonly size: number, readonly activeRuns = new ActiveRuns()) {}
  async load(): Promise<void> {
    if (!this.loading) this.loading = this.loadOnce();
    await this.loading;
  }
  private async loadOnce(): Promise<void> {
    let ids: Array<string | undefined> = [];
    try {
      const saved = JSON.parse(await readFile(join(this.stateDir, 'session-pool.json'), 'utf8'));
      if (saved.projectDir !== this.projectDir || !Array.isArray(saved.sessions) || saved.sessions.length > this.size ||
        saved.sessions.some((id: unknown) => id !== null && (typeof id !== 'string' || !id)) ||
        new Set(saved.sessions.filter(Boolean)).size !== saved.sessions.filter(Boolean).length) {
        throw new Error('会话池记录无效、项目目录变化或池容量缩小，请检查后再启动');
      }
      ids = saved.sessions.map((id: string | null) => id ?? undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Reuse the earlier fixed inbox thread on upgrade, without creating another thread.
      try {
        const saved = JSON.parse(await readFile(join(this.stateDir, 'processing-session.json'), 'utf8'));
        if (saved.projectDir !== this.projectDir || typeof saved.sessionId !== 'string' || !saved.sessionId) throw new Error('原处理会话记录无效或项目目录发生变化');
        ids = [saved.sessionId];
      } catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError; }
    }
    this.slots = Array.from({ length: this.size }, (_, index) => ({ index, sessionId: ids[index], lastUsed: 0, blockedUntil: 0 }));
    await writeFileAtomic(join(this.stateDir, 'session-pool.json'), `${JSON.stringify({ projectDir: this.projectDir, sessions: this.slots.map((slot) => slot.sessionId ?? null) })}\n`);
  }
  ids(): string[] { return this.slots.flatMap((slot) => slot.sessionId ? [slot.sessionId] : []); }
  async acquire(preferredIndex?: number): Promise<SessionLease> {
    await this.load();
    if (this.persistenceError) throw this.persistenceError;
    if (this.activeRuns.newRunsPaused()) throw new SessionPoolBusy();
    const candidates = [...this.slots].sort((a, b) => (a.index === preferredIndex ? -1 : b.index === preferredIndex ? 1 : a.lastUsed - b.lastUsed));
    for (const slot of candidates) {
      if (this.leased.has(slot.index) || slot.blockedUntil > Date.now()) continue;
      const scopeId = `inbox:pool:${slot.index}`;
      const releaseScope = this.activeRuns.reserve(scopeId);
      if (!releaseScope) continue;
      this.leased.add(slot.index);
      let released = false;
      return {
        index: slot.index, scopeId, sessionId: slot.sessionId,
        saveSession: (id) => this.saveSession(slot.index, id),
        block: () => { slot.blockedUntil = Date.now() + 30_000; },
        release: () => { if (released) return; released = true; slot.lastUsed = Date.now(); this.leased.delete(slot.index); releaseScope(); },
      };
    }
    throw new SessionPoolBusy();
  }
  private saveSession(index: number, id: string): Promise<void> {
    const task = this.saving.then(async () => {
      const slot = this.slots[index]!;
      if (slot.sessionId && slot.sessionId !== id) throw new Error('池中会话 ID 意外变化，禁止自动创建替代会话');
      if (slot.sessionId === id) return;
      const sessions = this.slots.map((row) => row.index === index ? id : row.sessionId ?? null);
      if (sessions.some((value, position) => value === id && position !== index)) throw new Error('同一会话不能占用两个池槽位');
      try { await writeFileAtomic(join(this.stateDir, 'session-pool.json'), `${JSON.stringify({ projectDir: this.projectDir, sessions })}\n`); }
      catch { this.persistenceError = new Error('会话池持久化失败，已停止分配新会话'); throw this.persistenceError; }
      slot.sessionId = id;
    });
    this.saving = task.catch(() => {});
    return task;
  }
}
