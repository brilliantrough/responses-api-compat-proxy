import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  startV2TestUpstreams,
  type V2TestUpstreams,
  type V2UpstreamMode,
} from './compact-v2-test-upstreams.js';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const V2_TEST_MODEL = 'conversation-model';

export type V2RoutingPlan = Readonly<{
  normal: readonly V2UpstreamMode[];
  v1: readonly V2UpstreamMode[];
  v2?: readonly V2UpstreamMode[];
}>;

export type V2ProxyResponse = Readonly<{
  status: number;
  headers: Headers;
  text: string;
}>;

export type V2ProxyHarness = Readonly<{
  upstreams: V2TestUpstreams;
  reload(plan: V2RoutingPlan): Promise<void>;
  requestV2(betaHeader?: string): Promise<V2ProxyResponse>;
  requestNormal(): Promise<V2ProxyResponse>;
  stats(): Promise<unknown>;
  close(): Promise<void>;
}>;

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('port reservation failed');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return port;
}

function routingDocument(upstreams: V2TestUpstreams, plan: V2RoutingPlan): unknown {
  const channels = Array.from(upstreams.ports.entries()).map(([id, port]) => ({
    id,
    base_url: `http://127.0.0.1:${port}`,
    api_key: `${id}-key`,
  }));
  return {
    default_model: V2_TEST_MODEL,
    channels,
    models: { [V2_TEST_MODEL]: { channel_ids: [...plan.normal] } },
    aliases: { latest: V2_TEST_MODEL },
    compact: {
      model: 'latest',
      channel_ids: [...plan.v1],
      ...(plan.v2 === undefined ? {} : { v2_channel_ids: [...plan.v2] }),
    },
  };
}

async function waitForHealthy(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) {
      throw new Error(`proxy exited before health check: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for proxy: ${output()}`);
}

async function responseValue(response: Response): Promise<V2ProxyResponse> {
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function stopProxy(proxy: ChildProcess): Promise<void> {
  if (proxy.exitCode !== null) {
    return;
  }
  proxy.kill('SIGTERM');
  const exited = await Promise.race([once(proxy, 'exit').then(() => true), delay(3_000).then(() => false)]);
  if (!exited) {
    proxy.kill('SIGKILL');
    await Promise.race([once(proxy, 'exit'), delay(1_000)]);
  }
}

export async function startV2ProxyHarness(initialPlan: V2RoutingPlan): Promise<V2ProxyHarness> {
  const upstreams = await startV2TestUpstreams();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-compact-v2-'));
  const fallbackPath = path.join(tempDir, 'fallback.json');
  const envPath = path.join(tempDir, '.env');
  const proxyPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  await writeFile(fallbackPath, JSON.stringify(routingDocument(upstreams, initialPlan), null, 2));
  await writeFile(envPath, [
    'HOST=127.0.0.1',
    `PORT=${proxyPort}`,
    `FALLBACK_CONFIG_PATH=${fallbackPath}`,
    'PROXY_UPSTREAM_TIMEOUT_MS=100',
    'PROXY_FIRST_BYTE_TIMEOUT_MS=250',
    'PROXY_FIRST_TEXT_TIMEOUT_MS=30',
    'PROXY_STREAM_IDLE_TIMEOUT_MS=500',
    'PROXY_TOTAL_REQUEST_TIMEOUT_MS=3000',
    'PROXY_MAX_FALLBACK_TOTAL_MS=2000',
    'PROXY_COMPACT_DETECT_ENABLED=0',
    'PROXY_HEALTH_FAILURE_THRESHOLD=3',
    'PROXY_CHANNEL_RETRY_DELAY_MS=0',
  ].join('\n'));

  const output: string[] = [];
  const proxy = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PROXY_ENV_PATH: envPath,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      FALLBACK_CONFIG_PATH: fallbackPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout?.on('data', chunk => output.push(String(chunk)));
  proxy.stderr?.on('data', chunk => output.push(String(chunk)));
  await waitForHealthy(baseUrl, proxy, () => output.join(''));

  const request = async (input: readonly unknown[], betaHeader?: string): Promise<V2ProxyResponse> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (betaHeader !== undefined) {
      headers['x-codex-beta-features'] = betaHeader;
    }
    return responseValue(await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'latest', stream: true, proxy_stream_mode: 'normalized', input }),
    }));
  };

  return {
    upstreams,
    reload: async plan => {
      await writeFile(fallbackPath, JSON.stringify(routingDocument(upstreams, plan), null, 2));
      const response = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`reload failed: ${response.status} ${await response.text()}`);
      }
    },
    requestV2: betaHeader => request([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'compaction_trigger' },
    ], betaHeader),
    requestNormal: () => request([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]),
    stats: async () => (await fetch(`${baseUrl}/admin/stats`)).json(),
    close: async () => {
      await stopProxy(proxy);
      await upstreams.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
