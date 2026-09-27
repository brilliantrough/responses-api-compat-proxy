import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as dotenvParse } from 'dotenv';

import { parseRoutingConfig } from './routing-config.js';
import { readRoutingPolicyConfig, routingPolicyDefaults } from './proxy-config.js';

const MASKED = '***';

const DEFAULT_ADMIN_ENV: Record<string, string> = {
  ...routingPolicyDefaults,
  PROXY_CLAUDE_BILLING_HEADER_MODE: 'strip_line',
  PROXY_COMPACT_TIMEOUT_MS: '300000',
  PROXY_COMPACT_DETECT_TIMEOUT_MS: '45000',
  PROXY_COMPACT_DETECT_ENABLED: '1',
};

type SecretEnvAction = 'keep' | 'replace' | 'clear';

export type EnvEntry = {
  key: string;
  value: string;
  secret: boolean;
};

export type ChannelView = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  apiKeyConfigured: boolean;
  disableCooldown: boolean;
};

export type ModelRouteView = {
  canonicalModel: string;
  channelIds: string[];
};

export type CompactRouteView = {
  model: string;
  channelIds: string[];
  v2ChannelIds: string[];
};

export type AdminConfigView = {
  env: EnvEntry[];
  defaultModel: string;
  channels: ChannelView[];
  models: ModelRouteView[];
  aliases: Record<string, string>;
  compact: CompactRouteView | null;
};

export type EnvDraftEntry = {
  key: string;
  secretAction?: SecretEnvAction;
  value?: string;
};

export type ChannelDraft = {
  id: string;
  name?: string;
  baseUrl: string;
  apiKeyAction: 'keep' | 'replace';
  apiKeyValue?: string;
  disableCooldown?: boolean;
};

export type ModelRouteDraft = {
  canonicalModel: string;
  channelIds: string[];
};

export type CompactRouteDraft = {
  model: string;
  channelIds: string[];
  v2ChannelIds?: string[] | null;
};

export type AdminConfigDraft = {
  env: EnvDraftEntry[];
  defaultModel: string;
  channels: ChannelDraft[];
  models: ModelRouteDraft[];
  aliases: Record<string, string>;
  compact?: CompactRouteDraft | null;
};

export type ConfigFileStore = {
  dir: string;
  envPath: string;
  fallbackPath: string;
};

type RawRoutingChannel = Readonly<{
  id: string;
  name?: string;
  base_url: string;
  api_key: string;
  disable_cooldown?: boolean;
}>;

type RawRoutingDocument = Readonly<{
  default_model: string;
  channels: readonly RawRoutingChannel[];
  models: Record<string, { channel_ids: string[] }>;
  aliases: Record<string, string>;
  compact?: { model: string; channel_ids: string[]; v2_channel_ids?: string[] };
}>;

function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.includes('KEY') || upper.includes('TOKEN') || upper.includes('SECRET');
}

export function createConfigFileStore(dir: string): ConfigFileStore {
  const resolved = resolve(dir);
  return {
    dir: resolved,
    envPath: join(resolved, '.env'),
    fallbackPath: join(resolved, 'fallback.json'),
  };
}

export function createConfigFileStoreFromPaths(options: {
  envPath: string;
  fallbackPath: string;
  modelMapPath?: string;
}): ConfigFileStore {
  const envResolved = resolve(options.envPath);
  return {
    dir: resolve(envResolved, '..'),
    envPath: envResolved,
    fallbackPath: resolve(options.fallbackPath),
  };
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  return dotenvParse(raw);
}

function parseRoutingFile(filePath: string): RawRoutingDocument {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const routing = parseRoutingConfig(parsed, filePath);
  const channels: RawRoutingChannel[] = [];
  for (const channel of routing.channelsById.values()) {
    channels.push({
      id: channel.id,
      name: channel.name,
      base_url: channel.baseUrl,
      api_key: channel.apiKey,
      disable_cooldown: channel.disableCooldown === true ? true : undefined,
    });
  }

  const models: Record<string, { channel_ids: string[] }> = {};
  for (const route of routing.modelRoutes.values()) {
    models[route.canonicalModel] = { channel_ids: [...route.channelIds] };
  }

  return {
    default_model: routing.defaultModel,
    channels,
    models,
    aliases: { ...routing.aliases },
    ...(routing.compactRoute === undefined
      ? {}
      : {
        compact: {
          model: routing.compactRoute.canonicalModel,
          channel_ids: [...routing.compactRoute.channelIds],
          ...(routing.compactRoute.v2ChannelIds.length === 0
            ? {}
            : { v2_channel_ids: [...routing.compactRoute.v2ChannelIds] }),
        },
      }),
  };
}

