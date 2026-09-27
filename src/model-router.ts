import type { RoutingConfig } from './routing-config.js';

export type ResolvedModelRoute = Readonly<{
  requestedModel: string;
  canonicalModel: string;
  channelIds: readonly string[];
}>;

export type ModelResolutionError = Readonly<{
  code: 'model_not_configured';
  requestedModel: string;
}>;

export function resolveModelRoute(
  requestedModel: unknown,
  config: RoutingConfig,
): ResolvedModelRoute | ModelResolutionError {
  const requestedModelText =
    typeof requestedModel === 'string' && requestedModel.length > 0 ? requestedModel : config.defaultModel;
  const canonicalModel = config.modelRoutes.has(requestedModelText)
    ? requestedModelText
    : config.aliases[requestedModelText];

  if (canonicalModel === undefined) {
    return {
      code: 'model_not_configured',
      requestedModel: requestedModelText,
    };
  }

  const route = config.modelRoutes.get(canonicalModel);
  if (route === undefined) {
    return {
      code: 'model_not_configured',
      requestedModel: requestedModelText,
    };
  }

  return {
    requestedModel: requestedModelText,
    canonicalModel,
    channelIds: route.channelIds,
  };
}

export function buildConfiguredModelsResponse(config: RoutingConfig): {
  object: string;
  data: Array<{ id: string; object: string; created: number; owned_by: string }>;
} {
  const ids = new Set<string>();

  for (const canonicalModel of config.modelRoutes.keys()) {
    ids.add(canonicalModel);
  }

  for (const aliasName of Object.keys(config.aliases)) {
    ids.add(aliasName);
  }

  return {
    object: 'list',
    data: Array.from(ids)
      .sort()
      .map(id => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'proxy',
      })),
  };
}
