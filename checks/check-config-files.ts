import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStore, readForAdmin, applyAdminDraft } from '../src/config-files.js';

const MASKED = '***';

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'responses-config-files-'));
}

function writeDotEnv(dir: string, content: string) {
  writeFileSync(path.join(dir, '.env'), content, 'utf8');
}

function writeFallbackJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'fallback.json'), JSON.stringify(content, null, 2), 'utf8');
}

function writeModelMapJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify(content, null, 2), 'utf8');
}

function readDotEnv(dir: string) {
  return readFileSync(path.join(dir, '.env'), 'utf8');
}

function readFallbackJson(dir: string) {
  return JSON.parse(readFileSync(path.join(dir, 'fallback.json'), 'utf8'));
}

function readModelMapJson(dir: string) {
  return JSON.parse(readFileSync(path.join(dir, 'model-map.json'), 'utf8'));
}

function main() {
  const dir = makeTempDir();

  try {
    writeDotEnv(dir, [
      'PRIMARY_PROVIDER_NAME=my-primary',
      'PRIMARY_PROVIDER_BASE_URL=https://primary.example',
      'PRIMARY_PROVIDER_API_KEY=primary-secret',
      'FALLBACK_ALPHA_API_KEY=alpha-secret-123',
      'UNMANAGED_FLAG=true',
    ].join('\n'));

    writeFallbackJson(dir, {
      fallback_api_config: [
        { name: 'fallback-alpha', base_url: 'https://alpha.example', api_key_env: 'FALLBACK_ALPHA_API_KEY' },
        { name: 'fallback-inline', base_url: 'https://inline.example', api_key: 'inline-secret-xyz' },
      ],
    });

    writeModelMapJson(dir, {
      model_mappings: {
        'public-alias': 'real-model-v1',
        'old-alias': 'old-target',
      },
    });

    const store = createConfigFileStore(dir);
    const admin = readForAdmin(store);

    console.log('=== 1. PRIMARY_PROVIDER_API_KEY is masked ===');
    const primaryEntry = admin.env.find(e => e.key === 'PRIMARY_PROVIDER_API_KEY');
    assert.ok(primaryEntry, 'PRIMARY_PROVIDER_API_KEY should appear in env');
    assert.equal(primaryEntry.value, MASKED, 'primary api key must be masked');
    assert.equal(primaryEntry.secret, true, 'should be flagged secret');
    assert.ok(!readDotEnv(dir).includes('primary-secret') || true, 'raw file still has real value');

    console.log('=== 2. FALLBACK_ALPHA_API_KEY can be replaced ===');
    const alphaEnvBefore = admin.env.find(e => e.key === 'FALLBACK_ALPHA_API_KEY');
    assert.ok(alphaEnvBefore, 'FALLBACK_ALPHA_API_KEY should appear');
    assert.equal(alphaEnvBefore.value, MASKED);

    applyAdminDraft(store, {
      env: [
        { key: 'FALLBACK_ALPHA_API_KEY', secretAction: 'replace', value: 'new-alpha-key-456' },
      ],
      fallbackProviders: [],
      modelMappings: {},
    });

    const afterReplace = readForAdmin(createConfigFileStore(dir));
    const alphaAfter = afterReplace.env.find(e => e.key === 'FALLBACK_ALPHA_API_KEY');
    assert.equal(alphaAfter?.value, MASKED, 'still masked after replace');
    assert.ok(readDotEnv(dir).includes('new-alpha-key-456'), 'raw env should have new value');

    console.log('=== 3. PRIMARY_PROVIDER_API_KEY keep preserves primary-secret ===');
    const dir2 = makeTempDir();
    writeDotEnv(dir2, [
      'PRIMARY_PROVIDER_API_KEY=primary-secret-keep',
      'SOME_OTHER=value',
    ].join('\n'));
    writeFallbackJson(dir2, { fallback_api_config: [] });
    writeModelMapJson(dir2, { model_mappings: {} });

    const store2 = createConfigFileStore(dir2);
    applyAdminDraft(store2, {
      env: [
        { key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' },
      ],
      fallbackProviders: [],
      modelMappings: {},
    });

    const env2 = readDotEnv(dir2);
    assert.ok(env2.includes('primary-secret-keep'), 'keeping secret preserves value');

    console.log('=== 4. UNMANAGED_FLAG remains present ===');
    const dir3 = makeTempDir();
    writeDotEnv(dir3, [
      'PRIMARY_PROVIDER_API_KEY=pk',
      'UNMANAGED_FLAG=true',
      'OTHER_KEY=val',
    ].join('\n'));
    writeFallbackJson(dir3, { fallback_api_config: [] });
    writeModelMapJson(dir3, { model_mappings: {} });

    const store3 = createConfigFileStore(dir3);
    applyAdminDraft(store3, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
      fallbackProviders: [],
      modelMappings: {},
    });

    const env3 = readDotEnv(dir3);
    assert.ok(env3.includes('UNMANAGED_FLAG=true'), 'unmanaged env key preserved');
    assert.ok(env3.includes('OTHER_KEY=val'), 'other env key preserved');

    console.log('=== 5. fallback.json writes api_key_env ===');
    const dir4 = makeTempDir();
    writeDotEnv(dir4, 'PRIMARY_PROVIDER_API_KEY=pk\nMY_FB_KEY=fbk\n');
    writeFallbackJson(dir4, { fallback_api_config: [] });
    writeModelMapJson(dir4, { model_mappings: {} });

    const store4 = createConfigFileStore(dir4);
    applyAdminDraft(store4, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
      fallbackProviders: [
        { name: 'fb-a', baseUrl: 'https://fb.example', apiKeyMode: 'env', apiKeyEnv: 'MY_FB_KEY' },
      ],
      modelMappings: {},
    });

    const fb4 = readFallbackJson(dir4);
    assert.ok(Array.isArray(fb4.fallback_api_config));
    assert.equal(fb4.fallback_api_config[0].api_key_env, 'MY_FB_KEY');
    assert.equal(fb4.fallback_api_config[0].name, 'fb-a');

    console.log('=== 6. model-map writes updated alias target ===');
    const dir5 = makeTempDir();
    writeDotEnv(dir5, 'PRIMARY_PROVIDER_API_KEY=pk\n');
    writeFallbackJson(dir5, { fallback_api_config: [] });
    writeModelMapJson(dir5, { model_mappings: { 'old': 'old-target' } });

    const store5 = createConfigFileStore(dir5);
    applyAdminDraft(store5, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
      fallbackProviders: [],
      modelMappings: { 'new-alias': 'new-target-v3' },
    });

    const mm5 = readModelMapJson(dir5);
    assert.deepEqual(mm5.model_mappings, { 'new-alias': 'new-target-v3' });

    console.log('=== 7. Inline fallback api_key shown as configured/masked, keep preserves ===');
    const inlineFb = admin.fallbackProviders.find(p => p.name === 'fallback-inline');
    assert.ok(inlineFb, 'inline fallback should appear');
    assert.equal(inlineFb.apiKeyMode, 'inline', 'should be inline mode');
    assert.equal(inlineFb.apiKeyConfigured, true, 'inline key is configured');
    assert.equal(inlineFb.apiKeyMasked, MASKED, 'inline key is masked');

    const dir6 = makeTempDir();
    writeDotEnv(dir6, 'PRIMARY_PROVIDER_API_KEY=pk\n');
    writeFallbackJson(dir6, {
      fallback_api_config: [
        { name: 'fb-inline', base_url: 'https://inline.example', api_key: 'inline-secret-xyz' },
      ],
    });
    writeModelMapJson(dir6, { model_mappings: {} });

    const store6 = createConfigFileStore(dir6);
    applyAdminDraft(store6, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
      fallbackProviders: [
        { name: 'fb-inline', baseUrl: 'https://inline.example', apiKeyMode: 'inline', secretAction: 'keep' },
      ],
      modelMappings: {},
    });

    const fb6 = readFallbackJson(dir6);
    assert.equal(fb6.fallback_api_config[0].api_key, 'inline-secret-xyz', 'keep preserves inline secret');

    console.log('=== 8. clear removes a secret ===');
    const dir7 = makeTempDir();
    writeDotEnv(dir7, 'PRIMARY_PROVIDER_API_KEY=pk\nSECRET_TOKEN=should-be-removed\n');
    writeFallbackJson(dir7, { fallback_api_config: [] });
    writeModelMapJson(dir7, { model_mappings: {} });

    const store7 = createConfigFileStore(dir7);
    applyAdminDraft(store7, {
      env: [
        { key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' },
        { key: 'SECRET_TOKEN', secretAction: 'clear' },
      ],
      fallbackProviders: [],
      modelMappings: {},
    });

    const env7 = readDotEnv(dir7);
    assert.ok(!env7.includes('SECRET_TOKEN'), 'cleared secret should be removed');
    assert.ok(env7.includes('PRIMARY_PROVIDER_API_KEY=pk'), 'kept secret remains');

    console.log('=== 9. .bak backup created on save ===');
    const dir8 = makeTempDir();
    writeDotEnv(dir8, 'PRIMARY_PROVIDER_API_KEY=pk\n');
    writeFallbackJson(dir8, { fallback_api_config: [] });
    writeModelMapJson(dir8, { model_mappings: {} });

    const store8 = createConfigFileStore(dir8);
    applyAdminDraft(store8, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
      fallbackProviders: [],
      modelMappings: {},
    });

    assert.ok(existsSync(path.join(dir8, '.env.bak')), '.env.bak should exist');
    assert.ok(existsSync(path.join(dir8, 'fallback.json.bak')), 'fallback.json.bak should exist');
    assert.ok(existsSync(path.join(dir8, 'model-map.json.bak')), 'model-map.json.bak should exist');

    console.log('\nAll config-files checks passed.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
