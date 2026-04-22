# Configuration

The proxy reads scalar runtime settings from environment variables and structured fallback/model settings from JSON files.

## Primary Provider

Required variables:

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://primary.example
PRIMARY_PROVIDER_API_KEY=your_key_here
```

The proxy calls:

- `PRIMARY_PROVIDER_BASE_URL + /v1/responses`
- `PRIMARY_PROVIDER_BASE_URL + /v1/models`

Optional default model:

```env
PRIMARY_PROVIDER_DEFAULT_MODEL=my-model-v2
```

## Instance Settings

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=proxy-11234
FALLBACK_CONFIG_PATH=./instances/example-11234/fallback.json.example
MODEL_MAP_PATH=./instances/example-11234/model-map.json.example
```

### Restart-Required Fields

Changes to `PORT` or `HOST` are detected at runtime reload but require a full process restart to take effect. When the admin UI or reload endpoint detects these changes, `restartRequiredFields` will list the affected fields and the admin UI will display a restart-required notice. Other configuration changes (timeouts, model mappings, fallback providers) take effect immediately on reload without a restart.

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

`PROXY_ENV_PATH` overrides the `.env` file location. When set, the admin config API reads from and writes to this path. The admin UI at `/admin` allows editing all three files through the browser (localhost only).

### Secret Handling

Environment keys containing `KEY`, `TOKEN`, or `SECRET` (case-insensitive) are treated as secrets:

- **Read**: The `GET /admin/config` endpoint returns `***` for secret values, never the actual value.
- **Edit**: In the admin UI, secret fields are displayed as masked password inputs. To change a secret, type the new value. To keep the existing secret, leave the field empty — the `secretAction: "keep"` default preserves the original value.
- **Save**: The `PUT /admin/config` endpoint supports three secret actions: `keep` (preserve existing), `replace` (set new value), or `clear` (remove). If no action is specified for a secret field, `keep` is assumed.

### .env Formatting Limitations

When the admin API writes the `.env` file, it normalizes formatting:

- **Comments, quotes, and multiline values are not preserved.** The admin API serializes `.env` as simple `KEY=VALUE` lines. Any inline comments, quoted values, or multiline formatting in the original file will be lost on save.
- **Process-level environment variables are not removed.** Clearing a key via admin only removes it from the `.env` file. The corresponding `process.env` variable inherited at process startup remains in memory until the process restarts. For security-sensitive clearing, restart the proxy process after saving.

### Runtime Path Resolution

Admin config paths for fallback JSON and model-map JSON are derived from the current runtime snapshot on each request, not frozen at startup. After a reload that changes `FALLBACK_CONFIG_PATH` or `MODEL_MAP_PATH`, subsequent admin reads and writes use the new paths. Changing `PROXY_ENV_PATH` itself still requires a process restart since it is read only at startup.

## Runtime Reference

Common settings and code defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `11234` | Listener port. |
| `HOST` | `0.0.0.0` | Listener host. |
| `INSTANCE_NAME` | `responses-proxy-${PORT}` | Logical instance name for logs, captures, and admin output. |
| `FALLBACK_CONFIG_PATH` | `config.json` | Fallback provider JSON path. |
| `MODEL_MAP_PATH` | `model-map.json` | Model mapping JSON path. |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `512` | Maximum active proxy requests before overload rejection. |
| `PROXY_MAX_CACHED_RESPONSES` | `200` | Maximum cached response lookup entries. |
| `PROXY_FORCE_STORE_FALSE` | `0` | Inject `store: false` for upstream compatibility. |

The example paths under `instances/example-*` are templates. Real deployments normally copy them to untracked runtime files, for example `instances/proxy-11234/fallback.json` and `instances/proxy-11234/model-map.json`.

## Timeout Settings

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

Example production-oriented values:

```env
PROXY_UPSTREAM_TIMEOUT_MS=30000
PROXY_NON_STREAM_TIMEOUT_MS=300000
PROXY_FIRST_BYTE_TIMEOUT_MS=30000
PROXY_FIRST_TEXT_TIMEOUT_MS=12000
PROXY_STREAM_IDLE_TIMEOUT_MS=60000
PROXY_TOTAL_REQUEST_TIMEOUT_MS=600000
PROXY_MAX_FALLBACK_TOTAL_MS=300000
```

- `PROXY_UPSTREAM_TIMEOUT_MS` limits initial stream connection setup.
- `PROXY_NON_STREAM_TIMEOUT_MS` limits non-streaming upstream requests.
- `PROXY_FIRST_BYTE_TIMEOUT_MS` limits waiting for the first response body chunk.
- `PROXY_FIRST_TEXT_TIMEOUT_MS` limits waiting for recognized text in normalized streams. Set `0` to disable.
- `PROXY_STREAM_IDLE_TIMEOUT_MS` limits gaps between stream body chunks.
- `PROXY_TOTAL_REQUEST_TIMEOUT_MS` limits total proxy request lifetime.
- `PROXY_MAX_FALLBACK_TOTAL_MS` limits time spent trying fallback endpoints.

Keep `PROXY_TOTAL_REQUEST_TIMEOUT_MS` larger than `PROXY_MAX_FALLBACK_TOTAL_MS` so fallback exhaustion can produce a controlled response.

## Stream Mode

```env
PROXY_STREAM_MODE=normalized
```

Supported values:

- `normalized` - parse upstream SSE events, normalize Responses-style payloads, and buffer pre-text metadata until text is recognized.
- `raw` - pass upstream SSE through with less proxy-side interpretation.

Clients can override stream mode per request with `proxy_stream_mode` in the request body or the `X-Proxy-Stream-Mode` header.

## Fallback Policy And Circuit Breaker

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

## Prompt Cache Hints

The proxy preserves client-provided `prompt_cache_retention` and `prompt_cache_key`. If absent, defaults can be injected:

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-prefix-key
```

Do not include random values, timestamps, or request ids in `PROXY_PROMPT_CACHE_KEY`.

## Request Normalization

```env
PROXY_CONVERT_SYSTEM_TO_DEVELOPER=1
PROXY_CLEAR_DEVELOPER_CONTENT=0
PROXY_CLEAR_SYSTEM_CONTENT=0
PROXY_CLEAR_INSTRUCTIONS=0
PROXY_OVERRIDE_INSTRUCTIONS_TEXT=
```

Use these only when an upstream provider needs compatibility adjustments. `PROXY_CONVERT_SYSTEM_TO_DEVELOPER` is enabled by default.

## Debug Settings

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
```

Debug captures can include sensitive prompts or provider responses. Keep them disabled by default and never commit capture output.
