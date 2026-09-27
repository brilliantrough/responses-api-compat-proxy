import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseDotenv } from 'dotenv';

type JsonObject = Readonly<Record<string, unknown>>;

type ChannelDocument = Readonly<{
  id: string;
  name: string;
  base_url: string;
  api_key: string;
}>;

type RoutingDocument = Readonly<{
  default_model: string;
  channels: readonly ChannelDocument[];
  models: Readonly<Record<string, Readonly<{ channel_ids: readonly string[] }>>>;
  aliases: Readonly<Record<string, string>>;
}>;

export type MigrationOptions = Readonly<{
  instanceDirectory: string;
  write: boolean;
  updateEnv: boolean;
}>;

function readObject(value: unknown, context: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must contain an object`);
  }
  return value;
}

function readString(source: JsonObject, property: string, context: string): string {
  const value = source[property];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}.${property} must be a non-empty string`);
  }
  return value.trim();
}

function readRequiredEnv(env: Readonly<Record<string, string>>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing ${key} in .env`);
  }
  return value.trim();
}

function readOptionalEnv(env: Readonly<Record<string, string>>, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim().length === 0 ? fallback : value.trim();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : 'channel';
}

function uniqueChannelId(name: string, usedIds: Set<string>): string {
  const baseId = slugify(name);
  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function maskApiKey(apiKey: string): string {
  return `****${apiKey.slice(-4)}`;
}

function maskDocument(document: RoutingDocument): RoutingDocument {
  return {
    ...document,
    channels: document.channels.map(channel => ({ ...channel, api_key: maskApiKey(channel.api_key) })),
  };
}

function readFallbackApiKey(entry: JsonObject, env: Readonly<Record<string, string>>, context: string): string {
  if (Object.hasOwn(entry, 'api_key')) {
    return readString(entry, 'api_key', context);
  }
  const apiKeyEnv = readString(entry, 'api_key_env', context);
  return readRequiredEnv(env, apiKeyEnv);
}

function readAliases(modelMapPath: string): Readonly<{ aliases: Readonly<Record<string, string>>; names: readonly string[] }> {
  const parsed: unknown = JSON.parse(readFileSync(modelMapPath, 'utf8'));
  const root = readObject(parsed, 'model-map.json');
  const rawMappings = root['model_mappings'];
  const mappings = rawMappings === undefined ? {} : readObject(rawMappings, 'model-map.json.model_mappings');
  const aliases: Record<string, string> = {};
  const names = new Set<string>();

  for (const [rawAlias, rawTarget] of Object.entries(mappings)) {
    const alias = rawAlias.trim();
    if (alias.length === 0) {
      throw new Error('model-map.json contains an empty alias name');
    }
    if (Object.hasOwn(aliases, alias)) {
      throw new Error(`model-map.json contains duplicate alias '${alias}'`);
    }
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
      throw new Error(`model-map.json alias '${alias}' must target a non-empty model`);
    }
    const target = rawTarget.trim();
    aliases[alias] = target;
    names.add(alias);
    names.add(target);
  }

  for (const [alias, target] of Object.entries(aliases)) {
    if (Object.hasOwn(aliases, target)) {
      throw new Error(`model-map.json alias '${alias}' targets another alias`);
    }
  }

  return { aliases: Object.freeze(aliases), names: Array.from(names) };
}

function buildRoutingDocument(instanceDirectory: string): RoutingDocument {
  const envPath = path.join(instanceDirectory, '.env');
  const fallbackPath = path.join(instanceDirectory, 'fallback.json');
  const modelMapPath = path.join(instanceDirectory, 'model-map.json');
  const env = parseDotenv(readFileSync(envPath, 'utf8'));
  const primaryBaseUrl = normalizeBaseUrl(readRequiredEnv(env, 'PRIMARY_PROVIDER_BASE_URL'));
  const primaryApiKey = readRequiredEnv(env, 'PRIMARY_PROVIDER_API_KEY');
  const primaryName = readOptionalEnv(env, 'PRIMARY_PROVIDER_NAME', 'primary-provider');
  const defaultModel = readOptionalEnv(env, 'PRIMARY_PROVIDER_DEFAULT_MODEL', 'default-model');
  const parsedFallback: unknown = JSON.parse(readFileSync(fallbackPath, 'utf8'));
  const fallbackRoot = readObject(parsedFallback, 'fallback.json');
  const rawFallbacks = fallbackRoot['fallback_api_config'];
  if (!Array.isArray(rawFallbacks)) {
    throw new Error('fallback.json.fallback_api_config must be an array');
  }

  const channels: ChannelDocument[] = [{ id: 'primary', name: primaryName, base_url: primaryBaseUrl, api_key: primaryApiKey }];
  const usedIds = new Set<string>(['primary']);
  for (let index = 0; index < rawFallbacks.length; index += 1) {
    const context = `fallback.json.fallback_api_config[${index}]`;
    const entry = readObject(rawFallbacks[index], context);
    const name = readString(entry, 'name', context);
    channels.push({
      id: uniqueChannelId(name, usedIds),
      name,
      base_url: normalizeBaseUrl(readString(entry, 'base_url', context)),
      api_key: readFallbackApiKey(entry, env, context),
    });
  }

  const modelMapping = readAliases(modelMapPath);
  const allNames = new Set<string>([defaultModel, ...modelMapping.names]);
  const canonicalModels = Array.from(allNames).filter(model => !Object.hasOwn(modelMapping.aliases, model));
  if (canonicalModels.length === 0) {
    throw new Error('Migration produced no canonical model routes');
  }

  const channelIds = channels.map(channel => channel.id);
  const models: Record<string, { channel_ids: readonly string[] }> = {};
  for (const model of canonicalModels) {
    models[model] = { channel_ids: channelIds };
  }
  return { default_model: defaultModel, channels, models, aliases: modelMapping.aliases };
}

function updateEnvWithMigrationComments(envPath: string): void {
  const source = readFileSync(envPath, 'utf8');
  const output: string[] = [];
  let primaryMarkerWritten = false;
  let modelMapMarkerWritten = false;
  let changed = false;

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    const isComment = trimmed.startsWith('#');
    const isPrimary = !isComment && trimmed.startsWith('PRIMARY_PROVIDER_') && trimmed.includes('=');
    const isModelMap = !isComment && trimmed.startsWith('MODEL_MAP_PATH=');
    if (!isPrimary && !isModelMap) {
      output.push(line);
      continue;
    }
    changed = true;
    if (isPrimary && !primaryMarkerWritten) {
      output.push('# PRIMARY_PROVIDER_* removed by migration tool');
      primaryMarkerWritten = true;
    }
    if (isModelMap && !modelMapMarkerWritten) {
      output.push('# MODEL_MAP_PATH removed by migration tool');
      modelMapMarkerWritten = true;
    }
    output.push(`# ${trimmed}`);
  }

  if (changed) {
    writeFileSync(envPath, output.join('\n'), 'utf8');
  }
}

