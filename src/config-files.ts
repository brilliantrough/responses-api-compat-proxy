import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import { randomUUID } from 'node:crypto';

const MASKED = '***';

type SecretEnvAction = 'keep' | 'replace' | 'clear';

export type EnvEntry = {
  key: string;
  value: string;
  secret: boolean;
};

export type FallbackProviderView = {
  name: string;
  baseUrl: string;
  apiKeyMode: 'env' | 'inline' | 'none';
  apiKeyEnv?: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
};

export type AdminConfigView = {
  env: EnvEntry[];
  fallbackProviders: FallbackProviderView[];
  modelMappings: Record<string, string>;
};

export type EnvDraftEntry = {
  key: string;
  secretAction?: SecretEnvAction;
  value?: string;
};

export type FallbackProviderDraft = {
  name: string;
  baseUrl: string;
  apiKeyMode: 'env' | 'inline' | 'none';
  apiKeyEnv?: string;
  value?: string;
  secretAction?: SecretEnvAction;
};

export type AdminConfigDraft = {
  env: EnvDraftEntry[];
  fallbackProviders: FallbackProviderDraft[];
  modelMappings: Record<string, string>;
};

export type ConfigFileStore = {
  dir: string;
  envPath: string;
  fallbackPath: string;
  modelMapPath: string;
};

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
    modelMapPath: join(resolved, 'model-map.json'),
  };
}

export function createConfigFileStoreFromPaths(options: {
  envPath: string;
  fallbackPath: string;
  modelMapPath: string;
}): ConfigFileStore {
  const envResolved = resolve(options.envPath);
  return {
    dir: resolve(envResolved, '..'),
    envPath: envResolved,
    fallbackPath: resolve(options.fallbackPath),
    modelMapPath: resolve(options.modelMapPath),
  };
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  return dotenvParse(raw);
}

function parseFallbackFile(filePath: string): { fallback_api_config: Array<{
  name: string;
  base_url: string;
  api_key?: string;
  api_key_env?: string;
}> } {
  if (!existsSync(filePath)) return { fallback_api_config: [] };
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function parseModelMapFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && 'model_mappings' in parsed) {
    return parsed.model_mappings;
  }
  return parsed ?? {};
}

function atomicWrite(filePath: string, content: string) {
  const dir = resolve(filePath, '..');
  const tmpFile = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpFile, content, 'utf8');
  renameSync(tmpFile, filePath);
}

function backupFile(filePath: string) {
  if (existsSync(filePath)) {
    copyFileSync(filePath, filePath + '.bak');
  }
}

function serializeEnv(pairs: Array<{ key: string; value: string }>): string {
  return pairs.map(p => `${p.key}=${p.value}`).join('\n') + '\n';
}

export function readForAdmin(store: ConfigFileStore): AdminConfigView {
  const envParsed = parseDotEnvFile(store.envPath);
  const fallbackParsed = parseFallbackFile(store.fallbackPath);
  const modelMappings = parseModelMapFile(store.modelMapPath);

  const env: EnvEntry[] = Object.entries(envParsed).map(([key, value]) => ({
    key,
    value: isSecretKey(key) ? MASKED : value,
    secret: isSecretKey(key),
  }));

  const fallbackProviders: FallbackProviderView[] = (fallbackParsed.fallback_api_config ?? []).map(item => {
    const hasInlineKey = typeof item.api_key === 'string' && item.api_key.length > 0;
    const hasEnvKey = typeof item.api_key_env === 'string' && item.api_key_env.length > 0;

    let apiKeyMode: 'env' | 'inline' | 'none';
    let apiKeyEnv: string | undefined;
    let apiKeyConfigured: boolean;
    let apiKeyMasked: string | null;

    if (hasEnvKey) {
      apiKeyMode = 'env';
      apiKeyEnv = item.api_key_env;
      apiKeyConfigured = !!envParsed[item.api_key_env!];
      apiKeyMasked = apiKeyConfigured ? MASKED : null;
    } else if (hasInlineKey) {
      apiKeyMode = 'inline';
      apiKeyConfigured = true;
      apiKeyMasked = MASKED;
    } else {
      apiKeyMode = 'none';
      apiKeyConfigured = false;
      apiKeyMasked = null;
    }

    return {
      name: item.name,
      baseUrl: item.base_url,
      apiKeyMode,
      apiKeyEnv,
      apiKeyConfigured,
      apiKeyMasked,
    };
  });

  return { env, fallbackProviders, modelMappings };
}

