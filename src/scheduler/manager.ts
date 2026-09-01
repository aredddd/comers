import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export type ScheduleSpec =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'cron'; expression: string };

export interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  status: 'active' | 'paused' | 'completed';
  nextRunAt?: number;
  lastRunAt?: number;
  createdAt: number;
  chatId: string;
  /** Scope used by /cron list and management in the owner conversation. */
  scopeId: string;
  /** Isolated agent-session scope. Keeps scheduled work out of the user's
   * currently selected interactive Codex task. */
  runScopeId?: string;
  chatType: 'p2p' | 'group';
  chatMode: 'p2p' | 'group' | 'topic';
  actorId: string;
  threadId?: string;
  lastStatus?: ScheduledRunStatus;
  lastError?: string;
  lastFinishedAt?: number;
  consecutiveFailures?: number;
}

export type ScheduledRunStatus =
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'timed_out';

export interface ScheduledRun {
  id: string;
  jobId: string;
  trigger: 'schedule' | 'manual';
  status: ScheduledRunStatus;
  createdAt: number;
  scheduledFor?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Scheduled fires advance the next occurrence once their message is
   * durably queued. Manual runs leave the configured schedule untouched. */
  advanceSchedule: boolean;
}

export interface CreateScheduledJobInput {
  name?: string;
  prompt: string;
  schedule: ScheduleSpec;
  chatId: string;
  scopeId: string;
  chatType: 'p2p' | 'group';
  chatMode: 'p2p' | 'group' | 'topic';
  actorId: string;
  threadId?: string;
}

export interface ScheduledSessionScopeMigration {
  targetScopeId: string;
  sourceScopeIds: string[];
}

export function scheduledSessionScope(scopeId: string): string {
  return `${scopeId}:cron`;
}

