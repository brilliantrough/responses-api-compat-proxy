import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = 'compact-model';
const regularModel = 'regular-model';
const compactCalls = new Map<FakeMode, number>();
const compactBodies = new Map<FakeMode, unknown[]>();
const hangingSockets = new Set<Socket>();

type FakeMode = 'supported' | 'unsupported' | 'auth' | 'hang' | 'server' | 'client';

function waitForHealthy(url: string): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
      }
      if (Date.now() - startedAt > 15000) {
        reject(new Error(`timed out waiting for ${url}`));
        return;
      }
      setTimeout(() => void poll(), 100);
    };
    void poll();
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake server did not expose a port');
  }
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return port;
}

function fakeUpstream(mode: FakeMode): Server {
  return createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'regular-ok', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses/compact') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const parsedBody: unknown = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    compactCalls.set(mode, (compactCalls.get(mode) ?? 0) + 1);
    const bodies = compactBodies.get(mode) ?? [];
    bodies.push(parsedBody);
    compactBodies.set(mode, bodies);
    if (mode === 'hang') {
      hangingSockets.add(req.socket);
      req.socket.once('close', () => hangingSockets.delete(req.socket));
      return;
    }
    if (mode === 'unsupported') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'compact route missing' } }));
      return;
    }
    if (mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    if (mode === 'server') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporarily unavailable with server-key', authorization: 'Bearer leaked-token' } }));
      return;
    }
    if (mode === 'client') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'compact-ok', object: 'response.compaction', output: [{ type: 'compaction' }] }));
  });
}

function routingDocument(ports: Readonly<Record<string, number>>, compact: boolean): unknown {
  const channels = Object.entries(ports).map(([id, port]) => ({
    id,
    base_url: `http://127.0.0.1:${port}`,
    api_key: `${id}-key`,
  }));
  return {
    default_model: regularModel,
    channels,
    models: {
      [regularModel]: { channel_ids: ['unsupported', 'auth', 'supported'] },
      [model]: { channel_ids: ['unsupported', 'auth', 'supported'] },
    },
    aliases: {},
    ...(compact ? { compact: { model, channel_ids: ['unsupported', 'auth', 'supported'] } } : {}),
  };
}

