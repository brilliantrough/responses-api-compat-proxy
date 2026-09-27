import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type ChannelConfig = Readonly<{
  id: string;
  name: string;
  baseUrl: string;
  responsesUrl: string;
  apiKey: string;
  fingerprint: string;
  disableCooldown: boolean;
}>;

export type ModelRoute = Readonly<{
  canonicalModel: string;
  channelIds: readonly string[];
}>;

export type CompactRoute = Readonly<{
  canonicalModel: string;
  channelIds: readonly string[];
  v2ChannelIds: readonly string[];
}>;

export type RoutingConfig = Readonly<{
  path: string;
  defaultModel: string;
  channelsById: ReadonlyMap<string, ChannelConfig>;
  modelRoutes: ReadonlyMap<string, ModelRoute>;
  aliases: Readonly<Record<string, string>>;
  compactRoute: CompactRoute | undefined;
}>;

export function compactHealthKey(canonicalModel: string): string {
  return `compact:${canonicalModel}`;
}

export function compactV2HealthKey(canonicalModel: string): string {
  return `compact-v2:${canonicalModel}`;
}

type JsonObject = Readonly<Record<string, unknown>>;

type FieldContext = Readonly<{
  configPath: string;
  fieldPath: string;
}>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(configPath: string, fieldPath: string, detail: string): never {
  throw new Error(`routing config ${configPath}: ${fieldPath} ${detail}`);
}

function readNonEmptyString(source: JsonObject, property: string, context: FieldContext): string {
  const value = source[property];
  const fieldPath = `${context.fieldPath}.${property}`;
  if (typeof value !== 'string') {
    fail(context.configPath, fieldPath, 'must be a non-empty string');
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    fail(context.configPath, fieldPath, 'must be a non-empty string');
  }

  return normalized;
}

function readOptionalName(source: JsonObject, context: FieldContext, fallback: string): string {
  const value = source['name'];
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'string') {
    fail(context.configPath, `${context.fieldPath}.name`, 'must be a string when present');
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

function fingerprintChannel(id: string, baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(`${id}|${baseUrl}|${apiKey}`).digest('hex');
}

function parseChannel(value: unknown, context: FieldContext): ChannelConfig {
  if (!isJsonObject(value)) {
    fail(context.configPath, context.fieldPath, 'must be an object');
  }

  if (Object.hasOwn(value, 'api_key_env')) {
    fail(context.configPath, `${context.fieldPath}.api_key_env`, 'is not supported');
  }

  const disableCooldown = value['disable_cooldown'];
  if (disableCooldown !== undefined && typeof disableCooldown !== 'boolean') {
    fail(context.configPath, `${context.fieldPath}.disable_cooldown`, 'must be a boolean');
  }

  const id = readNonEmptyString(value, 'id', context);
  const name = readOptionalName(value, context, id);
  const rawBaseUrl = readNonEmptyString(value, 'base_url', context);
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (baseUrl.length === 0) {
    fail(context.configPath, `${context.fieldPath}.base_url`, 'must not normalize to an empty URL');
  }

  const apiKey = readNonEmptyString(value, 'api_key', context);

  return Object.freeze({
    id,
    name,
    baseUrl,
    responsesUrl: `${baseUrl}/v1/responses`,
    apiKey,
    fingerprint: fingerprintChannel(id, baseUrl, apiKey),
    disableCooldown: disableCooldown === true,
  });
}

function parseChannels(root: JsonObject, configPath: string): Map<string, ChannelConfig> {
  const channels = root['channels'];
  if (!Array.isArray(channels) || channels.length === 0) {
    fail(configPath, 'channels', 'must be a non-empty array');
  }

  const channelsById = new Map<string, ChannelConfig>();
  for (let index = 0; index < channels.length; index += 1) {
    const channel = parseChannel(channels[index], { configPath, fieldPath: `channels[${index}]` });
    if (channelsById.has(channel.id)) {
      fail(configPath, `channels[${index}].id`, 'duplicates another channel id');
    }
    channelsById.set(channel.id, channel);
  }

  return channelsById;
}

function readChannelIdList(
  channelIds: unknown,
  context: FieldContext,
  property: 'channel_ids' | 'v2_channel_ids',
): readonly string[] {
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    fail(context.configPath, `${context.fieldPath}.${property}`, 'must be a non-empty array');
  }

  return channelIds.map((channelId, index) => {
    const channelContext = `${context.fieldPath}.${property}[${index}]`;
    if (typeof channelId !== 'string' || channelId.trim().length === 0) {
      fail(context.configPath, channelContext, 'must be a non-empty channel id string');
    }
    return channelId.trim();
  });
}