function atomicWrite(filePath: string, content: string, mode?: number): void {
  const dir = resolve(filePath, '..');
  mkdirSync(dir, { recursive: true });
  const tmpFile = join(dir, `.tmp-${randomUUID()}`);
  if (mode === undefined) {
    writeFileSync(tmpFile, content, 'utf8');
  } else {
    writeFileSync(tmpFile, content, { encoding: 'utf8', mode });
  }
  renameSync(tmpFile, filePath);
  if (mode !== undefined) {
    chmodSync(filePath, mode);
  }
}

function backupFile(filePath: string, mode?: number): void {
  if (!existsSync(filePath)) return;
  const backupPath = filePath + '.bak';
  copyFileSync(filePath, backupPath);
  if (mode !== undefined) {
    chmodSync(backupPath, mode);
  }
}

function serializeEnv(pairs: Array<{ key: string; value: string }>): string {
  return pairs.map(p => `${p.key}=${p.value}`).join('\n') + '\n';
}

function buildEnvView(envParsed: Record<string, string>): EnvEntry[] {
  const env: EnvEntry[] = Object.entries(envParsed).map(([key, value]) => ({
    key,
    value: isSecretKey(key) ? MASKED : value,
    secret: isSecretKey(key),
  }));

  for (const [key, value] of Object.entries(DEFAULT_ADMIN_ENV)) {
    if (!(key in envParsed)) {
      env.push({ key, value, secret: false });
    }
  }

  return env;
}

export function readForAdmin(store: ConfigFileStore): AdminConfigView {
  const envParsed = parseDotEnvFile(store.envPath);
  const routing = parseRoutingFile(store.fallbackPath);

  return {
    env: buildEnvView(envParsed),
    defaultModel: routing.default_model,
    channels: routing.channels.map(channel => ({
      id: channel.id,
      name: channel.name ?? channel.id,
      baseUrl: channel.base_url,
      apiKeyMasked: MASKED,
      apiKeyConfigured: true,
      disableCooldown: channel.disable_cooldown === true,
    })),
    models: Object.entries(routing.models).map(([canonicalModel, route]) => ({
      canonicalModel,
      channelIds: [...route.channel_ids],
    })),
    aliases: { ...routing.aliases },
    compact: routing.compact === undefined
      ? null
      : {
        model: routing.compact.model,
        channelIds: [...routing.compact.channel_ids],
        v2ChannelIds: [...(routing.compact.v2_channel_ids ?? [])],
      },
  };
}

function applyEnvChanges(envParsed: Record<string, string>, draftEnv: readonly EnvDraftEntry[]): void {
  for (const entry of draftEnv) {
    if (!isSecretKey(entry.key)) {
      if (entry.value !== undefined) {
        envParsed[entry.key] = entry.value;
      }
      continue;
    }

    const action = entry.secretAction ?? 'keep';
    switch (action) {
      case 'keep':
        break;
      case 'replace':
        if (entry.value !== undefined) {
          envParsed[entry.key] = entry.value;
        }
        break;
      case 'clear':
        delete envParsed[entry.key];
        break;
    }
  }
}

function resolveChannelApiKey(channel: ChannelDraft, existingKeysById: ReadonlyMap<string, string>): string {
  switch (channel.apiKeyAction) {
    case 'keep': {
      const existing = existingKeysById.get(channel.id);
      if (existing === undefined) {
        throw new Error(`channel '${channel.id}' cannot keep an api key because it does not exist yet`);
      }
      return existing;
    }
    case 'replace':
      if (channel.apiKeyValue === undefined || channel.apiKeyValue.trim().length === 0) {
        throw new Error(`channel '${channel.id}' replacement api key must be non-empty`);
      }
      return channel.apiKeyValue;
  }
}

