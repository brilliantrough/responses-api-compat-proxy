# Examples

All examples below use placeholder values and public-safe model names.

## Non-Streaming Request

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"public-alias-model","input":"Reply with exactly OK.","stream":false}'
```

## Streaming Request

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"public-alias-model","input":"Count to three.","stream":true}'
```

## Model Alias Example

`model-map.json`:

```json
{
  "model_mappings": {
    "public-alias-model": "my-model-v2"
  }
}
```

Request:

```json
{
  "model": "public-alias-model",
  "input": "Summarize this text.",
  "stream": false
}
```

The client still requests `public-alias-model`, but the proxy forwards `my-model-v2` upstream.

## Fallback Provider Example

`fallback.json`:

```json
{
  "fallback_api_config": [
    {
      "name": "fallback-a",
      "base_url": "https://fallback-a.example",
      "api_key_env": "FALLBACK_A_API_KEY"
    },
    {
      "name": "fallback-b",
      "base_url": "https://fallback-b.example",
      "api_key_env": "FALLBACK_B_API_KEY"
    }
  ]
}
```

`.env`:

```env
FALLBACK_A_API_KEY=your_fallback_a_api_key_here
FALLBACK_B_API_KEY=your_fallback_b_api_key_here
```

Use `api_key_env` so secrets stay in local env files instead of tracked JSON.

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

Use a stable prompt prefix key. Do not include timestamps, UUIDs, request IDs, or any other per-request entropy.

## Choosing `normalized` vs `raw`

Use `normalized` when the client wants the proxy to parse and normalize upstream SSE events before forwarding them.

```env
PROXY_STREAM_MODE=normalized
```

Use `raw` when the client wants to consume the upstream SSE shape directly with less proxy-side interpretation.

```env
PROXY_STREAM_MODE=raw
```

You can also override stream mode per request with `proxy_stream_mode` in the request body or `X-Proxy-Stream-Mode` in the request headers.
