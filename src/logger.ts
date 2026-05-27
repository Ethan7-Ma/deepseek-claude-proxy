/**
 * Structured timing logger for request tracing.
 */
import type { RequestTrace, TracePhase } from "./types.ts";

export function logTimingEvent(
  trace: RequestTrace,
  phase: TracePhase,
  extra: Record<string, unknown> = {},
) {
  console.log(
    `[Gateway] ${JSON.stringify({
      request_id: trace.requestId,
      provider: trace.provider,
      requested_model: trace.requestedModel,
      target_model: trace.targetModel,
      stream: trace.stream,
      audit_mode: trace.auditMode,
      phase,
      elapsed_ms: Date.now() - trace.startedAt,
      at: new Date().toISOString(),
      ...extra,
    })}`,
  );
}
