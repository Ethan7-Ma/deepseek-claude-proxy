/**
 * Integration tests for Hermes Gateway.
 * Tests against a mock upstream server — no real API keys needed.
 */

import http, { type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";
import { describe, it, expect, afterEach, vi } from "vitest";

// We test individual modules directly since createGateway creates a real server

// ─── Test helpers ──────────────────────────────────────────────────

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function startServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("No port"));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ─── Mock upstream ─────────────────────────────────────────────────

function createMockUpstream(opts: {
  failCount?: number;
  noThinking?: boolean;
  statusCode?: number;
} = {}) {
  const { failCount = 0, noThinking = false } = opts;
  let requestCount = 0;

  const server = http.createServer(async (req, res) => {
    requestCount++;
    const body = await readJsonBody(req);

    // Simulate failures
    if (requestCount <= failCount) {
      res.destroy(new Error("Simulated failure"));
      return;
    }

    const isStream = body.stream === true;

    if (!isStream) {
      // Non-streaming: return JSON
      writeJson(res, 200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model || "test-model",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }

    // Streaming: return SSE
    const hasThinking = body.thinking &&
      typeof body.thinking === "object" &&
      (body.thinking as any).type === "enabled";

    const ssePayload = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    ];

    if (!noThinking || hasThinking) {
      ssePayload.push(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze this carefully..."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      );
    }

    ssePayload.push(
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(ssePayload.join(""));
  });

  return { server, get requestCount() { return requestCount; } };
}

// ─── Unit: SSE Thinking Scanner ────────────────────────────────────

describe("Thinking Guardian — scanSSEForThinking", () => {
  it("detects thinking blocks in valid SSE", async () => {
    // We test the regex directly via the guardian module
    const { scanSSEForThinking } = await import("../src/guardian.ts");

    const withThinking = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const result = scanSSEForThinking(withThinking);
    expect(result.passed).toBe(true);
    expect(result.blocksFound).toBeGreaterThanOrEqual(1);
  });

  it("reports failure when no thinking blocks present", async () => {
    const { scanSSEForThinking } = await import("../src/guardian.ts");

    const withoutThinking = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const result = scanSSEForThinking(withoutThinking);
    expect(result.passed).toBe(false);
    expect(result.blocksFound).toBe(0);
  });

  it("detects thinking_delta as thinking activity", async () => {
    const { scanSSEForThinking } = await import("../src/guardian.ts");

    const withDeltaOnly = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const result = scanSSEForThinking(withDeltaOnly);
    expect(result.passed).toBe(true);
    expect(result.blocksFound).toBe(1);
  });
});

// ─── Unit: Thinking Injection ──────────────────────────────────────

describe("Thinking Guardian — injectThinkingConfig", () => {
  it("adds thinking config when missing", async () => {
    const { injectThinkingConfig } = await import("../src/guardian.ts");

    const body = { model: "test", max_tokens: 100, messages: [] };
    const result = injectThinkingConfig(body, 2048);

    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(result.model).toBe("test");
    expect(result.messages).toEqual([]);
  });

  it("upgrades budget when too low", async () => {
    const { injectThinkingConfig } = await import("../src/guardian.ts");

    const body = {
      model: "test",
      thinking: { type: "enabled", budget_tokens: 512 },
    };
    const result = injectThinkingConfig(body, 4096);

    expect((result.thinking as any).budget_tokens).toBe(4096);
  });

  it("preserves non-enabled thinking config", async () => {
    const { injectThinkingConfig } = await import("../src/guardian.ts");

    const body = {
      model: "test",
      thinking: { type: "disabled" },
    };
    const result = injectThinkingConfig(body, 2048);

    // Should still set it to enabled with budget
    expect((result.thinking as any).type).toBe("enabled");
    expect((result.thinking as any).budget_tokens).toBe(2048);
  });

  it("does not modify original object", async () => {
    const { injectThinkingConfig } = await import("../src/guardian.ts");

    const body = { model: "test" };
    const result = injectThinkingConfig(body, 2048);

    expect((body as any).thinking).toBeUndefined();
    expect((result as any).thinking).toBeDefined();
  });
});

// ─── Unit: Audit Engine ────────────────────────────────────────────

describe("Audit Engine", () => {
  it("returns hud-formula profile with correct budget", async () => {
    const { getAuditProfile } = await import("../src/audit.ts");

    const profile = getAuditProfile("hud-formula");
    expect(profile.mode).toBe("hud-formula");
    expect(profile.minThinkingBudget).toBe(4096);
    expect(profile.systemPrompt).toContain("optical inspection");
    expect(profile.annotateReasoning).toBe(true);
  });

  it("falls back to general for unknown modes", async () => {
    const { getAuditProfile } = await import("../src/audit.ts");

    const profile = getAuditProfile("nonexistent");
    expect(profile.mode).toBe("general");
  });

  it("injects system prompt into request body", async () => {
    const { applyAuditProfile } = await import("../src/audit.ts");

    const body = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    };

    const enhanced = applyAuditProfile(body, "hud-formula");

    expect(enhanced.system).toBeDefined();
    expect(Array.isArray(enhanced.system)).toBe(true);
    expect((enhanced.system as any[])[0].text).toContain("optical inspection");
    expect((enhanced as any).thinking.budget_tokens).toBeGreaterThanOrEqual(4096);
  });

  it("prepends audit prompt to existing system messages", async () => {
    const { applyAuditProfile } = await import("../src/audit.ts");

    const body = {
      model: "test",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [],
    };

    const enhanced = applyAuditProfile(body, "hud-tolerance");
    const system = enhanced.system as any[];

    expect(system).toHaveLength(2);
    expect(system[0].text).toContain("tolerance");
    expect(system[1].text).toBe("You are helpful.");
  });

  it("lists all audit modes", async () => {
    const { listAuditModes } = await import("../src/audit.ts");

    const modes = listAuditModes();
    expect(modes).toHaveLength(3);
    expect(modes.map((m) => m.mode)).toContain("hud-formula");
    expect(modes.map((m) => m.mode)).toContain("hud-tolerance");
    expect(modes.map((m) => m.mode)).toContain("general");
  });
});

// ─── Unit: Model Mapping ───────────────────────────────────────────

describe("Model Mapping", () => {
  it("maps claude-sonnet-4-6 to target model", async () => {
    const { default: gatewayModule } = await import("../src/gateway.ts");
    // The mapModel function is internal to gateway.ts, so we test via the server
    // For now we verify the logic through an integration test below
  });
});

// ─── Integration: Gateway Server ───────────────────────────────────

describe("Gateway Server Integration", () => {
  const testEnvKeys = [
    "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_ANTHROPIC_BASE_URL",
    "KIMI_API_KEY", "KIMI_MODEL", "KIMI_ANTHROPIC_BASE_URL",
    "QWEN_API_KEY", "QWEN_MODEL", "QWEN_ANTHROPIC_BASE_URL",
    "GLM_API_KEY", "GLM_MODEL", "GLM_ANTHROPIC_BASE_URL",
    "MINIMAX_API_KEY", "MINIMAX_MODEL", "MINIMAX_ANTHROPIC_BASE_URL",
    "MIMO_API_KEY", "MIMO_MODEL", "MIMO_ANTHROPIC_BASE_URL",
    "GATEWAY_PORT", "PROXY_API_KEY",
    "CUSTOM1_NAME", "CUSTOM1_KEY", "CUSTOM1_BASE_URL", "CUSTOM1_MODEL",
    "CUSTOM2_NAME", "CUSTOM2_KEY", "CUSTOM2_BASE_URL", "CUSTOM2_MODEL",
    "CUSTOM3_NAME", "CUSTOM3_KEY", "CUSTOM3_BASE_URL", "CUSTOM3_MODEL",
  ] as const;

  let envBackup: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    for (const key of testEnvKeys) {
      setEnv(key, envBackup[key]);
    }
    vi.resetModules();
  });

  async function setupGateway(
    envOverrides: Record<string, string | undefined> = {},
  ) {
    // Backup env
    for (const key of testEnvKeys) {
      envBackup[key] = process.env[key];
    }

    // Clear all gateway env vars
    for (const key of testEnvKeys) {
      setEnv(key, undefined);
    }

    // Set up mock upstream
    const upstream = createMockUpstream();
    const upstreamPort = await startServer(upstream.server);

    // Configure env for test
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.DEEPSEEK_MODEL = "test-model";
    process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
    process.env.GATEWAY_PORT = "0";

    // Apply overrides
    for (const [key, value] of Object.entries(envOverrides)) {
      setEnv(key, value);
    }

    vi.resetModules();

    // Create gateway
    const { ProviderMesh } = await import("../src/providers.ts");
    const { createGateway } = await import("../src/gateway.ts");

    const mesh = new ProviderMesh();
    const gateway = createGateway(mesh);
    const gatewayPort = await startServer(gateway);

    return {
      upstream,
      upstreamPort,
      gateway,
      gatewayPort,
      mesh,
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      async close() {
        await closeServer(gateway);
        await closeServer(upstream.server);
      },
    };
  }

  it("health endpoint returns provider info", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.provider).toBe("deepseek");
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0].name).toBe("deepseek");
      expect(body.providers[0].status).toBe("up");
    } finally {
      await harness.close();
    }
  });

  it("root endpoint shows gateway info", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.name).toBe("hermes-gateway");
      expect(body.features).toContain("thinking-guardian");
      expect(body.features).toContain("provider-mesh");
      expect(body.features).toContain("audit-mode");
    } finally {
      await harness.close();
    }
  });

  it("v1/models lists Claude models", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/v1/models`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("audit-modes lists available modes", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/audit-modes`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.modes).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("proxies non-streaming request successfully", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-token",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.model).toBe("test-model"); // Remapped to provider model
    } finally {
      await harness.close();
    }
  });

  it("proxies streaming SSE response", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-token",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);

      const text = await response.text();
      expect(text).toContain("message_start");
      expect(text).toContain("thinking_delta"); // Thinking blocks present
      expect(text).toContain("message_stop");
    } finally {
      await harness.close();
    }
  });

  it("rejects with 401 when PROXY_API_KEY is set and not provided", async () => {
    const harness = await setupGateway({ PROXY_API_KEY: "secret-token" });
    try {
      const response = await fetch(`${harness.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error.type).toBe("authentication_error");
    } finally {
      await harness.close();
    }
  });

  it("accepts when PROXY_API_KEY matches", async () => {
    const harness = await setupGateway({ PROXY_API_KEY: "secret-token" });
    try {
      const response = await fetch(`${harness.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret-token",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(response.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 for unknown endpoints", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/nonexistent`);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error.type).toBe("not_found_error");
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for invalid JSON body", async () => {
    const harness = await setupGateway();
    try {
      const response = await fetch(`${harness.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-token",
        },
        body: "not json {{{",
      });

      expect(response.status).toBe(400);
    } finally {
      await harness.close();
    }
  });
});

