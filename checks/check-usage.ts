import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createUsageStore, parseUsageQuery } from '../src/usage-store.js';
import { beginUsageAttempt, usageContext } from '../src/usage-tracking.js';
import { extractUsageMetrics } from '../src/responses-sse.js';
import { collectUptime, UPTIME_INTERVAL_MS } from '../src/uptime.js';
import { createHealthRegistry } from '../src/channel-health.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';

const dir = await mkdtemp(join(tmpdir(), 'relay-usage-'));
const boundary = Date.parse('2026-09-11T16:00:00Z'); // midnight UTC+8
const query = { from: boundary - 86400000, to: boundary + 86400000, bucket: 'day' as const, offset: 480, channels: [], models: [], kind: 'all' };
let store = createUsageStore(join(dir, 'history.sqlite'));
let proxy: ChildProcess | undefined;
let output = '';
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const input = JSON.stringify(body.input);
  if (req.url?.startsWith('/bad/')) {
    res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'unavailable' } })); return;
  }
  const payload = { id: 'response-check', object: 'response', status: 'completed', model: body.model,
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } },
    output: [{ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
  };
  if (input.includes('"missing"')) delete (payload as { usage?: unknown }).usage;
  if (input.includes('"failed"')) payload.status = 'failed';
  if (input.includes('"cancel"')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', response: { ...payload, status: 'in_progress' } })}\n\n`);
    return;
  }
  if (body.stream) {
    res.writeHead(200, { 'content-type': input.includes('"probe"') ? 'text/plain' : 'text/event-stream' });
    res.end(['response.created', 'response.completed', 'response.completed'].map(type => `event: ${type}\ndata: ${JSON.stringify({ type, response: payload })}\n\n`).join(''));
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }
});

