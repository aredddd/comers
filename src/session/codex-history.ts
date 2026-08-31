import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';
import { normalizeSessionPreview } from './preview';
import { CodexAppServerClient } from '../agent/codex/app-server-client';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export type CodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown';

export interface CodexThreadHistoryEntry {
  threadId: string;
  sessionId?: string;
  preview: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  recencyAtMs: number;
  source: string;
  name?: string;
  status: 'active' | 'idle' | 'systemError' | 'notLoaded' | 'unknown';
  isPinned: boolean;
  gitBranch?: string;
}

export interface ListCodexThreadHistoryOptions {
  binary: string;
  /** Omit to list Codex tasks across every workspace, like `codex resume --all`. */
  cwd?: string;
  limit: number;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
  sourceKinds?: readonly CodexThreadSourceKind[];
  useStateDbOnly?: boolean;
  searchTerm?: string;
  cursor?: string;
}

export interface CodexThreadHistoryPage {
  entries: CodexThreadHistoryEntry[];
  nextCursor?: string;
}

export interface CodexThreadTurnSummary {
  turnId: string;
  status: string;
  startedAtMs?: number;
  completedAtMs?: number;
  userText?: string;
  assistantText?: string;
  tools: string[];
}

export interface CodexThreadDetail extends CodexThreadHistoryEntry {
  turns: CodexThreadTurnSummary[];
}

export type CodexHistoryErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'app-server-error'
  | 'malformed-response';

export class CodexHistoryError extends Error {
  readonly code: CodexHistoryErrorCode;

