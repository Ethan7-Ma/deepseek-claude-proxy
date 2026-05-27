// ─── Provider types ───────────────────────────────────────────────

export interface ProviderConfig {
  name: string;
  /** Anthropic-compatible base URL (e.g. https://api.deepseek.com/anthropic) */
  baseUrl: string;
  apiKey: string;
  /** Default model to map Claude aliases to */
  model: string;
}

export type ProviderStatus = "up" | "down" | "degraded";

export interface ProviderState {
  config: ProviderConfig;
  status: ProviderStatus;
  lastCheck: number;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
}

// ─── Request tracing ──────────────────────────────────────────────

export interface RequestTrace {
  requestId: string;
  provider: string;
  requestedModel: string;
  targetModel: string;
  stream: boolean;
  startedAt: number;
  auditMode?: AuditMode;
}

export type TracePhase =
  | "start"
  | "thinking_check"
  | "upstream_headers"
  | "first_chunk"
  | "completed"
  | "client_aborted"
  | "error"
  | "retry"
  | "failover";

// ─── Thinking Guardian ────────────────────────────────────────────

export interface ThinkingCheck {
  passed: boolean;
  blocksFound: number;
  totalBytes: number;
  reason: string;
}

// ─── Audit Engine ─────────────────────────────────────────────────

export type AuditMode = "hud-formula" | "hud-tolerance" | "general";

export interface AuditProfile {
  mode: AuditMode;
  /** System prompt injected before user messages */
  systemPrompt: string;
  /** Minimum thinking budget to enforce */
  minThinkingBudget: number;
  /** Whether to extract and annotate reasoning chains */
  annotateReasoning: boolean;
}

// ─── SSE Types ────────────────────────────────────────────────────

export interface SSEDecoder {
  feed(chunk: string): SSEEvent[];
  flush(): SSEEvent[];
}

export interface SSEEvent {
  event: string;
  data: string;
}
