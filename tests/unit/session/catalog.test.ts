import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fclaude\x1f/repo\x1ffp-1');
  });

  it('stores Claude sessions and Codex threads in isolated active entries', async () => {
    const catalog = new SessionCatalog(await path());

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      threadId: 'thread-1',
      now: 2000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-1', agentId: 'claude' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ threadId: 'thread-1', agentId: 'codex' });
    await catalog.flush();
  });

  it('keeps only one current task per scope and agent', async () => {
    const catalog = new SessionCatalog(await path());
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo-a',
      policyFingerprint: 'fp-a',
      threadId: 'thread-a',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo-b',
      policyFingerprint: 'fp-b',
      threadId: 'thread-b',
      now: 2000,
    });

    expect(catalog.activeFor({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo-a',
      policyFingerprint: 'fp-a',
    })).toBeUndefined();
    expect(catalog.activeFor({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo-b',
      policyFingerprint: 'fp-b',
    })).toMatchObject({ threadId: 'thread-b' });
    expect(catalog.entries().find((item) => item.threadId === 'thread-a')?.status).toBe('archived');
    await catalog.flush();
  });

  it('consolidates legacy scheduled scopes into one current task', async () => {
    const catalog = new SessionCatalog(await path());
    catalog.upsertActive({
      scopeId: 'chat-1:cron:job-a',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      threadId: 'thread-old',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1:cron:job-b',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      threadId: 'thread-new',
      now: 2000,
    });

    const selected = catalog.consolidateActiveScopes({
      agentId: 'codex',
      sourceScopeIds: ['chat-1:cron:job-a', 'chat-1:cron:job-b'],
      targetScopeId: 'chat-1:cron',
      now: 3000,
    });

    expect(selected).toMatchObject({
      scopeId: 'chat-1:cron',
      threadId: 'thread-new',
      status: 'active',
    });
    expect(catalog.activeFor({
      scopeId: 'chat-1:cron',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
    })).toMatchObject({ threadId: 'thread-new' });
    expect(catalog.entries().filter((entry) =>
      entry.status === 'active' && entry.scopeId.startsWith('chat-1:cron'),
    )).toHaveLength(1);
    expect(catalog.entries().find((entry) => entry.threadId === 'thread-old')?.status).toBe('archived');

    catalog.upsertActive({
      scopeId: 'chat-1:cron:job-a',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp',
      threadId: 'thread-straggler',
      now: 4000,
    });
    expect(catalog.consolidateActiveScopes({
      agentId: 'codex',
      sourceScopeIds: ['chat-1:cron:job-a'],
      targetScopeId: 'chat-1:cron',
      now: 5000,
    })).toMatchObject({ threadId: 'thread-new' });
    await catalog.flush();
  });

  it('reconciles legacy catalogs with multiple active tasks on load', async () => {
    const catalogPath = await path();
    await writeFile(
      catalogPath,
      `${JSON.stringify([
        codexEntry('chat-1', 'thread-old', 1000, '/repo-a', 'fp-a'),
        codexEntry('chat-1', 'thread-new', 2000, '/repo-b', 'fp-b'),
      ])}\n`,
      'utf8',
    );
    const catalog = new SessionCatalog(catalogPath);

    await catalog.load();
    await catalog.flush();

    expect(catalog.entries().find((item) => item.threadId === 'thread-old')?.status).toBe('archived');
    expect(catalog.entries().find((item) => item.threadId === 'thread-new')?.status).toBe('active');
  });

  it('rejects mismatched Claude/Codex identity fields and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        threadId: 'thread-wrong',
        now: 1000,
      }),
    ).toThrow(/Claude.*sessionId/i);
    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-wrong',
        now: 1000,
      }),
    ).toThrow(/Codex.*threadId/i);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-damaged',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('archives only the current agent/cwd/fingerprint entry for a new conversation', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({ ...base, agentId: 'claude', sessionId: 'sess-1', now: 1000 });
    catalog.upsertActive({ ...base, agentId: 'codex', threadId: 'thread-1', now: 1000 });

    expect(catalog.archiveActive({ ...base, agentId: 'claude', now: 2000 })).toBe(true);

    expect(catalog.activeFor({ ...base, agentId: 'claude' })).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-1',
    });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, 50_000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, 20_000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now: 100 * 24 * 60 * 60 * 1000,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.sessionId === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(20);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  sessionId: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'claude' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    sessionId,
    status: 'active' as const,
    updatedAt,
  };
}

function codexEntry(
  scopeId: string,
  threadId: string,
  updatedAt: number,
  cwdRealpath: string,
  policyFingerprint: string,
) {
  const identity = {
    scopeId,
    agentId: 'codex' as const,
    cwdRealpath,
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    threadId,
    status: 'active' as const,
    updatedAt,
  };
}
