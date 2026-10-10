import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, codeSnapshot, ensureCodeWorkspace, cleanupReleasedWorktrees } from '../../../src/inbox/workspace';
import type { InboxItem } from '../../../src/inbox/types';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-git-')); dirs.push(dir);
  const primary = join(dir, 'repo'); await mkdir(primary);
  await git(primary, ['init', '-b', 'main']);
  await git(primary, ['config', 'user.name', '测试']); await git(primary, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(primary, 'file.txt'), 'initial\n'); await git(primary, ['add', 'file.txt']); await git(primary, ['commit', '-m', '初始提交']);
  return { dir, primary, stateDir: join(dir, 'state') };
}
describe('isolated review workspaces', () => {
  it('同一事项复用工作区，并保留主 checkout 的脏改动', async () => {
    const { primary, stateDir } = await repo(); await writeFile(join(primary, 'file.txt'), 'user change\n');
    const workspace = await ensureCodeWorkspace(primary, stateDir, 'item-one');
    expect(await ensureCodeWorkspace(primary, stateDir, 'item-one')).toBe(workspace);
    expect(await git(primary, ['diff'])).toContain('user change');
    expect(await git(workspace, ['status', '--porcelain'])).toBe('');
  });
  it('达到 5 个 linked worktree 时禁止创建第 6 个', async () => {
    const { dir, primary, stateDir } = await repo();
    for (let i = 0; i < 5; i++) await git(primary, ['worktree', 'add', '--detach', join(dir, `existing-${i}`)]);
    await expect(ensureCodeWorkspace(primary, stateDir, 'overflow')).rejects.toThrow('5 个 linked worktree');
    expect((await git(primary, ['worktree', 'list', '--porcelain'])).match(/worktree /g)).toHaveLength(6);
  });
  it('代码指纹同时覆盖已跟踪修改与新增文件', async () => {
    const { primary } = await repo(); const before = await codeSnapshot(primary);
    await writeFile(join(primary, 'new.txt'), 'new\n'); const added = await codeSnapshot(primary);
    expect(added.fingerprint).not.toBe(before.fingerprint); expect(added.diff).toContain('new.txt');
    await writeFile(join(primary, 'file.txt'), 'changed\n'); expect((await codeSnapshot(primary)).fingerprint).not.toBe(added.fingerprint);
  });
  it('拒绝复用来自其他仓库的工作区', async () => {
    const one = await repo(); const two = await repo();
    await expect(ensureCodeWorkspace(one.primary, one.stateDir, 'item', two.primary)).rejects.toThrow('不匹配');
  });
  it('确认已进入远端主干的干净自有工作区会回收，其他工作区保留', async () => {
    const { dir, primary, stateDir } = await repo(); const remote = join(dir, 'remote'); await mkdir(remote);
    await git(remote, ['init', '--bare']); await git(primary, ['remote', 'add', 'origin', remote]);
    await git(primary, ['push', '-u', 'origin', 'main']); await git(primary, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const id = 'released-item'; const worktree = await ensureCodeWorkspace(primary, stateDir, id);
    await writeFile(join(worktree, 'file.txt'), 'fixed\n'); await git(worktree, ['add', '-A']); await git(worktree, ['commit', '-m', '修复']);
    await git(primary, ['merge', '--ff-only', `codex/inbox-${id.slice(0, 12)}`]); await git(primary, ['push', 'origin', 'main']);
    const item: InboxItem = { id, key: 'k', status: 'review', title: '修复', revision: 1, events: [], updatedAt: 1, worktree,
      artifacts: [{ id: 'a', kind: 'code', title: '修复', body: '结果', status: 'sent', receipt: 'https://example.invalid/pull/1' }] };
    expect(await cleanupReleasedWorktrees([item], stateDir)).toEqual([id]);
    expect((await git(primary, ['worktree', 'list', '--porcelain'])).match(/worktree /g)).toHaveLength(1);
  });
  it('dirty 或 active 工作区即使存在已发布 MR 也不会回收', async () => {
    const { primary, stateDir } = await repo(); const id = 'dirty-item'; const worktree = await ensureCodeWorkspace(primary, stateDir, id);
    const item: InboxItem = { id, key: 'k', status: 'running', title: '修复', revision: 1, events: [], updatedAt: 1, worktree,
      artifacts: [{ id: 'a', kind: 'code', title: '修复', body: '结果', status: 'sent', receipt: 'https://example.invalid/pull/1' }] };
    expect(await cleanupReleasedWorktrees([item], stateDir)).toEqual([]);
    await writeFile(join(worktree, 'file.txt'), 'unfinished\n'); item.status = 'review';
    expect(await cleanupReleasedWorktrees([item], stateDir)).toEqual([]);
    expect(await git(worktree, ['status', '--porcelain'])).toContain('file.txt');
  });
});
