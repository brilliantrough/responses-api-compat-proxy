import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'responses-admin-monitor-'));
const envPath = path.join(tempDir, '.env');
const fallbackPath = path.join(tempDir, 'fallback.json');
const modelMapPath = path.join(tempDir, 'model-map.json');
const port = 11540 + Math.floor(Math.random() * 1000);

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

writeFileSync(
  envPath,
  [
    `PROXY_ENV_PATH=${envPath}`,
    `PORT=${port}`,
    'HOST=127.0.0.1',
    'INSTANCE_NAME=monitor-check',
    'PRIMARY_PROVIDER_NAME=mock-primary',
    'PRIMARY_PROVIDER_BASE_URL=https://primary.example',
    'PRIMARY_PROVIDER_API_KEY=primary-key',
    `FALLBACK_CONFIG_PATH=${fallbackPath}`,
    `MODEL_MAP_PATH=${modelMapPath}`,
  ].join('\n'),
);
writeFileSync(fallbackPath, JSON.stringify({ fallback_api_config: [] }, null, 2));
writeFileSync(modelMapPath, JSON.stringify({ model_mappings: { alias: 'target' } }, null, 2));

const proxy = spawn('npx', ['tsx', 'src/json-proxy.ts'], {
  cwd: path.resolve('.'),
  env: { ...process.env, PROXY_ENV_PATH: envPath },
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

await once(proxy.stdout!, 'data');

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

try {
  const html = await http('GET', '/admin/monitor');
  assert.equal(html.statusCode, 200);
  assert.match(html.text, /Provider Monitor/);
  assert.match(String(html.headers['content-type']), /text\/html/);

  const js = await http('GET', '/admin/assets/monitor.js');
  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  assert.match(js.text, /monitor\/stats/);
  assert.match(js.text, /setInterval\(poll, 1000\)/);
  assert.match(js.text, /visibilitychange/);

  const css = await http('GET', '/admin/assets/monitor.css');
  assert.equal(css.statusCode, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);

  await delay(50);
  const beforeLog = output;
  for (let i = 0; i < 3; i += 1) {
    const stats = await http('GET', '/admin/monitor/stats');
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.headers['cache-control'], 'no-store');
    const body = JSON.parse(stats.text) as {
      ok: boolean;
      endpointHealth: unknown[];
      stats: { requestsTotal: number };
    };
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.endpointHealth), true);
    assert.equal(typeof body.stats.requestsTotal, 'number');
  }
  const newLog = output.slice(beforeLog.length);
  assert.equal(newLog.includes('admin stats returned'), false);
  assert.equal(newLog.includes('monitor stats returned'), false);
  assert.equal(/\[r\d+\]/.test(newLog), false, `monitor polling should not emit request logs, got: ${newLog}`);

  const oldStats = await http('GET', '/admin/stats');
  assert.equal(oldStats.statusCode, 200);

  console.log('Admin monitor checks passed.');
} finally {
  if (proxy.pid) {
    try {
      process.kill(-proxy.pid, 'SIGTERM');
    } catch {
      proxy.kill('SIGTERM');
    }
  }
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
