import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStore, readForAdmin, applyAdminDraft, validateDraft } from '../src/config-files.js';

const MASKED = '***';
const allTempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'responses-config-files-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(dir: string, content: string) {
  writeFileSync(path.join(dir, '.env'), content, 'utf8');
}

function writeFallbackJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'fallback.json'), JSON.stringify(content, null, 2), 'utf8');
}

function readDotEnv(dir: string) {
  return readFileSync(path.join(dir, '.env'), 'utf8');
}

function readFallbackJson(dir: string) {
  return JSON.parse(readFileSync(path.join(dir, 'fallback.json'), 'utf8')) as Record<string, unknown>;
}

function routingDocument(channelAKey = 'alpha-secret-123') {
  return {
    default_model: 'model-a',
    channels: [
      { id: 'alpha', name: 'Alpha', base_url: 'https://alpha.example', api_key: channelAKey },
      { id: 'beta', base_url: 'https://beta.example', api_key: 'beta-secret-456' },
    ],
    models: {
      'model-a': { channel_ids: ['alpha', 'beta'] },
      'model-b': { channel_ids: ['beta'] },
    },
    aliases: {
      'public-alias': 'model-a',
    },
  };
}

function fallbackMode(dir: string, filename = 'fallback.json') {
  return statSync(path.join(dir, filename)).mode & 0o777;
}

