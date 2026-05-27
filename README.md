# deepseek-claude-proxy

A minimal proxy that lets Claude Code use DeepSeek as its backend.

## What it does

Claude Code speaks the Anthropic Messages API natively. DeepSeek provides an Anthropic-compatible endpoint at `https://api.deepseek.com/anthropic`. This proxy sits between them and handles one thing: mapping Claude model names to DeepSeek model names.

```
Claude Code  →  deepseek-claude-proxy  →  DeepSeek /anthropic
                (model name mapping)
```

## Quick Start

```bash
export DEEPSEEK_API_KEY=sk-your-key

# Run directly
npx deepseek-claude-proxy

# Or install globally
npm install -g deepseek-claude-proxy
deepseek-claude-proxy
```

Then point Claude Code at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=any-string-works
claude
```

### Docker

```bash
echo "DEEPSEEK_API_KEY=sk-your-key" > .env
docker compose up -d
```

## Configuration

All via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | *(required)* | Your DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model name to use |
| `DEEPSEEK_ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic endpoint |
| `PROXY_PORT` | `8080` | Server port |
| `PROXY_API_KEY` | *(optional)* | Require this token in client requests |

## How it works

The proxy is ~120 lines of TypeScript with zero npm dependencies (Node 20+ only).

When Claude Code sends a request with `model: "claude-sonnet-4-6"`, the proxy replaces it with `DEEPSEEK_MODEL` (default: `deepseek-v4-pro`). Non-Claude model names pass through unchanged. Everything else — streaming, tool use, thinking blocks — is forwarded as-is.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Messages API proxy |
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | Model listing |

## Library usage

```ts
import { createApp } from "deepseek-claude-proxy";

const server = createApp();
server.listen(8080);
```

## License

MIT
