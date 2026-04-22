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

function writeModelMapJson(filePath: string, content: unknown) {
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
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
    const modelMapPath = path.join(configDir, 'model-map.json');

    writeFallbackJson(fallbackPath, {
      fallback_api_config: [
        { name: 'fb-a', base_url: 'https://fb.example', api_key_env: 'FB_A_KEY' },
        { name: 'fb-inline', base_url: 'https://inline.example', api_key: 'inline-secret-xyz' },
      ],
    });
    writeModelMapJson(modelMapPath, { model_mappings: { 'alias-x': 'model-y' } });
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=test-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://api.test.example',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PRIMARY_PROVIDER_DEFAULT_MODEL=gpt-4o-test',
      'PORT=0',
      'HOST=127.0.0.1',
      'PROXY_STREAM_MODE=normalized',
      'FB_A_KEY=fb-secret-key',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      `MODEL_MAP_PATH=${modelMapPath}`,
    ]);

    const runtimeStore = createRuntimeConfigStore({ envPath });
    const snap = runtimeStore.getSnapshot();
    const configStore = createConfigFileStoreFromPaths({
      envPath,
      fallbackPath: snap.config.fallbackConfigPath,
      modelMapPath: snap.config.modelMappingPath,
    });
    const adminHandler = createAdminHandler({ configStore, runtimeStore });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log('=== 2. HTML has required UI sections ===');
    const htmlRes = await fetch(`${baseUrl}/admin`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();

    const requiredIds = [
      'status', 'dirty-badge', 'restart-notice',
      'primary-table', 'fallback-table',
      'model-mappings-list', 'btn-add-mapping',
      'runtime-table',
      'btn-validate', 'btn-save', 'btn-reload', 'btn-rollback',
      'validation-result', 'action-result',
    ];
    for (const id of requiredIds) {
      assert.ok(html.includes(id), `HTML should contain element id="${id}"`);
    }

    console.log('=== 3. JS loads and references key behaviors ===');
    const jsRes = await fetch(`${baseUrl}/admin/assets/admin.js`);
    assert.equal(jsRes.status, 200);
    const js = await jsRes.text();
    assert.ok(js.includes('loadConfig'), 'JS should define loadConfig');
    assert.ok(js.includes('/admin/config'), 'JS should fetch /admin/config');
    assert.ok(js.includes('/admin/config/validate'), 'JS should call validate endpoint');
    assert.ok(js.includes('/admin/config/reload'), 'JS should call reload endpoint');
    assert.ok(js.includes('/admin/config/rollback'), 'JS should call rollback endpoint');
    assert.ok(js.includes('PUT'), 'JS should use PUT for save');
    assert.ok(js.includes('secretAction'), 'JS should handle secret actions');
    assert.ok(js.includes('password'), 'JS should use password inputs for secrets');
    assert.ok(js.includes('restartRequired'), 'JS should check restart-required fields');
    assert.ok(js.includes('badge-dirty'), 'JS should track dirty state');

    console.log('=== 4. CSS has required styles ===');
    const cssRes = await fetch(`${baseUrl}/admin/assets/admin.css`);
    assert.equal(cssRes.status, 200);
    const css = await cssRes.text();
    assert.ok(css.includes('section'), 'CSS should style sections');
    assert.ok(css.includes('badge-dirty'), 'CSS should have dirty badge style');
    assert.ok(css.includes('notice-restart'), 'CSS should have restart notice style');
    assert.ok(css.includes('notice-error'), 'CSS should have error notice style');
    assert.ok(css.includes('btn-row'), 'CSS should style button rows');

    console.log('=== 5. Config API returns data for all UI sections ===');
    const configRes = await fetch(`${baseUrl}/admin/config`);
    const configBody = (await configRes.json()) as Record<string, unknown>;
    assert.ok(configBody.ok);
    const config = configBody.config as Record<string, unknown>;
    assert.ok(Array.isArray(config.env), 'should have env array');
    assert.ok(Array.isArray(config.fallbackProviders), 'should have fallbackProviders array');
    assert.ok(config.modelMappings && typeof config.modelMappings === 'object', 'should have modelMappings');
    assert.equal(typeof configBody.runtimeVersion, 'number', 'should have runtimeVersion');
    assert.ok(Array.isArray(configBody.restartRequiredFields), 'should have restartRequiredFields');

    const envArr = config.env as Array<Record<string, unknown>>;
    const secretEntry = envArr.find(e => e.key === 'PRIMARY_PROVIDER_API_KEY');
    assert.ok(secretEntry, 'should have PRIMARY_PROVIDER_API_KEY');
    assert.equal(secretEntry!.value, '***', 'API key should be masked');

    const fbArr = config.fallbackProviders as Array<Record<string, unknown>>;
    assert.equal(fbArr.length, 2, 'should have two fallback providers');
    assert.equal(fbArr[0].name, 'fb-a');
    assert.equal(fbArr[0].apiKeyMode, 'env');
    assert.equal(fbArr[0].apiKeyMasked, '***', 'fallback env key should be masked');
    assert.equal(fbArr[1].name, 'fb-inline');
    assert.equal(fbArr[1].apiKeyMode, 'inline');
    assert.equal(fbArr[1].apiKeyMasked, '***', 'fallback inline key should be masked');

    const mm = config.modelMappings as Record<string, string>;
    assert.equal(mm['alias-x'], 'model-y', 'model mapping should be present');

    console.log('=== 6. Secret env entries with keep do not leak masked value ===');
    {
      const draftEnvSecretKeep = envArr
        .filter(e => e.secret)
        .map(e => ({ key: e.key, secretAction: 'keep' as const }));
      assert.ok(draftEnvSecretKeep.length > 0, 'should have at least one secret env entry');

      for (const entry of draftEnvSecretKeep) {
        assert.ok(!('value' in entry), `secret "${entry.key}" with keep must not include value field`);
      }

      const validateRes = await fetch(`${baseUrl}/admin/config/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: [
            ...envArr.filter(e => !e.secret).map(e => ({ key: e.key, value: e.value })),
            ...draftEnvSecretKeep,
          ],
          fallbackProviders: fbArr.map(p => ({
            name: p.name,
            baseUrl: p.baseUrl,
            apiKeyMode: p.apiKeyMode,
            ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
            secretAction: 'keep' as const,
          })),
          modelMappings: mm,
        }),
      });
      const validateBody = (await validateRes.json()) as Record<string, unknown>;
      assert.equal(validateBody.valid, true, 'keep-without-value draft should validate');
    }

    console.log('=== 7. Inline fallback secret: keep preserves existing inline key ===');
    {
      const origFallback = JSON.parse(readFileSync(fallbackPath, 'utf8'));
      const origInlineKey = (origFallback.fallback_api_config as Array<Record<string, string>>)
        .find(p => p.name === 'fb-inline')!.api_key;
      assert.equal(origInlineKey, 'inline-secret-xyz', 'original inline key should be present');

      const saveRes = await fetch(`${baseUrl}/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: [
            ...envArr.filter(e => !e.secret).map(e => ({ key: e.key, value: e.value })),
            ...envArr.filter(e => e.secret).map(e => ({ key: e.key, secretAction: 'keep' as const })),
          ],
          fallbackProviders: [
            { name: 'fb-a', baseUrl: 'https://fb.example', apiKeyMode: 'env', apiKeyEnv: 'FB_A_KEY' },
            { name: 'fb-inline', baseUrl: 'https://inline.example', apiKeyMode: 'inline', secretAction: 'keep' as const },
          ],
          modelMappings: mm,
        }),
      });
      assert.equal(saveRes.status, 200);
      const saveBody = (await saveRes.json()) as Record<string, unknown>;
      assert.equal(saveBody.ok, true, 'save should succeed');

      const afterFallback = JSON.parse(readFileSync(fallbackPath, 'utf8'));
      const afterInline = (afterFallback.fallback_api_config as Array<Record<string, string>>)
        .find(p => p.name === 'fb-inline')!;
      assert.equal(afterInline.api_key, origInlineKey, 'inline key should be preserved on keep');
    }

    console.log('=== 8. Inline fallback secret: replace updates key, clear removes it ===');
    {
      const saveReplace = await fetch(`${baseUrl}/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: [
            ...envArr.filter(e => !e.secret).map(e => ({ key: e.key, value: e.value })),
            ...envArr.filter(e => e.secret).map(e => ({ key: e.key, secretAction: 'keep' as const })),
          ],
          fallbackProviders: [
            { name: 'fb-a', baseUrl: 'https://fb.example', apiKeyMode: 'env', apiKeyEnv: 'FB_A_KEY' },
            { name: 'fb-inline', baseUrl: 'https://inline.example', apiKeyMode: 'inline', secretAction: 'replace' as const, value: 'new-inline-key' },
          ],
          modelMappings: mm,
        }),
      });
      assert.equal(saveReplace.status, 200);
      const replaced = JSON.parse(readFileSync(fallbackPath, 'utf8'));
      const replacedEntry = (replaced.fallback_api_config as Array<Record<string, string>>)
        .find(p => p.name === 'fb-inline')!;
      assert.equal(replacedEntry.api_key, 'new-inline-key', 'inline key should be replaced');

      const saveClear = await fetch(`${baseUrl}/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: [
            ...envArr.filter(e => !e.secret).map(e => ({ key: e.key, value: e.value })),
            ...envArr.filter(e => e.secret).map(e => ({ key: e.key, secretAction: 'keep' as const })),
          ],
          fallbackProviders: [
            { name: 'fb-a', baseUrl: 'https://fb.example', apiKeyMode: 'env', apiKeyEnv: 'FB_A_KEY' },
            { name: 'fb-inline', baseUrl: 'https://inline.example', apiKeyMode: 'inline', secretAction: 'clear' as const },
          ],
          modelMappings: mm,
        }),
      });
      assert.equal(saveClear.status, 200);
      const cleared = JSON.parse(readFileSync(fallbackPath, 'utf8'));
      const clearedEntry = (cleared.fallback_api_config as Array<Record<string, string>>)
        .find(p => p.name === 'fb-inline')!;
      assert.ok(!('api_key' in clearedEntry), 'inline key should be removed on clear');
    }

    console.log('=== 9. Model mapping alias edit renames key ===');
    {
      const saveRename = await fetch(`${baseUrl}/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: [
            ...envArr.filter(e => !e.secret).map(e => ({ key: e.key, value: e.value })),
            ...envArr.filter(e => e.secret).map(e => ({ key: e.key, secretAction: 'keep' as const })),
          ],
          fallbackProviders: [
            { name: 'fb-a', baseUrl: 'https://fb.example', apiKeyMode: 'env', apiKeyEnv: 'FB_A_KEY' },
            { name: 'fb-inline', baseUrl: 'https://inline.example', apiKeyMode: 'none' },
          ],
          modelMappings: { 'alias-renamed': 'model-z' },
        }),
      });
      assert.equal(saveRename.status, 200);
      const mmAfter = JSON.parse(readFileSync(modelMapPath, 'utf8'));
      assert.deepEqual(mmAfter.model_mappings, { 'alias-renamed': 'model-z' }, 'model mapping should be renamed');
      assert.ok(!('alias-x' in mmAfter.model_mappings), 'old alias should be gone');
    }

    console.log('\nAll admin UI smoke checks passed.');
  } finally {
    for (const server of allServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const d of allTempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