  constructor(code: CodexHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexHistoryError';
    this.code = code;
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 5000;
const DEFAULT_SOURCE_KINDS: readonly CodexThreadSourceKind[] = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
];

export async function listCodexThreadHistory(
  options: ListCodexThreadHistoryOptions,
): Promise<CodexThreadHistoryPage> {
  const child = spawnCodexAppServer(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  const stderrChunks: Buffer[] = [];
  let settled = false;

  const result = await new Promise<CodexThreadHistoryPage>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listRequested = false;

    const fail = (err: unknown): void => {
      if (settled) return;
      reject(
        err instanceof CodexHistoryError
          ? err
          : new CodexHistoryError('spawn-failed', errorMessage(err)),
      );
      cleanup({ kill: true });
    };

    const cleanup = (options: { kill: boolean }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeListener('error', fail);
      child.stdin.removeListener('error', fail);
      child.stderr.removeAllListeners('data');
      if (options.kill && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };

    timer = setTimeout(() => {
      reject(new CodexHistoryError('timeout', `codex history query timed out after ${timeoutMs}ms`));
      cleanup({ kill: true });
    }, timeoutMs);

    child.once('error', fail);
    child.stdin.once('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const response = recordValue(msg);
      if (!response) return;
      if (response.id === 1) {
        if (response.error) {
          const err = recordValue(response.error);
          reject(
            new CodexHistoryError(
              'app-server-error',
              typeof err?.message === 'string' ? err.message : 'codex app-server rejected initialization',
            ),
          );
          cleanup({ kill: true });
          return;
        }
        if (!listRequested) {
          listRequested = true;
          try {
            child.stdin.write(
              `${JSON.stringify(initializedNotification())}\n${JSON.stringify(listRequest(options))}\n`,
              'utf8',
              (err?: Error | null) => {
                if (err) fail(err);
              },
            );
          } catch (err) {
            fail(err);
          }
        }
        return;
      }
      if (response.id !== 2) return;
      if (response.error) {
        const err = recordValue(response.error);
        reject(
          new CodexHistoryError(
            'app-server-error',
            typeof err?.message === 'string' ? err.message : 'codex app-server rejected history query',
          ),
        );
        cleanup({ kill: true });
        return;
      }
      const parsed = parseThreadListResponse(response.result);
      if (!parsed.ok) {
        reject(parsed.error);
        cleanup({ kill: true });
        return;
      }
      resolve(parsed.page);
      cleanup({ kill: true });
    });

    child.once('exit', (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(
        new CodexHistoryError(
          'spawn-failed',
          `codex app-server exited before history response: ${code ?? 'signal'}${stderr ? `: ${stderr}` : ''}`,
        ),
      );
      cleanup({ kill: true });
    });

    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}\n`,
        'utf8',
        (err?: Error | null) => {
          if (err) fail(err);
        },
      );
    } catch (err) {
      fail(err);
    }
  });

  await waitForChildExit(child, 250);
  return result;
}

export async function readCodexThreadDetail(
  options: Omit<ListCodexThreadHistoryOptions, 'limit'> & { threadId: string },
): Promise<CodexThreadDetail> {
  const result = await codexAppServerRequest(options, 'thread/read', {
    threadId: options.threadId,
    includeTurns: true,
  });
  const raw = recordValue(result);
  const thread = normalizeThread(raw?.thread);
  const threadRaw = recordValue(raw?.thread);
  if (!thread || !threadRaw) {
    throw new CodexHistoryError('malformed-response', 'codex app-server returned malformed thread/read response');
  }
  return {
    ...thread,
    turns: Array.isArray(threadRaw.turns)
      ? threadRaw.turns
          .map(normalizeTurn)
          .filter((turn): turn is CodexThreadTurnSummary => Boolean(turn))
      : [],
  };
}

export async function updateCodexThreadPinned(
  options: Omit<ListCodexThreadHistoryOptions, 'limit'> & { threadId: string; isPinned: boolean },
): Promise<void> {
  await codexAppServerRequest(options, 'thread/metadata/update', {
    threadId: options.threadId,
    isPinned: options.isPinned,
  });
}

export async function archiveCodexThread(
  options: Omit<ListCodexThreadHistoryOptions, 'limit'> & { threadId: string },
): Promise<void> {
  await codexAppServerRequest(options, 'thread/archive', { threadId: options.threadId });
}

async function codexAppServerRequest(
  options: Pick<
    ListCodexThreadHistoryOptions,
    'binary' | 'profileStateDir' | 'codexHome' | 'inheritCodexHome' | 'timeoutMs'
  >,
  method: string,
  params: unknown,
): Promise<unknown> {
  const env: NodeJS.ProcessEnv = {};
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  else if (options.inheritCodexHome === false) env.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  const client = new CodexAppServerClient({
    binary: options.binary,
    cwd: options.profileStateDir,
    env,
    clientName: 'comers-task-manager',
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  try {
    await withTimeout(client.connect(), timeoutMs, `codex ${method} connect timed out`);
    return await withTimeout(client.request(method, params), timeoutMs, `codex ${method} timed out`);
  } finally {
    await client.close(250).catch(() => undefined);
  }
}

function spawnCodexAppServer(options: ListCodexThreadHistoryOptions): CodexAppServerChild {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }

  return spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
}

function initializeRequest() {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'comers',
        title: 'Comers',
        version: '0.8.0',
      },
      capabilities: null,
    },
  };
}

function initializedNotification() {
  return {
    method: 'initialized',
    params: {},
  };
}

function listRequest(options: ListCodexThreadHistoryOptions) {
  return {
    method: 'thread/list',
    id: 2,
    params: {
      limit: options.limit,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      // The desktop app can have rollout JSONL that has not been repaired into
      // the state DB yet. Scan-and-repair is what makes the Feishu picker see
      // the same task inventory as the desktop client.
      useStateDbOnly: options.useStateDbOnly ?? false,
      ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      sourceKinds: [...(options.sourceKinds ?? DEFAULT_SOURCE_KINDS)],
    },
  };
}

function parseThreadListResponse(
  input: unknown,
): { ok: true; page: CodexThreadHistoryPage } | { ok: false; error: CodexHistoryError } {
  const raw = recordValue(input);
  if (!raw || !Array.isArray(raw.data)) {
    return {
      ok: false,
      error: new CodexHistoryError('malformed-response', 'codex app-server returned malformed thread/list response'),
    };
  }
  return {
    ok: true,
    page: {
      entries: raw.data.map(normalizeThread).filter((entry): entry is CodexThreadHistoryEntry => Boolean(entry)),
      ...(stringValue(raw.nextCursor) ? { nextCursor: stringValue(raw.nextCursor) } : {}),
    },
  };
}

function normalizeThread(input: unknown): CodexThreadHistoryEntry | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const threadId = stringValue(raw.id);
  const cwd = stringValue(raw.cwd);
  if (!threadId || !cwd) return undefined;
  const createdAt = numberValue(raw.createdAt);
  const updatedAt = numberValue(raw.updatedAt);
  const recencyAt = numberValue(raw.recencyAt);
  return {
    threadId,
    ...(stringValue(raw.sessionId) ? { sessionId: stringValue(raw.sessionId) } : {}),
    preview: normalizeSessionPreview(stringValue(raw.preview) ?? '') || '(空会话)',
    cwd,
    createdAtMs: Math.round((createdAt ?? 0) * 1000),
    updatedAtMs: Math.round((updatedAt ?? 0) * 1000),
    recencyAtMs: Math.round((recencyAt ?? updatedAt ?? createdAt ?? 0) * 1000),
    source: sourceValue(raw.source),
    ...(stringValue(raw.name) ? { name: stringValue(raw.name) } : {}),
    status: statusValue(raw.status),
    isPinned: raw.isPinned === true,
    ...(stringValue(recordValue(raw.gitInfo)?.branch)
      ? { gitBranch: stringValue(recordValue(raw.gitInfo)?.branch) }
      : {}),
  };
}

function normalizeTurn(input: unknown): CodexThreadTurnSummary | undefined {
  const raw = recordValue(input);
  const turnId = stringValue(raw?.id);
  if (!raw || !turnId) return undefined;
  let userText = '';
  let assistantText = '';
  const tools: string[] = [];
  if (Array.isArray(raw.items)) {
    for (const candidate of raw.items) {
      const item = recordValue(candidate);
      if (!item) continue;
      if (item.type === 'userMessage' && Array.isArray(item.content)) {
        userText += item.content
          .map((content) => {
            const entry = recordValue(content);
            return entry?.type === 'text' ? stringValue(entry.text) ?? '' : '';
          })
          .join('');
      } else if (item.type === 'agentMessage') {
        assistantText += stringValue(item.text) ?? '';
      } else if (typeof item.type === 'string' && item.type !== 'reasoning') {
        tools.push(item.type);
      }
    }
  }
  const startedAt = numberValue(raw.startedAt);
  const completedAt = numberValue(raw.completedAt);
  return {
    turnId,
    status: stringValue(raw.status) ?? 'unknown',
    ...(startedAt !== undefined ? { startedAtMs: Math.round(startedAt * 1000) } : {}),
    ...(completedAt !== undefined ? { completedAtMs: Math.round(completedAt * 1000) } : {}),
    ...(userText.trim() ? { userText: normalizeSessionPreview(userText) } : {}),
    ...(assistantText.trim() ? { assistantText: assistantText.trim() } : {}),
    tools,
  };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexHistoryError('timeout', message)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForChildExit(child: CodexAppServerChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sourceValue(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return JSON.stringify(input);
  return 'unknown';
}

function statusValue(
  input: unknown,
): CodexThreadHistoryEntry['status'] {
  const type = stringValue(recordValue(input)?.type);
  if (
    type === 'active' ||
    type === 'idle' ||
    type === 'systemError' ||
    type === 'notLoaded'
  ) {
    return type;
  }
  return 'unknown';
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