function readChannelIds(route: JsonObject, context: FieldContext): readonly string[] {
  return readChannelIdList(route['channel_ids'], context, 'channel_ids');
}

function readOptionalV2ChannelIds(route: JsonObject, context: FieldContext): readonly string[] {
  const value = route['v2_channel_ids'];
  return value === undefined ? [] : readChannelIdList(value, context, 'v2_channel_ids');
}

function parseModelRoutes(
  root: JsonObject,
  channelsById: ReadonlyMap<string, ChannelConfig>,
  configPath: string,
): Map<string, ModelRoute> {
  const models = root['models'];
  if (!isJsonObject(models)) {
    fail(configPath, 'models', 'must be an object');
  }

  const routes = new Map<string, ModelRoute>();
  for (const [rawModel, rawRoute] of Object.entries(models)) {
    const canonicalModel = rawModel.trim();
    const modelPath = `models['${canonicalModel}']`;
    if (canonicalModel.length === 0) {
      fail(configPath, "models['']", 'must have a non-empty canonical model name');
    }
    if (routes.has(canonicalModel)) {
      fail(configPath, modelPath, 'duplicates another canonical model name');
    }
    if (!isJsonObject(rawRoute)) {
      fail(configPath, modelPath, 'must be an object');
    }

    const channelIds = readChannelIds(rawRoute, { configPath, fieldPath: modelPath });
    const seenChannelIds = new Set<string>();
    for (let index = 0; index < channelIds.length; index += 1) {
      const channelId = channelIds[index];
      const channelPath = `${modelPath}.channel_ids[${index}]`;
      if (seenChannelIds.has(channelId)) {
        fail(configPath, channelPath, 'duplicates another channel in the route');
      }
      if (!channelsById.has(channelId)) {
        fail(configPath, channelPath, 'references an unknown channel id');
      }
      seenChannelIds.add(channelId);
    }

    routes.set(canonicalModel, Object.freeze({ canonicalModel, channelIds }));
  }

  return routes;
}

function parseAliases(
  root: JsonObject,
  modelRoutes: ReadonlyMap<string, ModelRoute>,
  configPath: string,
): Readonly<Record<string, string>> {
  const rawAliases = root['aliases'];
  if (rawAliases === undefined) {
    return {} as Readonly<Record<string, string>>;
  }
  if (!isJsonObject(rawAliases)) {
    fail(configPath, 'aliases', 'must be an object');
  }

  const aliasTargets = new Map<string, string>();
  for (const [rawAlias, rawTarget] of Object.entries(rawAliases)) {
    const alias = rawAlias.trim();
    const aliasPath = `aliases['${alias}']`;
    if (alias.length === 0) {
      fail(configPath, "aliases['']", 'must have a non-empty alias name');
    }
    if (aliasTargets.has(alias)) {
      fail(configPath, aliasPath, 'duplicates another alias name');
    }
    if (modelRoutes.has(alias)) {
      fail(configPath, aliasPath, 'collides with a canonical model name');
    }
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
      fail(configPath, aliasPath, 'must target a non-empty canonical model string');
    }
    aliasTargets.set(alias, rawTarget.trim());
  }

  const aliases: Record<string, string> = {};
  for (const [alias, target] of aliasTargets) {
    const aliasPath = `aliases['${alias}']`;
    if (aliasTargets.has(target)) {
      fail(configPath, aliasPath, 'must not target another alias');
    }
    if (!modelRoutes.has(target)) {
      fail(configPath, aliasPath, 'targets an unknown canonical model');
    }
    aliases[alias] = target;
  }

  return Object.freeze(aliases);
}

