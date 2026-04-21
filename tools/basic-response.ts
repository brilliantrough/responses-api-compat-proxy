import { createOpenResponses } from '@ai-sdk/open-responses';
import { streamText } from 'ai';
import 'dotenv/config';

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

const providerName = process.env.PRIMARY_PROVIDER_NAME ?? 'primary-provider';
const providerBaseUrl = normalizeBaseUrl(
  process.env.PRIMARY_PROVIDER_BASE_URL ?? 'https://primary.example',
);
const apiKey = process.env.PRIMARY_PROVIDER_API_KEY;
const defaultModel = process.env.PRIMARY_PROVIDER_DEFAULT_MODEL ?? 'my-model-v2';
const responsesUrl = `${providerBaseUrl}/v1/responses`;

if (!apiKey) {
  throw new Error('Missing PRIMARY_PROVIDER_API_KEY in .env');
}

const model = process.argv[2] ?? defaultModel;
const prompt =
  process.argv.slice(3).join(' ') ||
  'Please reply with a short greeting and confirm that the Responses API request worked.';

const provider = createOpenResponses({
  name: providerName,
  url: responsesUrl,
  apiKey,
});

async function main() {
  console.log('Sending request...');
  console.log(`- provider: ${providerName}`);
  console.log(`- endpoint: ${responsesUrl}`);
  console.log(`- model: ${model}`);
  console.log(`- prompt: ${prompt}`);

  const streamEventTypes: string[] = [];
  const streamSamples: unknown[] = [];
  let finishPayload: unknown;

  const result = streamText({
    model: provider(model),
    prompt,
    onFinish(event) {
      finishPayload = {
        finishReason: event.finishReason,
        usage: event.usage,
        totalUsage: event.totalUsage,
        response: event.response,
      };
    },
  });

  console.log('\nStreaming text:\n');

  for await (const part of result.fullStream) {
    streamEventTypes.push(part.type);
    if (streamSamples.length < 10) {
      streamSamples.push(part);
    }

    if (part.type === 'text-delta' && typeof part.text === 'string') {
      process.stdout.write(part.text);
    }
  }

  console.log('\n\nDebug info:\n');

  console.log(
    JSON.stringify(
      {
        eventTypes: streamEventTypes,
        warnings: await result.warnings,
        finishReason: await result.finishReason,
        usage: await result.usage,
        text: await result.text,
        streamSamples,
        finishPayload,
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error('\nRequest failed.');

  if (error instanceof Error) {
    console.error(error.message);

    const maybeCause = error as Error & { cause?: unknown };
    if (maybeCause.cause) {
      console.error('\nCause:');
      console.error(JSON.stringify(maybeCause.cause, null, 2));
    }
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});
