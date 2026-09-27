import type { ChannelConfig } from './routing-config.js';
import {
  detectionDetail,
  detectionResult,
  probeCompactChannel,
  probeCompactChannelV2,
  type CompactFetch,
  type DetectionProtocol,
  type DetectionResult,
  type DetectionStatus,
} from './compact-detection-probe.js';
export type { DetectionProtocol, DetectionResult, DetectionStatus } from './compact-detection-probe.js';

export type CompactDetectionSnapshot = Readonly<{
  model: string | null;
  inProgress: boolean;
  lastCompletedAt: number | null;
  results: readonly DetectionResult[];
}>;

export type CompactDetectionService = Readonly<{
  probeChannel(
    channel: ChannelConfig,
    model: string,
    options: Readonly<{ protocol: DetectionProtocol; timeoutMs: number }>,
  ): Promise<DetectionResult>;
  detectAll(
    channels: readonly ChannelConfig[],
    model: string,
    options?: Readonly<{ force?: boolean; timeoutMs?: number }>,
  ): Promise<CompactDetectionSnapshot>;
  getResults(): CompactDetectionSnapshot;
  getRunCount(): number;
  setModel(model: string | null): void;
  reset(): void;
}>;

type DetectionServiceOptions = Readonly<{
  fetchImpl?: CompactFetch;
  timeoutMs?: number;
}>;

export function createCompactDetectionService(options: DetectionServiceOptions = {}): CompactDetectionService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 45_000;
  const cache = new Map<string, DetectionResult>();
  const currentResults = new Map<string, DetectionResult>();
  let currentModel: string | null = null;
  let inProgress = false;
  let lastCompletedAt: number | null = null;
  let runCount = 0;
  let activeRun: Promise<void> | null = null;
  let resetGeneration = 0;

  const cacheKey = (channel: ChannelConfig, model: string, protocol: DetectionProtocol): string =>
    `${channel.fingerprint}|${model}|${protocol}`;
  const resultKey = (channelId: string, protocol: DetectionProtocol): string => `${channelId}|${protocol}`;

  const getResults = (): CompactDetectionSnapshot => {
    const results = Array.from(currentResults.values()).sort((left, right) => {
      const channelOrder = left.channelId.localeCompare(right.channelId);
      return channelOrder === 0 ? left.protocol.localeCompare(right.protocol) : channelOrder;
    });

    return {
      model: currentModel,
      inProgress,
      lastCompletedAt,
      results,
    };
  };

  const probeChannel = (
    channel: ChannelConfig,
    model: string,
    probeOptions: Readonly<{ protocol: DetectionProtocol; timeoutMs: number }>,
  ): Promise<DetectionResult> => {
    const options = { timeoutMs: probeOptions.timeoutMs, fetchImpl };
    return probeOptions.protocol === 'v1'
      ? probeCompactChannel(channel, model, options)
      : probeCompactChannelV2(channel, model, options);
  };

  const detectAll = async (
    channels: readonly ChannelConfig[],
    model: string,
    detectOptions: Readonly<{ force?: boolean; timeoutMs?: number }> = {},
  ): Promise<CompactDetectionSnapshot> => {
    while (activeRun !== null) {
      await activeRun;
    }

    const generation = resetGeneration;
    const run = (async (): Promise<void> => {
      inProgress = true;
      currentResults.clear();
      currentModel = model;
      runCount += 1;
      const force = detectOptions.force === true;
      const timeoutMs = detectOptions.timeoutMs ?? defaultTimeoutMs;
      const nextResults = new Map<string, DetectionResult>();
      const protocols = ['v1', 'v2'] as const;
      const targets = channels.flatMap(channel => protocols.map(protocol => ({ channel, protocol })));

      try {
        for (const target of targets) {
          const cached = cache.get(cacheKey(target.channel, model, target.protocol));
          if (cached !== undefined) {
            nextResults.set(resultKey(target.channel.id, target.protocol), cached);
          }
        }
        const pending = targets.filter(
          target => force || !cache.has(cacheKey(target.channel, model, target.protocol)),
        );
        const settled = await Promise.allSettled(pending.map(target => probeChannel(target.channel, model, {
          protocol: target.protocol,
          timeoutMs,
        })));
        if (generation !== resetGeneration) {
          return;
        }
        for (let index = 0; index < settled.length; index += 1) {
          const target = pending[index];
          const item = settled[index];
          if (target === undefined || item === undefined) {
            continue;
          }
          if (item.status === 'fulfilled') {
            cache.set(cacheKey(target.channel, model, target.protocol), item.value);
            nextResults.set(resultKey(target.channel.id, target.protocol), item.value);
            continue;
          }
          const failedResult = detectionResult(target.channel, {
            protocol: target.protocol,
            status: 'error',
            probedAt: Date.now(),
            detail: detectionDetail(item.reason, target.channel.apiKey),
          });
          cache.set(cacheKey(target.channel, model, target.protocol), failedResult);
          nextResults.set(resultKey(target.channel.id, target.protocol), failedResult);
        }
        currentResults.clear();
        for (const [key, result] of nextResults) {
          currentResults.set(key, result);
        }
        lastCompletedAt = Date.now();
      } finally {
        inProgress = false;
      }
    })();
    activeRun = run;
    try {
      await run;
    } finally {
      if (activeRun === run) {
        activeRun = null;
      }
    }
    return getResults();
  };

  return {
    probeChannel,
    detectAll,
    getResults,
    getRunCount: () => runCount,
    setModel: (model: string | null) => {
      if (currentModel !== model) {
        resetGeneration += 1;
        currentResults.clear();
        lastCompletedAt = null;
      }
      currentModel = model;
    },
    reset: () => {
      if (currentModel !== null) {
        resetGeneration += 1;
        currentModel = null;
        currentResults.clear();
        lastCompletedAt = null;
      }
    },
  };
}
