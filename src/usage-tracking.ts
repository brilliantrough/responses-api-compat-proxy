import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { JsonRecord } from './responses-input-normalization.js';

export type UsageAttempt = {
  id: string; requestId: string; startedAt: number; finishedAt: number | null;
  channelId: string; channelName: string; model: string; kind: string;
  outcome: 'pending' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  status: number | null; reason: string | null;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  totalTokens: number | null; reasoningTokens: number | null;
};

export const usageContext = new AsyncLocalStorage<{
  requestId: string;
  write: (row: UsageAttempt) => void;
  current?: ReturnType<typeof beginUsageAttempt>;
}>();

export function beginUsageAttempt(channel: { id: string; name: string }, model: string, kind: string, signal: AbortSignal) {
  const context = usageContext.getStore();
  context?.current?.finish();
  const row: UsageAttempt = {
    id: randomUUID(), requestId: context?.requestId ?? randomUUID(), startedAt: Date.now(), finishedAt: null,
    channelId: channel.id, channelName: channel.name, model, kind, outcome: 'pending', status: null, reason: null,
    inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, reasoningTokens: null,
  };
  let finished = false;
  let terminalFailure: string | undefined;
  const attempt = {
    row,
    observe(response: JsonRecord, usage?: JsonRecord) {
      if (finished) return;
      if (response.status === 'failed' || response.status === 'incomplete' || response.type === 'error' || response.type === 'response.failed' || response.type === 'response.incomplete') {
        terminalFailure = String(response.status ?? response.type);
      }
      if (!usage) return;
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'reasoningTokens'] as const) {
        const value = usage[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) row[key] = value;
      }
    },
    result(outcome: UsageAttempt['outcome'], reason?: string) {
      if (finished) return;
      row.outcome = outcome;
      row.reason = reason ?? null;
    },
    finish() {
      if (finished) return;
      finished = true;
      const abort = signal.reason;
      if (row.outcome !== 'success' && abort?.kind === 'client_disconnect') {
        row.outcome = 'cancelled'; row.reason = 'client_disconnect';
      } else if (row.outcome !== 'success' && abort?.kind === 'timeout') {
        row.outcome = 'failed'; row.reason = `timeout:${abort.phase}`;
      } else if (row.outcome === 'pending') {
        row.outcome = 'failed'; row.reason = 'unfinished_attempt';
      }
      if (terminalFailure && row.outcome === 'success') {
        row.outcome = 'failed'; row.reason = terminalFailure;
      }
      row.finishedAt = Date.now();
      if (row.totalTokens === null && row.inputTokens !== null && row.outputTokens !== null) row.totalTokens = row.inputTokens + row.outputTokens;
      // Invalid cache counters must not manufacture negative uncached input or a >100% hit rate.
      if (row.inputTokens !== null && row.cachedInputTokens !== null && row.cachedInputTokens > row.inputTokens) row.cachedInputTokens = null;
      context?.write(row);
    },
  };
  if (context) { context.current = attempt; context.write(row); }
  return attempt;
}

export function observeResponseUsage(response: JsonRecord, usage?: JsonRecord) {
  usageContext.getStore()?.current?.observe(response, usage);
}
