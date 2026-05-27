/**
 * Thinking Guardian — validates that upstream responses contain thinking blocks.
 *
 * DeepSeek's /anthropic endpoint converts `reasoning_content` to Anthropic `thinking` blocks
 * when `thinking: { type: "enabled", budget_tokens: N }` is present in the request.
 * This guardian monitors SSE streams to verify thinking blocks are present.
 * If missing, it triggers retry with explicit thinking budget injection.
 */

import type { ThinkingCheck, RequestTrace } from "./types.ts";
import { logTimingEvent } from "./logger.ts";

const MIN_THINKING_BLOCKS = 1;
const MAX_RETRIES = 2;

/**
 * Scan a raw SSE payload string for thinking blocks.
 */
export function scanSSEForThinking(raw: string): ThinkingCheck {
  let blocksFound = 0;

  // Match Anthropic SSE thinking events:
  // event: content_block_start
  // data: {"type":"content_block_start",...,"content_block":{"type":"thinking",...}}
  const thinkingBlockStartRegex = /"content_block":\s*\{\s*"type":\s*"thinking"/g;
  const matches = raw.match(thinkingBlockStartRegex);
  if (matches) {
    blocksFound += matches.length;
  }

  // Also check for thinking_delta which indicates active thinking
  const thinkingDeltaRegex = /"type":\s*"thinking_delta"/g;
  const deltaMatches = raw.match(thinkingDeltaRegex);
  if (deltaMatches && blocksFound === 0) {
    blocksFound = deltaMatches.length;
  }

  return {
    passed: blocksFound >= MIN_THINKING_BLOCKS,
    blocksFound,
    totalBytes: raw.length,
    reason:
      blocksFound >= MIN_THINKING_BLOCKS
        ? `Found ${blocksFound} thinking block(s)`
        : `No thinking blocks detected in ${raw.length} bytes of response`,
  };
}

/**
 * Inject thinking configuration into the request body.
 */
export function injectThinkingConfig(
  body: Record<string, unknown>,
  minBudget: number = 2048,
): Record<string, unknown> {
  const normalized = { ...body };

  if (normalized.thinking && typeof normalized.thinking === "object") {
    const thinking = normalized.thinking as Record<string, unknown>;
    if (thinking.type === "disabled") {
      // Override: retry needs thinking enabled
      thinking.type = "enabled";
      thinking.budget_tokens = minBudget;
    } else if (
      thinking.type === "enabled" &&
      typeof thinking.budget_tokens === "number" &&
      thinking.budget_tokens < minBudget
    ) {
      thinking.budget_tokens = minBudget;
    }
  } else {
    normalized.thinking = {
      type: "enabled",
      budget_tokens: minBudget,
    };
  }

  return normalized;
}

export interface GuardianResult {
  passed: boolean;
  check: ThinkingCheck;
  retried: boolean;
  retries: number;
}

/**
 * Evaluate thinking presence and decide if retry is needed.
 */
export function evaluateThinking(
  rawBody: string,
  trace: RequestTrace,
  retryCount: number,
): GuardianResult {
  const check = scanSSEForThinking(rawBody);

  logTimingEvent(trace, "thinking_check", {
    blocks_found: check.blocksFound,
    total_bytes: check.totalBytes,
    passed: check.passed,
    retry_count: retryCount,
  });

  if (check.passed) {
    return { passed: true, check, retried: retryCount > 0, retries: retryCount };
  }

  if (retryCount < MAX_RETRIES) {
    console.warn(
      `[Guardian] No thinking blocks (attempt ${retryCount + 1}/${MAX_RETRIES}) — retrying with injected thinking config`,
    );
    return { passed: false, check, retried: true, retries: retryCount };
  }

  console.error(
    `[Guardian] No thinking blocks after ${MAX_RETRIES} retries — returning as-is`,
  );
  return { passed: false, check, retried: true, retries: retryCount };
}