async function listen(server: ReturnType<typeof createServer>) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
async function stop() { if (proxy && proxy.exitCode === null) { const exited = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exited; } }
try {
  await usageContext.run({ requestId: 'boundary-request', write: row => store.write({ ...row, startedAt: row.channelId === 'a' ? boundary - 1 : boundary }) }, async () => {
    const a = beginUsageAttempt({ id: 'a', name: 'A' }, 'model', 'responses', new AbortController().signal);
    a.row.startedAt = boundary - 1;
    extractUsageMetrics({ usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } } });
    extractUsageMetrics({ usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } } });
    a.result('failed', 'fallback');
    const b = beginUsageAttempt({ id: 'b', name: 'B' }, 'model', 'responses', new AbortController().signal);
    b.row.startedAt = boundary;
    extractUsageMetrics({ usage: { input_tokens: 200, output_tokens: 10 } });
    b.result('success'); b.finish(); b.finish();
  });
  let result: any = await store.query(query);
  assert.equal(result.requests, 1); assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].bucket, boundary - 86400000); assert.equal(result.rows[1].bucket, boundary);
  assert.equal(result.rows[0].inputTokens, 100); assert.equal(result.rows[0].failed, 1);
  assert.equal(result.rows[1].inputTokens, 200); assert.equal(result.rows[1].cacheKnown, 0);
  assert.equal(result.rows[0].cacheEligibleInput, 100); assert.equal(result.rows[0].cacheEligibleCached, 80);
  assert.equal((await store.query({ ...query, channels: ['a'], models: ['model'], bucket: 'hour' }) as any).rows.length, 1);
  assert.throws(() => parseUsageQuery(new URLSearchParams('from=1&to=9999999999999&bucket=hour')));
  await usageContext.run({ requestId: 'interrupted', write: row => store.write({ ...row, startedAt: boundary }) }, () => {
    beginUsageAttempt({ id: 'c', name: 'C' }, 'model', 'responses', new AbortController().signal);
  });
  await store.close(); store = createUsageStore(join(dir, 'history.sqlite'));
  result = await store.query(query);
  assert.equal(result.rows.reduce((n: number, row: any) => n + row.interrupted, 0), 1);
  assert.equal(result.rows.reduce((n: number, row: any) => n + row.inputTokens, 0), 300);
  await store.close();

  const upstreamPort = await listen(upstream), reserve = createServer();
  const port = await listen(reserve); await new Promise<void>(resolve => reserve.close(() => resolve()));
  await writeFile(join(dir, 'fallback.json'), JSON.stringify({ default_model: 'm', channels: [
    { id: 'bad', name: 'Bad', base_url: `http://127.0.0.1:${upstreamPort}/bad`, api_key: 'test', disable_cooldown: true },
    { id: 'good', name: 'Good', base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'test', disable_cooldown: true },
  ], models: { m: { channel_ids: ['bad','good'] }, n: { channel_ids: ['good'] } }, aliases: { alias: 'm' }, compact: { model: 'm', channel_ids: ['bad','good'], v2_channel_ids: ['good'] } }), { mode: 0o600 });
  await writeFile(join(dir, '.env'), `PORT=${port}\nHOST=127.0.0.1\nINSTANCE_NAME=usage-check\nFALLBACK_CONFIG_PATH=${join(dir,'fallback.json')}\nPROXY_COMPACT_DETECT_ENABLED=0\nPROXY_FIRST_TEXT_TIMEOUT_MS=0\nPROXY_STREAM_MISSING_USAGE_ENABLED=0\n`);
  const runtime = createRuntimeConfigStore({ envPath: join(dir, '.env') });
  let clock = Math.floor(Date.now() / UPTIME_INTERVAL_MS) * UPTIME_INTERVAL_MS;
  const health = createHealthRegistry({ now: () => clock });
  runtime.registerHealthRegistry?.(health);
  const good = runtime.getSnapshot().routingConfig.channelsById.get('good')!;
  const fail = () => {
    const acquired = health.acquire({ channelId: good.id, channelFingerprint: good.fingerprint, canonicalModel: 'm', disableCooldown: true });
    assert.ok(acquired.ok);
    health.complete(acquired.lease, { success: false, scope: 'model_channel', reason: 'timeout', channelReachabilityProven: true });
  };
  fail();
  let samples = collectUptime(runtime, health, clock);
  assert.equal(samples.find(row => row.model === 'm' && row.channelId === 'good')!.state, 'yellow');
  assert.equal(samples.find(row => row.model === 'n' && row.channelId === 'good')!.state, 'green');
  assert.equal(samples.length, 3, 'only configured ordinary model routes, no aliases or compact');
  store = createUsageStore(join(dir, 'uptime.sqlite'));
  store.writeUptime(samples); store.writeUptime(samples);
  const historyQuery = { model: 'm', from: clock, to: clock + UPTIME_INTERVAL_MS * 2 };
  assert.equal((await store.queryUptime(historyQuery) as any).rows.length, 2, 'one persisted snapshot per route per bucket');
  for (let i = 1; i < 15; i++) fail();
  assert.equal(collectUptime(runtime, health, clock).find(row => row.model === 'm' && row.channelId === 'good')!.state, 'green', 'No breaker with both thresholds met is available');
  health.control('good', 'open');
  assert.ok(collectUptime(runtime, health, clock).filter(row => row.channelId === 'good').every(row => row.state === 'red'));
  clock += UPTIME_INTERVAL_MS;
  samples = collectUptime(runtime, health, clock); store.writeUptime(samples);
  await store.close(); store = createUsageStore(join(dir, 'uptime.sqlite'));
  assert.equal((await store.queryUptime(historyQuery) as any).rows.length, 4, 'uptime survives worker restart');
  health.control('good', 'close');
  assert.ok(collectUptime(runtime, health, clock).every(row => row.state === 'green'));
  await store.close();
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    proxy = spawn(process.execPath, ['--import', 'tsx', 'src/json-proxy.ts'], { env: { ...process.env, PROXY_ENV_PATH: join(dir,'.env') }, stdio: ['ignore','pipe','pipe'] });
    proxy.stdout?.on('data', chunk => { output += chunk; }); proxy.stderr?.on('data', chunk => { output += chunk; });
    for (let i=0; i<100; i++) { try { if ((await fetch(base+'/healthz')).ok) return; } catch {} await delay(100); }
    throw new Error('Proxy startup timeout');
  }
  await start();
  const uptime = await (await fetch(base + '/admin/uptime?model=n&hours=24')).json();
  assert.deepEqual(uptime.channels.map((channel: any) => channel.id), ['good']);
  assert.ok(uptime.rows.length > 0);
  assert.ok(!JSON.stringify(uptime).includes('fingerprint'));
  assert.equal((await fetch(base + '/admin/uptime?model=alias')).status, 400);
  assert.equal((await fetch(base + '/admin/uptime?hours=99999')).status, 400);
  async function post(body: unknown, path = '/v1/responses', status = 200) { const response = await fetch(base+path, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) }); await response.text(); assert.equal(response.status,status); }
  await Promise.all(Array.from({ length: 10 }, (_,i) => post({ model: i%2 ? 'alias' : 'm', input:'OK', stream:i%2===0 })));
  await post({ model:'n', input:'missing' });
  await post({ model:'n', input:'failed' }, '/v1/responses', 502);
  await post({ model:'n', input:'probe', stream:true });
  await post({ model:'n', input:'OK', stream:true, proxy_stream_mode:'raw' });
  await post({ model:'m', input:[] }, '/v1/responses/compact');
  await post({ model:'n', stream:true, input:[{ type:'compaction_trigger' }] });
  const abort = new AbortController();
  const cancelled = await fetch(base+'/v1/responses', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({model:'n',input:'cancel',stream:true,proxy_stream_mode:'raw'}), signal:abort.signal });
  await cancelled.body!.getReader().read(); abort.abort(); await delay(150);
  const params = new URLSearchParams({ from:String(Date.now()-86400000), to:String(Date.now()+86400000), bucket:'day', offset:'480' });
  async function stats() { return (await fetch(base+'/admin/usage/stats?'+params)).json(); }
  result = await stats();
  const total = (key: string) => result.rows.reduce((n:number,row:any) => n+row[key],0);
  assert.equal(result.requests,17); assert.equal(total('attempts'),52);
  assert.equal(total('success'),15); assert.equal(total('failed'),36); assert.equal(total('cancelled'),1);
  assert.equal(total('inputTokens'),1800); assert.equal(total('outputTokens'),360); assert.equal(total('cachedInputTokens'),1080);
  assert.equal(result.rows.filter((row:any) => row.kind==='compact').reduce((n:number,row:any) => n+row.attempts,0),4);
  assert.equal(result.rows.filter((row:any) => row.kind==='compact-v2')[0].model,'n');
  assert.equal((await fetch(base+'/admin/usage/stats?from=bad')).status,400);
  const before = JSON.stringify(result.rows); await stop(); await start(); result = await stats(); assert.equal(JSON.stringify(result.rows),before);
  console.log('Usage checks passed: midnight/hour filters, missing usage, deduplication, interrupted recovery, 10 concurrent requests, fallback, JSON/SSE/raw/probe, compact v1/v2, cancellation, process restart.');
} catch (error) { console.error(output); throw error; }
finally { await stop(); upstream.closeAllConnections(); upstream.close(); await rm(dir,{ recursive:true, force:true }); }
