import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { SchedulerSessionPool, SessionPoolBusy } from '../../../src/scheduler/session-pool';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(size = 3) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-pool-')); dirs.push(dir);
  const active = new ActiveRuns(); return { dir, active, pool: new SchedulerSessionPool(dir, '/fixed-project', size, active) };
}
describe('Comers scheduler session pool', () => {
  it('根据调度器的预留和运行状态选择空闲槽位，满池排队不扩容', async () => {
    const { pool, active } = await fixture();
    const release = active.reserve('inbox:pool:0')!;
    const fake = new FakeAgentAdapter(); const run = fake.run({ runId: 'scheduled', scopeId: 'inbox:pool:1', prompt: 'busy' });
    active.register('inbox:pool:1', run);
    const third = await pool.acquire(); expect(third.index).toBe(2);
    await expect(pool.acquire()).rejects.toBeInstanceOf(SessionPoolBusy);
    release(); const first = await pool.acquire(); expect(first.index).toBe(0);
    first.release(); third.release(); active.unregister('inbox:pool:1', run);
    const next = await pool.acquire(); expect(next.index).toBe(1); next.release();
  });
  it('并发保存三个 ID 后跨重启复用同一个有界池，拒绝重复 ID 或意外换会话', async () => {
    const { pool, dir } = await fixture();
    const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(new Set(leases.map((lease) => lease.index)).size).toBe(3);
    await Promise.all(leases.map((lease) => lease.saveSession(`session-${lease.index}`)));
    leases.forEach((lease) => lease.release());
    const saved = JSON.parse(await readFile(join(dir, 'session-pool.json'), 'utf8'));
    expect(saved.sessions).toEqual(['session-0', 'session-1', 'session-2']);
    const restarted = new SchedulerSessionPool(dir, '/fixed-project', 3);
    for (let round = 0; round < 12; round++) { const lease = await restarted.acquire(); expect(lease.sessionId).toBe(`session-${lease.index}`); lease.release(); }
    expect(restarted.ids()).toHaveLength(3);
    const lease = await restarted.acquire(); await expect(lease.saveSession('unplanned-new-session')).rejects.toThrow('ID 意外变化'); lease.release();
    await expect(new SchedulerSessionPool(dir, '/fixed-project', 2).load()).rejects.toThrow('池容量缩小');
  });
  it('全局暂停或外部 writer 冲突会保留队列，不创建替代会话', async () => {
    const { pool, active } = await fixture(1); const resume = active.pauseNewRuns('reconnect');
    await expect(pool.acquire()).rejects.toBeInstanceOf(SessionPoolBusy); resume();
    const lease = await pool.acquire(); await lease.saveSession('existing-session'); lease.block(); lease.release();
    await expect(pool.acquire()).rejects.toBeInstanceOf(SessionPoolBusy); expect(pool.ids()).toEqual(['existing-session']);
  });
});
