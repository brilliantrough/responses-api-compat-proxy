# Configuration

The proxy reads scalar runtime settings from environment variables and structured fallback and model settings from JSON files.

Use this page in two passes:

1. Fill the required provider fields.
2. Keep the recommended defaults unless you already know why your upstream needs something different.

## Required Fields

These are the minimum fields needed to call an upstream provider:

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
```

The proxy calls:

- `PRIMARY_PROVIDER_BASE_URL + /v1/responses`
- `PRIMARY_PROVIDER_BASE_URL + /v1/models`

If the base URL does not expose those endpoints, the proxy cannot work.

## Common Fields Most Users Change

These are the settings most users touch during setup:

```env
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
MODEL_MAP_PATH=./instances/proxy-11234/model-map.json
```

- `PRIMARY_PROVIDER_DEFAULT_MODEL` provides a convenient default model name for testing.
- `PORT` and `HOST` control the listener address.
- `INSTANCE_NAME` labels logs, admin output, and captures.
- `PROXY_ENV_PATH` tells the admin config API which `.env` file to read and write.
- `FALLBACK_CONFIG_PATH` and `MODEL_MAP_PATH` should usually point at gitignored runtime files, not tracked `*.example` files.

### Restart-Required Fields

Changes to `PORT` or `HOST` are detected at runtime reload but require a full process restart to take effect. When the admin UI or reload endpoint detects these changes, `restartRequiredFields` lists them and the UI shows a restart-required notice.

Changing `PROXY_ENV_PATH` also requires a process restart because it is read only at startup.

## Advanced Runtime Controls

Most users should leave these alone on the first run.

### Runtime Reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `11234` | Listener port. |
| `HOST` | `0.0.0.0` | Listener host. |
| `INSTANCE_NAME` | `responses-proxy-${PORT}` | Logical instance name for logs, captures, and admin output. |
| `PROXY_ENV_PATH` | `.env` | `.env` file used by startup and admin editing. |
| `FALLBACK_CONFIG_PATH` | `config.json` | Fallback provider JSON path. |
| `MODEL_MAP_PATH` | `model-map.json` | Model mapping JSON path. |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `512` | Maximum active proxy requests before overload rejection. |
| `PROXY_MAX_CACHED_RESPONSES` | `200` | Maximum cached response lookup entries. |
| `PROXY_FORCE_STORE_FALSE` | `0` | Inject `store: false` for upstream compatibility. |

The tracked example directories under `instances/example-*` are templates. Real deployments should copy them to gitignored runtime files such as `instances/proxy-11234/.env`, `instances/proxy-11234/fallback.json`, and `instances/proxy-11234/model-map.json`.

### Timeout Settings

Code defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `8000` | Initial stream connection setup. |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `20000` | Non-streaming upstream request lifetime. |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `8000` | Waiting for the first response body chunk. |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `0` | Waiting for recognized text in normalized streams; `0` disables this guard. |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `15000` | Maximum gap between stream body chunks. |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `45000` | Total proxy request lifetime. |
| `PROXY_MAX_FALLBACK_ATTEMPTS` | fallback endpoint count, minimum `1` | Maximum fallback endpoints to try. |
| `PROXY_MAX_FALLBACK_TOTAL_MS` | `30000` | Time budget for fallback attempts. |

### Recommended Profiles

#### Local Development

Use when you want quick local testing on one machine.

```env
PROXY_STREAM_MODE=normalized
PROXY_MAX_CONCURRENT_REQUESTS=32
PROXY_MAX_CACHED_RESPONSES=50
```

#### General Stable Proxy

Recommended starting point for most deployments.

```env
PROXY_UPSTREAM_TIMEOUT_MS=50000
PROXY_NON_STREAM_TIMEOUT_MS=240000
PROXY_FIRST_BYTE_TIMEOUT_MS=40000
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
PROXY_MAX_FALLBACK_TOTAL_MS=480000
PROXY_MAX_CONCURRENT_REQUESTS=128
PROXY_MAX_CACHED_RESPONSES=200
```

#### Long Streaming Outputs

Use when providers are slow or long-form generation often pauses between chunks.

```env
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
```

Increase timeouts if your upstream produces long pauses before first text or between chunks. Decrease them if you want the proxy to fail fast and move to fallback sooner. Keep `PROXY_TOTAL_REQUEST_TIMEOUT_MS` larger than `PROXY_MAX_FALLBACK_TOTAL_MS` so fallback exhaustion can still return a controlled response.

The tracked `.env.example` files intentionally use these recommended values, which are more conservative than some code defaults such as `PROXY_MAX_FALLBACK_TOTAL_MS=30000`.

Example stable starting values:

```env
PROXY_UPSTREAM_TIMEOUT_MS=50000
PROXY_NON_STREAM_TIMEOUT_MS=240000
PROXY_FIRST_BYTE_TIMEOUT_MS=40000
PROXY_FIRST_TEXT_TIMEOUT_MS=120000
PROXY_STREAM_IDLE_TIMEOUT_MS=70000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=700000
PROXY_MAX_FALLBACK_TOTAL_MS=480000
```

### Stream Mode

```env
PROXY_STREAM_MODE=normalized
```

Supported values:

- `normalized` - parse upstream SSE events, normalize Responses-style payloads, and buffer pre-text metadata until text is recognized.
- `raw` - pass upstream SSE through with less proxy-side interpretation.

Clients can override stream mode per request with `proxy_stream_mode` in the request body or the `X-Proxy-Stream-Mode` header.

### Fallback Policy And Circuit Breaker

```env
PROXY_FALLBACK_ON_RETRYABLE_4XX=1
PROXY_FALLBACK_ON_COMPAT_4XX=1
PROXY_FALLBACK_COMPAT_PATTERNS=model not found,unsupported model,store must be false
PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS=maximum context length,input too large
PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS=120000
PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS=120000
PROXY_ENDPOINT_AUTH_COOLDOWN_MS=1800000
PROXY_ENDPOINT_FAILURE_THRESHOLD=1
PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES=1
```

These settings control which upstream failures trigger fallback and how long endpoints stay cooled down after failures.

### Request Normalization

```env
PROXY_CONVERT_SYSTEM_TO_DEVELOPER=1
PROXY_CLEAR_DEVELOPER_CONTENT=0
PROXY_CLEAR_SYSTEM_CONTENT=0
PROXY_CLEAR_INSTRUCTIONS=0
PROXY_OVERRIDE_INSTRUCTIONS_TEXT=
```

Use these only when an upstream provider needs compatibility adjustments. `PROXY_CONVERT_SYSTEM_TO_DEVELOPER` is enabled by default.

## Fallback Providers

Prefer `api_key_env` so secrets stay in environment files instead of JSON:

```json
{
  "fallback_api_config": [
    {
      "name": "fallback-a",
      "base_url": "https://fallback-a.example",
      "api_key_env": "FALLBACK_A_API_KEY"
    }
  ]
}
```

## Model Mappings

Model mappings rewrite the upstream request model while preserving the client-facing requested model in normalized responses:

```json
{
  "model_mappings": {
    "public-alias-model": "my-model-v2"
  }
}
```

## Config File Paths and Admin Editing

The proxy uses three config files controlled by environment variables:

| File | Default Path | Env Variable | Editable via Admin |
| --- | --- | --- | --- |
| `.env` | `.env` | `PROXY_ENV_PATH` | Yes |
| Fallback JSON | `config.json` | `FALLBACK_CONFIG_PATH` | Yes |
| Model map JSON | `model-map.json` | `MODEL_MAP_PATH` | Yes |

`PROXY_ENV_PATH` overrides the `.env` file location. When set, the admin config API reads from and writes to this path. The admin UI at `/admin` allows editing all three files through the browser, but only from localhost.

### Secret Handling

Environment keys containing `KEY`, `TOKEN`, or `SECRET` are treated as secrets:

- Read: `GET /admin/config` returns `***`, never the actual value.
- Edit: secret fields are masked and require explicit replacement.
- Save: `PUT /admin/config` supports `keep`, `replace`, and `clear` actions. If omitted, `keep` is assumed.

### `.env` Formatting Limitations

When the admin API writes the `.env` file, it normalizes formatting:

- Comments, quotes, and multiline values are not preserved.
- Clearing a key from `.env` does not remove an inherited `process.env` value until the process restarts.

For security-sensitive clearing, restart the proxy after saving.

### Runtime Path Resolution

Admin config paths for fallback JSON and model-map JSON are derived from the current runtime snapshot on each request, not frozen at startup. After a reload that changes `FALLBACK_CONFIG_PATH` or `MODEL_MAP_PATH`, subsequent admin reads and writes use the new paths.

## Prompt Cache Hints

The proxy preserves client-provided `prompt_cache_retention` and `prompt_cache_key`. If absent, defaults can be injected:

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-prefix-key
```

Use `PROXY_PROMPT_CACHE_KEY` only for a stable prompt prefix key. Do not include timestamps, UUIDs, request IDs, or any other per-request entropy, or cache hit rates will collapse.

Whether the provider actually honors these hints still depends on the upstream implementation.

## Debug Settings (Keep Off By Default)

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
```

`PROXY_LOG_REQUEST_BODY` can log raw request content and should stay disabled unless you are debugging locally. Debug captures can include sensitive prompts or provider responses. Keep these settings disabled by default and never commit capture output.
