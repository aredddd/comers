import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, readFile, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireHostLock } from '../runtime/host-lock';
import type { InboxItem } from './types';

const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await exec('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 4_000_000 })).stdout.trim(); }
  catch { throw new Error('Git 操作失败，请检查仓库状态、分支和授权'); }
}
export async function codeSnapshot(cwd: string): Promise<{ fingerprint: string; diff: string }> {
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const diff = await git(cwd, ['diff', 'HEAD', '--binary']);
  const files = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256').update(head).update(diff);
  const additions: string[] = [];
  for (const file of files) {
    const path = join(cwd, file); const stat = await lstat(path);
    if (stat.size > 2_000_000) throw new Error('未跟踪文件过大，请检查工作区后再审阅');
    const content = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
    hash.update(file).update(String(stat.mode)).update(content);
    additions.push(`新增文件：${file}\n${String(content).slice(0, 20_000)}`);
  }
  return { fingerprint: hash.digest('hex'), diff: [diff, ...additions].join('\n\n') };
}
export async function cleanupReleasedWorktrees(items: InboxItem[], stateDir: string): Promise<string[]> {
  const released: string[] = [];
  for (const item of items) {
    if (!item.worktree || !['review', 'ignored'].includes(item.status) ||
        !item.artifacts.some((artifact) => artifact.kind === 'code' && artifact.status === 'sent' && artifact.receipt?.startsWith('https://')) ||
        item.artifacts.some((artifact) => artifact.kind === 'code' && ['pending', 'approved', 'sending', 'send_unknown'].includes(artifact.status))) continue;
    let release: (() => Promise<void>) | undefined;
    try {
      const path = await realpath(item.worktree);
      if (!path.startsWith(`${join(await realpath(stateDir), 'worktrees')}/`)) continue;
      const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const lock = await acquireHostLock(join(common, 'comers-inbox-worktree-allocation'));
      if (!lock) continue;
      release = lock.release;
      if (await git(path, ['status', '--porcelain'])) continue; // dirty: never reclaim
      const branch = await git(path, ['branch', '--show-current']);
      if (branch !== `codex/inbox-${item.id.slice(0, 12)}`) continue;
      const base = (await git(path, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).replace('refs/remotes/origin/', '');
      if (!['main', 'master'].includes(base)) continue; // integrated/unknown: retain
      await git(path, ['fetch', '--quiet', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`]);
      await git(path, ['merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${base}`]);
      const listed = (await git(path, ['worktree', 'list', '--porcelain'])).split('\n').filter((line) => line.startsWith('worktree '));
      const primary = listed[0]?.slice(9);
      if (!primary || primary === path) continue;
      await git(primary, ['worktree', 'remove', path]);
      await git(primary, ['branch', '-d', branch]);
      released.push(item.id);
    } catch { /* blocked or not yet merged: retain the checkout and branch */ }
    finally { await release?.(); }
  }
  return released;
}
export async function ensureCodeWorkspace(cwd: string, stateDir: string, itemId: string, existing?: string): Promise<string> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lock = await acquireHostLock(join(common, 'comers-inbox-worktree-allocation'));
  if (!lock) throw new Error('仓库正在分配工作区，请稍后重试');
  try {
    if (existing) {
      if (await git(existing, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== common) throw new Error('已有工作区与路由仓库不匹配');
      return existing;
    }
    await mkdir(join(stateDir, 'worktrees'), { recursive: true, mode: 0o700 });
    const target = join(await realpath(join(stateDir, 'worktrees')), itemId);
    const worktrees = await git(cwd, ['worktree', 'list', '--porcelain']);
    const paths = worktrees.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    if (paths.includes(target)) return target;
    // Primary checkout is not a linked-worktree slot. Never remove unproven,
    // dirty, integrated or other agents' checkouts to make room.
    if (paths.length - 1 >= 5) throw new Error('仓库已有 5 个 linked worktree，需先安全回收已发布工作区');
    await git(cwd, ['worktree', 'add', '-b', `codex/inbox-${itemId.slice(0, 12)}`, target, 'HEAD']);
    return await realpath(target);
  } finally { await lock.release(); }
}
