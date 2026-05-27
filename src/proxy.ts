import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

const CLAUDE_RE = /^claude-|^(?:opus|sonnet|haiku)$/i;

const MODELS = [
  { id: 'claude-sonnet-4-6', object: 'model' },
  { id: 'claude-haiku-4-5', object: 'model' },
  { id: 'claude-opus-4-7', object: 'model' },
];

function hdr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function mapModel(m: string): string {
  return CLAUDE_RE.test(m) ? MODEL : m;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

export function createApp() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const proxyKey = process.env.PROXY_API_KEY;
  const baseUrl = (process.env.DEEPSEEK_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/$/, '');

  function authorized(req: IncomingMessage): boolean {
    if (!proxyKey) return true;
    const tok = hdr(req, 'x-api-key') ?? hdr(req, 'authorization')?.replace(/^Bearer\s+/i, '');
    return tok === proxyKey;
  }

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', provider: 'deepseek', model: MODEL });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: MODELS });
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      if (!authorized(req)) {
        return json(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } });
      }

      let payload: Record<string, unknown>;
      try { payload = JSON.parse(await readBody(req)); } catch {
        return json(res, 400, { error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
      }

      if (typeof payload.model === 'string') {
        payload.model = mapModel(payload.model);
      }

      const streaming = payload.stream === true;
      const beta = hdr(req, 'anthropic-beta');

      let upstream: Response;
      try {
        upstream = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey!,
            'anthropic-version': hdr(req, 'anthropic-version') || '2023-06-01',
            ...(beta ? { 'anthropic-beta': beta } : {}),
          },
          body: JSON.stringify(payload),
        });
      } catch {
        return json(res, 502, { error: { type: 'api_error', message: 'Upstream unreachable' } });
      }

      if (streaming) {
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (upstream.body) {
          Readable.fromWeb(upstream.body as never).pipe(res);
        } else {
          res.end();
        }
        return;
      }

      const text = await upstream.text();
      for (const [k, v] of upstream.headers) {
        if (!['transfer-encoding', 'content-length'].includes(k.toLowerCase())) {
          res.setHeader(k, v);
        }
      }
      res.writeHead(upstream.status);
      res.end(text);
      return;
    }

    json(res, 404, { error: { type: 'not_found', message: 'Not found' } });
  });

  return srv;
}

// CLI entry
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  if (!process.env.DEEPSEEK_API_KEY) {
    process.stderr.write('Error: DEEPSEEK_API_KEY is required\n');
    process.exit(1);
  }
  createApp().listen(PORT);
  process.stderr.write(`deepseek-claude-proxy listening on port ${PORT}\n`);
}