export class SchedulerManager {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly runs = new Map<string, ScheduledRun>();
  private readonly dispatching = new Set<string>();
  private readonly dispatchingScopes = new Set<string>();
  private readonly sessionScopeMigrationMap = new Map<string, Set<string>>();
  private readonly ticks = new Set<Promise<void>>();
  private saving: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly path: string,
    private readonly trigger: (job: ScheduledJob, run: ScheduledRun) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      const state = normalizeState(raw);
      let migrated = false;
      for (const candidate of state.jobs) {
        const job = normalizeJob(candidate);
        if (!job) continue;
        const targetScopeId = scheduledSessionScope(job.scopeId);
        const sourceScopeIds = this.sessionScopeMigrationMap.get(targetScopeId) ?? new Set<string>();
        sourceScopeIds.add(`${job.scopeId}:cron:${job.id}`);
        this.sessionScopeMigrationMap.set(targetScopeId, sourceScopeIds);
        if (job.runScopeId !== targetScopeId) {
          if (job.runScopeId && job.runScopeId !== job.scopeId) {
            sourceScopeIds.add(job.runScopeId);
          }
          this.jobs.set(job.id, { ...job, runScopeId: targetScopeId });
          migrated = true;
        } else {
          this.jobs.set(job.id, job);
        }
      }
      for (const candidate of state.runs) {
        const run = normalizeRun(candidate);
        if (run) this.runs.set(run.id, run);
      }
      this.pruneRuns();
      if (migrated) await this.persistNow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('scheduler', 'load-failed', { error: errorMessage(error) });
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.scheduleTick();
    this.timer = setInterval(() => this.scheduleTick(), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  create(input: CreateScheduledJobInput): ScheduledJob {
    const now = this.now();
    const id = randomUUID().replace(/-/g, '').slice(0, 10);
    const nextRunAt = nextOccurrence(input.schedule, now);
    if (!nextRunAt) throw new Error('这个时间表达式在未来一年内没有执行时间');
    const job: ScheduledJob = {
      id,
      name: input.name?.trim() || input.prompt.trim().replace(/\s+/g, ' ').slice(0, 36),
      prompt: input.prompt.trim(),
      schedule: input.schedule,
      status: 'active',
      nextRunAt,
      createdAt: now,
      chatId: input.chatId,
      scopeId: input.scopeId,
      runScopeId: scheduledSessionScope(input.scopeId),
      chatType: input.chatType,
      chatMode: input.chatMode,
      actorId: input.actorId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
    this.jobs.set(id, job);
    this.schedulePersist();
    return { ...job };
  }

  list(scopeId?: string): ScheduledJob[] {
    return [...this.jobs.values()]
      .filter((job) => !scopeId || job.scopeId === scopeId)
      .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
      .map((job) => ({ ...job }));
  }

  get(id: string): ScheduledJob | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  sessionScopeMigrations(): ScheduledSessionScopeMigration[] {
    return [...this.sessionScopeMigrationMap.entries()].map(([targetScopeId, sourceScopeIds]) => ({
      targetScopeId,
      sourceScopeIds: [...sourceScopeIds],
    }));
  }

  pause(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status === 'completed') return false;
    this.jobs.set(id, { ...job, status: 'paused' });
    this.schedulePersist();
    return true;
  }

  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status === 'completed') return false;
    const nextRunAt = nextOccurrence(job.schedule, this.now());
    if (!nextRunAt) return false;
    this.jobs.set(id, { ...job, status: 'active', nextRunAt });
    this.schedulePersist();
    return true;
  }

  remove(id: string): boolean {
    if (this.hasActiveRun(id) || this.dispatching.has(id)) return false;
    const removed = this.jobs.delete(id);
    if (removed) this.schedulePersist();
    return removed;
  }

  async runNow(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || this.hasActiveRun(id) || this.dispatching.has(id) || this.scopeBusy(job)) return false;
    return this.runJob(job, false);
  }

  history(jobId: string, limit = 10): ScheduledRun[] {
    return [...this.runs.values()]
      .filter((run) => run.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map((run) => ({ ...run }));
  }

  /** Reconcile scheduler state with the inbound message ledger after a
   * restart. A recoverable scheduled message owns its prior run; an orphaned
   * dispatch is failed and made eligible for a bounded retry. */
  async reconcileRecoverableRuns(recoverableRunIds: ReadonlySet<string>): Promise<void> {
    let changed = false;
    for (const run of this.runs.values()) {
      if (!isActiveStatus(run.status)) continue;
      if (recoverableRunIds.has(run.id)) {
        if (run.status === 'dispatching') {
          this.runs.set(run.id, { ...run, status: 'queued' });
          this.advanceAfterQueue(run);
          changed = true;
        }
        continue;
      }
      const finishedAt = this.now();
      this.runs.set(run.id, {
        ...run,
        status: 'failed',
        finishedAt,
        error: 'bridge 重启后未找到可恢复的排队消息',
      });
      this.noteFailure(run.jobId, finishedAt, 'bridge 重启后未找到可恢复的排队消息', {
        retryDispatch: run.status === 'dispatching' && run.advanceSchedule,
      });
      changed = true;
    }
    if (changed) await this.persistNow();
  }

  async markRunning(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || (run.status !== 'queued' && run.status !== 'dispatching')) return false;
    const startedAt = this.now();
    this.runs.set(runId, { ...run, status: 'running', startedAt });
    const job = this.jobs.get(run.jobId);
    if (job) this.jobs.set(job.id, { ...job, lastRunAt: startedAt, lastStatus: 'running' });
    await this.persistNow();
    return true;
  }

  async finishRun(
    runId: string,
    status: Extract<ScheduledRunStatus, 'succeeded' | 'failed' | 'interrupted' | 'timed_out'>,
    error?: string,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || !isActiveStatus(run.status)) return false;
    const finishedAt = this.now();
    this.runs.set(runId, {
      ...run,
      status,
      finishedAt,
      ...(error ? { error: error.slice(0, 1000) } : {}),
    });
    if (status === 'succeeded') {
      const job = this.jobs.get(run.jobId);
      if (job) {
        this.jobs.set(job.id, {
          ...job,
          lastStatus: status,
          lastFinishedAt: finishedAt,
          lastError: undefined,
          consecutiveFailures: 0,
        });
      }
    } else {
      this.noteFailure(run.jobId, finishedAt, error ?? status);
    }
    this.pruneRuns();
    await this.persistNow();
    return true;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.ticks]);
    await this.saving;
  }

  private scheduleTick(): void {
    const tick = this.tick();
    this.ticks.add(tick);
    void tick.finally(() => this.ticks.delete(tick));
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const due = [...this.jobs.values()].filter(
      (job) =>
        job.status === 'active' &&
        job.nextRunAt !== undefined &&
        job.nextRunAt <= now &&
        !this.dispatching.has(job.id) &&
        !this.hasActiveRun(job.id) &&
        !this.scopeBusy(job),
    );
    await Promise.allSettled(due.map((job) => this.runJob(job, true)));
  }

  private async runJob(job: ScheduledJob, advance: boolean): Promise<boolean> {
    const runScopeId = job.runScopeId ?? scheduledSessionScope(job.scopeId);
    if (this.dispatching.has(job.id) || this.hasActiveRun(job.id) || this.scopeBusy(job)) return false;
    this.dispatching.add(job.id);
    this.dispatchingScopes.add(runScopeId);
    const createdAt = this.now();
    const run: ScheduledRun = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      jobId: job.id,
      trigger: advance ? 'schedule' : 'manual',
      status: 'dispatching',
      createdAt,
      ...(advance && job.nextRunAt !== undefined ? { scheduledFor: job.nextRunAt } : {}),
      advanceSchedule: advance,
    };
    this.runs.set(run.id, run);
    try {
      // Persist the dispatch claim before any outbound message. If this write
      // fails, fail closed: no external side effect has happened yet.
      await this.persistNow();
      await this.trigger({ ...job }, { ...run });
      this.runs.set(run.id, { ...run, status: 'queued' });
      this.advanceAfterQueue(run);
      await this.persistNow();
      log.info('scheduler', 'triggered', { id: job.id, runId: run.id, scope: job.scopeId });
      return true;
    } catch (error) {
      const message = errorMessage(error);
      const finishedAt = this.now();
      this.runs.set(run.id, { ...run, status: 'failed', finishedAt, error: message.slice(0, 1000) });
      this.noteFailure(job.id, finishedAt, message, { retryDispatch: advance });
      await this.persistNow().catch((persistError) => {
        log.warn('scheduler', 'failure-state-persist-failed', {
          id: job.id,
          runId: run.id,
          error: errorMessage(persistError),
        });
      });
      log.warn('scheduler', 'trigger-failed', { id: job.id, runId: run.id, error: message });
      return false;
    } finally {
      this.dispatching.delete(job.id);
      this.dispatchingScopes.delete(runScopeId);
    }
  }

  private advanceAfterQueue(run: ScheduledRun): void {
    if (!run.advanceSchedule) return;
    const current = this.jobs.get(run.jobId);
    if (!current) return;
    if (current.schedule.kind === 'once') {
      this.jobs.set(current.id, {
        ...current,
        status: 'completed',
        nextRunAt: undefined,
        lastStatus: 'queued',
      });
      return;
    }
    const after = Math.max(run.scheduledFor ?? run.createdAt, this.now());
    this.jobs.set(current.id, {
      ...current,
      nextRunAt: nextOccurrence(current.schedule, after),
      lastStatus: 'queued',
    });
  }

  private noteFailure(
    jobId: string,
    finishedAt: number,
    error: string,
    options: { retryDispatch?: boolean } = {},
  ): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const consecutiveFailures = (job.consecutiveFailures ?? 0) + 1;
    const retryDelay = Math.min(60_000 * 2 ** Math.min(consecutiveFailures - 1, 4), 15 * 60_000);
    this.jobs.set(job.id, {
      ...job,
      lastStatus: 'failed',
      lastError: error.slice(0, 1000),
      lastFinishedAt: finishedAt,
      consecutiveFailures,
      ...(options.retryDispatch ? { status: 'active', nextRunAt: finishedAt + retryDelay } : {}),
    });
  }

  private hasActiveRun(jobId: string): boolean {
    return [...this.runs.values()].some(
      (run) => run.jobId === jobId && isActiveStatus(run.status),
    );
  }

  private scopeBusy(job: ScheduledJob): boolean {
    const runScopeId = job.runScopeId ?? scheduledSessionScope(job.scopeId);
    if (this.dispatchingScopes.has(runScopeId)) return true;
    return [...this.runs.values()].some((run) => {
      if (!isActiveStatus(run.status)) return false;
      const activeJob = this.jobs.get(run.jobId);
      return activeJob !== undefined &&
        (activeJob.runScopeId ?? scheduledSessionScope(activeJob.scopeId)) === runScopeId;
    });
  }

  private pruneRuns(): void {
    const terminal = [...this.runs.values()]
      .filter((run) => !isActiveStatus(run.status))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const run of terminal.slice(500)) this.runs.delete(run.id);
  }

  private schedulePersist(): void {
    this.saving = this.saving.then(() => this.persist()).catch((error) => {
      log.warn('scheduler', 'persist-failed', { error: errorMessage(error) });
    });
  }

  private async persistNow(): Promise<void> {
    this.saving = this.saving.catch(() => {}).then(() => this.persist());
    await this.saving;
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(
      this.path,
      `${JSON.stringify({
        version: 2,
        jobs: [...this.jobs.values()],
        runs: [...this.runs.values()],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

export function parseScheduleAndPrompt(input: string, now = Date.now()): {
  schedule: ScheduleSpec;
  prompt: string;
} | undefined {
  const trimmed = input.trim();
  let match = /^in\s+(\d+)([smhd])\s+([\s\S]+)$/i.exec(trimmed);
  if (match) {
    const duration = durationMs(Number(match[1]), match[2]!.toLowerCase());
    return { schedule: { kind: 'once', at: now + duration }, prompt: match[3]!.trim() };
  }
  match = /^every\s+(\d+)([mhd])\s+([\s\S]+)$/i.exec(trimmed);
  if (match) {
    const everyMs = durationMs(Number(match[1]), match[2]!.toLowerCase());
    if (everyMs < 60_000) return undefined;
    return { schedule: { kind: 'interval', everyMs }, prompt: match[3]!.trim() };
  }
  match = /^daily\s+([01]?\d|2[0-3]):([0-5]\d)\s+([\s\S]+)$/i.exec(trimmed);
  if (match) {
    return {
      schedule: { kind: 'daily', hour: Number(match[1]), minute: Number(match[2]) },
      prompt: match[3]!.trim(),
    };
  }
  match = /^cron\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/i.exec(trimmed);
  if (match) {
    const expression = match.slice(1, 6).join(' ');
    if (!parseCron(expression)) return undefined;
    return { schedule: { kind: 'cron', expression }, prompt: match[6]!.trim() };
  }
  return undefined;
}

export function formatSchedule(schedule: ScheduleSpec): string {
  if (schedule.kind === 'once') return `一次性 · ${new Date(schedule.at).toLocaleString()}`;
  if (schedule.kind === 'interval') return `每 ${formatDuration(schedule.everyMs)}`;
  if (schedule.kind === 'daily') return `每天 ${pad(schedule.hour)}:${pad(schedule.minute)}`;
  return `cron ${schedule.expression}`;
}

function nextOccurrence(schedule: ScheduleSpec, after: number): number | undefined {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : after + 1000;
  if (schedule.kind === 'interval') return after + schedule.everyMs;
  if (schedule.kind === 'daily') {
    const next = new Date(after);
    next.setSeconds(0, 0);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= after) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const fields = parseCron(schedule.expression);
  if (!fields) return undefined;
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let index = 0; index < limit; index++) {
    const dayMatches = fields.day.has(cursor.getDate());
    const weekdayMatches = fields.weekday.has(cursor.getDay());
    // Traditional five-field cron treats day-of-month and day-of-week as an
    // OR when both are restricted.  If either field is `*`, the other field
    // alone decides.  Keeping this here avoids silently running fewer jobs
    // than users expect from familiar cron expressions.
    const calendarDayMatches = fields.dayWildcard
      ? weekdayMatches
      : fields.weekdayWildcard
        ? dayMatches
        : dayMatches || weekdayMatches;
    if (
      fields.minute.has(cursor.getMinutes()) &&
      fields.hour.has(cursor.getHours()) &&
      calendarDayMatches &&
      fields.month.has(cursor.getMonth() + 1)
    ) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return undefined;
}

function parseCron(expression: string): {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayWildcard: boolean;
  weekdayWildcard: boolean;
} | undefined {
  const [minute, hour, day, month, weekday, ...extra] = expression.trim().split(/\s+/);
  if (!minute || !hour || !day || !month || !weekday || extra.length) return undefined;
  const parsed = {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    day: parseCronField(day, 1, 31),
    month: parseCronField(month, 1, 12),
    weekday: parseCronField(weekday, 0, 7, true),
    dayWildcard: day === '*',
    weekdayWildcard: weekday === '*',
  };
  return parsed.minute && parsed.hour && parsed.day && parsed.month && parsed.weekday
    ? parsed as { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; dayWildcard: boolean; weekdayWildcard: boolean }
    : undefined;
}

function parseCronField(value: string, min: number, max: number, sundaySeven = false): Set<number> | undefined {
  const result = new Set<number>();
  for (const part of value.split(',')) {
    const [rangePart, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step <= 0) return undefined;
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart?.includes('-')) {
      const [startRaw, endRaw] = rangePart.split('-');
      start = Number(startRaw);
      end = Number(endRaw);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return undefined;
    for (let number = start; number <= end; number += step) {
      result.add(sundaySeven && number === 7 ? 0 : number);
    }
  }
  return result.size ? result : undefined;
}

function durationMs(value: number, unit: string): number {
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  return `${ms / 60_000} 分钟`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeState(input: unknown): { jobs: unknown[]; runs: unknown[] } {
  // Version 1 stored a bare job array. Keep accepting it so existing Comers
  // profiles upgrade in place without touching their schedules.
  if (Array.isArray(input)) return { jobs: input, runs: [] };
  if (!input || typeof input !== 'object') return { jobs: [], runs: [] };
  const raw = input as { jobs?: unknown; runs?: unknown };
  return {
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
  };
}

function normalizeRun(input: unknown): ScheduledRun | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<ScheduledRun>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.jobId !== 'string' ||
    (raw.trigger !== 'schedule' && raw.trigger !== 'manual') ||
    !isScheduledRunStatus(raw.status) ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.advanceSchedule !== 'boolean' ||
    (raw.scheduledFor !== undefined && typeof raw.scheduledFor !== 'number') ||
    (raw.startedAt !== undefined && typeof raw.startedAt !== 'number') ||
    (raw.finishedAt !== undefined && typeof raw.finishedAt !== 'number') ||
    (raw.error !== undefined && typeof raw.error !== 'string')
  ) return undefined;
  return raw as ScheduledRun;
}

function isScheduledRunStatus(input: unknown): input is ScheduledRunStatus {
  return input === 'dispatching' ||
    input === 'queued' ||
    input === 'running' ||
    input === 'succeeded' ||
    input === 'failed' ||
    input === 'interrupted' ||
    input === 'timed_out';
}

function isActiveStatus(status: ScheduledRunStatus): boolean {
  return status === 'dispatching' || status === 'queued' || status === 'running';
}

function normalizeJob(input: unknown): ScheduledJob | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<ScheduledJob>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.prompt !== 'string' ||
    !raw.schedule ||
    (raw.status !== 'active' && raw.status !== 'paused' && raw.status !== 'completed') ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.chatId !== 'string' ||
    typeof raw.scopeId !== 'string' ||
    (raw.runScopeId !== undefined && typeof raw.runScopeId !== 'string') ||
    (raw.chatType !== 'p2p' && raw.chatType !== 'group') ||
    (raw.chatMode !== 'p2p' && raw.chatMode !== 'group' && raw.chatMode !== 'topic') ||
    typeof raw.actorId !== 'string' ||
    (raw.lastStatus !== undefined && !isScheduledRunStatus(raw.lastStatus)) ||
    (raw.lastError !== undefined && typeof raw.lastError !== 'string') ||
    (raw.lastFinishedAt !== undefined && typeof raw.lastFinishedAt !== 'number') ||
    (raw.consecutiveFailures !== undefined && typeof raw.consecutiveFailures !== 'number')
  ) return undefined;
  return raw as ScheduledJob;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