// ─── Integration: Provider Mesh ────────────────────────────────────

describe("Provider Mesh", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("initializes with deepseek as default", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    process.env.DEEPSEEK_MODEL = "test-model";
    vi.resetModules();

    const { ProviderMesh } = await import("../src/providers.ts");
    const mesh = new ProviderMesh();

    expect(mesh.active).toBe("deepseek");
    expect(mesh.getConfig().model).toBe("test-model");
  });

  it("supports custom OpenAI-compatible providers", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    process.env.CUSTOM1_NAME = "my-provider";
    process.env.CUSTOM1_KEY = "custom-key";
    process.env.CUSTOM1_BASE_URL = "https://api.example.com/anthropic";
    process.env.CUSTOM1_MODEL = "custom-model";
    vi.resetModules();

    const { ProviderMesh } = await import("../src/providers.ts");
    const mesh = new ProviderMesh();

    const config = mesh.getConfig("my-provider");
    expect(config.name).toBe("my-provider");
    expect(config.baseUrl).toBe("https://api.example.com/anthropic");
    expect(config.model).toBe("custom-model");
    expect(config.apiKey).toBe("custom-key");
  });

  it("records failures and fails over", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    process.env.KIMI_API_KEY = "test";
    process.env.QWEN_API_KEY = "test";
    vi.resetModules();

    const { ProviderMesh } = await import("../src/providers.ts");
    const mesh = new ProviderMesh();

    expect(mesh.active).toBe("deepseek");

    // First 2 failures don't trigger failover
    mesh.recordFailure("deepseek");
    mesh.recordFailure("deepseek");
    expect(mesh.active).toBe("deepseek");
    expect(mesh.getState("deepseek")?.status).toBe("up");

    // 3rd failure triggers failover
    const newActive = mesh.recordFailure("deepseek");
    expect(newActive).toBe("kimi");
    expect(mesh.active).toBe("kimi");
    expect(mesh.getState("deepseek")?.status).toBe("down");
  });

  it("auto-recovers primary when successful", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    process.env.KIMI_API_KEY = "test";
    vi.resetModules();

    const { ProviderMesh } = await import("../src/providers.ts");
    const mesh = new ProviderMesh();

    // Fail primary, failover to kimi
    mesh.recordFailure("deepseek");
    mesh.recordFailure("deepseek");
    mesh.recordFailure("deepseek");
    expect(mesh.active).toBe("kimi");

    // Primary recovers
    mesh.recordSuccess("deepseek");
    expect(mesh.active).toBe("deepseek");
    expect(mesh.getState("deepseek")?.status).toBe("up");
  });
});
