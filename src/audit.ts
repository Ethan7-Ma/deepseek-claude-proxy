/**
 * Audit Engine — domain-specific prompt injection for code audit scenarios.
 *
 * Modes:
 *   hud-formula    — HUD optical formula inspection (default for your workflow)
 *   hud-tolerance  — HUD tolerance configuration audit
 *   general        — General code review with enhanced reasoning
 *
 * Activate via HTTP header:  X-Audit-Mode: hud-formula
 */

import type { AuditMode, AuditProfile } from "./types.ts";

const PROFILES: Record<AuditMode, AuditProfile> = {
  "hud-formula": {
    mode: "hud-formula",
    systemPrompt: `You are a world-class optical inspection engineer auditing HUD (Head-Up Display) detection formulas.

CRITICAL REQUIREMENTS:
1. For EVERY formula you encounter, trace the full computation chain:
   - pixel → mm conversion (pixeltommratio = objectsize * vid / actualzoom)
   - mm → angle conversion (small-angle approximation: θ ≈ pixel × OS/AZ radians)
   - Binocular parallax uses 65mm IPD baseline
2. Cross-reference against these known patterns:
   - PISCES and QBHA use SAME physics via DIFFERENT optical paths
   - Vertical parallax has NO movement component (only horizontal)
   - ActualZoom = lens physical focal length (50/35/52mm common values)
3. Flag EVERY instance of:
   - Variable reference errors (X used where Y belongs)
   - Horizontal/vertical axis confusion
   - Multiple hardcoded values for the SAME concept that conflict
   - Missing unit conversions in multi-step chains
4. In your thinking, show the FORMULA DERIVATION with units at each step.
5. Output format: mark each finding with 🐛 (confirmed bug), ⚠️ (suspicious), or ✅ (verified correct).

You are NOT just reviewing — you are the domain expert the original developers wish they had.`,
    minThinkingBudget: 4096,
    annotateReasoning: true,
  },

  "hud-tolerance": {
    mode: "hud-tolerance",
    systemPrompt: `You are auditing HUD optical inspection tolerance configurations.

CRITICAL RULES:
1. Hardcoded tolerances are NORMAL in industrial software — do NOT flag them just for being hardcoded.
2. The REAL danger is MULTIPLE hardcoded values for the SAME tolerance concept that CONFLICT.
3. ZIP configurations are 95% trusted — only check for ordering errors.
4. Focus on: same parameter defined differently in different files, missing inheritance, copy-paste drift.
5. For each tolerance: trace where it's DEFINED vs where it's CONSUMED. Flag only mismatches.
6. In your thinking, show the definition site and each consumption site side by side.`,
    minThinkingBudget: 2048,
    annotateReasoning: false,
  },

  general: {
    mode: "general",
    systemPrompt: `You are an expert code reviewer. Think step-by-step before answering. Verify every claim against the code. When you find a bug, explain WHY it's wrong, not just WHERE.`,
    minThinkingBudget: 1024,
    annotateReasoning: false,
  },
};

/**
 * Get the audit profile for a given mode. Falls back to "general" for unknown modes.
 */
export function getAuditProfile(mode: string): AuditProfile {
  if (mode in PROFILES) {
    return PROFILES[mode as AuditMode];
  }
  return PROFILES.general;
}

/**
 * Enhance a request body with audit-specific configuration.
 * Injects system prompt and ensures minimum thinking budget.
 */
export function applyAuditProfile(
  body: Record<string, unknown>,
  mode: string,
): Record<string, unknown> {
  const profile = getAuditProfile(mode);
  const enhanced = { ...body };

  // Inject system prompt before existing system messages
  const system = profile.systemPrompt;
  const existingSystem = enhanced.system;

  if (Array.isArray(existingSystem)) {
    // Prepend audit system prompt
    enhanced.system = [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ...existingSystem,
    ];
  } else if (typeof existingSystem === "string") {
    enhanced.system = [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      { type: "text", text: existingSystem },
    ];
  } else {
    enhanced.system = [{ type: "text", text: system }];
  }

  // Ensure minimum thinking budget
  if (enhanced.thinking && typeof enhanced.thinking === "object") {
    const thinking = enhanced.thinking as Record<string, unknown>;
    if (
      thinking.type === "enabled" &&
      typeof thinking.budget_tokens === "number" &&
      thinking.budget_tokens < profile.minThinkingBudget
    ) {
      thinking.budget_tokens = profile.minThinkingBudget;
    }
  } else {
    enhanced.thinking = {
      type: "enabled",
      budget_tokens: profile.minThinkingBudget,
    };
  }

  return enhanced;
}

/**
 * List available audit modes (for the /audit-modes endpoint).
 */
export function listAuditModes(): Array<{ mode: string; description: string }> {
  return [
    { mode: "hud-formula", description: "HUD optical formula chain audit" },
    { mode: "hud-tolerance", description: "HUD tolerance configuration audit" },
    { mode: "general", description: "General code review with enhanced reasoning" },
  ];
}