function parseCompactRoute(
  root: JsonObject,
  channelsById: ReadonlyMap<string, ChannelConfig>,
  modelRoutes: ReadonlyMap<string, ModelRoute>,
  aliases: Readonly<Record<string, string>>,
  configPath: string,
): CompactRoute | undefined {
  const rawCompact = root['compact'];
  if (rawCompact === undefined) {
    return undefined;
  }
  if (!isJsonObject(rawCompact)) {
    fail(configPath, 'compact', 'must be an object');
  }

  const requestedModel = readNonEmptyString(rawCompact, 'model', { configPath, fieldPath: 'compact' });
  const aliasTarget = Object.hasOwn(aliases, requestedModel) ? aliases[requestedModel] : undefined;
  const canonicalModel = modelRoutes.has(requestedModel) ? requestedModel : aliasTarget;
  if (canonicalModel === undefined) {
    fail(configPath, 'compact.model', 'must resolve to a canonical model or alias');
  }

  const channelIds = readChannelIds(rawCompact, { configPath, fieldPath: 'compact' });
  const seenChannelIds = new Set<string>();
  for (let index = 0; index < channelIds.length; index += 1) {
    const channelId = channelIds[index];
    const channelPath = `compact.channel_ids[${index}]`;
    if (seenChannelIds.has(channelId)) {
      fail(configPath, channelPath, 'duplicates another channel in the compact route');
    }
    if (!channelsById.has(channelId)) {
      fail(configPath, channelPath, 'references an unknown channel id');
    }
    seenChannelIds.add(channelId);
  }

  const v2ChannelIds = readOptionalV2ChannelIds(rawCompact, { configPath, fieldPath: 'compact' });
  const seenV2ChannelIds = new Set<string>();
  for (let index = 0; index < v2ChannelIds.length; index += 1) {
    const channelId = v2ChannelIds[index];
    const channelPath = `compact.v2_channel_ids[${index}]`;
    if (seenV2ChannelIds.has(channelId)) {
      fail(configPath, channelPath, 'duplicates another channel in the compact v2 route');
    }
    if (!channelsById.has(channelId)) {
      fail(configPath, channelPath, 'references an unknown channel id');
    }
    seenV2ChannelIds.add(channelId);
  }

  return Object.freeze({ canonicalModel, channelIds, v2ChannelIds });
}

function warnUnusedChannels(
  channelsById: ReadonlyMap<string, ChannelConfig>,
  modelRoutes: ReadonlyMap<string, ModelRoute>,
  compactRoute: CompactRoute | undefined,
  configPath: string,
): void {
  const usedChannelIds = new Set<string>();
  for (const route of modelRoutes.values()) {
    for (const channelId of route.channelIds) {
      usedChannelIds.add(channelId);
    }
  }
  if (compactRoute !== undefined) {
    for (const channelId of compactRoute.channelIds) {
      usedChannelIds.add(channelId);
    }
    for (const channelId of compactRoute.v2ChannelIds) {
      usedChannelIds.add(channelId);
    }
  }

  for (const channelId of channelsById.keys()) {
    if (!usedChannelIds.has(channelId)) {
      console.warn(`routing config ${configPath}: unused channel '${channelId}' is not referenced by any model route`);
    }
  }
}

export function loadRoutingConfig(path: string): RoutingConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parseRoutingConfig(parsed, path);
}

export function parseRoutingConfig(value: unknown, path: string): RoutingConfig {
  if (!isJsonObject(value)) {
    fail(path, 'root', 'must be an object');
  }

  if (Object.hasOwn(value, 'fallback_api_config')) {
    fail(path, 'fallback_api_config', 'is no longer supported');
  }

  const rootContext = { configPath: path, fieldPath: 'root' };
  const requestedDefaultModel = readNonEmptyString(value, 'default_model', rootContext);
  const channelsById = parseChannels(value, path);
  const modelRoutes = parseModelRoutes(value, channelsById, path);
  const aliases = parseAliases(value, modelRoutes, path);
  const compactRoute = parseCompactRoute(value, channelsById, modelRoutes, aliases, path);
  const aliasTarget = Object.hasOwn(aliases, requestedDefaultModel) ? aliases[requestedDefaultModel] : undefined;
  const defaultModel = modelRoutes.has(requestedDefaultModel) ? requestedDefaultModel : aliasTarget;
  if (defaultModel === undefined) {
    fail(path, 'default_model', 'must resolve to a canonical model or alias');
  }

  warnUnusedChannels(channelsById, modelRoutes, compactRoute, path);

  return Object.freeze({
    path,
    defaultModel,
    channelsById,
    modelRoutes,
    aliases,
    compactRoute,
  });
}

export function listConfiguredModels(config: RoutingConfig): readonly string[] {
  return Array.from(config.modelRoutes.keys()).sort();
}
