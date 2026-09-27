import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = require.resolve('tsx/cli');
const model = process.argv[2] ?? process.env.LOAD_TEST_MODEL ?? 'gpt-5.4';
const prompt = process.env.LOAD_TEST_PROMPT ?? 'Reply with a very short greeting only.';
const rps = Number(process.env.LOAD_TEST_RPS ?? 5);
const durationMs = Number(process.env.LOAD_TEST_DURATION_MS ?? 5000);

type Result = Readonly<{
  ok: boolean;
  status: number;
  latencyMs: number;
  bodyPreview: string;
}>;

let inFlight = 0;
let maxInFlight = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealthy(url: string): Promise<void> {
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

function createProxyEnv(proxyPort: number, fallbackConfigPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    INSTANCE_NAME: 'responses-proxy-load-tool',
    FALLBACK_CONFIG_PATH: fallbackConfigPath,
  };
  const oldPrimaryPrefix = ['PRIMARY', 'PROVIDER'].join('_');
  for (const suffix of ['NAME', 'BASE_URL', 'API_KEY', 'DEFAULT_MODEL']) {
    delete env[`${oldPrimaryPrefix}_${suffix}`];
  }
  delete env[['MODEL', 'MAP', 'PATH'].join('_')];
  return env;
}

async function singleRequest(url: string, index: number): Promise<Result> {
  const startedAt = Date.now();
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: `${prompt} [request ${index + 1}]` }),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - startedAt, bodyPreview: text.slice(0, 200) };
  } catch (error) {
    return { ok: false, status: 0, latencyMs: Date.now() - startedAt, bodyPreview: error instanceof Error ? error.message : String(error) };
  } finally {
    inFlight -= 1;
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function runLoadTest(url: string): Promise<void> {
  const totalRequests = Math.max(1, Math.floor((rps * durationMs) / 1000));
  const intervalMs = 1000 / rps;
  const wallStartedAt = Date.now();
  console.log('Starting load test...');
  console.log(JSON.stringify({ url, model, rps, durationMs, totalRequests }, null, 2));

  const tasks: Array<Promise<Result>> = [];
  for (let index = 0; index < totalRequests; index += 1) {
    tasks.push(singleRequest(url, index));
    if (index < totalRequests - 1) {
      await sleep(intervalMs);
    }
  }

  const results = await Promise.all(tasks);
  const successCount = results.filter(result => result.ok).length;
  const failureCount = results.length - successCount;
  const latencies = results.map(result => result.latencyMs);
  const avgLatencyMs = latencies.length === 0 ? 0 : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
  const wallDurationMs = Date.now() - wallStartedAt;
  const statusCounts = results.reduce<Record<string, number>>((accumulator, result) => {
    const key = String(result.status);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});

  console.log('\nLoad test result:\n');
  console.log(JSON.stringify({
    totalRequests: results.length,
    successCount,
    failureCount,
    successRate: results.length === 0 ? 0 : Number((successCount / results.length).toFixed(4)),
    wallDurationMs,
    achievedRps: wallDurationMs === 0 ? 0 : Number((results.length / (wallDurationMs / 1000)).toFixed(2)),
    maxInFlight,
    avgLatencyMs,
    minLatencyMs: latencies.length === 0 ? 0 : Math.min(...latencies),
    p50LatencyMs: percentile(latencies, 50),
    p90LatencyMs: percentile(latencies, 90),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    maxLatencyMs: latencies.length === 0 ? 0 : Math.max(...latencies),
    statusCounts,
    failedSamples: results.filter(result => !result.ok).slice(0, 5),
  }, null, 2));

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

async function runWithTemporaryProxy(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-load-tool-'));
  const upstream = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_load_tool',
        object: 'response',
        status: 'completed',
        model,
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === 'string') {
    throw new Error('Failed to resolve mock upstream address');
  }

  const proxyPort = upstreamAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(fallbackConfigPath, JSON.stringify({
    default_model: model,
    channels: [{ id: 'primary', name: 'Local Load Provider', base_url: `http://127.0.0.1:${upstreamAddress.port}`, api_key: 'mock-upstream-key' }],
    models: { [model]: { channel_ids: ['primary'] } },
    aliases: {},
  }, null, 2), { encoding: 'utf8', mode: 0o600 });

  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: createProxyEnv(proxyPort, fallbackConfigPath),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    const url = `http://127.0.0.1:${proxyPort}/v1/responses`;
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);
    await runLoadTest(url);
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([once(proxy, 'exit'), delay(3000).then(() => proxy.kill('SIGKILL'))]);
    upstream.close();
    await once(upstream, 'close');
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) {
    console.error(stderrText);
  }
}

async function main(): Promise<void> {
  const configuredUrl = process.env.LOAD_TEST_URL;
  if (configuredUrl === undefined || configuredUrl.trim().length === 0) {
    await runWithTemporaryProxy();
    return;
  }
  await runLoadTest(configuredUrl.trim());
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
