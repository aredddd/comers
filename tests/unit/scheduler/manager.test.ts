import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SchedulerManager,
  formatSchedule,
  parseScheduleAndPrompt,
  type ScheduledJob,
} from '../../../src/scheduler/manager.js';

describe('persisted scheduler', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('parses one-shot, interval, daily, and standard five-field cron expressions', () => {
    const now = new Date('2026-08-31T08:00:00+08:00').getTime();
    expect(parseScheduleAndPrompt('in 10m 生成日报', now)).toMatchObject({
      schedule: { kind: 'once', at: now + 600_000 },
      prompt: '生成日报',
    });
    expect(parseScheduleAndPrompt('every 2h 检查构建', now)).toMatchObject({
      schedule: { kind: 'interval', everyMs: 7_200_000 },
    });
    expect(formatSchedule(parseScheduleAndPrompt('daily 09:30 早报', now)!.schedule)).toBe('每天 09:30');
    expect(parseScheduleAndPrompt('cron 0 9 * * 1-5 工作日检查', now)).toMatchObject({
      schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
    });
    expect(parseScheduleAndPrompt('every 5s 太频繁', now)).toBeUndefined();
  });

  it('persists jobs and can trigger, pause, resume, and remove them after reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-scheduler-'));
    cleanup.push(dir);
    const path = join(dir, 'jobs.json');
    const triggered: string[] = [];
    const now = Date.now();
    const first = new SchedulerManager(path, async (job) => {
      triggered.push(job.id);
    }, () => now);
    const job = first.create({
      prompt: '检查测试',
      schedule: { kind: 'interval', everyMs: 60_000 },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    expect(job.runScopeId).toBe('oc_1:cron');
    await first.flush();

    let runId = '';
    const second = new SchedulerManager(path, async (loaded, run) => {
      triggered.push(loaded.id);
      runId = run.id;
    }, () => now);
    await second.load();
    expect(second.list('oc_1')).toHaveLength(1);
    expect(second.pause(job.id)).toBe(true);
    expect(second.resume(job.id)).toBe(true);
    expect(await second.runNow(job.id)).toBe(true);
    expect(triggered).toEqual([job.id]);
    expect(second.history(job.id)).toMatchObject([{ id: runId, status: 'queued' }]);
    expect(await second.markRunning(runId)).toBe(true);
    expect(await second.finishRun(runId, 'succeeded')).toBe(true);
    expect(second.history(job.id)).toMatchObject([{ id: runId, status: 'succeeded' }]);
    expect(second.remove(job.id)).toBe(true);
    await second.flush();
    expect(second.list()).toHaveLength(0);
  });

  it('uses traditional cron day OR semantics and accepts Sunday as 7', () => {
    const path = join(tmpdir(), 'unused-scheduler-jobs.json');
    const monday = new Date(2026, 7, 31, 10, 0).getTime();
    const manager = new SchedulerManager(path, async () => {}, () => monday);
    const sundayJob = manager.create({
      prompt: '周日任务',
      schedule: { kind: 'cron', expression: '0 9 * * 7' },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    expect(sundayJob.nextRunAt).toBe(new Date(2026, 8, 6, 9, 0).getTime());

    const afterFirstOfMonth = new Date(2026, 8, 1, 9, 1).getTime();
    const orManager = new SchedulerManager(path, async () => {}, () => afterFirstOfMonth);
    const orJob = orManager.create({
      prompt: '每月一号或每周一',
      schedule: { kind: 'cron', expression: '0 9 1 * 1' },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    expect(orJob.nextRunAt).toBe(new Date(2026, 8, 7, 9, 0).getTime());
  });

  it('dispatches due jobs from different conversations concurrently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-scheduler-parallel-'));
    cleanup.push(dir);
    let now = Date.now();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const seen = new Set<string>();
    const manager = new SchedulerManager(join(dir, 'jobs.json'), async (job) => {
      seen.add(job.id);
      if (seen.size === 2) bothStarted();
      await gate;
    }, () => now);
    const create = (prompt: string, scopeId: string) => manager.create({
      prompt,
      schedule: { kind: 'once', at: now + 1000 },
      chatId: scopeId,
      scopeId,
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    create('任务一', 'oc_1');
    create('任务二', 'oc_2');
    now += 2000;
    manager.start();
    await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('due jobs were serialized')), 1000)),
    ]);
    expect(seen.size).toBe(2);
    release();
    manager.stop();
    await manager.flush();
  });

  it('serializes jobs that share one scheduled-session scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-scheduler-serial-'));
    cleanup.push(dir);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const runIds: string[] = [];
    const manager = new SchedulerManager(join(dir, 'jobs.json'), async (_job, run) => {
      runIds.push(run.id);
      if (runIds.length === 1) {
        firstStarted();
        await gate;
      }
    });
    const create = (prompt: string) => manager.create({
      prompt,
      schedule: { kind: 'interval', everyMs: 60_000 },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    const first = create('任务一');
    const second = create('任务二');

    const firstDispatch = manager.runNow(first.id);
    await started;
    expect(await manager.runNow(second.id)).toBe(false);
    releaseFirst();
    expect(await firstDispatch).toBe(true);
    expect(await manager.runNow(second.id)).toBe(false);
    expect(await manager.markRunning(runIds[0]!)).toBe(true);
    expect(await manager.finishRun(runIds[0]!, 'succeeded')).toBe(true);
    expect(await manager.runNow(second.id)).toBe(true);
    expect(runIds).toHaveLength(2);
  });

  it('migrates per-job session scopes to one shared conversation scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-scheduler-scope-migration-'));
    cleanup.push(dir);
    const path = join(dir, 'jobs.json');
    const first = new SchedulerManager(path, async () => {});
    const one = first.create({
      prompt: '任务一',
      schedule: { kind: 'interval', everyMs: 60_000 },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    const two = first.create({
      prompt: '任务二',
      schedule: { kind: 'interval', everyMs: 60_000 },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    await first.flush();
    const state = JSON.parse(await readFile(path, 'utf8')) as { jobs: ScheduledJob[] };
    state.jobs = state.jobs.map((job) => ({ ...job, runScopeId: `${job.scopeId}:cron:${job.id}` }));
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const second = new SchedulerManager(path, async () => {});
    await second.load();

    expect(second.get(one.id)?.runScopeId).toBe('oc_1:cron');
    expect(second.get(two.id)?.runScopeId).toBe('oc_1:cron');
    expect(second.sessionScopeMigrations()).toEqual([{
      targetScopeId: 'oc_1:cron',
      sourceScopeIds: expect.arrayContaining([
        `oc_1:cron:${one.id}`,
        `oc_1:cron:${two.id}`,
      ]),
    }]);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { jobs: ScheduledJob[] };
    expect(persisted.jobs.every((job) => job.runScopeId === 'oc_1:cron')).toBe(true);

    const third = new SchedulerManager(path, async () => {});
    await third.load();
    expect(third.sessionScopeMigrations()[0]?.sourceScopeIds).toEqual(expect.arrayContaining([
      `oc_1:cron:${one.id}`,
      `oc_1:cron:${two.id}`,
    ]));
  });

  it('reconciles persisted active runs against recoverable scheduled messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-scheduler-reconcile-'));
    cleanup.push(dir);
    const path = join(dir, 'jobs.json');
    let runId = '';
    const manager = new SchedulerManager(path, async (_job, run) => { runId = run.id; });
    const job = manager.create({
      prompt: '检查状态',
      schedule: { kind: 'interval', everyMs: 60_000 },
      chatId: 'oc_1',
      scopeId: 'oc_1',
      chatType: 'p2p',
      chatMode: 'p2p',
      actorId: 'ou_owner',
    });
    await manager.flush();
    expect(await manager.runNow(job.id)).toBe(true);

    const recovered = new SchedulerManager(path, async () => {});
    await recovered.load();
    await recovered.reconcileRecoverableRuns(new Set([runId]));
    expect(recovered.history(job.id)[0]?.status).toBe('queued');

    const orphaned = new SchedulerManager(path, async () => {});
    await orphaned.load();
    await orphaned.reconcileRecoverableRuns(new Set());
    expect(orphaned.history(job.id)[0]).toMatchObject({ status: 'failed' });
  });
});
