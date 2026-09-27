# Examples

All examples use placeholder values and models configured in `fallback.json`.

## Routing Config With Alias and Fallback

```json
{
  "default_model": "my-model-v2",
  "channels": [
    {
      "id": "primary",
      "name": "Primary Provider",
      "base_url": "https://primary.example",
      "api_key": "primary-api-key"
    },
    {
      "id": "fallback-a",
      "name": "Fallback A",
      "base_url": "https://fallback-a.example",
      "api_key": "fallback-a-api-key"
    }
  ],
  "models": {
    "my-model-v2": { "channel_ids": ["primary", "fallback-a"] },
    "fast-model": { "channel_ids": ["fallback-a", "primary"] }
  },
  "aliases": {
    "public-alias-model": "my-model-v2"
  }
}
```

The proxy forwards the canonical model string to every channel. A client request for `public-alias-model` uses the `my-model-v2` route and health state.

## Non-Streaming Request

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

## Streaming Request

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"public-alias-model","input":"Count to three.","stream":true}'
```

## Omitted Model

When `model` is omitted, the proxy uses `default_model` after resolving an alias if needed:

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"input":"Use the default configured model.","stream":false}'
```

## Prompt Cache Hints

Request body:

```json
{
  "model": "public-alias-model",
  "input": "Summarize the following text.",
  "prompt_cache_retention": "in_memory",
  "prompt_cache_key": "stable-summary-prefix"
}
```

Proxy defaults in `.env`:

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-summary-prefix
```

Use a stable prompt prefix key. Do not include timestamps, UUIDs, request IDs, or other per-request entropy.

## Claude Billing Header Compatibility

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`strip_line` removes the full `x-anthropic-billing-header: ...` line after gateway conversion. `strip_cch` preserves the line and removes only dynamic `cch=...` fields.

## Choosing `normalized` vs `raw`

```env
PROXY_STREAM_MODE=normalized
```

Use `normalized` when the proxy should parse and normalize upstream SSE events. Use `raw` when clients should consume the upstream SSE shape directly.

Per-request overrides are supported through `proxy_stream_mode` in the request body or `X-Proxy-Stream-Mode` in the request headers.
