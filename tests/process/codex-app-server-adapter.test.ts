import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('CodexAdapter app-server runtime', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('reuses one transport, streams rich events, resolves approval, steers, and refreshes delivery route', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const adapter = new CodexAdapter({
      binary: fake.binary,
      profileStateDir: fake.dir,
      runtime: 'app-server',
      sandbox: 'workspace-write',
    });

    const firstOptions = {
      runId: 'run-1',
      scopeId: 'chat-1',
      prompt: 'first prompt',
      cwd: fake.dir,
      audios: ['/tmp/voice.ogg'],
      deliveryContext: { chatId: 'oc_1', messageId: 'om_1', chatType: 'p2p' },
    } as const;
    await adapter.prepareRun(firstOptions);
    const first = adapter.run(firstOptions);
    const firstEvents: AgentEvent[] = [];
    for await (const event of first.events) {
      firstEvents.push(event);
      if (event.type === 'approval_request') {
        expect(await first.respondToRequest?.(event.request.id, 'accept')).toBe(true);
      }
    }

    expect(firstEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system', threadId: 'thread-shared' }),
      expect.objectContaining({ type: 'text', delta: '正在检查' }),
      expect.objectContaining({ type: 'approval_request' }),
      expect.objectContaining({ type: 'approval_resolved' }),
      expect.objectContaining({ type: 'final_text', content: '第一轮完成' }),
      expect.objectContaining({ type: 'done', terminationReason: 'normal' }),
    ]));

    const secondOptions = {
      ...firstOptions,
      runId: 'run-2',
      prompt: 'second prompt',
      threadId: 'thread-shared',
      deliveryContext: { chatId: 'oc_1', messageId: 'om_2', chatType: 'p2p' },
    } as const;
    await adapter.prepareRun(secondOptions);
    const second = adapter.run(secondOptions);
    const secondEvents: AgentEvent[] = [];
    for await (const event of second.events) {
      secondEvents.push(event);
      if (event.type === 'text') {
        await second.steer?.({
          text: '追加指示',
          clientUserMessageId: 'om_steer',
          images: ['/tmp/guide.png'],
          audios: ['/tmp/guide.ogg'],
        });
      }
    }
    expect(secondEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'final_text', content: '第二轮完成' }),
      expect.objectContaining({ type: 'done', terminationReason: 'normal' }),
    ]));
    expect(secondEvents).not.toContainEqual(
      expect.objectContaining({ type: 'final_text', content: '上一轮晚到消息' }),
    );
    expect(await second.waitForExit(20)).toBe(true);

    const records = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((record) => record.method === 'initialize')).toHaveLength(1);
    expect(records.filter((record) => record.method === 'thread/start')).toHaveLength(1);
    expect(records.filter((record) => record.method === 'thread/name/set')).toEqual([
      expect.objectContaining({
        params: { threadId: 'thread-shared', name: 'Comers · first prompt' },
      }),
    ]);
    expect(records.filter((record) => record.method === 'turn/start')).toHaveLength(2);
    const steerRecord = records.find((record) => record.method === 'turn/steer');
    expect(steerRecord?.params.clientUserMessageId).toBe('om_steer');
    expect(steerRecord?.params.input).toEqual(expect.arrayContaining([
      { type: 'text', text: '追加指示', text_elements: [] },
      { type: 'localImage', path: '/tmp/guide.png' },
      { type: 'localAudio', path: '/tmp/guide.ogg' },
    ]));
    expect(records.find((record) => record.method === 'turn/start')?.params.input).toContainEqual({
      type: 'localAudio',
      path: '/tmp/voice.ogg',
    });
    const routeRecord = records.find((record) => record.routeFile)?.routeFile as string;
    expect(JSON.parse(await readFile(routeRecord, 'utf8'))).toMatchObject({ messageId: 'om_2' });
    await adapter.close();
  });

  it('fixed inbox transport sends worktree write roots without changing project cwd', async () => {
    const fake = await createFakeAppServer(); cleanup.push(fake.dir);
    const adapter = new CodexAdapter({ binary: fake.binary, profileStateDir: fake.dir, runtime: 'app-server', requireAppServer: true });
    const options = { runId: 'code-run', scopeId: 'inbox:processing', prompt: 'code', cwd: fake.dir, sandbox: 'workspace-write', writableRoots: ['/isolated-worktree'] } as const;
    await adapter.prepareRun(options);
    const run = adapter.run(options);
    for await (const event of run.events) if (event.type === 'approval_request') await run.respondToRequest?.(event.request.id, 'accept');
    await adapter.close();
    const records = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.find((record) => record.method === 'turn/start')?.params).toMatchObject({ cwd: fake.dir, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/isolated-worktree'], networkAccess: false } });
  });
  it('fixed inbox refuses resume failure rather than falling back to exec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-resume-failure-')); cleanup.push(dir);
    const binary = join(dir, 'fake-codex.mjs');
    await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (!process.argv.includes('app-server')) { process.stdout.write('codex-cli 0.146.0\\n'); process.exit(0); }
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
  if (msg.method === 'thread/resume') process.stdout.write(JSON.stringify({id:msg.id,error:{code:-32000,message:'already has an active writer'}})+'\\n');
}`); await chmod(binary, 0o755);
    const adapter = new CodexAdapter({ binary, profileStateDir: dir, runtime: 'app-server', requireAppServer: true });
    await expect(adapter.prepareRun({ runId: 'r', scopeId: 'inbox:processing', cwd: dir, threadId: 'shared', prompt: 'retry' })).rejects.toThrow('active writer');
    await adapter.close();
  });

  it('preserves the name of a desktop task selected through resume', async () => {
    const fake = await createFakeAppServer({ resumeName: 'Desktop task' });
    cleanup.push(fake.dir);
    const adapter = new CodexAdapter({
      binary: fake.binary,
      profileStateDir: fake.dir,
      runtime: 'app-server',
      sandbox: 'workspace-write',
    });
    const options = {
      runId: 'run-resume',
      scopeId: 'chat-1',
      prompt: 'follow up',
      cwd: fake.dir,
      threadId: 'thread-shared',
    } as const;

    await adapter.prepareRun(options);
    await adapter.close();

    const records = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((record) => record.method === 'thread/resume')).toHaveLength(1);
    expect(records.filter((record) => record.method === 'thread/name/set')).toHaveLength(0);
  });

  it('preserves an unnamed external task selected through resume', async () => {
    const fake = await createFakeAppServer({ resumePreview: 'Desktop task preview' });
    cleanup.push(fake.dir);
    const adapter = new CodexAdapter({
      binary: fake.binary,
      profileStateDir: fake.dir,
      runtime: 'app-server',
      sandbox: 'workspace-write',
    });

    await adapter.prepareRun({
      runId: 'run-external-resume',
      scopeId: 'chat-1',
      prompt: 'follow up',
      cwd: fake.dir,
      threadId: 'thread-shared',
    });
    await adapter.close();

    const records = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((record) => record.method === 'thread/name/set')).toHaveLength(0);
  });

  it('repairs the raw title of a legacy Comers task selected through resume', async () => {
    const fake = await createFakeAppServer({ resumePreview: '<bridge_context>{}</bridge_context>' });
    cleanup.push(fake.dir);
    const adapter = new CodexAdapter({
      binary: fake.binary,
      profileStateDir: fake.dir,
      runtime: 'app-server',
      sandbox: 'workspace-write',
    });

    await adapter.prepareRun({
      runId: 'run-comers-resume',
      scopeId: 'chat-1',
      prompt: '继续排查会话',
      cwd: fake.dir,
      threadId: 'thread-shared',
    });
    await adapter.close();

    const records = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((record) => record.method === 'thread/name/set')).toEqual([
      expect.objectContaining({
        params: { threadId: 'thread-shared', name: 'Comers · 继续排查会话' },
      }),
    ]);
  });

  it('uses one generic title for the shared scheduled task', async () => {
    const fake = await createFakeAppServer({
      resumeName: 'Comers · [定时任务：旧任务] 检查状态',
      resumePreview: '<bridge_context>{}</bridge_context>',
    });
    cleanup.push(fake.dir);
    const adapter = new CodexAdapter({
      binary: fake.binary,
      profileStateDir: fake.dir,
      runtime: 'app-server',
      sandbox: 'workspace-write',
    });

    await adapter.prepareRun({
      runId: 'run-scheduled-resume',
      scopeId: 'chat-1:cron',
      prompt: '[定时任务：新任务]\n继续检查',
      cwd: fake.dir,
      threadId: 'thread-shared',
    });
    await adapter.close();

    const records = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records.filter((record) => record.method === 'thread/name/set')).toEqual([
      expect.objectContaining({
        params: { threadId: 'thread-shared', name: 'Comers · 定时任务' },
      }),
    ]);
  });
});

async function createFakeAppServer(
  options: { resumeName?: string; resumePreview?: string } = {},
): Promise<{ dir: string; binary: string; record: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-test-'));
  const binary = join(dir, 'fake-codex.mjs');
  const record = join(dir, 'requests.jsonl');
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = ${JSON.stringify(record)};
const resumeName = ${JSON.stringify(options.resumeName ?? null)};
const resumePreview = ${JSON.stringify(options.resumePreview ?? '')};
if (!process.argv.includes('app-server')) {
  process.stdout.write('codex-cli 0.146.0\\n');
  process.exit(0);
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
let activeTurn = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of rl) {
  const msg = JSON.parse(line);
  appendFileSync(record, JSON.stringify({ ...msg, routeFile: process.env.LARK_CHANNEL_ROUTE_FILE }) + '\\n');
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'thread/start') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-shared', name: null, preview: '' } } });
  else if (msg.method === 'thread/resume') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId, name: resumeName, preview: resumePreview } } });
  else if (msg.method === 'thread/name/set') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'turn/start') {
    turn++;
    activeTurn = 'turn-' + turn;
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: activeTurn, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: 'thread-shared', turn: { id: activeTurn, status: 'inProgress' } } });
    send({ method: 'item/started', params: { threadId: 'thread-shared', turnId: activeTurn, item: { type: 'agentMessage', id: 'comment-' + turn, text: '', phase: 'commentary' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-shared', turnId: activeTurn, itemId: 'comment-' + turn, delta: '正在检查' } });
    send({ method: 'item/completed', params: { threadId: 'thread-shared', turnId: activeTurn, item: { type: 'agentMessage', id: 'comment-' + turn, text: '正在检查', phase: 'commentary' } } });
    if (turn === 1) {
      send({ method: 'item/commandExecution/requestApproval', id: 90, params: { threadId: 'thread-shared', turnId: activeTurn, itemId: 'cmd-1', startedAtMs: Date.now(), command: 'echo ok', cwd: process.cwd() } });
    } else {
      setTimeout(() => finishTurn(turn, activeTurn), 20);
    }
  } else if (msg.id === 90 && msg.result) {
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-shared', requestId: 90 } });
    finishTurn(1, activeTurn);
  } else if (msg.method === 'turn/steer') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: activeTurn } });
  } else if (msg.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}
function finishTurn(number, turnId) {
  const final = number === 1 ? '第一轮完成' : '第二轮完成';
  send({ method: 'item/started', params: { threadId: 'thread-shared', turnId, item: { type: 'agentMessage', id: 'final-' + number, text: '', phase: 'final_answer' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-shared', turnId, itemId: 'final-' + number, delta: final } });
  send({ method: 'item/completed', params: { threadId: 'thread-shared', turnId, item: { type: 'agentMessage', id: 'final-' + number, text: final, phase: 'final_answer' } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-shared', turn: { id: turnId, status: 'completed' } } });
  if (number === 1) {
    send({ method: 'item/completed', params: { threadId: 'thread-shared', turnId, item: { type: 'agentMessage', id: 'late-1', text: '上一轮晚到消息', phase: 'final_answer' } } });
  }
}
`, 'utf8');
  await chmod(binary, 0o755);
  return { dir, binary, record };
}
