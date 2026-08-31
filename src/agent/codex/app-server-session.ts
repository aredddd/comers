import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import type {
  AgentApprovalDecision,
  AgentApprovalQuestion,
  AgentApprovalRequest,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { log } from '../../core/logger';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { CodexAppServerClient, type AppServerMessage, AsyncQueue } from './app-server-client';

interface PendingServerRequest {
  rpcId: string | number;
  method: string;
  params: Record<string, unknown>;
  request: AgentApprovalRequest;
}

export interface CodexAppServerSessionOptions {
  binary: string;
  profileStateDir: string;
  cwd: string;
  scopeId: string;
  requestedThreadId?: string;
  model?: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexHome?: string;
  inheritCodexHome: boolean;
  larkChannel?: LarkChannelEnvContext;
  botIdentity?: AgentBotIdentity;
}

export class CodexAppServerSession {
  readonly routeFile: string;
  readonly scopeId: string;
  readonly cwd: string;
  readonly sandbox: CodexAppServerSessionOptions['sandbox'];
  readonly model: string | undefined;
  readonly requestedThreadId: string | undefined;
  private readonly client: CodexAppServerClient;
  private readonly pendingRequests = new Map<string, PendingServerRequest>();
  private threadIdValue = '';
  private currentRun: AppServerTurnRun | undefined;

  constructor(private readonly options: CodexAppServerSessionOptions) {
    this.scopeId = options.scopeId;
    this.cwd = options.cwd;
    this.sandbox = options.sandbox;
    this.model = options.model;
    this.requestedThreadId = options.requestedThreadId;
    const safeScope = createHash('sha256').update(options.scopeId).digest('hex').slice(0, 24);
    this.routeFile = join(options.profileStateDir, 'routes', `${safeScope}.json`);

    const env = buildLarkChannelEnv(options.larkChannel);
    env.LARK_CHANNEL_ROUTE_FILE = this.routeFile;
    if (options.codexHome) env.CODEX_HOME = options.codexHome;
    else if (!options.inheritCodexHome) env.CODEX_HOME = join(options.profileStateDir, 'codex-home');
    this.client = new CodexAppServerClient({
      binary: options.binary,
      cwd: options.cwd,
      env,
      clientName: 'comers-mobile',
    });
  }

  get threadId(): string {
    return this.threadIdValue;
  }

  get exited(): boolean {
    return this.client.exited;
  }

  async connect(): Promise<void> {
    await mkdir(dirname(this.routeFile), { recursive: true });
    await this.client.connect();
    const common = {
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
      approvalPolicy: 'on-request',
      sandbox: this.sandbox,
      developerInstructions: buildBridgeSystemPrompt(this.options.botIdentity),
    };
    const response = this.requestedThreadId
      ? await this.client.request('thread/resume', {
          threadId: this.requestedThreadId,
          ...common,
          excludeTurns: true,
        })
      : await this.client.request('thread/start', common);
    const thread = recordValue(recordValue(response)?.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    this.threadIdValue = threadId;
    this.client.clearMessages();
    log.info('app-server', this.requestedThreadId ? 'thread-resumed' : 'thread-started', {
      scope: this.scopeId,
      threadId,
      cwd: this.cwd,
    });
  }

  async prepareDelivery(opts: AgentRunOptions): Promise<void> {
    if (!opts.deliveryContext) return;
    const temp = `${this.routeFile}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(opts.deliveryContext)}\n`, { mode: 0o600 });
    await rename(temp, this.routeFile);
  }

  run(opts: AgentRunOptions): AgentRun {
    if (this.currentRun && !this.currentRun.finished) {
      throw new Error(`codex app-server already has an active turn for scope ${this.scopeId}`);
    }
    // A terminal notification ends the run immediately, but app-server can
    // still have already-written notifications for that same turn buffered on
    // stdout.  Drop those before the next turn starts; otherwise the new run
    // has no turn id yet and could briefly accept a stale item as its own.
    this.client.clearMessages();
    const run = new AppServerTurnRun(this, opts);
    this.currentRun = run;
    run.start();
    return run;
  }

  async startTurn(opts: AgentRunOptions): Promise<{ turn: Record<string, unknown> }> {
    const input: unknown[] = [
      { type: 'text', text: opts.prompt, text_elements: [] },
      ...(opts.images ?? []).map((path) => ({ type: 'localImage', path })),
      ...(opts.audios ?? []).map((path) => ({ type: 'localAudio', path })),
    ];
    return this.client.request('turn/start', {
      threadId: this.threadIdValue,
      clientUserMessageId: opts.deliveryContext?.messageId ?? opts.runId,
      input,
      cwd: this.cwd,
      ...(opts.model ? { model: opts.model } : {}),
    });
  }

  stream(): AsyncIterable<AppServerMessage> {
    return this.client.stream();
  }

  async interrupt(turnId: string): Promise<void> {
    await this.client.request('turn/interrupt', {
      threadId: this.threadIdValue,
      turnId,
    });
  }

  async steer(turnId: string, text: string): Promise<void> {
    await this.client.request('turn/steer', {
      threadId: this.threadIdValue,
      expectedTurnId: turnId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  }

  async respondToRequest(
    requestId: string,
    decision: AgentApprovalDecision,
    value?: string,
  ): Promise<boolean> {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    const response = approvalResponse(pending, decision, value);
    if (!response) return false;
    this.client.respond(pending.rpcId, response);
    return true;
  }

  registerRequest(message: AppServerMessage): AgentEvent | undefined {
    if (message.id === undefined || !message.method) return undefined;
    const params = recordValue(message.params) ?? {};
    if (message.method === 'currentTime/read') {
      this.client.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return undefined;
    }
    const request = normalizeApprovalRequest(message.id, message.method, params);
    if (!request) {
      this.client.respondError(message.id, `unsupported app-server request: ${message.method}`);
      return undefined;
    }
    this.pendingRequests.set(request.id, {
      rpcId: message.id,
      method: message.method,
      params,
      request,
    });
    return { type: 'approval_request', request };
  }

  resolveRequest(requestId: string): AgentEvent {
    this.pendingRequests.delete(requestId);
    return { type: 'approval_resolved', requestId };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class AppServerTurnRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly queue = new AsyncQueue<AgentEvent>();
  private turnIdValue = '';
  private startError: Error | undefined;
  private completedResolve!: () => void;
  private readonly completed = new Promise<void>((resolve) => {
    this.completedResolve = resolve;
  });
  private readonly itemPhases = new Map<string, 'commentary' | 'final_answer' | 'unknown'>();
  private readonly itemDeltaChars = new Map<string, number>();
  finished = false;

  constructor(
    private readonly session: CodexAppServerSession,
    private readonly options: AgentRunOptions,
  ) {
    this.runId = options.runId;
    this.events = this.queue;
  }

  start(): void {
    this.queue.push({
      type: 'system',
      threadId: this.session.threadId,
      cwd: this.session.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    void this.session.startTurn(this.options).then(
      (response) => {
        const turnId = stringValue(response.turn.id);
        if (turnId) this.turnIdValue = turnId;
      },
      (error: unknown) => {
        this.startError = error instanceof Error ? error : new Error(String(error));
        this.queue.push({
          type: 'error',
          message: `codex turn/start 失败：${this.startError.message}`,
          terminationReason: 'failed',
        });
        this.finish();
      },
    );
    void this.pump();
  }

  async stop(): Promise<void> {
    if (this.finished) return;
    if (!this.turnIdValue) {
      await waitUntil(() => Boolean(this.turnIdValue) || Boolean(this.startError), 2000);
    }
    if (this.turnIdValue) {
      await this.session.interrupt(this.turnIdValue).catch((error) => {
        log.warn('app-server', 'interrupt-failed', { error: errorMessage(error) });
      });
    }
  }

  async steer(text: string): Promise<void> {
    if (!this.turnIdValue) throw new Error('当前 turn 尚未开始，暂时不能追加消息');
    await this.session.steer(this.turnIdValue, text);
  }

  respondToRequest(
    requestId: string,
    decision: AgentApprovalDecision,
    value?: string,
  ): Promise<boolean> {
    return this.session.respondToRequest(requestId, decision, value);
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.finished) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.completed.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.session.stream()) {
        if (this.finished) return;
        if (message.id !== undefined && message.method) {
          const event = this.session.registerRequest(message);
          if (event) this.queue.push(event);
          continue;
        }
        const event = this.mapMessage(message);
        if (event) {
          this.queue.push(event);
          if (event.type === 'done' || event.type === 'error') {
            this.finish();
            return;
          }
        }
      }
      if (!this.finished) {
        this.queue.push({
          type: 'error',
          message: 'codex app-server 事件流意外关闭',
          terminationReason: 'failed',
        });
        this.finish();
      }
    } catch (error) {
      if (!this.finished) {
        this.queue.push({
          type: 'error',
          message: `codex app-server 事件流失败：${errorMessage(error)}`,
          terminationReason: 'failed',
        });
        this.finish();
      }
    }
  }

  private mapMessage(message: AppServerMessage): AgentEvent | undefined {
    const method = message.method;
    const params = recordValue(message.params) ?? {};
    if (!method || !this.matchesThread(params)) return undefined;
    if (method === 'turn/started') {
      const turn = recordValue(params.turn);
      const turnId = stringValue(turn?.id);
      if (turnId) this.turnIdValue = turnId;
      return undefined;
    }
    if (method === 'item/started') {
      const item = recordValue(params.item);
      if (!item) return undefined;
      const id = stringValue(item.id);
      if (item.type === 'agentMessage' && id) {
        const phase = item.phase === 'commentary' || item.phase === 'final_answer'
          ? item.phase
          : 'unknown';
        this.itemPhases.set(id, phase);
        return undefined;
      }
      return mapToolStart(item);
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = stringValue(params.itemId);
      const delta = stringValue(params.delta);
      if (!itemId || !delta) return undefined;
      const phase = this.itemPhases.get(itemId) ?? 'unknown';
      this.itemDeltaChars.set(itemId, (this.itemDeltaChars.get(itemId) ?? 0) + delta.length);
      return phase === 'commentary' ? { type: 'text', delta } : undefined;
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const delta = stringValue(params.delta);
      return delta ? { type: 'thinking', delta } : undefined;
    }
    if (method === 'item/completed') {
      const item = recordValue(params.item);
      if (!item) return undefined;
      if (item.type === 'agentMessage') {
        const id = stringValue(item.id) ?? '';
        const text = stringValue(item.text) ?? '';
        const phase = item.phase === 'commentary' || item.phase === 'final_answer'
          ? item.phase
          : (this.itemPhases.get(id) ?? 'unknown');
        this.itemPhases.delete(id);
        const hadDelta = (this.itemDeltaChars.get(id) ?? 0) > 0;
        this.itemDeltaChars.delete(id);
        if (!text) return undefined;
        if (phase === 'commentary') return hadDelta ? undefined : { type: 'text', delta: text };
        return { type: 'final_text', content: text };
      }
      return mapToolComplete(item);
    }
    if (method === 'serverRequest/resolved') {
      const requestId = requestIdString(params.requestId);
      return requestId ? this.session.resolveRequest(requestId) : undefined;
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = recordValue(params.tokenUsage);
      const last = recordValue(tokenUsage?.last);
      return {
        type: 'usage',
        inputTokens: numberValue(last?.inputTokens),
        outputTokens: numberValue(last?.outputTokens),
        cachedInputTokens: numberValue(last?.cachedInputTokens),
        reasoningOutputTokens: numberValue(last?.reasoningOutputTokens),
      };
    }
    if (method === 'turn/completed') {
      const turn = recordValue(params.turn);
      const status = stringValue(turn?.status);
      if (status === 'failed') {
        const error = recordValue(turn?.error);
        return {
          type: 'error',
          message: stringValue(error?.message) ?? 'Codex turn failed',
          terminationReason: 'failed',
        };
      }
      return {
        type: 'done',
        threadId: this.session.threadId,
        terminationReason: status === 'interrupted' ? 'interrupted' : 'normal',
      };
    }
    if (method === 'error' && params.willRetry !== true) {
      const error = recordValue(params.error);
      return {
        type: 'error',
        message: stringValue(error?.message) ?? 'Codex app-server error',
        terminationReason: 'failed',
      };
    }
    return undefined;
  }

  private matchesThread(params: Record<string, unknown>): boolean {
    const threadId = stringValue(params.threadId);
    if (threadId && threadId !== this.session.threadId) return false;
    const turnId = stringValue(params.turnId) ?? stringValue(recordValue(params.turn)?.id);
    return !turnId || !this.turnIdValue || turnId === this.turnIdValue;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.queue.close();
    this.completedResolve();
  }
}

function mapToolStart(item: Record<string, unknown>): AgentEvent | undefined {
  const id = stringValue(item.id);
  if (!id) return undefined;
  if (item.type === 'commandExecution') {
    return {
      type: 'tool_use',
      id,
      name: 'command_execution',
      input: { command: stringValue(item.command) ?? '', cwd: stringValue(item.cwd) },
    };
  }
  if (item.type === 'fileChange') {
    return { type: 'tool_use', id, name: 'file_change', input: { changes: item.changes ?? [] } };
  }
  if (item.type === 'webSearch') {
    return { type: 'tool_use', id, name: 'web_search', input: { query: item.query ?? '' } };
  }
  if (item.type === 'mcpToolCall') {
    return {
      type: 'tool_use',
      id,
      name: `${stringValue(item.server) ?? 'mcp'}/${stringValue(item.tool) ?? 'tool'}`,
      input: item.arguments,
    };
  }
  if (item.type === 'dynamicToolCall') {
    return {
      type: 'tool_use',
      id,
      name: stringValue(item.tool) ?? 'dynamic_tool',
      input: item.arguments,
    };
  }
  return undefined;
}

function mapToolComplete(item: Record<string, unknown>): AgentEvent | undefined {
  const id = stringValue(item.id);
  if (!id) return undefined;
  if (item.type === 'commandExecution') {
    const exitCode = numberValue(item.exitCode);
    return {
      type: 'tool_result',
      id,
      output: stringValue(item.aggregatedOutput) ?? '',
      isError: item.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
    };
  }
  if (item.type === 'fileChange') {
    return {
      type: 'tool_result',
      id,
      output: summarizeFileChanges(item.changes),
      isError: item.status === 'failed' || item.status === 'declined',
    };
  }
  if (item.type === 'webSearch' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return {
      type: 'tool_result',
      id,
      output: stringifyCompact(item.result ?? item.error ?? item.contentItems ?? ''),
      isError: item.status === 'failed' || item.success === false || Boolean(item.error),
    };
  }
  return undefined;
}

function normalizeApprovalRequest(
  rpcId: string | number,
  method: string,
  params: Record<string, unknown>,
): AgentApprovalRequest | undefined {
  const id = requestIdString(rpcId);
  if (!id) return undefined;
  if (method === 'item/commandExecution/requestApproval') {
    const command = stringValue(params.command) ?? '';
    return {
      id,
      kind: 'command',
      title: params.networkApprovalContext ? 'Codex 请求网络访问' : 'Codex 请求执行命令',
      ...(command ? { command, detail: command } : {}),
      ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}),
      ...(stringValue(params.reason) ? { reason: stringValue(params.reason) } : {}),
      allowForSession: allowsSessionDecision(params.availableDecisions),
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    return {
      id,
      kind: 'file-change',
      title: 'Codex 请求修改文件',
      ...(stringValue(params.reason) ? { reason: stringValue(params.reason) } : {}),
      ...(stringValue(params.grantRoot) ? { detail: `写入范围：${stringValue(params.grantRoot)}` } : {}),
      allowForSession: true,
    };
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      id,
      kind: 'permissions',
      title: 'Codex 请求额外权限',
      detail: stringifyCompact(params.permissions),
      ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}),
      ...(stringValue(params.reason) ? { reason: stringValue(params.reason) } : {}),
      allowForSession: true,
    };
  }
  if (method === 'item/tool/requestUserInput') {
    return {
      id,
      kind: 'user-input',
      title: 'Codex 需要你的选择',
      questions: normalizeQuestions(params.questions),
    };
  }
  if (method === 'mcpServer/elicitation/request') {
    return {
      id,
      kind: 'mcp-elicitation',
      title: `MCP「${stringValue(params.serverName) ?? 'server'}」需要确认`,
      ...(stringValue(params.message) ? { detail: stringValue(params.message) } : {}),
      ...(stringValue(params.url) ? { url: stringValue(params.url) } : {}),
    };
  }
  return undefined;
}