async function request(baseUrl: string, body: unknown): Promise<{ status: number; json: unknown; headers: Headers }> {
  const response = await fetch(`${baseUrl}/v1/responses/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json(), headers: response.headers };
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-compact-proxy-'));
  const servers = new Map<string, Server>();
  const sockets: Server[] = [];
  const portNames: FakeMode[] = ['unsupported', 'auth', 'supported', 'hang', 'server', 'client'];
  try {
    for (const mode of portNames) {
      const server = fakeUpstream(mode);
      await listen(server);
      servers.set(mode, server);
      sockets.push(server);
    }
    const ports: Record<string, number> = {};
    for (const [name, server] of servers) {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error(`missing address for ${name}`);
      ports[name] = address.port;
    }

    const fallbackPath = path.join(tempDir, 'fallback.json');
    const envPath = path.join(tempDir, '.env');
    const proxyPort = await reservePort();
    await writeFile(fallbackPath, JSON.stringify(routingDocument(ports, false), null, 2));
    await writeFile(envPath, [
      'HOST=127.0.0.1',
      `PORT=${proxyPort}`,
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      'PROXY_UPSTREAM_TIMEOUT_MS=200',
      'PROXY_COMPACT_TIMEOUT_MS=500',
      'PROXY_HEALTH_FAILURE_THRESHOLD=3',
      'PROXY_CHANNEL_RETRY_DELAY_MS=0',
      'PROXY_COMPACT_DETECT_ENABLED=0',
      'PROXY_PROMPT_CACHE_KEY=stable-compact-key',
      'PROXY_PROMPT_CACHE_RETENTION=24h',
    ].join('\n'));

    const tsxCliPath = require.resolve('tsx/cli');
    const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
      cwd: workspaceRoot,
      env: { ...process.env, PROXY_ENV_PATH: envPath, PORT: String(proxyPort), HOST: '127.0.0.1', FALLBACK_CONFIG_PATH: fallbackPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);
      const baseUrl = `http://127.0.0.1:${proxyPort}`;

      console.log('=== 1. absent compact route returns 501 ===');
      const absent = await request(baseUrl, { model, input: [] });
      assert.equal(absent.status, 501);
      assert.equal((absent.json as { error?: { message?: string } }).error?.message, 'compact route not configured');

      console.log('=== 2. reload compact route and respect fallback order ===');
      await writeFile(fallbackPath, JSON.stringify(routingDocument(ports, true), null, 2));
      const reload = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
      assert.equal(reload.status, 200);
      const fallback = await request(baseUrl, { model: 'client-request-model', input: [] });
      assert.equal(fallback.status, 200);
      assert.equal((fallback.json as { object?: string }).object, 'response.compaction');
      assert.equal(compactCalls.get('unsupported'), 3);
      assert.equal(compactCalls.get('auth'), 3);
      assert.equal(compactCalls.get('supported'), 1);
      const forwarded = compactBodies.get('supported')?.[0] as Record<string, unknown> | undefined;
      assert.equal(forwarded?.model, model);
      assert.equal(forwarded?.prompt_cache_key, 'stable-compact-key');
      assert.equal(forwarded?.prompt_cache_retention, '24h');

      console.log('=== 3. compact failures do not open regular model breaker ===');
      const regular = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: regularModel, input: 'hello' }),
      });
      assert.equal(regular.status, 200);
      const monitor = await (await fetch(`${baseUrl}/admin/monitor/stats`)).json() as {
        healthSnapshot?: { modelChannels?: Array<{ canonicalModel?: string; channelId?: string; state?: string }> };
      };
      assert.ok(monitor.healthSnapshot?.modelChannels?.some(item => item.canonicalModel === regularModel && item.channelId === 'auth' && item.state === 'closed'));

      console.log('=== 4. timeout falls through to a later supported channel ===');
      const timeoutDocument = routingDocument({ hang: ports.hang, supported: ports.supported }, true);
      await writeFile(fallbackPath, JSON.stringify({
        ...(timeoutDocument as Record<string, unknown>),
        channels: [
          { id: 'hang', base_url: `http://127.0.0.1:${ports.hang}`, api_key: 'hang-key' },
          { id: 'supported', base_url: `http://127.0.0.1:${ports.supported}`, api_key: 'supported-key' },
        ],
        models: { [regularModel]: { channel_ids: ['hang', 'supported'] }, [model]: { channel_ids: ['hang', 'supported'] } },
        compact: { model, channel_ids: ['hang', 'supported'] },
      }, null, 2));
      const timeoutReload = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
      if (timeoutReload.status !== 200) {
        throw new Error(`timeout reload failed: ${timeoutReload.status} ${await timeoutReload.text()}`);
      }
      const timeoutResponse = await request(baseUrl, { model, input: [] });
      assert.equal(timeoutResponse.status, 200);

      console.log('=== 5. client error does not fall back ===');
      await writeFile(fallbackPath, JSON.stringify({
        ...(timeoutDocument as Record<string, unknown>),
        channels: [
          { id: 'client', base_url: `http://127.0.0.1:${ports.client}`, api_key: 'client-key' },
          { id: 'supported', base_url: `http://127.0.0.1:${ports.supported}`, api_key: 'supported-key' },
        ],
        models: { [regularModel]: { channel_ids: ['client', 'supported'] }, [model]: { channel_ids: ['client', 'supported'] } },
        compact: { model, channel_ids: ['client', 'supported'] },
      }, null, 2));
      const clientReload = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
      assert.equal(clientReload.status, 200);
      const supportedCallsBeforeClientError = compactCalls.get('supported');
      const clientResponse = await request(baseUrl, { model: 'ignored-model', input: [], prompt_cache_key: 'client-key' });
      assert.equal(clientResponse.status, 400);
      assert.equal(compactCalls.get('supported'), supportedCallsBeforeClientError);
      const clientBody = compactBodies.get('client')?.at(-1) as Record<string, unknown> | undefined;
      assert.equal(clientBody?.model, model);
      assert.equal(clientBody?.prompt_cache_key, 'client-key');

      console.log('=== 6. all blocked compact channels return 503 ===');
      await writeFile(fallbackPath, JSON.stringify({
        ...(timeoutDocument as Record<string, unknown>),
        channels: [
          { id: 'server', base_url: `http://127.0.0.1:${ports.server}`, api_key: 'server-key' },
        ],
        models: { [regularModel]: { channel_ids: ['server'] }, [model]: { channel_ids: ['server'] } },
        compact: { model, channel_ids: ['server'] },
      }, null, 2));
      const serverReload = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
      assert.equal(serverReload.status, 200);
      const firstServerFailure = await request(baseUrl, { model, input: [] });
      assert.equal(firstServerFailure.status, 502);
      assert.equal(JSON.stringify(firstServerFailure.json).includes('server-key'), false);
      assert.equal(JSON.stringify(firstServerFailure.json).includes('leaked-token'), false);
      const blocked = await request(baseUrl, { model, input: [] });
      assert.equal(blocked.status, 503);
      assert.equal((blocked.json as { error?: { message?: string } }).error?.message, 'compact_channels_unavailable');
      assert.ok(blocked.headers.get('retry-after'));
      const stats = await (await fetch(`${baseUrl}/admin/stats`)).json() as {
        stats?: { compactRequestsTotal?: number; compactFallbacks?: number; compactDetectionRuns?: number };
      };
      assert.equal(stats.stats?.compactRequestsTotal, 6);
      assert.ok((stats.stats?.compactFallbacks ?? 0) >= 2);
      assert.equal(stats.stats?.compactDetectionRuns, 0);

      console.log('Compact proxy checks passed.');
    } finally {
      proxy.kill('SIGTERM');
      await Promise.race([once(proxy, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  } finally {
    for (const socket of hangingSockets) socket.destroy();
    for (const server of sockets) server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
