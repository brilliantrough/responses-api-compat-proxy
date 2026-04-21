# Responses API Compatibility Proxy

A TypeScript proxy for testing and normalizing OpenAI Responses API-compatible upstream providers.

This project is not an official OpenAI project. It is a compatibility and operations layer for providers that expose OpenAI-style `/v1/responses` and `/v1/models` endpoints, with extra handling for fallback, SSE normalization, request normalization, and runtime diagnostics.

## Features

- `POST /v1/responses` proxying for JSON and streaming clients.
- `GET /v1/models` passthrough with optional model alias exposure.
- OpenAI Responses API request normalization helpers.
- `raw` and `normalized` SSE stream modes.
- Fallback providers with retryable error classification.
- Endpoint cooldown and lightweight circuit breaker behavior.
- Prompt cache hint passthrough and default injection.
- Lightweight admin endpoints for stats and cache clearing.
- Example multi-instance configuration layout.

## Quick Start

```bash
npm install
cp instances/example-11234/.env.example .env
npm run build
npm run proxy
```

Edit `.env` before starting the proxy:

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://primary.example
PRIMARY_PROVIDER_API_KEY=your_key_here
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=proxy-11234
FALLBACK_CONFIG_PATH=./instances/example-11234/fallback.json.example
MODEL_MAP_PATH=./instances/example-11234/model-map.json.example
```

Send a non-streaming request:

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"my-model-v2","input":"Say hello."}'
```

Send a streaming request:

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model":"my-model-v2","input":"Say hello.","stream":true}'
```

## Repository Layout

- `src/` - production proxy source and Responses compatibility helpers.
- `checks/` - lightweight regression checks and mock-upstream checks.
- `tools/` - manual smoke and load-test tools.
- `instances/` - safe example instance layouts.
- `deploy/systemd/` - deployment templates.
- `docs/` - configuration, streaming, and operations notes.

## Configuration

See `docs/configuration.md` for environment variables, fallback config, model mappings, prompt cache hints, and timeout guidance.

## Streaming Compatibility

See `docs/streaming-compatibility.md` for SSE behavior, `raw` vs `normalized` stream modes, timeout phases, and missing usage debugging.

## Operations

See `docs/operations.md` for multi-instance layout, systemd deployment, admin endpoints, logs, captures, and safe restart guidance.

## Scripts

- `npm run build` - compile production source to `dist/`.
- `npm run proxy` - start the proxy through `tsx` for development.
- `npm run proxy:start` - start the compiled proxy from `dist/json-proxy.js`.
- `npm run basic` - run a direct Responses API smoke tool.
- `npm run loadtest` - run a low-rate proxy load test.
- `npm run check:sse` - validate SSE parsing and reconstruction helpers.
- `npm run check:normalize` - validate Responses request normalization helpers.
- `npm run check:config` - validate public-safe proxy configuration defaults.
- `npm run check:fallback` - validate fallback classification rules.

## Security Notes

Never commit real `.env` files, real instance directories, provider API keys, logs, captures, raw SSE failure dumps, or request bodies.

The bundled admin endpoints are intended for local or trusted-network operation. Do not expose them directly to the public internet without adding authentication, authorization, and CORS restrictions.

## License

Add a license before publishing the repository.