function approvalResponse(
  pending: PendingServerRequest,
  decision: AgentApprovalDecision,
  value?: string,
): unknown | undefined {
  if (pending.method === 'item/commandExecution/requestApproval' || pending.method === 'item/fileChange/requestApproval') {
    if (decision === 'answer') return undefined;
    return { decision };
  }
  if (pending.method === 'item/permissions/requestApproval') {
    const grant = decision === 'accept' || decision === 'acceptForSession';
    const requested = recordValue(pending.params.permissions) ?? {};
    return {
      permissions: grant
        ? {
            ...(requested.network ? { network: requested.network } : {}),
            ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
          }
        : {},
      scope: decision === 'acceptForSession' ? 'session' : 'turn',
    };
  }
  if (pending.method === 'item/tool/requestUserInput') {
    if (decision !== 'answer' || value === undefined) return undefined;
    const questions = normalizeQuestions(pending.params.questions);
    if (questions.length === 0) return undefined;
    const selected = decodeAnswerValue(value, questions);
    return { answers: selected };
  }
  if (pending.method === 'mcpServer/elicitation/request') {
    if (decision === 'decline' || decision === 'cancel') {
      return { action: decision, content: null, _meta: null };
    }
    if (decision === 'answer') {
      return { action: 'accept', content: parseAnswerContent(value), _meta: null };
    }
    return { action: 'accept', content: null, _meta: null };
  }
  return undefined;
}

