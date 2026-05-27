/**
 * Provider Mesh — multi-provider with automatic failover and health checks.
 *
 * The mesh maintains a list of providers in priority order.
 * The primary (index 0) handles all traffic under normal conditions.
 * On failure, it fails over to the next healthy provider.
 * Health checks run every 30s and auto-recover the primary when it comes back.
 */

import type { ProviderConfig, ProviderState, ProviderStatus } from "./types.ts";

// ─── Configuration ────────────────────────────────────────────────

function pickEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function buildProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // DeepSeek (primary)
  const dsKey = pickEnv("DEEPSEEK_API_KEY");
  if (dsKey) {
    providers.push({
      name: "deepseek",
      baseUrl: pickEnv("DEEPSEEK_ANTHROPIC_BASE_URL") || "https://api.deepseek.com/anthropic",
      apiKey: dsKey,
      model: pickEnv("DEEPSEEK_MODEL") || "deepseek-v4-pro",
    });
  }

  // Kimi (backup)
  const kimiKey = pickEnv("KIMI_API_KEY");
  if (kimiKey) {
    providers.push({
      name: "kimi",
      baseUrl: pickEnv("KIMI_ANTHROPIC_BASE_URL") || "https://api.moonshot.cn/anthropic",
      apiKey: kimiKey,
      model: pickEnv("KIMI_MODEL") || "kimi-k2.6",
    });
  }

  // Qwen (backup)
  const qwenKey = pickEnv("QWEN_API_KEY");
  if (qwenKey) {
    providers.push({
      name: "qwen",
      baseUrl: pickEnv("QWEN_ANTHROPIC_BASE_URL") || "https://dashscope.aliyuncs.com/apps/anthropic",
      apiKey: qwenKey,
      model: pickEnv("QWEN_MODEL") || "qwen-plus",
    });
  }

  // GLM (backup)
  const glmKey = pickEnv("GLM_API_KEY");
  if (glmKey) {
    providers.push({
      name: "glm",
      baseUrl: pickEnv("GLM_ANTHROPIC_BASE_URL") || "https://open.bigmodel.cn/api/anthropic",
      apiKey: glmKey,
      model: pickEnv("GLM_MODEL") || "glm-5.1",
    });
  }

  // MiniMax (backup)
  const mmKey = pickEnv("MINIMAX_API_KEY");
  if (mmKey) {
    providers.push({
      name: "minimax",
      baseUrl: pickEnv("MINIMAX_ANTHROPIC_BASE_URL") || "https://api.minimaxi.com/anthropic",
      apiKey: mmKey,
      model: pickEnv("MINIMAX_MODEL") || "minimax-m2.7-highspeed",
    });
  }

  // MIMO (backup)
  const mimoKey = pickEnv("MIMO_API_KEY");
  if (mimoKey) {
    providers.push({
      name: "mimo",
      baseUrl: pickEnv("MIMO_ANTHROPIC_BASE_URL") || "https://api.xiaomimimo.com/anthropic",
      apiKey: mimoKey,
      model: pickEnv("MIMO_MODEL") || "mimo-v2.5-pro",
    });
  }

  // Custom OpenAI-compatible endpoints via env vars
  // CUSTOM_PROVIDER_NAME, CUSTOM_PROVIDER_KEY, CUSTOM_PROVIDER_BASE_URL, CUSTOM_PROVIDER_MODEL
  for (let i = 1; i <= 3; i++) {
    const name = pickEnv(`CUSTOM${i}_NAME`);
    const key = pickEnv(`CUSTOM${i}_KEY`);
    const baseUrl = pickEnv(`CUSTOM${i}_BASE_URL`);
    if (name && key && baseUrl) {
      providers.push({
        name: name.toLowerCase(),
        baseUrl,
        apiKey: key,
        model: pickEnv(`CUSTOM${i}_MODEL`) || "default",
      });
    }
  }

  return providers;
}

// ─── Provider Mesh ────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL = 30_000; // 30s
const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_CHECK_TIMEOUT = 5_000;

export class ProviderMesh {
  private states: Map<string, ProviderState> = new Map();
  private order: string[] = [];
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private activeProvider: string;

  constructor() {
    const configs = buildProviders();
    if (configs.length === 0) {
      throw new Error(
        "No providers configured. Set at least one *_API_KEY environment variable."
      );
    }

    for (const config of configs) {
      this.states.set(config.name, {
        config,
        status: "up",
        lastCheck: 0,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
      });
      this.order.push(config.name);
    }

    this.activeProvider = this.order[0];
  }

