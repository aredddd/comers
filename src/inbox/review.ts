import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InboxStore } from './store';
import { data, record, runJsonCli, text, type JsonCli } from './cli-client';
import type { InboxArtifact, InboxEvent, InboxItem } from './types';
import { codeSnapshot, git } from './workspace';

const exec = promisify(execFile);
export interface ReviewInput { itemId: string; artifactId?: string; revision: number; body?: string }
export class InboxReview {
  constructor(private readonly store: InboxStore, private readonly stateDir: string,
    private readonly cli: JsonCli = runJsonCli) {}

  async update(input: ReviewInput, action: 'approve' | 'reject' | 'edit' | 'retry'): Promise<void> {
    await this.store.update((state) => {
      const item = state.items.find((row) => row.id === input.itemId);
      if (!item || item.revision !== input.revision) throw new Error('事项已更新，请重新审阅');
      if (action === 'retry') {
        if (!['failed', 'interrupted'].includes(item.status)) throw new Error('当前事项不能重试');
        item.status = 'queued'; item.error = undefined;
      } else {
        if (item.status !== 'review') throw new Error('事项尚未准备好或已有新变化');
        const artifact = item.artifacts.find((row) => row.id === input.artifactId);
        if (!artifact || !['pending', 'approved', 'rejected'].includes(artifact.status)) throw new Error('产物不可修改');
        if (action === 'edit') {
          if (!input.body?.trim()) throw new Error('草稿内容不能为空');
          artifact.body = input.body; artifact.status = 'pending';
        } else artifact.status = action === 'approve' ? 'approved' : 'rejected';
      }
      item.revision++;
    });
  }

  async send(input: ReviewInput): Promise<void> {
    const { artifact, target } = await this.claim(input, ['reply', 'defect_handoff']);
    try {
      const response = artifact.kind === 'reply'
        ? data(await this.cli('lark-cli', ['im', '+messages-reply', '--as', 'user', '--message-id', target!.messageId!,
          '--text', artifact.body, '--idempotency-key', artifact.id, '--json']))
        : data(await this.cli('meegle', ['comment', 'add', '--action', 'create', '--project-key', target!.projectKey!,
          '--work-item-id', target!.workItemId!, '--content', artifact.body, '--format', 'json']));
      await this.finish(input, 'sent', text(response.message_id || response.comment_id || record(response.message).message_id) || 'CLI 已确认成功');
    } catch {
      // A timeout after server acceptance cannot safely be treated as a failed
      // write. Meegle comments lack an idempotency key: never auto-resend.
      await this.finish(input, 'send_unknown', '发送结果待核实，请检查原消息或工单，系统不会自动重发');
      throw new Error('发送结果待核实，请检查来源后再处理');
    }
  }

  async publishDraftMr(input: ReviewInput): Promise<void> {
    const item = this.store.snapshot().items.find((row) => row.id === input.itemId);
    const artifact = item?.artifacts.find((row) => row.id === input.artifactId);
    if (!item?.worktree || artifact?.kind !== 'code') throw new Error('没有隔离代码工作区');
    const snapshot = await codeSnapshot(item.worktree);
    if (snapshot.fingerprint !== artifact.codeFingerprint) throw new Error('代码已变化，请重新生成并审阅');
    const remote = await git(item.worktree, ['remote', 'get-url', 'origin']);
    const host = remote.match(/^(?:https:\/\/|git@)([^/:]+)[/:]/)?.[1];
    if (!host) throw new Error('无法确认仓库远端');
    const isGithub = host === 'github.com';
    const binary = isGithub ? 'gh' : 'glab';
    // Verify auth and branch target before staging/pushing anything.
    try { await exec(binary, ['auth', 'status', ...(isGithub ? [] : ['--hostname', host])], { cwd: item.worktree, timeout: 20_000 }); }
    catch { throw new Error(`${binary} 尚未授权，请通过 CLI 登录后重试`); }
    const base = (await git(item.worktree, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).replace('refs/remotes/origin/', '');
    const branch = await git(item.worktree, ['branch', '--show-current']);
    if (!branch.startsWith('codex/inbox-')) throw new Error('代码分支不属于收件箱');
    await this.claim(input, ['code']);
    const bodyPath = join(this.stateDir, `mr-body-${artifact.id}.md`);
    try {
      // Check again after the durable review claim.
      if ((await codeSnapshot(item.worktree)).fingerprint !== artifact.codeFingerprint) throw new Error('代码在发布前发生变化');
      await git(item.worktree, ['add', '-A']);
      const staged = await git(item.worktree, ['diff', '--cached', '--name-only']);
      if (staged) await git(item.worktree, ['commit', '-m', artifact.title]);
      await git(item.worktree, ['push', '-u', 'origin', branch]);
      await writeFile(bodyPath, artifact.body, { mode: 0o600 });
      const existing = item.artifacts.find((row) => row.kind === 'code' && row.status === 'sent' && row.receipt?.startsWith('https://'))?.receipt;
      const args = existing
        ? isGithub ? ['pr', 'edit', existing, '--title', artifact.title, '--body-file', bodyPath]
          : ['mr', 'update', existing, '--title', artifact.title, '--description', artifact.body]
        : isGithub ? ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', artifact.title, '--body-file', bodyPath]
          : ['mr', 'create', '--draft', '--target-branch', base, '--source-branch', branch, '--title', artifact.title, '--description', artifact.body, '--yes'];
      const response = await exec(binary, args, { cwd: item.worktree, timeout: 60_000, maxBuffer: 128_000 });
      const url = existing ?? response.stdout.match(/https:\/\/[^\s]+\/(?:pull|merge_requests|(?:-\/merge_requests))\/\d+/)?.[0];
      if (!url) throw new Error('远端没有返回 MR 链接');
      await this.finish(input, 'sent', url);
    } catch {
      await this.finish(input, 'send_unknown', 'MR 发布结果待核实，请检查远端分支和 MR，系统不会自动重试');
      throw new Error('MR 发布结果待核实');
    } finally { await rm(bodyPath, { force: true }); }
  }

  private async claim(input: ReviewInput, kinds: InboxArtifact['kind'][]): Promise<{ item: InboxItem; artifact: InboxArtifact; target?: InboxEvent }> {
    return this.store.update((state) => {
      const item = state.items.find((row) => row.id === input.itemId);
      if (!item || item.revision !== input.revision || item.status !== 'review') throw new Error('事项已更新，请重新审阅');
      const artifact = item.artifacts.find((row) => row.id === input.artifactId);
      if (!artifact || artifact.status !== 'approved' || !kinds.includes(artifact.kind)) throw new Error('先审阅并通过这个产物');
      const target = item.events.find((event) => event.id === artifact.targetEventId);
      if (artifact.kind === 'reply' && !target?.messageId) throw new Error('回复目标无效');
      if (artifact.kind === 'defect_handoff' && (!target?.projectKey || !target.workItemId)) throw new Error('缺陷目标无效');
      artifact.status = 'sending'; item.revision++;
      return structuredClone({ item, artifact, target });
    });
  }
  private async finish(input: ReviewInput, status: 'sent' | 'send_unknown', receipt: string): Promise<void> {
    await this.store.update((state) => {
      const item = state.items.find((row) => row.id === input.itemId)!;
      const artifact = item.artifacts.find((row) => row.id === input.artifactId);
      if (!artifact) throw new Error('发送记录丢失，停止重试');
      artifact.status = status; artifact.receipt = receipt; item.revision++;
    });
  }
}
