import type { Command } from 'commander';
import { mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';
import { acquireHostLock } from '../../runtime/host-lock';
import { CodexInboxAgent } from '../../inbox/agent';
import { InboxEngine } from '../../inbox/engine';
import { InboxSources } from '../../inbox/sources';
import { InboxStore } from '../../inbox/store';
import { DEFAULT_INBOX_CONFIG, type InboxConfig } from '../../inbox/types';
import { startInboxServer } from '../../inbox/server';

export function registerInboxCommands(program: Command): void {
  const inbox = program.command('inbox').description('私聊、群聊 @ 和 Meegle 缺陷的 AI 待审阅收件箱');
  inbox.command('status').description('读取采集健康和队列数量，不展示消息正文或凭证')
    .requiredOption('--state-dir <path>', '收件箱目录')
    .action(async (opts: { stateDir: string }) => {
      const store = new InboxStore(join(resolve(opts.stateDir), 'state.json')); await store.load();
      const state = store.snapshot(); const counts: Record<string, number> = {};
      for (const item of state.items) if (!item.mergedInto) counts[item.status] = (counts[item.status] ?? 0) + 1;
      console.log(JSON.stringify({ counts, health: state.health }, null, 2));
    });
  inbox.command('init').description('生成 10 秒轮询配置，不启动监控')
    .requiredOption('--state-dir <path>', '配置、队列和隔离工作区目录')
    .action(async (opts: { stateDir: string }) => {
      const dir = resolve(opts.stateDir); await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, 'config.json');
      try { await readFile(path); throw new Error('配置已存在，请直接编辑或运行'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeFileAtomic(path, `${JSON.stringify(DEFAULT_INBOX_CONFIG, null, 2)}\n`);
      console.log(`收件箱配置已生成：${path}`);
    });
  inbox.command('run').description('启动采集、AI 处理和本机审阅界面')
    .requiredOption('--state-dir <path>', '收件箱目录')
    .option('--port <number>', '本机审阅界面端口，默认随机', '0')
    .option('--once', '只采集一轮，不启动 AI 或常驻服务')
    .action(async (opts: { stateDir: string; port: string; once?: boolean }) => {
      const dir = await realpath(resolve(opts.stateDir));
      const config = await loadInboxConfig(join(dir, 'config.json'));
      const lock = await acquireHostLock(join(dir, 'inbox.lock'));
      if (!lock) throw new Error('这个收件箱已经在运行');
      const store = new InboxStore(join(dir, 'state.json'));
      const sources = new InboxSources(config); const agent = new CodexInboxAgent(config, dir, undefined,
        () => store.snapshot().items.map((item) => item.executionSessionId).filter((id): id is string => Boolean(id)));
      const engine = new InboxEngine(store, sources, agent, config, dir);
      let server: Awaited<ReturnType<typeof startInboxServer>> | undefined;
      try {
        await store.load();
        if (opts.once) {
          await sources.preflight(); await engine.pollOnce();
          const state = store.snapshot();
          console.log(JSON.stringify({ items: state.items.length, health: state.health }, null, 2)); return;
        }
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
        server = await startInboxServer(store, dir, port);
        await engine.start();
        console.log(`收件箱已启动，轮询 ${config.intervalMs / 1000} 秒。审阅地址保存在 ${join(dir, 'console.json')}。`);
        // Do not print the console access token into shared logs.
        await new Promise<void>((done) => {
          const stop = (): void => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); done(); };
          process.on('SIGINT', stop); process.on('SIGTERM', stop);
        });
      } finally {
        await engine.stop();
        if (server) await new Promise<void>((done) => server!.server.close(() => done()));
        await rm(join(dir, 'console.json'), { force: true });
        await lock.release();
      }
    });
}

export async function loadInboxConfig(path: string): Promise<InboxConfig> {
  const config = { ...DEFAULT_INBOX_CONFIG, ...JSON.parse(await readFile(path, 'utf8')) } as InboxConfig;
  if (!Number.isInteger(config.intervalMs) || config.intervalMs < 1000 || !Number.isFinite(config.overlapMs) || config.overlapMs < 0 ||
      !Number.isFinite(config.messageLookbackMs) || config.messageLookbackMs < 0 ||
      !Number.isInteger(config.agentTimeoutMs) || config.agentTimeoutMs < 1000 ||
      config.maxConcurrentRuns !== 1 || !Array.isArray(config.sources) || !config.sources.length ||
      new Set(config.sources).size !== config.sources.length || config.sources.some((source) => !['p2p', 'mention', 'defect'].includes(source)) ||
      !Array.isArray(config.defectTypeKeys) || config.defectTypeKeys.some((key) => typeof key !== 'string') ||
      !Array.isArray(config.routes) || config.routes.some((route) => !route.id || !route.cwd || !route.name) ||
      new Set(config.routes.map((route) => route.id)).size !== config.routes.length ||
      typeof config.codexBinary !== 'string' || typeof config.discoverSessions !== 'boolean' ||
      (config.codexModel !== undefined && (typeof config.codexModel !== 'string' || !config.codexModel.trim())) ||
      !Number.isInteger(config.maxSessionCandidates) || config.maxSessionCandidates < 1 || config.maxSessionCandidates > 100) {
    throw new Error('收件箱配置无效；当前版本支持一个 AI 任务并发');
  }
  return config;
}
