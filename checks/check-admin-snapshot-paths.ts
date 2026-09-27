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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-snap-paths-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(envPath: string, lines: string[]) {
  writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function writeFallbackJson(filePath: string, content: unknown) {
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
}

function routingDocument(modelLabel: string, channelKey: string) {
  return {
    default_model: modelLabel,
    channels: [
      { id: 'alpha', base_url: 'https://alpha.example', api_key: channelKey },
    ],
    models: {
      [modelLabel]: { channel_ids: ['alpha'] },
    },
    aliases: { latest: modelLabel },
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
    console.log('=== 1. setup with initial routing path ===');
    const configDir1 = makeTempDir();
    const configDir2 = makeTempDir();
    const envPath = path.join(configDir1, '.env');
    const fallbackPath1 = path.join(configDir1, 'fallback.json');
    const fallbackPath2 = path.join(configDir2, 'fallback.json');

    writeFallbackJson(fallbackPath1, routingDocument('model-a', 'key-a'));
    writeFallbackJson(fallbackPath2, routingDocument('model-b', 'key-b'));
    writeDotEnv(envPath, [
      'PORT=0',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${fallbackPath1}`,
    ]);

    const runtimeStore = createRuntimeConfigStore({ envPath });
    const snap1 = runtimeStore.getSnapshot();
    assert.equal(snap1.config.routingConfigPath, fallbackPath1);
    const configStore = createConfigFileStoreFromPaths({ envPath, fallbackPath: snap1.config.routingConfigPath });
    const adminHandler = createAdminHandler({ configStore, runtimeStore });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    const config1Res = await fetch(`${baseUrl}/admin/config`);
    const config1Body = await config1Res.json() as Record<string, unknown>;
    const config1 = config1Body.config as Record<string, unknown>;
    assert.equal(config1.defaultModel, 'model-a');
    assert.deepEqual(config1.aliases, { latest: 'model-a' });

    console.log('=== 2. reload after changing FALLBACK_CONFIG_PATH picks up the new routing path ===');
    writeDotEnv(envPath, [
      'PORT=0',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${fallbackPath2}`,
    ]);
    const reloadRes = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
    assert.equal(reloadRes.status, 200);
    const reloadBody = await reloadRes.json() as Record<string, unknown>;
    assert.equal(reloadBody.ok, true);

    const config2Res = await fetch(`${baseUrl}/admin/config`);
    const config2Body = await config2Res.json() as Record<string, unknown>;
    const config2 = config2Body.config as Record<string, unknown>;
    assert.equal(config2.defaultModel, 'model-b');
    assert.deepEqual(config2.aliases, { latest: 'model-b' });

    console.log('=== 3. PUT writes to the live routing path ===');
    const saveRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [],
        defaultModel: 'model-b',
        channels: [{ id: 'alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' }],
        models: [{ canonicalModel: 'model-b', channelIds: ['alpha'] }],
        aliases: { latest: 'model-b' },
      }),
    });
    assert.equal(saveRes.status, 200);

    const written1 = JSON.parse(readFileSync(fallbackPath2, 'utf8')) as Record<string, unknown>;
    assert.equal(written1.default_model, 'model-b');
    assert.deepEqual(written1.aliases, { latest: 'model-b' });
    const writtenChannels = written1.channels as Array<Record<string, unknown>>;
    assert.equal(writtenChannels[0]?.api_key, 'key-b');

    console.log('=== 4. old routing path is unchanged after reload/save ===');
    const original = JSON.parse(readFileSync(fallbackPath1, 'utf8')) as Record<string, unknown>;
    assert.equal(original.default_model, 'model-a');

    console.log('\nAll snapshot-paths checks passed.');
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
