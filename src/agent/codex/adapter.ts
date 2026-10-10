import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildCodexArgs } from './argv';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';
import { CodexAppServerSession } from './app-server-session';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  /** Direct constructors keep legacy exec behavior unless explicitly opted in;
   * normalized runtime profiles pass `app-server`. */
  runtime?: 'app-server' | 'exec';
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  /** Non-chat workers can supply their own developer-level operating policy. */
  systemPrompt?: string;
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly runtime: 'app-server' | 'exec';
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly optionsSystemPrompt: string | undefined;
  private botIdentity: AgentBotIdentity | undefined;
  private readonly appServerSessions = new Map<string, CodexAppServerSession>();
  private readonly preparedRuns = new Map<
    string,
    { kind: 'app-server'; session: CodexAppServerSession } | { kind: 'exec' }
  >();

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.runtime = opts.runtime ?? 'exec';
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.optionsSystemPrompt = opts.systemPrompt;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    if (this.runtime !== 'app-server') return;
    if (!opts?.cwd || !opts.scopeId) {
      // Legacy/direct callers do not have a Feishu scope. They keep the
      // one-shot exec behavior instead of failing startup compatibility.
      if (opts) this.preparedRuns.set(opts.runId, { kind: 'exec' });
      log.info('app-server', 'fallback-exec-no-scope', {
        hasOptions: Boolean(opts),
        hasCwd: Boolean(opts?.cwd),
        hasScope: Boolean(opts?.scopeId),
      });
      return;
    }
    const scopeId = opts.scopeId;
    let session: CodexAppServerSession | undefined;
    try {
      session = this.appServerSessions.get(scopeId);
      const canReuse = Boolean(
        session &&
        !session.exited &&
        session.cwd === opts.cwd &&
        session.sandbox === (opts.sandbox ?? this.sandbox) &&
        opts.threadId &&
        session.threadId === opts.threadId,
      );
      if (session && !canReuse) {
        this.appServerSessions.delete(scopeId);
        await session.close().catch((error) => {
          log.warn('app-server', 'replace-close-failed', { error: errorMessage(error) });
        });
        session = undefined;
      }
      if (!session) {
        session = new CodexAppServerSession({
          binary: this.binary,
          profileStateDir: this.profileStateDir,
          cwd: opts.cwd,
          scopeId,
          ...(opts.threadId ? { requestedThreadId: opts.threadId } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          sandbox: opts.sandbox ?? this.sandbox,
          ...(this.codexHome ? { codexHome: this.codexHome } : {}),
          inheritCodexHome: this.inheritCodexHome,
          ...(this.larkChannel ? { larkChannel: this.larkChannel } : {}),
          ...(this.botIdentity ? { botIdentity: this.botIdentity } : {}),
          ...(this.optionsSystemPrompt ? { systemPrompt: this.optionsSystemPrompt } : {}),
        });
        await session.connect();
        this.appServerSessions.set(scopeId, session);
      }
      await session.prepareDelivery(opts);
      this.preparedRuns.set(opts.runId, { kind: 'app-server', session });
    } catch (error) {
      // Compatibility escape hatch for older/partially-installed Codex builds.
      // A single failed rich-runtime startup must not take the already-working
      // personal bot offline; the run falls back to `codex exec` and logs why.
      log.warn('app-server', 'fallback-exec', { error: errorMessage(error) });
      if (session) {
        if (this.appServerSessions.get(scopeId) === session) {
          this.appServerSessions.delete(scopeId);
        }
        await session.close().catch((closeError) => {
          log.warn('app-server', 'fallback-close-failed', {
            error: errorMessage(closeError),
          });
        });
      }
      this.preparedRuns.set(opts.runId, { kind: 'exec' });
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    const prepared = this.preparedRuns.get(opts.runId);
    this.preparedRuns.delete(opts.runId);
    if (prepared?.kind === 'app-server') return prepared.session.run(opts);
    return this.runExec(opts);
  }

  async close(): Promise<void> {
    const sessions = [...this.appServerSessions.values()];
    this.appServerSessions.clear();
    this.preparedRuns.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  private runExec(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    const args = buildCodexArgs({
      cwd: opts.cwd,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
    });
    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(
      this.larkChannel,
      opts.deliveryContext,
    );
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(this.optionsSystemPrompt
      ? `${this.optionsSystemPrompt}\n\n${opts.prompt}`
      : prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`codex runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`codex runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
