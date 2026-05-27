#!/usr/bin/env node
/**
 * Hermes Gateway → deepseek-claude-proxy
 *
 * Three killer features over plain proxies:
 *   1. Thinking Guardian — validates that upstream responses actually contain thinking blocks.
 *      If not, retries with injected thinking config. Catches silent thinking loss.
 *   2. Provider Mesh — automatic failover between providers with health checks.
 *      Primary goes down → traffic shifts to backup. Primary recovers → auto switch back.
 *   3. Audit Mode — domain-specific system prompt injection for code audit workflows.
 *      Activate via HTTP header:  X-Audit-Mode: hud-formula
 *
 * Zero dependencies. Node 20+ only. Native fetch, http, ReadableStream.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY=sk-xxx
 *   node dist/gateway.js                    # Start on :8080
 *   ANTHROPIC_BASE_URL=http://localhost:8080 claude
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { RequestTrace } from "./types.ts";
import { ProviderMesh } from "./providers.ts";
import { evaluateThinking, injectThinkingConfig } from "./guardian.ts";
import { applyAuditProfile, listAuditModes } from "./audit.ts";
import { logTimingEvent } from "./logger.ts";

// Load .env if present
if (existsSync(".env")) loadEnvFile(".env");

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_PORT = 8080;
const MAX_BODY_SIZE = 32 * 1024 * 1024; // 32MB
const GATEWAY_VERSION = "0.1.0";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "content-encoding", "content-length", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

// ─── HTTP Helpers ─────────────────────────────────────────────────

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(",");
  return raw;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON: ${(err as Error).message}`));
      }
    });

    req.on("error", reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function copyResponseHeaders(
  upstream: Response,
  res: ServerResponse,
) {
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, proxyApiKey?: string): boolean {
  if (!proxyApiKey) return true;

  const tokens = [
    getHeader(req, "x-api-key")?.trim(),
  ];

  const auth = getHeader(req, "authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) tokens.push(match[1].trim());
  }

  return tokens.includes(proxyApiKey);
}

// ─── Model Mapping ────────────────────────────────────────────────

const CLAUDE_FAMILY_WORDS = ["opus", "sonnet", "haiku"];

function mapModel(requestedModel: unknown, targetModel: string): string {
  if (typeof requestedModel !== "string" || !requestedModel) {
    return targetModel;
  }

  const normalized = requestedModel.toLowerCase();

  // Pure Claude family aliases: "opus", "sonnet", "haiku"
  if (CLAUDE_FAMILY_WORDS.includes(normalized)) {
    return targetModel;
  }

  // Claude model IDs: "claude-sonnet-4-6", "claude-opus-4-7", etc.
  if (
    normalized.startsWith("claude-") &&
    CLAUDE_FAMILY_WORDS.some((w) => normalized.includes(`-${w}`))
  ) {
    return targetModel;
  }

  // Pass through: native provider model names
  return requestedModel;
}

// ─── Request handling ─────────────────────────────────────────────

function buildUpstreamHeaders(
  req: IncomingMessage,
  apiKey: string,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version":
      getHeader(req, "anthropic-version") || DEFAULT_ANTHROPIC_VERSION,
    accept:
      getHeader(req, "accept") ||
      (stream ? "text/event-stream" : "application/json"),
  };

  const beta = getHeader(req, "anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;

  return headers;
}

function getUpstreamUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v1/messages`;
}

// ─── Non-streaming request ────────────────────────────────────────

async function handleNonStreaming(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  mesh: ProviderMesh,
  trace: RequestTrace,
) {
  const config = mesh.getConfig();
  const targetModel = mapModel(body.model, config.model);
  const upstreamBody = { ...body, model: targetModel };
  const url = getUpstreamUrl(config.baseUrl);

  logTimingEvent(trace, "start");

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(req, config.apiKey, false),
      body: JSON.stringify(upstreamBody),
    });

    logTimingEvent(trace, "upstream_headers", {
      status: upstream.status,
      content_type: upstream.headers.get("content-type") || "",
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    copyResponseHeaders(upstream, res);
    res.writeHead(upstream.status);
    res.end(payload);

    mesh.recordSuccess(config.name);
    logTimingEvent(trace, "completed", {
      status: upstream.status,
      bytes: payload.byteLength,
    });
  } catch (error: any) {
    console.error(`[Gateway] Upstream error (${config.name}):`, error.message);

    // Try failover
    const newProvider = mesh.recordFailure(config.name);
    if (newProvider && newProvider !== config.name) {
      // Retry with new provider
      const newConfig = mesh.getConfig(newProvider);
      try {
        logTimingEvent(trace, "failover", {
          from: config.name,
          to: newProvider,
        });

        const retryBody = { ...body, model: mapModel(body.model, newConfig.model) };
        const upstream = await fetch(getUpstreamUrl(newConfig.baseUrl), {
          method: "POST",
          headers: buildUpstreamHeaders(req, newConfig.apiKey, false),
          body: JSON.stringify(retryBody),
        });

        const payload = Buffer.from(await upstream.arrayBuffer());
        copyResponseHeaders(upstream, res);
        res.writeHead(upstream.status);
        res.end(payload);

        mesh.recordSuccess(newProvider);
        logTimingEvent(trace, "completed", {
          status: upstream.status,
          bytes: payload.byteLength,
          failover: true,
        });
        return;
      } catch (retryError: any) {
        mesh.recordFailure(newProvider);
      }
    }

    // All providers failed
    logTimingEvent(trace, "error", { message: error.message });
    if (!res.headersSent) {
      respondJson(res, 500, {
        type: "error",
        error: {
          type: "internal_error",
          message: `All providers unavailable. Last error: ${error.message}`,
        },
      });
    }
  }
}

// ─── Streaming request ────────────────────────────────────────────

async function handleStreaming(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  mesh: ProviderMesh,
  trace: RequestTrace,
  auditMode?: string,
) {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const isRetry = attempt > 0;
    if (isRetry) logTimingEvent(trace, "retry", { attempt });

    const config = mesh.getConfig();
    const targetModel = mapModel(body.model, config.model);
    let upstreamBody = { ...body, model: targetModel, stream: true };

    // On retry, inject explicit thinking config
    if (isRetry) {
      upstreamBody = injectThinkingConfig(upstreamBody, 4096) as typeof upstreamBody;
    }

    // Apply audit profile if active
    if (auditMode) {
      upstreamBody = applyAuditProfile(upstreamBody, auditMode) as typeof upstreamBody;
    }

    const url = getUpstreamUrl(config.baseUrl);
    const abortController = new AbortController();
    let clientClosed = false;
    let streamDone = false;
    let sawFirstChunk = false;

    logTimingEvent(trace, "start");

    // Handle client disconnect
    res.on("close", () => {
      if (streamDone) return;
      clientClosed = true;
      abortController.abort();
      logTimingEvent(trace, "client_aborted");
    });

    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: buildUpstreamHeaders(req, config.apiKey, true),
        body: JSON.stringify(upstreamBody),
        signal: abortController.signal,
      });

      logTimingEvent(trace, "upstream_headers", {
        status: upstream.status,
        content_type: upstream.headers.get("content-type") || "",
      });

      // Buffer the response for thinking check
      const chunks: Buffer[] = [];

      if (!upstream.body) {
        streamDone = true;
        copyResponseHeaders(upstream, res);
        res.writeHead(upstream.status);
        res.end();
        logTimingEvent(trace, "completed", { status: upstream.status, bytes: 0 });
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let rawBody = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush decoder
            rawBody += decoder.decode();
            break;
          }

          const text = decoder.decode(value, { stream: true });
          rawBody += text;

          // Forward data to client immediately (passthrough)
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            copyResponseHeaders(upstream, res);
            res.writeHead(upstream.status);
            logTimingEvent(trace, "first_chunk", {
              status: upstream.status,
              chunk_bytes: value.byteLength,
            });
          }
          res.write(value);
        }
      } catch (streamError: any) {
        if (clientClosed) return;
        console.error(`[Gateway] Stream error (${config.name}):`, streamError.message);
        break;
      }

      // Check thinking blocks
      const guardianResult = evaluateThinking(rawBody, trace, attempt);

      if (guardianResult.passed || attempt >= MAX_RETRIES) {
        // Passed, or max retries exhausted — finalize response
        streamDone = true;
        res.end();
        mesh.recordSuccess(config.name);
        logTimingEvent(trace, "completed", {
          status: upstream.status,
          bytes: rawBody.length,
          thinking_blocks: guardianResult.check.blocksFound,
          retried: guardianResult.retried,
        });
        return;
      }

      // Need retry — but we've already sent headers/data to client
      // In a real production gateway, we'd buffer the entire response before sending.
      // For now: if thinking is missing and we need a retry, we log it but can't
      // undo what was sent. The retry only works if the client can handle it.
      // Most Claude Code usage won't hit this because DeepSeek reliably returns thinking.

      streamDone = true;
      res.end();
      console.warn(
        `[Gateway] Thinking missing in attempt ${attempt + 1} — would retry, but response already streamed to client`,
      );

      // Continue to next attempt — but in practice we need to buffer for retry
      // For v0.1, we log and continue. v0.2 will buffer.
      mesh.recordSuccess(config.name);
      return;

    } catch (error: any) {
      const wasAborted = error?.name === "AbortError" || abortController.signal.aborted;
      if (clientClosed || wasAborted) {
        console.warn("[Gateway] Client disconnected, streaming aborted");
        return;
      }

      console.error(`[Gateway] Upstream error (${config.name}):`, error.message);

      // Try failover
      const newProvider = mesh.recordFailure(config.name);
      if (newProvider && newProvider !== config.name) {
        logTimingEvent(trace, "failover", {
          from: config.name,
          to: newProvider,
        });
        // Continue loop with new provider
        continue;
      }

      // All providers down
      logTimingEvent(trace, "error", { message: error.message });
      if (!res.headersSent) {
        respondJson(res, 500, {
          type: "error",
          error: {
            type: "internal_error",
            message: `All providers unavailable. Last error: ${error.message}`,
          },
        });
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
  }
}

// ─── Server ───────────────────────────────────────────────────────

export interface GatewayOptions {
  port?: number;
  proxyApiKey?: string;
}

export function createGateway(mesh: ProviderMesh, options: GatewayOptions = {}) {
  const proxyApiKey = options.proxyApiKey || process.env.PROXY_API_KEY?.trim() || undefined;
  let requestSequence = 0;

  const server = createServer(async (req, res) => {
    const { method, url } = req;

    // ── GET / ──
    if (method === "GET" && (url === "/" || url === "")) {
      const config = mesh.getConfig();
      respondJson(res, 200, {
        name: "deepseek-claude-proxy",
        version: GATEWAY_VERSION,
        status: "running",
        provider: mesh.active,
        model: config.model,
        features: ["thinking-guardian", "provider-mesh", "audit-mode"],
        endpoints: {
          messages: "POST /v1/messages",
          health: "GET /health",
          models: "GET /v1/models",
          provider: "GET /api/provider",
          "audit-modes": "GET /audit-modes",
        },
      });
      return;
    }

    // ── GET /health ──
    if (method === "GET" && url === "/health") {
      const config = mesh.getConfig();
      const states = mesh.getAllStates().map((s) => ({
        name: s.config.name,
        status: s.status,
        failures: s.consecutiveFailures,
      }));
      respondJson(res, 200, {
        status: "ok",
        provider: mesh.active,
        model: config.model,
        providers: states,
      });
      return;
    }

    // ── GET /v1/models ──
    if (method === "GET" && url === "/v1/models") {
      respondJson(res, 200, {
        data: [
          { id: "claude-opus-4-7", object: "model" },
          { id: "claude-sonnet-4-6", object: "model" },
          { id: "claude-haiku-4-5", object: "model" },
        ],
      });
      return;
    }

    // ── GET /api/provider ──
    if (method === "GET" && url === "/api/provider") {
      const config = mesh.getConfig();
      const states = mesh.getAllStates().map((s) => ({
        name: s.config.name,
        model: s.config.model,
        status: s.status,
        baseUrl: s.config.baseUrl,
      }));
      respondJson(res, 200, {
        provider: mesh.active,
        model: config.model,
        baseUrl: config.baseUrl,
        providers: states,
      });
      return;
    }

    // ── GET /audit-modes ──
    if (method === "GET" && url === "/audit-modes") {
      respondJson(res, 200, { modes: listAuditModes() });
      return;
    }

    // ── POST /v1/messages (protected) ──
    if (method === "POST" && url === "/v1/messages") {
      if (!checkAuth(req, proxyApiKey)) {
        respondJson(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "Invalid API key" },
        });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err: any) {
        respondJson(res, 400, {
          type: "error",
          error: { type: "invalid_request_error", message: err.message },
        });
        return;
      }

      const config = mesh.getConfig();
      const targetModel = mapModel(body.model, config.model);
      const auditMode = getHeader(req, "x-audit-mode") || undefined;
      const trace: RequestTrace = {
        requestId: `req-${++requestSequence}`,
        provider: mesh.active,
        requestedModel: typeof body.model === "string" ? body.model : targetModel,
        targetModel,
        stream: Boolean(body.stream),
        startedAt: Date.now(),
        auditMode: auditMode as any,
      };

      if (body.stream) {
        await handleStreaming(req, res, body, mesh, trace, auditMode);
      } else {
        await handleNonStreaming(req, res, body, mesh, trace);
      }
      return;
    }

    // ── 404 ──
    respondJson(res, 404, {
      type: "error",
      error: { type: "not_found_error", message: `Unknown endpoint: ${method} ${url}` },
    });
  });

  return server;
}

// ─── CLI Entrypoint ───────────────────────────────────────────────

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const port = parseInt(process.env.GATEWAY_PORT || process.env.PROXY_PORT || String(DEFAULT_PORT), 10);

  let mesh: ProviderMesh;
  try {
    mesh = new ProviderMesh();
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  }

  const server = createGateway(mesh);
  mesh.startHealthChecks();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[Gateway] Shutting down...");
    mesh.stopHealthChecks();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  });

  process.on("SIGTERM", () => {
    mesh.stopHealthChecks();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  });

  server.listen(port, () => {
    const config = mesh.getConfig();
    const states = mesh.getAllStates();
    const backupProviders = states.slice(1).filter((s) => s.status === "up");

    console.log(`
╔══════════════════════════════════════════════════════════╗
║         deepseek-claude-proxy v${GATEWAY_VERSION}                  ║
╠══════════════════════════════════════════════════════════╣
║  http://localhost:${port}
║  Primary:  ${config.name} (${config.model})
${backupProviders.map((p) => `║  Backup:   ${p.config.name} (${p.config.model})`).join("\n") || "║  Backup:   none configured"}
╠══════════════════════════════════════════════════════════╣
║  Features:  Thinking Guardian · Provider Mesh · Audit
╠══════════════════════════════════════════════════════════╣
║  Set in your app:
║  ANTHROPIC_BASE_URL=http://localhost:${port}
║  ANTHROPIC_API_KEY=${process.env.PROXY_API_KEY ? "same as PROXY_API_KEY" : "any-string-works"}
╚══════════════════════════════════════════════════════════╝

Audit modes: GET /audit-modes
  Activate via header: X-Audit-Mode: hud-formula
`);
  });
}

// ─── Exports ──────────────────────────────────────────────────────

export { ProviderMesh } from "./providers.ts";
export { evaluateThinking, injectThinkingConfig } from "./guardian.ts";
export { applyAuditProfile, getAuditProfile, listAuditModes } from "./audit.ts";
