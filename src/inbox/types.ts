export type SourceKind = 'p2p' | 'mention' | 'defect';
export interface InboxEvent {
  id: string;
  key: string;
  version: string;
  source: SourceKind;
  text: string;
  title: string;
  url?: string;
  messageId?: string;
  chatId?: string;
  projectKey?: string;
  workItemId?: string;
  workItemType?: string;
  observedAt: number;
}
export interface InboxArtifact {
  id: string;
  kind: 'reply' | 'code' | 'clarification' | 'analysis' | 'defect_handoff';
  title: string;
  body: string;
  url?: string;
  status: 'pending' | 'approved' | 'rejected' | 'sending' | 'sent' | 'send_unknown';
  targetEventId?: string;
  receipt?: string;
  codeFingerprint?: string;
}
export interface InboxItem {
  id: string;
  key: string;
  revision: number;
  status: 'queued' | 'running' | 'review' | 'ignored' | 'failed' | 'interrupted';
  title: string;
  events: InboxEvent[];
  artifacts: InboxArtifact[];
  updatedAt: number;
  sourceSessionId?: string;
  executionSessionId?: string;
  routeId?: string;
  worktree?: string;
  error?: string;
  mergedInto?: string;
}
export interface SourceCheckpoint {
  cursor: number;
  baseline: boolean;
  versions: Record<string, string>;
  watched?: InboxEvent[];
}
export interface InboxState {
  schema: 1;
  items: InboxItem[];
  sources: Partial<Record<SourceKind, SourceCheckpoint>>;
  health: Partial<Record<SourceKind, { checkedAt: number; error?: string; nextPollAt?: number }>>;
}
export interface InboxRoute {
  id: string;
  name: string;
  cwd: string;
  sourceSessionId?: string;
  keywords?: string[];
}
export interface InboxConfig {
  intervalMs: number;
  overlapMs: number;
  messageLookbackMs: number;
  maxConcurrentRuns: number;
  agentTimeoutMs: number;
  codexBinary: string;
  codexModel?: string;
  sources: SourceKind[];
  defectTypeKeys: string[];
  routes: InboxRoute[];
  discoverSessions: boolean;
  maxSessionCandidates: number;
}
export const DEFAULT_INBOX_CONFIG: InboxConfig = {
  intervalMs: 10_000,
  overlapMs: 5 * 60_000,
  messageLookbackMs: 30 * 60_000,
  maxConcurrentRuns: 1,
  agentTimeoutMs: 20 * 60_000,
  codexBinary: 'codex',
  sources: ['p2p', 'mention', 'defect'],
  defectTypeKeys: ['issue', 'bug'],
  routes: [],
  discoverSessions: true,
  maxSessionCandidates: 30,
};
