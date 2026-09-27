import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createAdminHandler, isAllowedAdminAccess, isLocalhost } from '../src/admin-api.js';
import { createCompactDetectionService } from '../src/compact-support.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-admin-api-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(envPath: string, lines: string[]) {
  writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function writeFallbackJson(filePath: string, content: unknown) {
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
}

function routingDocument() {
  return {
    default_model: 'model-a',
    channels: [
      { id: 'alpha', name: 'Alpha', base_url: 'https://alpha.example', api_key: 'alpha-secret' },
      { id: 'beta', base_url: 'https://beta.example', api_key: 'beta-secret' },
    ],
    models: {
      'model-a': { channel_ids: ['alpha', 'beta'] },
      'model-b': { channel_ids: ['beta'] },
    },
    aliases: { latest: 'model-a' },
    compact: {
      model: 'latest',
      channel_ids: ['beta', 'alpha'],
      v2_channel_ids: ['alpha'],
    },
  };
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Promise<{ server: import('node:http').Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled && !res.headersSent && !res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    allServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

async function main() {
  try {
    console.log('=== 1. isLocalhost helper ===');
    assert.equal(isLocalhost('127.0.0.1'), true);
    assert.equal(isLocalhost('::1'), true);
    assert.equal(isLocalhost('::ffff:127.0.0.1'), true);
    assert.equal(isLocalhost('192.168.1.1'), false);
    assert.equal(isLocalhost(undefined), false);
    assert.equal(isAllowedAdminAccess('127.0.0.1', false), true);
    assert.equal(isAllowedAdminAccess('172.17.0.1', false), false);
    assert.equal(isAllowedAdminAccess('172.17.0.1', true), true);

    console.log('=== 2. setup with separated env and routing dirs ===');
    const envDir = makeTempDir();
    const configDir = makeTempDir();

    const envPath = path.join(envDir, '.env');
    const fallbackPath = path.join(configDir, 'fallback.json');

    writeFallbackJson(fallbackPath, routingDocument());
    writeDotEnv(envPath, [
      'ADMIN_TEST_API_KEY=test-key-123',
      'PORT=0',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
    ]);

    const runtimeStore = createRuntimeConfigStore({ envPath });
    const snap = runtimeStore.getSnapshot();
    assert.equal(snap.config.routingConfigPath, fallbackPath, 'runtime snapshot should have correct routing path');

    const configStore = createConfigFileStoreFromPaths({
      envPath,
      fallbackPath: snap.config.routingConfigPath,
    });
    const compactDetection = createCompactDetectionService({
      fetchImpl: async url => url.endsWith('/responses/compact')
        ? new Response(JSON.stringify({ object: 'response.compaction' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
        : new Response([
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","item":{"type":"compaction"}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"object":"response.compaction","output":[{"type":"compaction"}]}}',
          '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    await compactDetection.detectAll(
      Array.from(snap.config.routingConfig.channelsById.values()),
      'model-a',
    );
    const adminHandler = createAdminHandler({ configStore, runtimeStore, compactDetection });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log('=== 3. GET /admin/config returns masked routing config ===');
    const getConfigRes = await fetch(`${baseUrl}/admin/config`);
    assert.equal(getConfigRes.status, 200);
    const getConfigBody = await getConfigRes.json() as Record<string, unknown>;
    const config = getConfigBody.config as Record<string, unknown>;
    assert.ok(Array.isArray(config.env));
    assert.ok(Array.isArray(config.channels));
    assert.ok(Array.isArray(config.models));
    assert.equal(config.defaultModel, 'model-a');
    assert.deepEqual(config.aliases, { latest: 'model-a' });
    assert.deepEqual(config.compact, {
      model: 'model-a',
      channelIds: ['beta', 'alpha'],
      v2ChannelIds: ['alpha'],
    });

    const envArr = config.env as Array<Record<string, unknown>>;
    const apiKeyEntry = envArr.find(entry => entry.key === 'ADMIN_TEST_API_KEY');
    assert.ok(apiKeyEntry);
    assert.equal(apiKeyEntry?.value, '***');

    const channels = config.channels as Array<Record<string, unknown>>;
    assert.equal(channels[0]?.apiKeyMasked, '***');
    assert.equal(channels[0]?.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(config).includes('alpha-secret'));

    console.log('=== 4. POST /admin/config/validate validates without writing files ===');
    const envBeforeValidate = readFileSync(envPath, 'utf8');
    const fbBeforeValidate = readFileSync(fallbackPath, 'utf8');
    const validateRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'SOME_KEY', value: 'new-value' }],
        defaultModel: 'latest',
        channels: [
          { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' },
          { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'keep' },
        ],
        models: [{ canonicalModel: 'model-a', channelIds: ['alpha', 'beta'] }],
        aliases: { latest: 'model-a' },
        compact: { model: 'latest', channelIds: ['alpha'], v2ChannelIds: null },
      }),
    });
    assert.equal(validateRes.status, 200);
    const validateBody = await validateRes.json() as Record<string, unknown>;
    assert.equal(validateBody.valid, true);
    assert.equal(readFileSync(envPath, 'utf8'), envBeforeValidate);
    assert.equal(readFileSync(fallbackPath, 'utf8'), fbBeforeValidate);

    console.log('=== 5. invalid validate draft returns errors ===');
    const badValidateRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: 'not-an-array',
        defaultModel: '',
        channels: [{ id: 'alpha', baseUrl: '', apiKeyAction: 'replace' }],
        models: [{ canonicalModel: 'model-a', channelIds: ['missing'] }],
        aliases: { 'model-a': 'model-b' },
      }),
    });
    assert.equal(badValidateRes.status, 200);
    const badValidateBody = await badValidateRes.json() as Record<string, unknown>;
    assert.equal(badValidateBody.valid, false);

    console.log('=== 6. PUT /admin/config writes routing config and reloads ===');
    const putRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'ADMIN_TEST_API_KEY', secretAction: 'keep' }],
        defaultModel: 'model-b',
        channels: [
          { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' },
          { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'replace', apiKeyValue: 'beta-secret-new' },
        ],
        models: [{ canonicalModel: 'model-b', channelIds: ['beta', 'alpha'] }],
        aliases: { latest: 'model-b' },
        compact: { model: 'latest', channelIds: ['beta'], v2ChannelIds: ['alpha'] },
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json() as Record<string, unknown>;
    assert.equal(putBody.ok, true);
    assert.ok((putBody.runtimeVersion as number) >= 2);

    const written = JSON.parse(readFileSync(fallbackPath, 'utf8')) as Record<string, unknown>;
    assert.equal(written.default_model, 'model-b');
    const writtenChannels = written.channels as Array<Record<string, unknown>>;
    assert.equal(writtenChannels[0]?.api_key, 'alpha-secret');
    assert.equal(writtenChannels[1]?.api_key, 'beta-secret-new');
    assert.deepEqual(written.aliases, { latest: 'model-b' });
    assert.deepEqual(written.compact, {
      model: 'latest',
      channel_ids: ['beta'],
      v2_channel_ids: ['alpha'],
    });
    assert.equal(statSync(fallbackPath).mode & 0o777, 0o600, 'fallback.json should be mode 0600');
    assert.equal(statSync(`${fallbackPath}.bak`).mode & 0o777, 0o600, 'fallback backup should be mode 0600');
    assert.equal(existsSync(path.join(configDir, 'model-map.json')), false, 'model-map.json should not be used');

    console.log('=== 7. reload and rollback work ===');
    const reloadRes = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
    assert.equal(reloadRes.status, 200);
    const reloadBody = await reloadRes.json() as Record<string, unknown>;
    assert.equal(reloadBody.ok, true);

    const rollbackRes = await fetch(`${baseUrl}/admin/config/rollback`, { method: 'POST' });
    assert.equal(rollbackRes.status, 200);
    const rollbackBody = await rollbackRes.json() as Record<string, unknown>;
    assert.equal(rollbackBody.ok, true);
    assert.ok(Array.isArray(rollbackBody.restored));

    console.log('=== 8. HTML and assets are served ===');
    const adminHtmlRes = await fetch(`${baseUrl}/admin`);
    assert.equal(adminHtmlRes.status, 200);
    const adminHtmlBody = await adminHtmlRes.text();
    assert.ok(adminHtmlBody.includes('Admin Config'));
    assert.ok(adminHtmlBody.includes('default-model-input'));
    assert.ok(adminHtmlBody.includes('channels-table'));
    assert.ok(adminHtmlBody.includes('model-routes-list'));
    assert.ok(adminHtmlBody.includes('aliases-list'));

    const adminJsRes = await fetch(`${baseUrl}/admin/assets/admin.js`);
    assert.equal(adminJsRes.status, 200);
    const adminJs = await adminJsRes.text();
    assert.ok(adminJs.includes('default-model-input'));
    assert.ok(adminJs.includes('channels-table'));
    assert.ok(adminJs.includes('model-routes-list'));
    assert.ok(adminJs.includes('aliases-list'));

    const adminCssRes = await fetch(`${baseUrl}/admin/assets/admin.css`);
    assert.equal(adminCssRes.status, 200);
    const adminCss = await adminCssRes.text();
    assert.ok(adminCss.includes('routing-row'));
    assert.ok(adminCss.includes('channel-key-wrap'));

    console.log('=== 9. invalid PUT returns 400 and has no side effects ===');
    const envBeforeInvalid = readFileSync(envPath, 'utf8');
    const fbBeforeInvalid = readFileSync(fallbackPath, 'utf8');
    const invalidPutRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: 'not-an-array',
        defaultModel: '',
        channels: [{ id: '', baseUrl: '', apiKeyAction: 'replace' }],
        models: [{ canonicalModel: 'model-a', channelIds: ['missing'] }],
        aliases: { 'model-a': 'model-b' },
      }),
    });
    assert.equal(invalidPutRes.status, 400);
    assert.equal(readFileSync(envPath, 'utf8'), envBeforeInvalid);
    assert.equal(readFileSync(fallbackPath, 'utf8'), fbBeforeInvalid);

    console.log('=== 10. asset and path handling are safe ===');
    const unknownRes = await fetch(`${baseUrl}/admin/unknown`);
    assert.equal(unknownRes.status, 404);
    const badJsonRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    assert.equal(badJsonRes.status, 400);

    const statsRes = await fetch(`${baseUrl}/admin/stats`);
    assert.equal(statsRes.status, 200);
    const detectionRes = await fetch(`${baseUrl}/admin/compact/detection`);
    assert.equal(detectionRes.status, 200);
    const detectionBody = await detectionRes.json() as Record<string, unknown>;
    assert.equal(detectionBody.ok, true);
    assert.equal(Array.isArray(detectionBody.results), true);
    const detectionResults = detectionBody.results as Array<Record<string, unknown>>;
    assert.ok(detectionResults.length > 0);
    assert.equal(detectionResults.every(item => item.protocol === 'v1' || item.protocol === 'v2'), true);
    const detectRes = await fetch(`${baseUrl}/admin/compact/detect`, { method: 'POST' });
    assert.equal(detectRes.status, 200);
    assert.equal((await detectRes.json() as Record<string, unknown>).started, true);
    const clearRes = await fetch(`${baseUrl}/admin/cache/clear`, { method: 'POST' });
    assert.equal(clearRes.status, 200);

    const traversalStatus = await new Promise<number>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write('GET /admin/assets/%2e%2e/src/admin-api.ts HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let resp = '';
      socket.on('data', chunk => { resp += chunk.toString(); });
      socket.on('end', () => {
        const match = resp.match(/^HTTP\/[^ ]+ (\d+)/);
        if (match) resolve(parseInt(match[1], 10));
        else reject(new Error('No status in response: ' + resp.slice(0, 200)));
      });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error('socket timeout')); }, 5000);
    });
    assert.ok(traversalStatus === 404 || traversalStatus === 400 || traversalStatus === 403);

    console.log('\nAll admin-config-api checks passed.');
  } finally {
    for (const server of allServers) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    for (const dir of allTempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main();