function allowsSessionDecision(input: unknown): boolean {
  return !Array.isArray(input) || input.includes('acceptForSession');
}

function normalizeQuestions(input: unknown): AgentApprovalQuestion[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((raw) => {
    const question = recordValue(raw);
    const id = stringValue(question?.id);
    const text = stringValue(question?.question);
    if (!question || !id || !text) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((item) => {
          const option = recordValue(item);
          const label = stringValue(option?.label);
          if (!label) return [];
          return [{ label, value: label, ...(stringValue(option?.description) ? { description: stringValue(option?.description) } : {}) }];
        })
      : undefined;
    return [{
      id,
      header: stringValue(question.header) ?? '请选择',
      question: text,
      ...(options?.length ? { options } : {}),
      ...(question.isSecret === true ? { isSecret: true } : {}),
    }];
  });
}

function decodeAnswerValue(
  value: string,
  questions: AgentApprovalQuestion[],
): Record<string, { answers: string[] }> {
  const separator = value.indexOf(':');
  if (separator > 0) {
    const questionId = value.slice(0, separator);
    const answer = value.slice(separator + 1);
    if (questions.some((question) => question.id === questionId)) {
      return { [questionId]: { answers: [answer] } };
    }
  }
  if (questions.length === 1) return { [questions[0]!.id]: { answers: [value] } };
  try {
    const parsed = JSON.parse(value) as Record<string, string | string[]>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, answer]) => [
        key,
        { answers: Array.isArray(answer) ? answer.map(String) : [String(answer)] },
      ]),
    );
  } catch {
    return { [questions[0]!.id]: { answers: [value] } };
  }
}

function parseAnswerContent(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function summarizeFileChanges(input: unknown): string {
  if (!Array.isArray(input)) return '';
  return input
    .map((raw) => {
      const change = recordValue(raw);
      return change ? `${stringValue(change.path) ?? '(unknown)'}: ${stringifyCompact(change.kind)}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requestIdString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
