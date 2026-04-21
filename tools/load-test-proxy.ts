import 'dotenv/config';

const url = process.env.LOAD_TEST_URL ?? 'http://127.0.0.1:11234/v1/responses';
const allowedModels = new Set(['gpt-5.4', 'gpt-5.2', 'gpt-5-codex-mini']);
const defaultProviderModel = process.env.PRIMARY_PROVIDER_DEFAULT_MODEL;
const requestedModel = process.argv[2] ?? process.env.LOAD_TEST_MODEL ?? defaultProviderModel ?? 'gpt-5.4';
const prompt =
  process.env.LOAD_TEST_PROMPT ?? 'Reply with a very short greeting only.';

if (!allowedModels.has(requestedModel)) {
  throw new Error(
    `Unsupported load test model: ${requestedModel}. Allowed models: ${Array.from(allowedModels).join(', ')}`,
  );
}

const model = requestedModel;
const defaultRpsByModel: Record<string, number> = {
  'gpt-5.4': 3,
  'gpt-5.2': 5,
  'gpt-5-codex-mini': 10,
};
const rps = Number(process.env.LOAD_TEST_RPS ?? defaultRpsByModel[model] ?? 5);
const durationMs = Number(process.env.LOAD_TEST_DURATION_MS ?? 5000);

type Result = {
  ok: boolean;
  status: number;
  latencyMs: number;
  bodyPreview: string;
};

let inFlight = 0;
let maxInFlight = 0;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function singleRequest(index: number): Promise<Result> {
  const startedAt = Date.now();
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: `${prompt} [request ${index + 1}]`,
      }),
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      bodyPreview: text.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      bodyPreview: error instanceof Error ? error.message : String(error),
    };
  } finally {
    inFlight -= 1;
  }
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main() {
  const totalRequests = Math.max(1, Math.floor((rps * durationMs) / 1000));
  const intervalMs = 1000 / rps;
  const wallStartedAt = Date.now();
  const recommendedRps = defaultRpsByModel[model] ?? 5;

  console.log('Starting load test...');
  console.log(
    JSON.stringify(
      {
        url,
        model,
        rps,
        recommendedRps,
        durationMs,
        totalRequests,
      },
      null,
      2,
    ),
  );

  const tasks: Array<Promise<Result>> = [];

  for (let i = 0; i < totalRequests; i += 1) {
    tasks.push(singleRequest(i));
    if (i < totalRequests - 1) {
      await sleep(intervalMs);
    }
  }

  const results = await Promise.all(tasks);
  const successCount = results.filter(result => result.ok).length;
  const failureCount = results.length - successCount;
  const latencies = results.map(result => result.latencyMs);
  const avgLatencyMs =
    latencies.length === 0 ? 0 : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
  const wallDurationMs = Date.now() - wallStartedAt;

  const statusCounts = results.reduce<Record<string, number>>((acc, result) => {
    const key = String(result.status);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const failedSamples = results.filter(result => !result.ok).slice(0, 5);

  console.log('\nLoad test result:\n');
  console.log(
    JSON.stringify(
      {
        totalRequests: results.length,
        successCount,
        failureCount,
        successRate: results.length === 0 ? 0 : Number((successCount / results.length).toFixed(4)),
        wallDurationMs,
        achievedRps: wallDurationMs === 0 ? 0 : Number((results.length / (wallDurationMs / 1000)).toFixed(2)),
        maxInFlight,
        avgLatencyMs,
        minLatencyMs: latencies.length === 0 ? 0 : Math.min(...latencies),
        p50LatencyMs: percentile(latencies, 50),
        p90LatencyMs: percentile(latencies, 90),
        p95LatencyMs: percentile(latencies, 95),
        p99LatencyMs: percentile(latencies, 99),
        maxLatencyMs: latencies.length === 0 ? 0 : Math.max(...latencies),
        statusCounts,
        failedSamples,
      },
      null,
      2,
    ),
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