export function applyAdminDraft(store: ConfigFileStore, draft: AdminConfigDraft) {
  const envParsed = parseDotEnvFile(store.envPath);
  const fallbackParsed = parseFallbackFile(store.fallbackPath);

  backupFile(store.envPath);
  backupFile(store.fallbackPath);
  backupFile(store.modelMapPath);

  // Apply env changes
  for (const entry of draft.env) {
    if (!isSecretKey(entry.key)) {
      if (entry.value !== undefined) {
        envParsed[entry.key] = entry.value;
      }
      continue;
    }

    const action = entry.secretAction ?? 'keep';
    switch (action) {
      case 'keep':
        // preserve existing value, no-op
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

  // Write .env
  const envPairs = Object.entries(envParsed).map(([key, value]) => ({ key, value }));
  atomicWrite(store.envPath, serializeEnv(envPairs));

  // Write fallback.json
  const fallbackConfig = draft.fallbackProviders.map(p => {
    const item: Record<string, string> = {
      name: p.name,
      base_url: p.baseUrl,
    };

    // Check if existing inline secret needs preserving
    const existing = (fallbackParsed.fallback_api_config ?? []).find(
      (e: { name: string }) => e.name === p.name
    );

    if (p.apiKeyMode === 'env') {
      item.api_key_env = p.apiKeyEnv ?? '';
    } else if (p.apiKeyMode === 'inline') {
      const action = p.secretAction ?? 'keep';
      if (action === 'keep' && existing?.api_key) {
        item.api_key = existing.api_key;
      } else if (action === 'replace' && p.value) {
        item.api_key = p.value;
      }
      // 'clear' or no value => no api_key field
    }
    // 'none' => no key fields

    return item;
  });

  atomicWrite(store.fallbackPath, JSON.stringify({ fallback_api_config: fallbackConfig }, null, 2) + '\n');

  // Write model-map.json
  atomicWrite(
    store.modelMapPath,
    JSON.stringify({ model_mappings: draft.modelMappings }, null, 2) + '\n',
  );
}

export function validateDraft(draft: unknown): { ok: true; warnings: string[] } | { ok: false; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (typeof draft !== 'object' || draft === null) {
    return { ok: false, errors: ['draft must be a JSON object'] };
  }

  const d = draft as Record<string, unknown>;

  if (!Array.isArray(d.env)) {
    errors.push('draft.env must be an array');
  } else {
    for (let i = 0; i < d.env.length; i++) {
      const entry = d.env[i];
      if (typeof entry !== 'object' || entry === null) {
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
    }
  }

  if (!Array.isArray(d.fallbackProviders)) {
    errors.push('draft.fallbackProviders must be an array');
  } else {
    for (let i = 0; i < d.fallbackProviders.length; i++) {
      const prov = d.fallbackProviders[i];
      if (typeof prov !== 'object' || prov === null) {
        errors.push(`draft.fallbackProviders[${i}] must be an object`);
        continue;
      }
      const p = prov as Record<string, unknown>;
      if (typeof p.name !== 'string' || p.name.trim().length === 0) {
        errors.push(`draft.fallbackProviders[${i}].name must be a non-empty string`);
      }
      if (typeof p.baseUrl !== 'string' || p.baseUrl.trim().length === 0) {
        errors.push(`draft.fallbackProviders[${i}].baseUrl must be a non-empty string`);
      }
      if (p.apiKeyMode !== undefined && !['env', 'inline', 'none'].includes(String(p.apiKeyMode))) {
        errors.push(`draft.fallbackProviders[${i}].apiKeyMode must be 'env', 'inline', or 'none'`);
      }
    }
  }

  if (typeof d.modelMappings !== 'object' || d.modelMappings === null || Array.isArray(d.modelMappings)) {
    errors.push('draft.modelMappings must be a JSON object');
  } else {
    const mm = d.modelMappings as Record<string, unknown>;
    for (const [alias, target] of Object.entries(mm)) {
      if (typeof target !== 'string') {
        errors.push(`draft.modelMappings['${alias}'] must be a string`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, warnings };
}
