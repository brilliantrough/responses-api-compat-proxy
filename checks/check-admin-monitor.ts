import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'responses-admin-monitor-'));
const envPath = path.join(tempDir, '.env');
const fallbackPath = path.join(tempDir, 'fallback.json');
const port = 11540 + Math.floor(Math.random() * 1000);
const modelA = 'monitor-model-a';
const modelB = 'monitor-model-b';

type MonitorStatsBody = {
  ok?: boolean;
  configuredModels?: unknown;
  configuredChannels?: unknown;
  configuredChannelDetails?: unknown;
  configuredModelRoutes?: unknown;
  healthSnapshot?: {
    channels?: unknown;
    modelChannels?: unknown;
  };
  stats?: { requestsTotal?: unknown };
};

const primaryBody = { id: 'primary-empty', object: 'response', status: 'completed', model: modelA, output: [] };
const fallbackBody = { id: 'fallback-ok', object: 'response', status: 'completed', model: modelB, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, output: [{ id: 'msg-fallback-ok', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fallback ok', annotations: [] }] }] };

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealthy(url: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }

    await delay(150);
  }

  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve mock server address');
  }
  return address.port;
}

function createMockServer(body: unknown) {
  return createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

function writeRoutingConfig(primaryPort: number, fallbackPort: number) {
  writeFileSync(
    fallbackPath,
    JSON.stringify({
      default_model: modelA,
      channels: [
        { id: 'primary', name: 'Primary Test Channel', base_url: `http://127.0.0.1:${primaryPort}`, api_key: 'primary-key' },
        { id: 'fallback-a', name: 'Fallback A', base_url: `http://127.0.0.1:${fallbackPort}`, api_key: 'fallback-key' },
      ],
      models: {
        [modelA]: { channel_ids: ['primary', 'fallback-a'] },
        [modelB]: { channel_ids: ['primary', 'fallback-a'] },
      },
      aliases: {},
    }, null, 2),
  );
}

writeFileSync(
  envPath,
  [
    `PROXY_ENV_PATH=${envPath}`,
    `PORT=${port}`,
    'HOST=127.0.0.1',
    'INSTANCE_NAME=monitor-check',
    `FALLBACK_CONFIG_PATH=${fallbackPath}`,
  ].join('\n'),
);

const primaryServer = createMockServer(primaryBody);
const fallbackServer = createMockServer(fallbackBody);
const primaryAddress = await listen(primaryServer);
const fallbackAddress = await listen(fallbackServer);
writeRoutingConfig(primaryAddress, fallbackAddress);

const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PROXY_ENV_PATH: envPath,
    PRIMARY_PROVIDER_NAME: undefined,
    PRIMARY_PROVIDER_BASE_URL: undefined,
    PRIMARY_PROVIDER_API_KEY: undefined,
    PRIMARY_PROVIDER_DEFAULT_MODEL: undefined,
    MODEL_MAP_PATH: undefined,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

let output = '';
proxy.stdout?.on('data', chunk => {
  output += String(chunk);
});
proxy.stderr?.on('data', chunk => {
  output += String(chunk);
});

function http(method: string, targetPath: string) {
  return new Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; text: string }>(
    (resolve, reject) => {
      const req = request(
        { method, host: '127.0.0.1', port, path: targetPath, agent: false, headers: { connection: 'close' } },
        res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => {
            text += chunk;
          });
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

function assertStatsFields(body: MonitorStatsBody): void {
  assert.equal('endpointHealth' in body, false);
  assert.equal(Array.isArray(body.configuredModels), true);
  assert.equal(Array.isArray(body.configuredChannels), true);
  assert.equal(Array.isArray(body.configuredChannelDetails), true);
  assert.equal(Array.isArray(body.configuredModelRoutes), true);
  assert.deepEqual(body.configuredModels, [modelA, modelB]);
  assert.deepEqual(body.configuredChannels, ['primary', 'fallback-a']);
  assert.equal(Array.isArray(body.healthSnapshot?.channels), true);
  assert.equal(Array.isArray(body.healthSnapshot?.modelChannels), true);
  assert.equal(typeof body.stats?.requestsTotal, 'number');

  const routes = body.configuredModelRoutes as Array<{ canonicalModel?: string; channelIds?: string[] }>;
  const routeA = routes.find(route => route.canonicalModel === modelA);
  assert.ok(routeA);
  assert.deepEqual(routeA.channelIds, ['primary', 'fallback-a']);

  const channels = body.healthSnapshot?.channels as Array<{ channelId?: string; state?: string; halfOpenProbeInFlight?: number }>;
  const modelChannels = body.healthSnapshot?.modelChannels as Array<{ channelId?: string; canonicalModel?: string; state?: string }>;
  assert.equal(channels.length, 2);
  assert.equal(modelChannels.length, 4);
  assert.ok(channels.some(channel => channel.channelId === 'primary' && channel.state === 'closed'));
  assert.ok(modelChannels.some(channel => channel.channelId === 'primary' && channel.canonicalModel === modelA && channel.state === 'closed'));
  assert.ok(modelChannels.some(channel => channel.channelId === 'fallback-a' && channel.canonicalModel === modelB && channel.state === 'closed'));
  assert.equal(typeof channels[0]?.halfOpenProbeInFlight, 'number');
}

function assertMonitorStats(body: MonitorStatsBody): void {
  assert.equal(body.ok, true);
  assertStatsFields(body);
}

try {
  await waitForHealthy(`http://127.0.0.1:${port}/healthz`);

  const modelAResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelA, input: 'hello' }),
  });
  assert.equal(modelAResponse.status, 200);

  const modelBResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelB, input: 'hello again' }),
  });
  assert.equal(modelBResponse.status, 200);

  const html = await http('GET', '/admin/monitor');
  assert.equal(html.statusCode, 200);
  assert.match(html.text, /Channel Monitor/);
  assert.match(html.text, /Route Overview/);
  assert.match(html.text, /Channel Health/);
  assert.match(String(html.headers['content-type']), /text\/html/);

  const js = await http('GET', '/admin/assets/monitor.js');
  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  assert.match(js.text, /monitor\/stats/);
  assert.match(js.text, /setInterval\(poll, 1000\)/);
  assert.match(js.text, /visibilitychange/);
  assert.match(js.text, /healthSnapshot/);
  assert.match(js.text, /configuredModelRoutes/);
  assert.match(js.text, /toggleChannel/);
  assert.match(js.text, /aria-expanded/);
  assert.doesNotMatch(js.text, /endpointHealth/);

  const css = await http('GET', '/admin/assets/monitor.css');
  assert.equal(css.statusCode, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);
  assert.match(css.text, /--surface-canvas/);
  assert.match(css.text, /\.model-children/);
  assert.match(css.text, /\.state-badge/);

  await delay(50);
  const beforeLog = output;
  for (let i = 0; i < 3; i += 1) {
    const stats = await http('GET', '/admin/monitor/stats');
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.headers['cache-control'], 'no-store');
    assertMonitorStats(JSON.parse(stats.text) as MonitorStatsBody);
  }
  const newLog = output.slice(beforeLog.length);
  assert.equal(newLog.includes('admin stats returned'), false);
  assert.equal(newLog.includes('monitor stats returned'), false);
  assert.equal(/\[r\d+\]/.test(newLog), false, `monitor polling should not emit request logs, got: ${newLog}`);

  const oldStats = await http('GET', '/admin/stats');
  assert.equal(oldStats.statusCode, 200);
  assertStatsFields(JSON.parse(oldStats.text) as MonitorStatsBody);

  console.log('Admin monitor checks passed.');
} finally {
  if (proxy.pid) {
    try {
      process.kill(-proxy.pid, 'SIGTERM');
    } catch {
      proxy.kill('SIGTERM');
    }
  }
  primaryServer.close();
  fallbackServer.close();
  const exited = await Promise.race([
    once(proxy, 'exit').then(() => true),
    delay(3000).then(() => false),
  ]);
  if (!exited && proxy.pid) {
    try {
      process.kill(-proxy.pid, 'SIGKILL');
    } catch {
      proxy.kill('SIGKILL');
    }
    await Promise.race([once(proxy, 'exit'), delay(1000)]);
  }
  proxy.stdout?.destroy();
  proxy.stderr?.destroy();
  await rm(tempDir, { recursive: true, force: true });
}
