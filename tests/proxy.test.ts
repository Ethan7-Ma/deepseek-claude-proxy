import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from '../src/proxy.ts';

function mockUpstream(): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (req.headers['x-api-key'] !== 'sk-test') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return;
    }

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"message_start","message":{"id":"msg_1","model":"deepseek-v4-pro"}}\n\n');
      res.write('data: {"type":"content_block_start","content_block":{"type":"text","text":"Hello"}}\n\n');
      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'x-request-id': 'req_test_123',
    });
    res.end(JSON.stringify({
      id: 'msg_1',
      model: body.model || 'deepseek-v4-pro',
      content: [{ type: 'text', text: `Model used: ${body.model}` }],
      stop_reason: 'end_turn',
    }));
  });
}

let upstream: Server;
let upstreamPort: number;
let upstreamUrl: string;

async function setup(): Promise<void> {
  upstream = mockUpstream();
  await new Promise<void>(r => upstream.listen(0, r));
  upstreamPort = (upstream.address() as { port: number }).port;
  upstreamUrl = `http://localhost:${upstreamPort}`;
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = upstreamUrl;
  delete process.env.PROXY_API_KEY;
}

async function teardown(): Promise<void> {
  await new Promise(r => upstream.close(r));
  delete process.env.PROXY_API_KEY;
}

describe('POST /v1/messages', () => {
  beforeEach(setup);
  afterEach(teardown);

  async function send(body: Record<string, unknown>, headers?: Record<string, string>) {
    const app = createApp();
    await new Promise<void>(r => app.listen(0, r));
    const port = (app.address() as { port: number }).port;
    const resp = await fetch(`http://localhost:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    app.close();
    return resp;
  }

  it('proxies non-streaming requests', async () => {
    const resp = await send({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.model).toBe('deepseek-v4-pro');
  });

  it('proxies streaming SSE requests', async () => {
    const resp = await send({
      model: 'claude-haiku-4-5', max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }], stream: true,
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('message_start');
    expect(text).toContain('message_stop');
  });

  it('maps Claude model names to DeepSeek model', async () => {
    const resp = await send({
      model: 'claude-opus-4-7', max_tokens: 100,
      messages: [{ role: 'user', content: 'Test' }],
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.model).toBe('deepseek-v4-pro');
  });

  it('passes non-Claude model names through unchanged', async () => {
    const resp = await send({
      model: 'gpt-4', max_tokens: 100,
      messages: [{ role: 'user', content: 'Test' }],
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.model).toBe('gpt-4');
  });

  it('maps short aliases (sonnet, opus, haiku)', async () => {
    for (const alias of ['sonnet', 'opus', 'haiku']) {
      const resp = await send({
        model: alias, max_tokens: 100,
        messages: [{ role: 'user', content: 'Test' }],
      });
      expect(resp.status).toBe(200);
      const json = await resp.json();
      expect(json.model).toBe('deepseek-v4-pro');
    }
  });

  it('returns 401 when PROXY_API_KEY is set and missing', async () => {
    process.env.PROXY_API_KEY = 'secret-token';
    const resp = await send({
      model: 'claude-sonnet-4-6', max_tokens: 100,
      messages: [{ role: 'user', content: 'Test' }],
    });
    expect(resp.status).toBe(401);
  });

  it('accepts x-api-key header when PROXY_API_KEY is set', async () => {
    process.env.PROXY_API_KEY = 'secret-token';
    const resp = await send(
      { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'Test' }] },
      { 'x-api-key': 'secret-token' },
    );
    expect(resp.status).toBe(200);
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp();
    await new Promise<void>(r => app.listen(0, r));
    const port = (app.address() as { port: number }).port;
    const resp = await fetch(`http://localhost:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(resp.status).toBe(400);
    app.close();
  });
});

describe('GET endpoints', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('/health returns status ok', async () => {
    const app = createApp();
    await new Promise<void>(r => app.listen(0, r));
    const port = (app.address() as { port: number }).port;
    const resp = await fetch(`http://localhost:${port}/health`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe('ok');
    expect(json.provider).toBe('deepseek');
    app.close();
  });

  it('/v1/models returns Claude model list', async () => {
    const app = createApp();
    await new Promise<void>(r => app.listen(0, r));
    const port = (app.address() as { port: number }).port;
    const resp = await fetch(`http://localhost:${port}/v1/models`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data.every((m: { id: string }) => m.id.startsWith('claude-'))).toBe(true);
    app.close();
  });

  it('/nonexistent returns 404', async () => {
    const app = createApp();
    await new Promise<void>(r => app.listen(0, r));
    const port = (app.address() as { port: number }).port;
    const resp = await fetch(`http://localhost:${port}/nonexistent`);
    expect(resp.status).toBe(404);
    app.close();
  });
});