function buildRoutingDocument(draft: AdminConfigDraft, existingRouting: RawRoutingDocument): RawRoutingDocument {
  const existingKeysById = new Map(existingRouting.channels.map(channel => [channel.id, channel.api_key]));
  const models: Record<string, { channel_ids: string[] }> = {};
  for (const route of draft.models) {
    models[route.canonicalModel.trim()] = { channel_ids: route.channelIds.map(channelId => channelId.trim()) };
  }

  const compact = draft.compact === undefined || draft.compact === null
    ? undefined
    : {
      model: draft.compact.model.trim(),
      channel_ids: draft.compact.channelIds.map(channelId => channelId.trim()),
      ...((draft.compact.v2ChannelIds ?? []).length === 0
        ? {}
        : {
          v2_channel_ids: (draft.compact.v2ChannelIds ?? []).map(channelId => channelId.trim()),
        }),
    };

  return {
    default_model: draft.defaultModel.trim(),
    channels: draft.channels.map(channel => {
      const name = channel.name?.trim();
      const output: RawRoutingChannel & { disable_cooldown?: boolean } = name === undefined || name.length === 0
        ? {
          id: channel.id.trim(),
          base_url: channel.baseUrl.trim(),
          api_key: resolveChannelApiKey(channel, existingKeysById),
        }
        : {
          id: channel.id.trim(),
          name,
          base_url: channel.baseUrl.trim(),
          api_key: resolveChannelApiKey(channel, existingKeysById),
        };
      if (channel.disableCooldown === true) {
        output.disable_cooldown = true;
      }
      return output;
    }),
    models,
    aliases: { ...draft.aliases },
    ...(compact === undefined ? {} : { compact }),
  };
}

export function applyAdminDraft(store: ConfigFileStore, draft: AdminConfigDraft): void {
  const envParsed = parseDotEnvFile(store.envPath);
  const existingRouting = parseRoutingFile(store.fallbackPath);
  const nextRouting = buildRoutingDocument(draft, existingRouting);
  parseRoutingConfig(nextRouting, store.fallbackPath);

  backupFile(store.envPath);
  backupFile(store.fallbackPath, 0o600);

  applyEnvChanges(envParsed, draft.env);
  const envPairs = Object.entries(envParsed).map(([key, value]) => ({ key, value }));

  atomicWrite(store.envPath, serializeEnv(envPairs));
  atomicWrite(store.fallbackPath, JSON.stringify(nextRouting, null, 2) + '\n', 0o600);
}

