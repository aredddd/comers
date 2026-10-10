import { createHash } from 'node:crypto';
import { data, record, runJsonCli, text, InboxCliError, type JsonCli } from './cli-client';
import type { InboxConfig, InboxEvent, SourceCheckpoint, SourceKind } from './types';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function searchTime(ms: number): string {
  // The shortcut rejects fractional-second timestamps.
  return new Date(ms + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}
export interface PollResult { events: InboxEvent[]; checkpoint: SourceCheckpoint }
export class InboxSources {
  private selfId = '';
  private readonly linkKeys = new Map<string, string>();
  constructor(private readonly config: InboxConfig, private readonly cli: JsonCli = runJsonCli) {}

  async preflight(): Promise<void> {
    if (this.config.sources.some((source) => source !== 'defect')) {
      const status = record(await this.cli('lark-cli', ['auth', 'status', '--json', '--verify']));
      const user = record(record(status.identities).user);
      this.selfId = text(user.openId);
      if (!this.selfId || user.available === false) throw new InboxCliError('auth', '飞书用户身份不可用，请通过 lark-cli 授权');
    }
    if (this.config.sources.includes('defect')) {
      const status = record(await this.cli('meegle', ['auth', 'status', '--format', 'json']));
      if (status.authenticated !== true) throw new InboxCliError('auth', 'Meegle 尚未登录，请执行 meegle auth login');
    }
  }

  async poll(source: SourceKind, previous: SourceCheckpoint | undefined, now: number): Promise<PollResult> {
    return source === 'defect' ? this.defects(previous, now) : this.messages(source, previous, now);
  }

  private async messages(source: 'p2p' | 'mention', previous: SourceCheckpoint | undefined, now: number): Promise<PollResult> {
    const start = previous ? previous.cursor - this.config.overlapMs : now - this.config.messageLookbackMs;
    const versions = { ...previous?.versions }; const events: InboxEvent[] = [];
    let token = ''; const tokens = new Set<string>(); let complete = false;
    for (let page = 0; page < 100; page++) {
      const args = ['im', '+messages-search', '--as', 'user', '--query', '',
        '--chat-type', source === 'p2p' ? 'p2p' : 'group', '--sender-type', 'user',
        '--start', searchTime(start), '--end', searchTime(now), '--page-size', '50', '--no-reactions', '--json',
        ...(source === 'mention' ? ['--is-at-me'] : []), ...(token ? ['--page-token', token] : [])];
      const response = data(await this.cli('lark-cli', args));
      if (!Array.isArray(response.messages)) throw new InboxCliError('incomplete', '消息列表结构变化，未推进游标');
      for (const raw of response.messages) {
        const row = record(raw); const sender = record(row.sender);
        if (text(sender.id) === this.selfId || sender.sender_type !== 'user') continue;
        const id = text(row.message_id); const chatId = text(row.chat_id);
        if (!id || !chatId) throw new InboxCliError('incomplete', '消息缺少标识，未推进游标');
        const body = row.deleted === true ? '原消息已撤回，请忽略该消息并撤销旧回复草稿。'
          : typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? {});
        const version = fingerprint([body, row.update_time, row.updated]);
        const key = (this.config.sources.includes('defect') ? await this.defectLinkKey(body) : undefined)
          ?? `message:${chatId}:${text(row.thread_id || row.root_id || id)}`;
        versions[id] = version;
        events.push({ id, key, version, source, messageId: id, chatId, text: body,
          title: source === 'p2p' ? '私聊待处理' : '群聊 @ 待处理',
          url: text(row.message_app_link) || undefined, observedAt: now });
      }
      if (response.has_more === false) { complete = true; break; }
      token = text(response.page_token);
      if (!token || tokens.has(token)) break;
      tokens.add(token);
    }
    if (!complete) throw new InboxCliError('incomplete', '消息分页未完整读完，未推进游标');
    // IDs within the overlap window retain versions; older messages cannot be
    // returned by the next successful query. Persist unfinished items separately.
    const retained = Object.fromEntries(events.map((event) => [event.id, versions[event.id]!]));
    return { events, checkpoint: { cursor: now, baseline: true, versions: retained } };
  }

  private async defectLinkKey(body: string): Promise<string | undefined> {
    const links = body.match(/https:\/\/(?:project\.feishu\.cn|meegle\.com)\/[^\s"<>\\]+/g) ?? [];
    // Only one verified work item gives a safe automatic grouping key.
    const keys = new Set<string>();
    for (const url of [...new Set(links)].slice(0, 3)) {
      if (this.linkKeys.has(url)) { keys.add(this.linkKeys.get(url)!); continue; }
      const decoded = data(await this.cli('meegle', ['url', 'decode', '--url', url, '--format', 'json']));
      if (decoded.url_kind !== 'workitem_detail' || !decoded.work_item_id || !decoded.simple_name) continue;
      const resolved = data(await this.cli('meegle', ['project', 'search', '--project-key', text(decoded.simple_name), '--format', 'json']));
      const matches = Array.isArray(resolved.projects) ? resolved.projects : Array.isArray(resolved.list) ? resolved.list : [resolved];
      if (matches.length !== 1) continue;
      const projectKey = text(record(matches[0]).project_key);
      if (!projectKey) continue;
      const key = `defect:${projectKey}:${text(decoded.work_item_id)}`;
      this.linkKeys.set(url, key); keys.add(key);
    }
    return keys.size === 1 ? [...keys][0] : undefined;
  }

  private async defects(previous: SourceCheckpoint | undefined, now: number): Promise<PollResult> {
    const candidates = new Map<string, InboxEvent>();
    let count = 0; let complete = false; let total = -1;
    for (let page = 1; page <= 100; page++) {
      const response = data(await this.cli('meegle', ['mywork', 'todo', '--action', 'todo', '--todo-scope', 'all', '--page-num', String(page), '--format', 'json']));
      if (!Array.isArray(response.list) || !Number.isFinite(Number(response.total))) throw new InboxCliError('incomplete', 'Meegle 待办结构变化');
      if (total !== -1 && total !== Number(response.total)) throw new InboxCliError('incomplete', '分页期间待办数量变化，下轮重查');
      total = Number(response.total); count += response.list.length;
      for (const raw of response.list) {
        const row = record(raw); const info = record(row.work_item_info);
        if (!this.config.defectTypeKeys.includes(text(info.work_item_type_key))) continue;
        const projectKey = text(row.project_key); const workItemId = text(info.work_item_id);
        if (!projectKey || !workItemId) throw new InboxCliError('incomplete', '缺陷缺少标识');
        const key = `defect:${projectKey}:${workItemId}`;
        candidates.set(key, { id: key, key, version: '', source: 'defect', text: '',
          title: text(info.work_item_name) || '缺陷待处理', projectKey, workItemId, workItemType: text(info.work_item_type_key), observedAt: now });
      }
      if (count >= total) { complete = true; break; }
      if (response.list.length === 0) break;
    }
    if (!complete) throw new InboxCliError('incomplete', 'Meegle 分页未完整读完');
    // Keep monitoring a defect after its todo disappears (e.g. reassigned or
    // moved to QA); a todo-only scanner would miss its comments and closure.
    for (const event of previous?.watched ?? []) {
      if (!candidates.has(event.key)) candidates.set(event.key, event);
    }
    const events: InboxEvent[] = [];
    const entries = [...candidates.values()];
    // Bound API concurrency without silently dropping the rest of the scan.
    for (let index = 0; index < entries.length; index += 3) {
      const batch = await Promise.all(entries.slice(index, index + 3).map(async (event) => {
        const detail = data(await this.cli('meegle', ['workitem', 'get', '--project-key', event.projectKey!, '--work-item-id', event.workItemId!, '--format', 'json']));
        if (!detail.work_item_attribute || !Array.isArray(detail.work_item_fields)) throw new InboxCliError('incomplete', '缺陷详情不完整');
        const comments: unknown[] = []; let allComments = false;
        for (let page = 1; page <= 100; page++) {
          const response = data(await this.cli('meegle', ['comment', 'list', '--project-key', event.projectKey!, '--work-item-id', event.workItemId!, '--page-num', String(page), '--format', 'json']));
          if (!Array.isArray(response.comments)) throw new InboxCliError('incomplete', '缺陷评论不完整');
          comments.push(...response.comments);
          const pagination = record(response.pagination);
          if (page >= Number(pagination.total_pages) || comments.length >= Number(pagination.total)) { allComments = true; break; }
          if (!response.comments.length) break;
        }
        if (!allComments) throw new InboxCliError('incomplete', '缺陷评论分页未完整读完');
        const attribute = record(detail.work_item_attribute);
        // Exclude read-time metadata; only business content determines a change.
        const content = { name: attribute.work_item_name, status: attribute.work_item_status,
          roles: attribute.role_members, fields: detail.work_item_fields, comments };
        return { ...event, version: fingerprint(content), text: JSON.stringify(content), observedAt: now };
      }));
      events.push(...batch);
    }
    return { events, checkpoint: { baseline: true, cursor: now,
      versions: Object.fromEntries(events.map((event) => [event.id, event.version])),
      watched: events.map(({ text: _text, ...event }) => ({ ...event, text: '' })) } };
  }
}
