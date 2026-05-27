# Hermes Gateway

**Intelligent Anthropic-protocol gateway** — the thinking proxy that actually checks if thinking worked.

```
Claude Code → Hermes Gateway → DeepSeek /anthropic
                  │
                  ├─ Thinking Guardian: validates thinking blocks, retries if missing
                  ├─ Provider Mesh: auto failover DeepSeek→Kimi→Qwen
                  └─ Audit Mode: inject HUD formula review prompts via header
```

## Why this exists

Every other Claude proxy is a **dumb pipe** — they forward bytes without knowing what's inside. When DeepSeek silently drops `thinking` blocks, your Claude Code session degrades and you never know why.

**Hermes Gateway actually inspects the response.** It scans SSE streams for thinking blocks. If none are found, it retries with explicit thinking configuration. It also auto-fails over between providers and can inject domain-specific system prompts for code audit workflows.

## Quick Start

```bash
# Requires Node.js 20.12+
npx hermes-gateway

# Or install globally
npm install -g hermes-gateway
hermes-gateway
```

Configure your API key:

```bash
export DEEPSEEK_API_KEY=sk-your-key
```

Then point Claude Code at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=any-string-works
claude
```

## Three Killer Features

### 1. Thinking Guardian

DeepSeek's `/anthropic` endpoint converts `reasoning_content` to Anthropic `thinking` blocks — but only when `thinking: { type: "enabled", budget_tokens: N }` is present. If the client doesn't send it (Claude Code sometimes omits it), thinking silently disappears.

The Guardian scans every streaming response for thinking blocks. If none are found:
- **Attempt 1**: Retry with `thinking: { type: "enabled", budget_tokens: 4096 }` injected
- **Attempt 2**: Retry with higher budget
- **Final**: Pass through with a warning log

You'll see `[Gateway]` log lines with `phase: "thinking_check"` showing block counts.

### 2. Provider Mesh

```yaml
deepseek (primary) ──→ 100% traffic
  ├── DOWN? ──→ kimi takes over
  ├── RECOVERED? ──→ auto switch back
  └── health check every 30s
```

Configure multiple providers:

```bash
export DEEPSEEK_API_KEY=sk-xxx      # Primary
export KIMI_API_KEY=sk-yyy          # Backup
export QWEN_API_KEY=sk-zzz          # Backup
```

Health checks run every 30 seconds. After 3 consecutive failures, a provider is marked DOWN and traffic shifts to the next healthy one. When the primary recovers, traffic automatically shifts back.

### 3. Audit Mode

Activate HUD-specific code review with a single header:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "X-Audit-Mode: hud-formula" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":4096,"messages":[...]}'
```

Available modes:
| Mode | Description |
|------|-------------|
| `hud-formula` | HUD optical formula chain audit — traces pixel→mm→angle conversion chains |
| `hud-tolerance` | HUD tolerance configuration audit — detects conflicting hardcoded values |
| `general` | General code review with enhanced reasoning |

Get the full list: `GET /audit-modes`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (main proxy) |
| `GET` | `/health` | Health check with provider status |
| `GET` | `/v1/models` | Claude model listing |
| `GET` | `/api/provider` | Current provider info |
| `GET` | `/audit-modes` | Available audit modes |

## Configuration

All via environment variables or `.env` file:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek API key | *(required)* |
| `DEEPSEEK_MODEL` | Model name | `deepseek-v4-pro` |
| `KIMI_API_KEY` | Kimi API key (backup) | — |
| `QWEN_API_KEY` | Qwen API key (backup) | — |
| `GATEWAY_PORT` | Server port | `8080` |
| `PROXY_API_KEY` | Optional auth token | *(no auth)* |

## Compared to alternatives

| | Hermes Gateway | claude-proxy | CCR-Rust | UnicludeProxy | LiteLLM |
|---|:---:|:---:|:---:|:---:|:---:|
| **Thinking validation** | ✅ Active check | ❌ Blind passthrough | ❌ Disabled | ✅ Manual setup | ❌ Broken |
| **Provider failover** | ✅ Auto health checks | ❌ Manual switch | ✅ Manual switch | ❌ None | ✅ Yes |
| **Audit prompts** | ✅ Domain-specific | ❌ None | ❌ None | ❌ None | ❌ None |
| **Dependencies** | 0 (Node 20 native) | 1 (Express) | 0 (Rust binary) | 5+ (Python) | Docker |
| **Code size** | ~1200 lines | 549 lines | Full Rust stack | Python | Huge |
| **Deploy** | `npx` / `node` | `npx` / `npm -g` | `cargo build` | `pip` + 3 fixes | Docker |

## Library Usage

```ts
import { createGateway, ProviderMesh } from "hermes-gateway";

const mesh = new ProviderMesh();
const server = createGateway(mesh, { port: 8080 });
mesh.startHealthChecks();
server.listen(8080);
```

## License

MIT
