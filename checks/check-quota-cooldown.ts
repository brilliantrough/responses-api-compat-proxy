import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'quota-cooldown-model';
const QUOTA_COOLDOWN_MS = 2000;

const RAWCHAT_QUOTA_BODY = JSON.stringify({
  error: {
    message: '您当前的 Codex 额度已用完，请返回网页端查看明细。（traceid: 0HNNTN679HQCI:00000001）',
    type: 'permission_error',
    param: null,
    code: 'codex_quota_exhausted',
  },
});

async function waitForHealthy(url: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // proxy not ready yet
    }

    await delay(150);
  }

  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'responses-proxy-quota-cooldown-'));

  const hits = { quota: 0, cloudflare: 0, ok: 0 };
  let mode = 'quota';
  const perRequest = new Map<string, number>();

  const quotaUpstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      hits.quota += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (mode === 'sse-quota') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'insufficient_quota', message: 'empty balance' } } })}\n\n`);
        return; // proxy must stop immediately, not wait for idle timeout
      }
      if (mode === 'tool-drop') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","name":"lookup","call_id":"call_test","arguments":""}}\n\n');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (mode === 'jitter') {
        assert.equal(body.prompt_cache_key, 'same-session');
        const key = JSON.stringify(body.input);
        const count = (perRequest.get(key) ?? 0) + 1;
        perRequest.set(key, count);
        if (count <= 2) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"temporary jitter"}}');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'same-channel-ok', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same channel' }] }], usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 95 } } }));
        }
        return;
      }
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(RAWCHAT_QUOTA_BODY);
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const cloudflareUpstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      hits.cloudflare += 1;
      res.writeHead(403, { 'content-type': 'text/plain; charset=UTF-8' });
      res.end('error code: 1010');
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const okUpstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
      hits.ok += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'resp_ok',
        object: 'response',
        status: 'completed',
        model: MODEL,
        output: [{ id: 'msg_ok', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fallback answer', annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  for (const server of [quotaUpstream, cloudflareUpstream, okUpstream]) {
    server.listen(0, '127.0.0.1');
  }
  await Promise.all([quotaUpstream, cloudflareUpstream, okUpstream].map(server => once(server, 'listening')));

  const addresses = [quotaUpstream, cloudflareUpstream, okUpstream].map(server => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve mock upstream address');
    }
    return address.port;
  });

  const proxyPort = addresses[2] + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      default_model: MODEL,
      channels: [
        // disable_cooldown proves the quota branch overrides the no-breaker exemption.
        { id: 'quota-ch', name: 'quota exhausted channel', base_url: `http://127.0.0.1:${addresses[0]}`, api_key: 'quota-key', disable_cooldown: true },
        { id: 'cf-ch', name: 'cloudflare banned channel', base_url: `http://127.0.0.1:${addresses[1]}`, api_key: 'cf-key' },
        { id: 'ok-ch', name: 'healthy channel', base_url: `http://127.0.0.1:${addresses[2]}`, api_key: 'ok-key' },
      ],
      models: {
        [MODEL]: { channel_ids: ['quota-ch', 'cf-ch', 'ok-ch'] },
      },
      aliases: {},
    }, null, 2),
    'utf8',
  );

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/json-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'responses-proxy-quota-cooldown-check',
      PRIMARY_PROVIDER_NAME: undefined,
      PRIMARY_PROVIDER_BASE_URL: undefined,
      PRIMARY_PROVIDER_API_KEY: undefined,
      PRIMARY_PROVIDER_DEFAULT_MODEL: undefined,
      MODEL_MAP_PATH: undefined,
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_QUOTA_COOLDOWN_MS: String(QUOTA_COOLDOWN_MS),
       PROXY_HEALTH_FAILURE_THRESHOLD: '50',
       PROXY_CHANNEL_RETRY_DELAY_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  async function postResponses(): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: 'hello', stream: false }),
    });
  }

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const first = await postResponses();
    assert.equal(first.status, 200, 'first request must fall through to the healthy channel');
    assert.match(await first.text(), /fallback answer/);
    assert.equal(hits.quota, 1);
    assert.equal(hits.cloudflare, 3);
    assert.equal(hits.ok, 1);

    const second = await postResponses();
    assert.equal(second.status, 200);
    await second.text();
    assert.equal(hits.quota, 1, 'quota-cooled channel must be skipped while cooldown is active (even with disable_cooldown)');
    assert.equal(hits.cloudflare, 6, 'cloudflare 403 must NOT trigger the quota cooldown');
    assert.equal(hits.ok, 2);

    const stats = await (await fetch(`http://127.0.0.1:${proxyPort}/admin/monitor/stats`)).json();
    const quotaRecord = stats.healthSnapshot.channels.find((entry: { channelId: string }) => entry.channelId === 'quota-ch');
    const cfRecord = stats.healthSnapshot.channels.find((entry: { channelId: string }) => entry.channelId === 'cf-ch');
    assert.ok(quotaRecord, 'quota channel must appear in health snapshot');
    assert.ok(quotaRecord.quotaRemainingSeconds > 0, 'quota cooldown must be visible in the snapshot');
    assert.equal(quotaRecord.quotaFailureCount, 1);
    assert.equal(quotaRecord.lastFailureReason, 'quota_exhausted');
    assert.equal(cfRecord.quotaRemainingSeconds, 0, 'cloudflare channel must have no quota cooldown');
    assert.ok(Number(stats.quotaCooldownMs) === QUOTA_COOLDOWN_MS, 'admin stats must expose the configured quota cooldown');

    await delay(QUOTA_COOLDOWN_MS + 300);

    const third = await postResponses();
    assert.equal(third.status, 200);
    await third.text();
    assert.equal(hits.quota, 2, 'after cooldown expiry the channel is probed again');
    assert.equal(hits.ok, 3);

    const fourth = await postResponses();
    assert.equal(fourth.status, 200);
    await fourth.text();
    assert.equal(hits.quota, 2, 'a fresh quota rejection re-arms the cooldown immediately');

    const base = `http://127.0.0.1:${proxyPort}`;
    async function monitor() { return (await fetch(base + '/admin/stats')).json(); }
    async function control(action: string, fingerprint?: string) {
      const record = (await monitor()).healthSnapshot.channels.find((entry: any) => entry.channelId === 'quota-ch');
      return fetch(base + '/admin/channels/breaker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'quota-ch', action, fingerprint: fingerprint ?? record.fingerprint }) });
    }
    assert.equal((await control('invalid')).status, 400);
    assert.equal((await control('close', 'stale-fingerprint')).status, 409);
    assert.equal((await control('close')).status, 200, 'manual recovery clears quota');
    mode = 'sse-quota';
    let beforeHits = hits.quota;
    const sseResponse = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: 'sse quota', stream: true }) });
    assert.equal(sseResponse.status, 200);
    assert.match(await sseResponse.text(), /fallback answer/);
    assert.equal(hits.quota, beforeHits + 1, 'HTTP 200 nested SSE quota skips all same-channel retries');
    assert.ok((await monitor()).healthSnapshot.channels.find((entry: any) => entry.channelId === 'quota-ch').quotaRemainingSeconds > 0);
    await control('close');
    await control('open');
    beforeHits = hits.quota;
    await (await postResponses()).text();
    assert.equal(hits.quota, beforeHits, 'manual open overrides No breaker');
    await control('close');

    mode = 'jitter';
    const beforeFallback = hits.ok;
    const beforeHealth = (await monitor()).healthSnapshot.channels.find((entry: any) => entry.channelId === 'quota-ch');
    await Promise.all(['request-one', 'request-two'].map(async input => {
      const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input, prompt_cache_key: 'same-session' }) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /same channel/);
    }));
    assert.deepEqual([...perRequest.values()], [3, 3], 'concurrent same-key requests have independent budgets');
    assert.equal(hits.ok, beforeFallback, 'two transient failures must stay on the primary');
    const afterHealth = (await monitor()).healthSnapshot.channels.find((entry: any) => entry.channelId === 'quota-ch');
    assert.equal(afterHealth.totalFailures - beforeHealth.totalFailures, 4);
    assert.equal(afterHealth.successCount - beforeHealth.successCount, 2);
    assert.equal(afterHealth.windowFailures, 4);
    assert.equal(afterHealth.windowSuccesses, 2);

    for (const streamMode of ['normalized', 'raw']) {
      mode = 'tool-drop';
      beforeHits = hits.quota;
      const beforeCf = hits.cloudflare;
      const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: 'tool', stream: true, proxy_stream_mode: streamMode }) });
      assert.match(await response.text(), /function_call/);
      assert.equal(hits.quota, beforeHits + 1, 'never replay after a tool event reached the client');
      assert.equal(hits.cloudflare, beforeCf);
    }

    const output = stdout.join('');
    assert.ok(!output.includes('Quota-exhaustion cooldown parse error'), 'no startup parse issues expected');

    console.log('Quota cooldown check passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => {
        proxy.kill('SIGKILL');
      }),
    ]);
    for (const server of [quotaUpstream, cloudflareUpstream, okUpstream]) {
      server.close();
    }
    await Promise.all([quotaUpstream, cloudflareUpstream, okUpstream].map(server => once(server, 'close')));
    await rm(tempDir, { recursive: true, force: true });
  }

  const stderrText = stderr.join('').trim();
  if (stderrText.length > 0) {
    console.error(stderrText);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
