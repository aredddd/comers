import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStore } from '../../../src/inbox/store';
import { InboxSources, searchTime } from '../../../src/inbox/sources';
import { InboxReview, mergeRequestRepository } from '../../../src/inbox/review';
import { InboxEngine } from '../../../src/inbox/engine';
import { InboxCliError, type JsonCli } from '../../../src/inbox/cli-client';
import { DEFAULT_INBOX_CONFIG, type InboxEvent, type InboxItem, type InboxConfig } from '../../../src/inbox/types';
import type { InboxAgent } from '../../../src/inbox/agent';
import * as history from '../../../src/session/codex-history';
import { CodexInboxAgent } from '../../../src/inbox/agent';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { startInboxServer } from '../../../src/inbox/server';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'comers-inbox-')); dirs.push(dir); return { dir, store: new InboxStore(join(dir, 'state.json')) }; }
function event(version = 'v1', source: InboxEvent['source'] = 'p2p'): InboxEvent {
  return { id: 'event-1', key: 'message:c:m', version, source, text: '请分析这个问题', title: '待处理', observedAt: 1000, messageId: 'om_test', chatId: 'oc_test' };
}
async function ingest(store: InboxStore, e = event()) { await store.ingest(e.source, [e], { cursor: 1000, baseline: true, versions: { [e.id]: e.version } }); }
async function reviewable(store: InboxStore) {
  await ingest(store); await store.update((state) => {
    const item = state.items[0]!; item.status = 'review'; item.artifacts = [{ id: 'reply-1', kind: 'reply', title: '回复', body: '已定位原因', status: 'pending', targetEventId: 'event-1' }];
  });
  return store.snapshot().items[0]!;
}
describe('inbox durability and review gates', () => {
  it('草稿 MR 显式绑定 origin，fork 仓库不受 CLI 的 upstream 默认值影响', () => {
    expect(mergeRequestRepository('https://github.com/owner/fork.git')).toEqual({ host: 'github.com', isGithub: true, repository: 'owner/fork' });
    expect(mergeRequestRepository('git@git.example.com:group/subgroup/repo.git')).toEqual({ host: 'git.example.com', isGithub: false, repository: 'https://git.example.com/group/subgroup/repo' });
    expect(mergeRequestRepository('ssh://git@git.example.com/group/repo.git').repository).toBe('https://git.example.com/group/repo');
    expect(() => mergeRequestRepository('/local/repo')).toThrow('无法确认');
  });
  it('去重与游标在同一个可恢复快照中保存', async () => {
    const { store } = await fixture(); await ingest(store); await ingest(store);
    expect(store.snapshot().items).toHaveLength(1);
    const reloaded = new InboxStore(store.path); await reloaded.load();
    expect(reloaded.snapshot().items[0]!.events).toHaveLength(1);
    expect(reloaded.snapshot().sources.p2p!.cursor).toBe(1000);
  });
  it('写盘失败不会发布候选状态，也不会污染下一次保存', async () => {
    const { dir } = await fixture(); let fail = true;
    const store = new InboxStore(join(dir, 'state.json'), async () => { if (fail) throw Error('disk full'); });
    await expect(ingest(store)).rejects.toThrow('disk full');
    expect(store.snapshot().items).toHaveLength(0); expect(store.snapshot().sources.p2p).toBeUndefined();
    fail = false; await ingest(store, event('v2'));
    expect(store.snapshot().items[0]!.events[0]!.version).toBe('v2');
  });
  it('首次缺陷扫描仅建立基线，后续变化才排队', async () => {
    const { store } = await fixture(); await ingest(store, event('v1', 'defect'));
    expect(store.snapshot().items).toHaveLength(0);
    await ingest(store, event('v2', 'defect')); expect(store.snapshot().items).toHaveLength(1);
  });
  it('新变化撤销旧草稿和批准', async () => {
    const { store, dir } = await fixture(); const item = await reviewable(store);
    const review = new InboxReview(store, dir); await review.update({ itemId: item.id, artifactId: 'reply-1', revision: item.revision }, 'approve');
    await ingest(store, event('v2'));
    expect(store.snapshot().items[0]!.status).toBe('queued'); expect(store.snapshot().items[0]!.artifacts).toHaveLength(0);
  });
  it('未批准与过期审阅不能触发外发，批准后仅发送实际来源', async () => {
    const { store, dir } = await fixture(); const item = await reviewable(store); const cli = vi.fn<JsonCli>().mockResolvedValue({ data: { message_id: 'receipt' } });
    const review = new InboxReview(store, dir, cli); const input = { itemId: item.id, artifactId: 'reply-1', revision: item.revision };
    await expect(review.send(input)).rejects.toThrow('先审阅'); expect(cli).not.toHaveBeenCalled();
    await review.update(input, 'approve'); await expect(review.send(input)).rejects.toThrow('已更新');
    await review.send({ ...input, revision: store.snapshot().items[0]!.revision });
    expect(cli.mock.calls[0]![1]).toContain('om_test'); expect(cli.mock.calls[0]![1]).toContain('--idempotency-key');
    expect(store.snapshot().items[0]!.artifacts[0]!.status).toBe('sent');
  });
  it('同时点击发送只能领取一次', async () => {
    const { store, dir } = await fixture(); const item = await reviewable(store); const cli = vi.fn<JsonCli>().mockResolvedValue({ message_id: 'receipt' });
    const review = new InboxReview(store, dir, cli); await review.update({ itemId: item.id, artifactId: 'reply-1', revision: item.revision }, 'approve');
    const input = { itemId: item.id, artifactId: 'reply-1', revision: store.snapshot().items[0]!.revision };
    const outcomes = await Promise.allSettled([review.send(input), review.send(input)]);
    expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1); expect(cli).toHaveBeenCalledTimes(1);
  });
  it('发送超时与重启中的发送均保留未知结果，不自动重发', async () => {
    const { store, dir } = await fixture(); const item = await reviewable(store); const cli = vi.fn<JsonCli>().mockRejectedValue(Error('timeout'));
    const review = new InboxReview(store, dir, cli); await review.update({ itemId: item.id, artifactId: 'reply-1', revision: item.revision }, 'approve');
    await expect(review.send({ itemId: item.id, artifactId: 'reply-1', revision: store.snapshot().items[0]!.revision })).rejects.toThrow('待核实');
    expect(store.snapshot().items[0]!.artifacts[0]!.status).toBe('send_unknown');
    await store.update((state) => { state.items[0]!.status = 'running'; state.items[0]!.artifacts[0]!.status = 'sending'; });
    await store.recover(); expect(store.snapshot().items[0]!.status).toBe('interrupted'); expect(store.snapshot().items[0]!.artifacts[0]!.status).toBe('send_unknown');
  });
  it('并发采集不会丢掉正在发送的收据', async () => {
    const { store, dir } = await fixture(); const item = await reviewable(store); let done!: (value: unknown) => void;
    const cli: JsonCli = () => new Promise((resolve) => { done = resolve; }); const review = new InboxReview(store, dir, cli);
    await review.update({ itemId: item.id, artifactId: 'reply-1', revision: item.revision }, 'approve');
    const sending = review.send({ itemId: item.id, artifactId: 'reply-1', revision: store.snapshot().items[0]!.revision });
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    await ingest(store, event('v2')); done({ message_id: 'receipt' }); await sending;
    expect(store.snapshot().items[0]!.status).toBe('queued'); expect(store.snapshot().items[0]!.artifacts[0]!.receipt).toBe('receipt');
  });
});
describe('source pagination and content changes', () => {
  it('消息分页完整读取，过滤本人和 bot，群 @ 保留过滤标志', async () => {
    const cli = vi.fn<JsonCli>().mockImplementation(async (_binary, args) => {
      if (args[0] === 'auth') return { identities: { user: { openId: 'self', available: true } } };
      const msg = (id: string, sender = 'other', type = 'user') => ({ message_id: id, chat_id: 'chat', sender: { id: sender, sender_type: type }, content: '请帮忙' });
      return args.includes('--page-token') ? { data: { messages: [msg('b')], has_more: false } }
        : { data: { messages: [msg('a'), msg('own', 'self'), msg('bot', 'bot', 'bot')], has_more: true, page_token: 'next' } };
    });
    const sources = new InboxSources({ ...DEFAULT_INBOX_CONFIG, sources: ['mention'] }, cli); await sources.preflight();
    const result = await sources.poll('mention', undefined, 1700000000000);
    expect(result.events.map((row) => row.id)).toEqual(['a', 'b']);
    expect(cli.mock.calls[1]![1]).toContain('--is-at-me'); expect(cli.mock.calls[2]![1]).toContain('--page-token');
    expect(searchTime(1700000000001)).not.toContain('.001');
  });
  it('分页中断不产生可提交的游标', async () => {
    const cli = vi.fn<JsonCli>().mockResolvedValue({ data: { messages: [], has_more: true } });
    await expect(new InboxSources(DEFAULT_INBOX_CONFIG, cli).poll('p2p', undefined, 1000)).rejects.toThrow('未完整');
  });
  it('评论变化能触发事件，待办消失后仍跟踪', async () => {
    let comment = '初始'; let todo = true;
    const cli: JsonCli = async (_binary, args) => {
      if (args[0] === 'mywork') return { list: todo ? [{ project_key: 'project', work_item_info: { work_item_id: '10', work_item_type_key: 'issue', work_item_name: '缺陷' } }] : [], total: todo ? 1 : 0 };
      if (args[0] === 'workitem') return { work_item_attribute: { work_item_status: 'active', work_item_name: '缺陷' }, work_item_fields: [{ key: 'description', value: '问题' }] };
      return { comments: [{ comment_id: 'c', content: comment }], pagination: { total_pages: 1, total: 1 } };
    };
    const sources = new InboxSources(DEFAULT_INBOX_CONFIG, cli); const first = await sources.poll('defect', undefined, 1000);
    comment = '新增信息'; todo = false; const second = await sources.poll('defect', first.checkpoint, 2000);
    expect(second.events).toHaveLength(1); expect(second.events[0]!.version).not.toBe(first.events[0]!.version);
  });
  it('空评论列表也能完成基线，非缺陷待办不触发详情查询', async () => {
    const cli = vi.fn<JsonCli>().mockResolvedValue({ list: [{ project_key: 'p', work_item_info: { work_item_id: '1', work_item_type_key: 'story' } }], total: 1 });
    const result = await new InboxSources(DEFAULT_INBOX_CONFIG, cli).poll('defect', undefined, 1000);
    expect(result.events).toHaveLength(0); expect(cli).toHaveBeenCalledTimes(1);
  });
});
describe('AI work flow', () => {
  function agent(prepare?: InboxAgent['prepare']): InboxAgent {
    return { routes: async () => [], classify: async () => ({ action: 'reply', title: '答复', reason: '需要回应' }),
      prepare: prepare ?? (async () => ({ sessionId: 'new-session', artifacts: [{ id: 'a', kind: 'analysis', title: '分析', body: '结果', status: 'pending' }] })), close: async () => {} };
  }
  it('空轮询不启动 AI，限流按来源退避且保持游标', async () => {
    const { store, dir } = await fixture(); const sources = new InboxSources(DEFAULT_INBOX_CONFIG, async () => { throw new InboxCliError('rate_limit', '接口限流'); });
    const worker = agent(); const spy = vi.spyOn(worker, 'classify'); const engine = new InboxEngine(store, sources, worker, DEFAULT_INBOX_CONFIG, dir);
    await engine.pollOnce(1000); await engine.workOnce(); expect(spy).not.toHaveBeenCalled();
    expect(store.snapshot().sources.p2p).toBeUndefined(); expect(store.snapshot().health.p2p!.nextPollAt).toBeGreaterThan(1000);
  });
  it('执行期间的新信息使结果失效，重新排队', async () => {
    const { store, dir } = await fixture(); await ingest(store);
    const worker = agent(async () => { await ingest(store, event('v2')); return { artifacts: [{ id: 'a', kind: 'analysis', title: '过时分析', body: '旧结果', status: 'pending' }] }; });
    const engine = new InboxEngine(store, new InboxSources(DEFAULT_INBOX_CONFIG), worker, DEFAULT_INBOX_CONFIG, dir);
    await engine.workOnce(); expect(store.snapshot().items[0]!.status).toBe('queued'); expect(store.snapshot().items[0]!.artifacts).toHaveLength(0);
  });
  it('合并同一事项后，后续事件仍定位到归并目标', async () => {
    const { store, dir } = await fixture(); await ingest(store); await ingest(store, { ...event(), id: 'second', key: 'message:c:second' });
    const items = store.snapshot().items; const worker = agent(); worker.classify = async () => ({ action: 'reply', title: '同一问题', reason: '明确关联', relatedItemId: items[1]!.id });
    const config: InboxConfig = { ...DEFAULT_INBOX_CONFIG, maxConcurrentRuns: 1 };
    await new InboxEngine(store, new InboxSources(config), worker, config, dir).workOnce();
    await ingest(store, event('v2'));
    const target = store.snapshot().items.find((row) => row.id === items[1]!.id)!;
    expect(target.events).toHaveLength(2); expect(target.events.find((row) => row.id === 'event-1')!.version).toBe('v2');
  });
  it('分类、文字与代码处理及重启复用一个会话，项目目录稳定且每轮重新读取关联上下文', async () => {
    const { dir } = await fixture(); const project = join(dir, 'project');
    const classifier = [{ type: 'system', threadId: 'shared-thread' }, { type: 'final_text', content: JSON.stringify({ action: 'reply', title: '回复', reason: '需要回复' }) }, { type: 'done', terminationReason: 'normal', threadId: 'shared-thread' }] as const;
    const preparation = [{ type: 'system', threadId: 'shared-thread' }, { type: 'final_text', content: JSON.stringify({ artifacts: [{ kind: 'reply', title: '回复', body: '建议回复', targetEventId: 'event-1' }] }) }, { type: 'done', terminationReason: 'normal', threadId: 'shared-thread' }] as const;
    const fake = new FakeAgentAdapter({ events: [classifier, preparation, preparation] });
    const config = { ...DEFAULT_INBOX_CONFIG, codexModel: 'verified-account-model', sessionProjectDir: project, sessionPoolSize: 1, maxConcurrentRuns: 1 };
    const worker = new CodexInboxAgent(config, dir, fake);
    const item: InboxItem = { id: 'item', key: 'key', revision: 1, status: 'running', title: '问题', events: [event()], artifacts: [], updatedAt: 1 };
    const reader = vi.spyOn(history, 'readCodexThreadDetail').mockResolvedValue({ threadId: 'original-thread', turns: [{ userText: '上下文版本一', assistantText: '只读资料', status: 'completed' }] } as history.CodexThreadDetail);
    await worker.classify(item, [], []);
    const route = { id: 'route', name: '仓库', cwd: '/original', sourceSessionId: 'original-thread' };
    const result = await worker.prepare(item, route, '/isolated-worktree', { action: 'reply', title: '问题', reason: '答复' }, async () => {});
    reader.mockResolvedValue({ threadId: 'original-thread', turns: [{ userText: '上下文版本二', status: 'completed' }] } as history.CodexThreadDetail);
    const restarted = new CodexInboxAgent(config, dir, fake);
    await restarted.prepare({ ...item, id: 'another' }, route, '/another-worktree', { action: 'code', title: '修复', reason: '需修改' }, async () => {});
    expect(fake.runOptions[0]!.threadId).toBeUndefined();
    expect(fake.runOptions.slice(1).map((run) => run.threadId)).toEqual(['shared-thread', 'shared-thread']);
    expect(new Set(fake.runOptions.map((run) => run.cwd))).toEqual(new Set([project]));
    expect(new Set(fake.runOptions.map((run) => run.scopeId))).toEqual(new Set(['inbox:pool:0']));
    expect(fake.runOptions[1]!.writableRoots).toEqual([]);
    expect(fake.runOptions[2]!.writableRoots).toEqual(['/another-worktree']);
    expect(fake.runOptions[1]!.prompt).toContain('上下文版本一'); expect(fake.runOptions[2]!.prompt).toContain('上下文版本二');
    expect(reader).toHaveBeenCalledTimes(2); expect(fake.runOptions[0]!.model).toBe('verified-account-model');
    expect(result.sessionId).toBe('shared-thread'); expect(result.artifacts[0]!.status).toBe('pending');
    expect(JSON.parse(await readFile(join(dir, 'session-pool.json'), 'utf8'))).toEqual({ sessions: ['shared-thread'], projectDir: project });
  });
  it('固定会话恢复异常、ID 意外变化或目录变化时拒绝创建替代会话', async () => {
    const { dir } = await fixture(); const path = join(dir, 'processing-session.json');
    const fake = new FakeAgentAdapter({ events: [{ type: 'system', threadId: 'unexpected-thread' }] });
    await writeFile(path, JSON.stringify({ sessionId: 'shared-thread', projectDir: join(dir, 'workspace') }));
    const worker = new CodexInboxAgent(DEFAULT_INBOX_CONFIG, dir, fake);
    const item: InboxItem = { id: 'i', key: 'k', revision: 1, status: 'running', title: '问题', events: [event()], artifacts: [], updatedAt: 1 };
    await expect(worker.classify(item, [], [])).rejects.toThrow('池中会话 ID 意外变化');
    expect(fake.runOptions[0]!.threadId).toBe('shared-thread');
    await expect(new CodexInboxAgent({ ...DEFAULT_INBOX_CONFIG, sessionProjectDir: '/changed' }, dir, fake).routes()).rejects.toThrow('项目目录变化');
    await writeFile(join(dir, 'session-pool.json'), '{bad json');
    await expect(new CodexInboxAgent(DEFAULT_INBOX_CONFIG, dir, fake).classify(item, [], [])).rejects.toThrow();
    expect(fake.runOptions).toHaveLength(1);
  });
  it('读取源上下文期间停止处理器后，不再分配或启动新 turn', async () => {
    const { dir } = await fixture(); const fake = new FakeAgentAdapter();
    const worker = new CodexInboxAgent(DEFAULT_INBOX_CONFIG, dir, fake);
    let finish!: (value: history.CodexThreadDetail) => void;
    const read = vi.spyOn(history, 'readCodexThreadDetail').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const item: InboxItem = { id: 'i', key: 'k', revision: 1, status: 'running', title: '问题', events: [event()], artifacts: [], updatedAt: 1 };
    const task = worker.prepare(item, { id: 'r', name: '源会话', cwd: dir, sourceSessionId: 'source' }, dir, { action: 'reply', title: '问题', reason: '回复' }, async () => {});
    const rejected = expect(task).rejects.toThrow('已停止');
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await worker.close(); finish({ threadId: 'source', turns: [] } as unknown as history.CodexThreadDetail);
    await rejected; expect(fake.runOptions).toHaveLength(0);
  });
  it('本机审阅 API 拒绝无 token 访问，不渲染来源 HTML', async () => {
    const { store, dir } = await fixture(); await reviewable(store); const console = await startInboxServer(store, dir);
    try {
      const url = new URL(console.url); expect((await fetch(url.origin + '/api/state')).status).toBe(403);
      const response = await fetch(url.origin + '/api/state', { headers: { 'X-Inbox-Token': url.hash.slice(1) } });
      expect(response.status).toBe(200); expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(1);
      expect((await readFile(join(dir, 'console.json'), 'utf8')).includes(url.hash.slice(1))).toBe(true);
    } finally { await new Promise<void>((resolve) => console.server.close(() => resolve())); }
  });
});
