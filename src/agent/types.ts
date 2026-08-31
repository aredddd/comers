import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'approval_request'; request: AgentApprovalRequest }
  | { type: 'approval_resolved'; requestId: string }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export type AgentApprovalKind =
  | 'command'
  | 'file-change'
  | 'permissions'
  | 'user-input'
  | 'mcp-elicitation';

export interface AgentApprovalOption {
  label: string;
  value: string;
  description?: string;
}

export interface AgentApprovalQuestion {
  id: string;
  header: string;
  question: string;
  options?: AgentApprovalOption[];
  isSecret?: boolean;
}

export interface AgentApprovalRequest {
  id: string;
  kind: AgentApprovalKind;
  title: string;
  detail?: string;
  reason?: string;
  cwd?: string;
  command?: string;
  url?: string;
  questions?: AgentApprovalQuestion[];
  allowForSession?: boolean;
}

export type AgentApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | 'answer';

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

/**
 * The Feishu message that owns an agent run. Adapters expose this to the
 * route-bound artifact helper through environment variables, so the standard
 * file-reply path does not take an arbitrary recipient argument.
 */
export interface AgentDeliveryContext {
  chatId: string;
  messageId: string;
  chatType: string;
  threadId?: string;
}

export interface AgentRunOptions {
  runId: string;
  /** Stable bridge conversation scope. App-server adapters use it to reuse a
   * long-lived transport across turns without sharing state across chats. */
  scopeId?: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  audios?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  deliveryContext?: AgentDeliveryContext;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /** Add user guidance to the currently running turn when supported. */
  steer?(text: string): Promise<void>;
  /** Resolve an app-server approval or structured-input request. */
  respondToRequest?(
    requestId: string,
    decision: AgentApprovalDecision,
    value?: string,
  ): Promise<boolean>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /** Close long-lived transports owned by this adapter. */
  close?(): Promise<void>;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