function validateEnvDraft(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('draft.env must be an array');
    return;
  }

  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`draft.env[${i}] must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || e.key.trim().length === 0) {
      errors.push(`draft.env[${i}].key must be a non-empty string`);
    }
    if (e.secretAction !== undefined && !['keep', 'replace', 'clear'].includes(String(e.secretAction))) {
      errors.push(`draft.env[${i}].secretAction must be 'keep', 'replace', or 'clear'`);
    }
    if (!e.secretAction && typeof e.value !== 'string') {
      errors.push(`draft.env[${i}].value must be a string for non-secret entries`);
    }
    if (
      e.key === 'PROXY_CLAUDE_BILLING_HEADER_MODE' &&
      e.value !== undefined &&
      !['strip_line', 'strip-line', 'strip_cch', 'strip-cch'].includes(String(e.value).trim().toLowerCase())
    ) {
      errors.push(`draft.env[${i}].value must be 'strip_line' or 'strip_cch' for PROXY_CLAUDE_BILLING_HEADER_MODE`);
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const entry of value) {
    if (entry && typeof entry.key === 'string' && typeof entry.value === 'string') env[entry.key] = entry.value;
  }
  try { readRoutingPolicyConfig(env); } catch (error) { errors.push(String(error)); }
}

function validateChannels(value: unknown, errors: string[]): Set<string> {
  const channelIds = new Set<string>();
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('draft.channels must be a non-empty array');
    return channelIds;
  }

  for (let i = 0; i < value.length; i += 1) {
    const channel = value[i];
    if (typeof channel !== 'object' || channel === null || Array.isArray(channel)) {
      errors.push(`draft.channels[${i}] must be an object`);
      continue;
    }
    const c = channel as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    if (id.length === 0) {
      errors.push(`draft.channels[${i}].id must be a non-empty string`);
    } else if (channelIds.has(id)) {
      errors.push(`draft.channels[${i}].id duplicates another channel id`);
    } else {
      channelIds.add(id);
    }
    if (c.name !== undefined && typeof c.name !== 'string') {
      errors.push(`draft.channels[${i}].name must be a string when present`);
    }
    if (typeof c.baseUrl !== 'string' || c.baseUrl.trim().length === 0) {
      errors.push(`draft.channels[${i}].baseUrl must be a non-empty string`);
    }
    if (c.disableCooldown !== undefined && typeof c.disableCooldown !== 'boolean') {
      errors.push(`draft.channels[${i}].disableCooldown must be a boolean when present`);
    }
    if (c.apiKeyAction !== 'keep' && c.apiKeyAction !== 'replace') {
      errors.push(`draft.channels[${i}].apiKeyAction must be 'keep' or 'replace'`);
    }
    if (c.apiKeyAction === 'replace' && (typeof c.apiKeyValue !== 'string' || c.apiKeyValue.trim().length === 0)) {
      errors.push(`draft.channels[${i}].apiKeyValue must be a non-empty string when apiKeyAction is 'replace'`);
    }
  }

  return channelIds;
}

function validateModels(value: unknown, channelIds: ReadonlySet<string>, errors: string[]): Set<string> {
  const canonicalModels = new Set<string>();
  if (!Array.isArray(value)) {
    errors.push('draft.models must be an array');
    return canonicalModels;
  }

  for (let i = 0; i < value.length; i += 1) {
    const route = value[i];
    if (typeof route !== 'object' || route === null || Array.isArray(route)) {
      errors.push(`draft.models[${i}] must be an object`);
      continue;
    }
    const r = route as Record<string, unknown>;
    const canonicalModel = typeof r.canonicalModel === 'string' ? r.canonicalModel.trim() : '';
    if (canonicalModel.length === 0) {
      errors.push(`draft.models[${i}].canonicalModel must be a non-empty string`);
    } else if (canonicalModels.has(canonicalModel)) {
      errors.push(`draft.models[${i}].canonicalModel duplicates another canonical model`);
    } else {
      canonicalModels.add(canonicalModel);
    }

    if (!Array.isArray(r.channelIds) || r.channelIds.length === 0) {
      errors.push(`draft.models[${i}].channelIds must be a non-empty array`);
      continue;
    }
    const routeChannelIds = new Set<string>();
    for (let j = 0; j < r.channelIds.length; j += 1) {
      const channelId = r.channelIds[j];
      const normalized = typeof channelId === 'string' ? channelId.trim() : '';
      if (normalized.length === 0) {
        errors.push(`draft.models[${i}].channelIds[${j}] must be a non-empty string`);
      } else if (routeChannelIds.has(normalized)) {
        errors.push(`draft.models[${i}].channelIds[${j}] duplicates another channel in the route`);
      } else if (!channelIds.has(normalized)) {
        errors.push(`draft.models[${i}].channelIds[${j}] references an unknown channel id`);
      }
      routeChannelIds.add(normalized);
    }
  }

  return canonicalModels;
}

function validateAliases(value: unknown, canonicalModels: ReadonlySet<string>, errors: string[]): Set<string> {
  const aliasNames = new Set<string>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('draft.aliases must be a JSON object');
    return aliasNames;
  }

  const aliases = value as Record<string, unknown>;
  for (const [alias, target] of Object.entries(aliases)) {
    const normalizedAlias = alias.trim();
    if (normalizedAlias.length === 0) {
      errors.push("draft.aliases[''] must have a non-empty alias name");
    } else {
      aliasNames.add(normalizedAlias);
    }
    if (canonicalModels.has(normalizedAlias)) {
      errors.push(`draft.aliases['${alias}'] collides with a canonical model name`);
    }
    if (typeof target !== 'string' || target.trim().length === 0) {
      errors.push(`draft.aliases['${alias}'] must target a non-empty canonical model string`);
    } else if (!canonicalModels.has(target.trim())) {
      errors.push(`draft.aliases['${alias}'] targets an unknown canonical model`);
    }
  }

  return aliasNames;
}

type CompactValidationContext = Readonly<{
  channelIds: ReadonlySet<string>;
  canonicalModels: ReadonlySet<string>;
  aliasNames: ReadonlySet<string>;
}>;

function validateCompact(value: unknown, context: CompactValidationContext, errors: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push('draft.compact must be an object or null when present');
    return;
  }

  const compact = value as Record<string, unknown>;
  const model = typeof compact.model === 'string' ? compact.model.trim() : '';
  if (model.length === 0) {
    errors.push('draft.compact.model must be a non-empty string');
  } else if (!context.canonicalModels.has(model) && !context.aliasNames.has(model)) {
    errors.push('draft.compact.model must reference an existing canonical model or alias');
  }

  if (!Array.isArray(compact.channelIds) || compact.channelIds.length === 0) {
    errors.push('draft.compact.channelIds must be a non-empty array');
    return;
  }

  const compactChannelIds = new Set<string>();
  for (let index = 0; index < compact.channelIds.length; index += 1) {
    const channelId = compact.channelIds[index];
    const normalized = typeof channelId === 'string' ? channelId.trim() : '';
    if (normalized.length === 0) {
      errors.push(`draft.compact.channelIds[${index}] must be a non-empty string`);
    } else if (compactChannelIds.has(normalized)) {
      errors.push(`draft.compact.channelIds[${index}] duplicates another channel in the compact route`);
    } else if (!context.channelIds.has(normalized)) {
      errors.push(`draft.compact.channelIds[${index}] references an unknown channel id`);
    }
    compactChannelIds.add(normalized);
  }

  if (compact.v2ChannelIds === undefined || compact.v2ChannelIds === null) {
    return;
  }
  if (!Array.isArray(compact.v2ChannelIds)) {
    errors.push('draft.compact.v2ChannelIds must be an array or null when present');
    return;
  }

  const compactV2ChannelIds = new Set<string>();
  for (let index = 0; index < compact.v2ChannelIds.length; index += 1) {
    const channelId = compact.v2ChannelIds[index];
    const normalized = typeof channelId === 'string' ? channelId.trim() : '';
    if (normalized.length === 0) {
      errors.push(`draft.compact.v2ChannelIds[${index}] must be a non-empty string`);
    } else if (compactV2ChannelIds.has(normalized)) {
      errors.push(`draft.compact.v2ChannelIds[${index}] duplicates another channel in the compact v2 route`);
    } else if (!context.channelIds.has(normalized)) {
      errors.push(`draft.compact.v2ChannelIds[${index}] references an unknown channel id`);
    }
    compactV2ChannelIds.add(normalized);
  }
}

export function validateDraft(draft: unknown): { ok: true; warnings: string[] } | { ok: false; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return { ok: false, errors: ['draft must be a JSON object'] };
  }

  const d = draft as Record<string, unknown>;
  validateEnvDraft(d.env, errors);

  if (typeof d.defaultModel !== 'string' || d.defaultModel.trim().length === 0) {
    errors.push('draft.defaultModel must be a non-empty string');
  }

  const channelIds = validateChannels(d.channels, errors);
  const canonicalModels = validateModels(d.models, channelIds, errors);
  const aliasNames = validateAliases(d.aliases, canonicalModels, errors);
  validateCompact(d.compact, { channelIds, canonicalModels, aliasNames }, errors);

  if (
    typeof d.defaultModel === 'string' &&
    d.defaultModel.trim().length > 0 &&
    !canonicalModels.has(d.defaultModel.trim()) &&
    !aliasNames.has(d.defaultModel.trim())
  ) {
    errors.push('draft.defaultModel must reference an existing canonical model or alias');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, warnings };
}