function main() {
  try {
    const dir = makeTempDir();
    writeDotEnv(dir, [
      'PRIMARY_PROVIDER_API_KEY=primary-secret',
      'UNMANAGED_FLAG=true',
    ].join('\n'));
    writeFallbackJson(dir, routingDocument());

    const store = createConfigFileStore(dir);
    const admin = readForAdmin(store);

    console.log('=== 1. readForAdmin masks env and channel secrets ===');
    const primaryEntry = admin.env.find(e => e.key === 'PRIMARY_PROVIDER_API_KEY');
    assert.ok(primaryEntry, 'PRIMARY_PROVIDER_API_KEY should appear in env');
    assert.equal(primaryEntry.value, MASKED, 'env api key must be masked');
    assert.equal(primaryEntry.secret, true, 'env api key should be flagged secret');
    assert.equal(admin.defaultModel, 'model-a', 'default model should come from routing config');
    assert.equal(admin.channels.length, 2, 'channels should be exposed');
    assert.equal(admin.channels[0]?.apiKeyMasked, MASKED, 'channel api key must be masked');
    assert.equal(admin.channels[0]?.apiKeyConfigured, true, 'parsed channel keys are configured');
    assert.deepEqual(admin.models[0], { canonicalModel: 'model-a', channelIds: ['alpha', 'beta'] });
    assert.deepEqual(admin.aliases, { 'public-alias': 'model-a' });
    assert.equal(admin.compact, null, 'compact should be null when not configured');
    assert.ok(!JSON.stringify(admin).includes('alpha-secret-123'), 'admin view must not leak raw channel key');

    console.log('=== 2. keep preserves existing channel api key by id ===');
    applyAdminDraft(store, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'keep' }],
      defaultModel: 'model-b',
      channels: [
        { id: 'alpha', name: 'Alpha Renamed', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' },
        { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'keep' },
      ],
      models: [
        { canonicalModel: 'model-b', channelIds: ['beta', 'alpha'] },
      ],
      aliases: { latest: 'model-b' },
      compact: { model: 'latest', channelIds: ['alpha'], v2ChannelIds: ['beta'] },
    });
    const kept = readFallbackJson(dir);
    const keptChannels = kept.channels as Array<Record<string, unknown>>;
    assert.equal(kept.default_model, 'model-b');
    assert.equal(keptChannels[0]?.api_key, 'alpha-secret-123', 'keep preserves alpha key');
    assert.equal(keptChannels[0]?.name, 'Alpha Renamed', 'name should update');
    assert.deepEqual((kept.models as Record<string, { channel_ids: string[] }>)['model-b']?.channel_ids, ['beta', 'alpha']);
    assert.deepEqual(kept.aliases, { latest: 'model-b' });
    assert.deepEqual(kept.compact, {
      model: 'latest',
      channel_ids: ['alpha'],
      v2_channel_ids: ['beta'],
    });
    assert.deepEqual(readForAdmin(store).compact, {
      model: 'model-b',
      channelIds: ['alpha'],
      v2ChannelIds: ['beta'],
    });

    console.log('=== 3. replace changes a channel api key and keeps env secret masked ===');
    applyAdminDraft(store, {
      env: [{ key: 'PRIMARY_PROVIDER_API_KEY', secretAction: 'replace', value: 'new-primary-secret' }],
      defaultModel: 'model-b',
      channels: [
        { id: 'alpha', name: 'Alpha Renamed', baseUrl: 'https://alpha.example', apiKeyAction: 'replace', apiKeyValue: 'new-alpha-key' },
        { id: 'beta', baseUrl: 'https://beta.example', apiKeyAction: 'keep' },
      ],
      models: [{ canonicalModel: 'model-b', channelIds: ['alpha'] }],
      aliases: {},
      compact: null,
    });
    const replaced = readFallbackJson(dir);
    const replacedChannels = replaced.channels as Array<Record<string, unknown>>;
    assert.equal(replacedChannels[0]?.api_key, 'new-alpha-key', 'replace updates channel key');
    assert.equal('compact' in replaced, false, 'null compact draft removes compact route');
    assert.ok(readDotEnv(dir).includes('new-primary-secret'), 'env secret should be replaced');
    assert.equal(readForAdmin(store).channels[0]?.apiKeyMasked, MASKED, 're-read still masks channel key');

    console.log('=== 4. unmanaged env keys remain present ===');
    const envAfter = readDotEnv(dir);
    assert.ok(envAfter.includes('UNMANAGED_FLAG=true'), 'unmanaged env key preserved');

    console.log('=== 5. backups and fallback permissions ===');
    assert.ok(existsSync(path.join(dir, '.env.bak')), '.env.bak should exist');
    assert.ok(existsSync(path.join(dir, 'fallback.json.bak')), 'fallback.json.bak should exist');
    assert.equal(fallbackMode(dir), 0o600, 'fallback.json should be mode 0600');
    assert.equal(fallbackMode(dir, 'fallback.json.bak'), 0o600, 'fallback.json.bak should be mode 0600');
    assert.equal(existsSync(path.join(dir, 'model-map.json.bak')), false, 'model-map backup should not be created');

    console.log('=== 6. validateDraft catches routing draft errors ===');
    const invalid = validateDraft({
      env: [{ key: 'PROXY_CLAUDE_BILLING_HEADER_MODE', value: 'keep_everything' }],
      defaultModel: 'missing-model',
      channels: [
        { id: 'alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'keep' },
        { id: 'alpha', baseUrl: '', apiKeyAction: 'replace', apiKeyValue: '' },
      ],
      models: [{ canonicalModel: 'model-a', channelIds: ['missing-channel'] }],
      aliases: { 'model-a': 'missing-model' },
      compact: {
        model: 'model-a',
        channelIds: ['alpha'],
        v2ChannelIds: ['alpha', 'alpha', 'missing-channel'],
      },
    });
    assert.equal(invalid.ok, false, 'invalid draft should fail');
    if (!invalid.ok) {
      assert.ok(invalid.errors.some(error => error.includes('PROXY_CLAUDE_BILLING_HEADER_MODE')));
      assert.ok(invalid.errors.some(error => error.includes('duplicates another channel id')));
      assert.ok(invalid.errors.some(error => error.includes('unknown channel id')));
      assert.ok(invalid.errors.some(error => error.includes('collides with a canonical model name')));
      assert.ok(invalid.errors.some(error => error.includes('v2ChannelIds[1]') && error.includes('duplicates')));
      assert.ok(invalid.errors.some(error => error.includes('v2ChannelIds[2]') && error.includes('unknown')));
    }

    console.log('=== 7. validateDraft accepts alias default model ===');
    const valid = validateDraft({
      env: [{ key: 'PROXY_CLAUDE_BILLING_HEADER_MODE', value: 'strip_line' }],
      defaultModel: 'latest',
      channels: [{ id: 'alpha', baseUrl: 'https://alpha.example', apiKeyAction: 'replace', apiKeyValue: 'new-key' }],
      models: [{ canonicalModel: 'model-a', channelIds: ['alpha'] }],
      aliases: { latest: 'model-a' },
      compact: { model: 'latest', channelIds: ['alpha'], v2ChannelIds: null },
    });
    assert.equal(valid.ok, true, 'alias default should validate');

    console.log('\nAll config-files checks passed.');
  } finally {
    for (const dir of allTempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main();