  get active(): string {
    return this.activeProvider;
  }

  getConfig(name?: string): ProviderConfig {
    const providerName = name || this.activeProvider;
    const state = this.states.get(providerName);
    if (!state) {
      // Fallback to first available
      const firstUp = this.order.find((n) => this.states.get(n)?.status === "up");
      if (firstUp) return this.states.get(firstUp)!.config;
      return this.states.get(this.order[0])!.config;
    }
    return state.config;
  }

  getState(name?: string): ProviderState | undefined {
    return this.states.get(name || this.activeProvider);
  }

  getAllStates(): ProviderState[] {
    return this.order.map((name) => this.states.get(name)!);
  }

  /**
   * Find the next healthy provider after the given one.
   * Returns undefined if all providers are down.
   */
  private findNextHealthy(after: string): string | undefined {
    const idx = this.order.indexOf(after);
    // Start from next, wrap around
    for (let i = 1; i <= this.order.length; i++) {
      const candidate = this.order[(idx + i) % this.order.length];
      const state = this.states.get(candidate);
      if (state && state.status === "up") return candidate;
    }
    return undefined;
  }

  /**
   * Record a successful request — reset failure count and promote to primary if needed.
   */
  recordSuccess(name: string) {
    const state = this.states.get(name);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.totalRequests++;
    if (state.status !== "up") {
      state.status = "up";
      console.log(`[Mesh] Provider ${name} recovered — status: up`);
    }
    // If primary recovered, switch back
    if (name === this.order[0] && this.activeProvider !== name) {
      console.log(`[Mesh] Primary provider ${name} recovered — switching back`);
      this.activeProvider = name;
    }
  }

  /**
   * Record a failed request. If consecutive failures exceed threshold, mark as down.
   * Then fail over to next healthy provider. Returns the new active provider name,
   * or null if all providers are down.
   */
  recordFailure(name: string): string | null {
    const state = this.states.get(name);
    if (!state) return null;

    state.consecutiveFailures++;
    state.totalFailures++;
    state.totalRequests++;

    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && state.status === "up") {
      state.status = "down";
      console.warn(`[Mesh] Provider ${name} marked DOWN after ${state.consecutiveFailures} consecutive failures`);

      // Try failover
      const next = this.findNextHealthy(name);
      if (next && next !== name) {
        console.warn(`[Mesh] Failing over: ${name} → ${next}`);
        this.activeProvider = next;
        return next;
      }

      // All providers down — stay on current (will keep failing)
      if (!next) {
        console.error(`[Mesh] ALL PROVIDERS DOWN. No healthy provider available.`);
        return null;
      }
    }

    return this.activeProvider;
  }

  /**
   * Start periodic health checks.
   */
  startHealthChecks() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.runHealthCheck(), HEALTH_CHECK_INTERVAL);
    // Run first check after 5s
    setTimeout(() => this.runHealthCheck(), 5_000);
    console.log(`[Mesh] Health checks started (interval: ${HEALTH_CHECK_INTERVAL / 1000}s)`);
  }

  /**
   * Stop health checks — call on shutdown.
   */
  stopHealthChecks() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async runHealthCheck() {
    for (const name of this.order) {
      const state = this.states.get(name);
      if (!state) continue;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

        const response = await fetch(`${state.config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": state.config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: state.config.model,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        // 2xx or 4xx (except 401/403) means the endpoint is reachable
        if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403)) {
          if (state.status !== "up") {
            state.status = "up";
            state.consecutiveFailures = 0;
            console.log(`[Mesh] Health check: ${name} recovered`);

            // Auto-switch back to primary
            if (name === this.order[0] && this.activeProvider !== name) {
              console.log(`[Mesh] Auto-switching back to primary: ${name}`);
              this.activeProvider = name;
            }
          }
        } else {
          this.recordHealthFailure(state);
        }

        // Consume body to prevent memory leaks
        await response.body?.cancel();
      } catch {
        this.recordHealthFailure(state);
      }
    }
  }

  private recordHealthFailure(state: ProviderState) {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && state.status === "up") {
      state.status = "down";
      console.warn(`[Mesh] Health check: ${state.config.name} marked DOWN`);
    }
  }
}
