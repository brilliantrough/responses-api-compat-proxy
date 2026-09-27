import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createAdminHandler } from '../src/admin-api.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-admin-ui-'));
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
    console.log('=== 1. Setup ===');
    const configDir = makeTempDir();
    const envPath = path.join(configDir, '.env');
    const fallbackPath = path.join(configDir, 'fallback.json');

    writeFallbackJson(fallbackPath, routingDocument());
    writeDotEnv(envPath, [
      'PORT=0',
      'HOST=127.0.0.1',
      'FB_A_KEY=fb-secret-key',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
    ]);

    const runtimeStore = createRuntimeConfigStore({ envPath });
    const snap = runtimeStore.getSnapshot();
    const configStore = createConfigFileStoreFromPaths({ envPath, fallbackPath: snap.config.routingConfigPath });
    const adminHandler = createAdminHandler({ configStore, runtimeStore });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log('=== 2. HTML has required UI sections ===');
    const htmlRes = await fetch(`${baseUrl}/admin`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    for (const id of [
      'status', 'dirty-badge', 'restart-notice', 'primary-table', 'default-model-input',
      'channels-table', 'btn-add-channel', 'model-routes-list', 'btn-add-model-route',
      'aliases-list', 'btn-add-alias', 'runtime-table', 'btn-validate', 'btn-save', 'btn-reload', 'btn-rollback',
      'validation-result', 'action-result', 'instance-summary', 'topbar-runtime-version', 'topbar-active-requests',
    ]) {
      assert.ok(html.includes(id), `HTML should contain element id="${id}"`);
    }

    console.log('=== 3. JS references key routing behaviors ===');
    const jsRes = await fetch(`${baseUrl}/admin/assets/admin.js`);
    assert.equal(jsRes.status, 200);
    const js = await jsRes.text();
    assert.ok(js.includes('default-model-input'));
    assert.ok(js.includes('channels-table'));
    assert.ok(js.includes('model-routes-list'));
    assert.ok(js.includes('aliases-list'));
    assert.ok(js.includes('apiKeyAction'));
    assert.ok(js.includes('apiKeyValue'));
    assert.ok(js.includes('addChannel'));
    assert.ok(js.includes('addModelRoute'));
    assert.ok(js.includes('addAlias'));
    assert.ok(js.includes('secretAction'));

    console.log('=== 4. CSS has required styles ===');
    const cssRes = await fetch(`${baseUrl}/admin/assets/admin.css`);
    assert.equal(cssRes.status, 200);
    const css = await cssRes.text();
    assert.ok(css.includes('routing-row'));
    assert.ok(css.includes('channel-key-wrap'));
    assert.ok(css.includes('masked-secret'));

    console.log('=== 5. Config API returns new admin view shape ===');
    const configRes = await fetch(`${baseUrl}/admin/config`);
    const configBody = await configRes.json() as Record<string, unknown>;
    assert.ok(configBody.ok);
    const config = configBody.config as Record<string, unknown>;
    assert.ok(Array.isArray(config.env));
    assert.ok(Array.isArray(config.channels));
    assert.ok(Array.isArray(config.models));
    assert.equal(config.defaultModel, 'model-a');
    assert.deepEqual(config.aliases, { latest: 'model-a' });

    const channels = config.channels as Array<Record<string, unknown>>;
    assert.equal(channels[0]?.apiKeyMasked, '***');
    assert.equal(channels[0]?.apiKeyConfigured, true);
    const envArr = config.env as Array<Record<string, unknown>>;
    assert.equal(envArr.find(entry => entry.key === 'FB_A_KEY')?.value, '***');

    console.log('=== 6. Secret env and channel keep drafts validate ===');
    const validateRes = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'FB_A_KEY', secretAction: 'keep' }],
        defaultModel: 'latest',
        channels: [
          { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' },
          { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'keep' },
        ],
        models: [{ canonicalModel: 'model-a', channelIds: ['alpha', 'beta'] }],
        aliases: { latest: 'model-a' },
      }),
    });
    const validateBody = await validateRes.json() as Record<string, unknown>;
    assert.equal(validateBody.valid, true);

    console.log('=== 7. Keep preserves inline keys and replace updates them ===');
    const saveKeepRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'FB_A_KEY', secretAction: 'keep' }],
        defaultModel: 'model-a',
        channels: [
          { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' },
          { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'keep' },
        ],
        models: [{ canonicalModel: 'model-a', channelIds: ['alpha', 'beta'] }],
        aliases: { latest: 'model-a' },
      }),
    });
    assert.equal(saveKeepRes.status, 200);
    const saveKeepBody = await saveKeepRes.json() as Record<string, unknown>;
    assert.equal(saveKeepBody.ok, true);

    const saveReplaceRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'FB_A_KEY', secretAction: 'replace', value: 'fb-secret-key-new' }],
        defaultModel: 'model-b',
        channels: [
          { id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'replace', apiKeyValue: 'alpha-new' },
          { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'keep' },
        ],
        models: [{ canonicalModel: 'model-b', channelIds: ['beta', 'alpha'] }],
        aliases: { latest: 'model-b' },
      }),
    });
    assert.equal(saveReplaceRes.status, 200);
    const fallback = JSON.parse(readFileSync(fallbackPath, 'utf8')) as Record<string, unknown>;
    assert.equal(fallback.default_model, 'model-b');
    const savedChannels = fallback.channels as Array<Record<string, unknown>>;
    assert.equal(savedChannels[0]?.api_key, 'alpha-new');

    console.log('=== 8. UI shell still serves runtime and error states ===');
    assert.ok(readFileSync(fallbackPath, 'utf8').includes('model-b'));
    const reloadRes = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
    assert.equal(reloadRes.status, 200);
    const rollbackRes = await fetch(`${baseUrl}/admin/config/rollback`, { method: 'POST' });
    assert.equal(rollbackRes.status, 200);

    console.log('\nAll admin UI smoke checks passed.');
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