function printResult(document: RoutingDocument, options: MigrationOptions, fallbackPath: string): void {
  console.log(JSON.stringify(maskDocument(document), null, 2));
  console.log('\nMigration summary:');
  console.log(`- mode: ${options.write ? 'write' : 'dry-run'}`);
  console.log(`- channels: ${document.channels.length} (${document.channels.length - 1} fallback)`);
  console.log(`- canonical model routes: ${Object.keys(document.models).length}`);
  console.log(`- aliases: ${Object.keys(document.aliases).length}`);
  if (options.write) {
    console.log(`- backup: ${fallbackPath}.bak`);
    console.log('- fallback.json and fallback.json.bak written with mode 0600');
    if (options.updateEnv) {
      console.log('- legacy provider variables were commented in .env');
    }
  } else {
    console.log('- no files changed; rerun with --write to apply');
  }
}

export function migrateRoutingConfig(options: MigrationOptions): void {
  const instanceDirectory = path.resolve(options.instanceDirectory);
  const fallbackPath = path.join(instanceDirectory, 'fallback.json');
  const envPath = path.join(instanceDirectory, '.env');
  const document = buildRoutingDocument(instanceDirectory);

  if (options.write) {
    copyFileSync(fallbackPath, `${fallbackPath}.bak`);
    chmodSync(`${fallbackPath}.bak`, 0o600);
    writeFileSync(fallbackPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(fallbackPath, 0o600);
    if (options.updateEnv) {
      updateEnvWithMigrationComments(envPath);
    }
  }

  printResult(document, options, fallbackPath);
}
