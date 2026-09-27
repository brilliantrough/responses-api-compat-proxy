# Configuration

The proxy reads scalar runtime settings from environment variables and all channel/model routing from one JSON document at `FALLBACK_CONFIG_PATH`.

## Routing Document

`fallback.json` is the single source of truth for upstream channels, canonical model routes, aliases, the default model, and the optional compact route:

```json
{
  "default_model": "gpt-5.4",
  "channels": [
    {
      "id": "provider-a",
      "name": "Provider A",
      "base_url": "https://provider-a.example",
      "api_key": "replace-me"
    },
    {
      "id": "provider-b",
      "base_url": "https://provider-b.example",
      "api_key": "replace-me"
    }
  ],
  "models": {
    "gpt-5.4": { "channel_ids": ["provider-a", "provider-b"] },
    "gpt-5.2": { "channel_ids": ["provider-b", "provider-a"] }
  },
  "aliases": {
    "gpt-latest": "gpt-5.4"
  },
  "compact": {
    "model": "gpt-5.4",
    "channel_ids": ["provider-a", "provider-b"]
  }
}
```

Rules:

- Channel IDs are stable unique identifiers. `name` is display-only and defaults to `id`.
- Each model route uses its own ordered `channel_ids`; channel array order does not control routing.
- Aliases target canonical model names only. They do not own separate routes or health state.
- `default_model` may be a canonical model or an alias; runtime stores the canonical target.
- All channels receive the same canonical model string for a routed request.
- `fallback.json` and `fallback.json.bak` contain inline credentials and must remain mode `0600`.

Validation rejects legacy fallback arrays, env-key references, duplicate channels, unknown channel IDs, alias chains, and unknown defaults. A channel may set `disable_cooldown: true` to bypass ordinary automatic breakers; quota and administrator blocks still apply.

## Compact Route

The optional `compact` section routes OpenAI-style context compaction through its own ordered channel lists with the same health and fallback machinery as model routes:

```json
"compact": {
  "model": "gpt-5.4",
  "channel_ids": ["provider-a", "provider-b"],
  "v2_channel_ids": ["provider-c"]
}
```

- **v1** (unary `POST /v1/responses/compact`): `model` pins the canonical model used for every v1 compact call (aliases resolved; client-supplied `model` overridden). `channel_ids` is the ordered v1 fallback list.
- **v2** (codex remote compaction v2): clients send a normal streaming `POST /v1/responses` whose `input` array ends with `{"type":"compaction_trigger"}`. `v2_channel_ids` (optional) is the dedicated v2 fallback list. The client's conversation model is forwarded unchanged, and the proxy forwards or synthesizes `x-codex-beta-features: remote_compaction_v2`.
- v1 and v2 channel capabilities are disjoint in practice (OAuth relays are usually v2-only; API-key relays are usually v1-only) — configure and detect them separately.
- Compact ordinary failures are isolated under `compact:<model>` for v1 and `compact-v2:<model>` for v2. Only quota exhaustion and administrator actions block the entire channel across protocols.
- When every compact channel is health-blocked before any attempt, the proxy returns `503 compact_channels_unavailable` (v1) / `503 compact_v2_channels_unavailable` (v2); once at least one upstream attempt failed, the standard `fallback_exhausted` semantics apply.
- With no `compact` section configured, the v1 endpoint answers `501 compact route not configured` and v2-trigger requests route through the regular model routes.
- Compaction streams carry no `output_text`: `compaction` output items count as meaningful output (no `stream_no_text_content` false fallback), v2 requests are exempt from the first-text timeout, and the `response.compaction` object value survives normalization.

Compact support detection probes each configured channel with minimal real compact requests for both protocols (small token cost) after config load and via the admin UI's Detect button. Results are cached per channel fingerprint plus compact model plus protocol and are advisory only; they never mutate circuit-breaker state. The v2 `bridge_only` status marks endpoints that accept the request but return a plain-message bridge instead of a real encrypted compaction item.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_COMPACT_TIMEOUT_MS` | `300000` | Total time budget for one upstream compact attempt. |
| `PROXY_COMPACT_DETECT_ENABLED` | `1` | Auto-detect compact support after config load. |
| `PROXY_COMPACT_DETECT_TIMEOUT_MS` | `45000` | Per-channel probe timeout during detection. |

## Common `.env` Fields

```env
PORT=11234
HOST=0.0.0.0
INSTANCE_NAME=proxy-11234
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
```

`PORT`, `HOST`, and `PROXY_ENV_PATH` require a process restart to take full effect. The admin API can reload routing and most scalar settings at runtime after validation.

## Runtime Reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `11234` | Listener port. |
| `HOST` | `0.0.0.0` | Listener host. Use `127.0.0.1` for local-only runs. |
| `INSTANCE_NAME` | `responses-proxy-${PORT}` | Logical name for logs, captures, and admin output. |
| `PROXY_ENV_PATH` | `.env` | `.env` file read by startup and admin editing. |
| `FALLBACK_CONFIG_PATH` | `fallback.json` | Routing config path. |
| `PROXY_ADMIN_ALLOW_HOST` | `0` | Allow non-localhost `/admin` requests when explicitly enabled. |
| `PROXY_MAX_CONCURRENT_REQUESTS` | `512` | Maximum active proxy requests. |
| `PROXY_MAX_CACHED_RESPONSES` | `200` | Cached response lookup entries. |
| `PROXY_FORCE_STORE_FALSE` | `0` | Inject `store: false` for upstream compatibility. |

## Timeout Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `8000` | Initial stream connection setup. |
| `PROXY_NON_STREAM_TIMEOUT_MS` | `20000` | Non-streaming upstream lifetime. |
| `PROXY_FIRST_BYTE_TIMEOUT_MS` | `8000` | Waiting for the first body chunk. |
| `PROXY_FIRST_TEXT_TIMEOUT_MS` | `0` | Waiting for recognized text in normalized streams; `0` disables it. |
| `PROXY_STREAM_IDLE_TIMEOUT_MS` | `15000` | Maximum gap between stream chunks. |
| `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | `45000` | Total proxy request lifetime. |
| `PROXY_MAX_FALLBACK_TOTAL_MS` | `30000` | Time budget for scanning configured route channels. |

Keep `PROXY_TOTAL_REQUEST_TIMEOUT_MS` larger than `PROXY_MAX_FALLBACK_TOTAL_MS` so fallback exhaustion can return a controlled response.

## Health and Fallback Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_HEALTH_WINDOW_MS` | `180000` | Sliding window of completed upstream attempts. |
| `PROXY_HEALTH_FAILURE_THRESHOLD` | `15` | Minimum failures in the window. |
| `PROXY_HEALTH_FAILURE_RATE_THRESHOLD` | `0.5` | Failure ratio must be strictly greater than this value, in addition to the minimum count. |
| `PROXY_HEALTH_COOLDOWN_MS` | `600000` | Ordinary and manual breaker duration. |
| `PROXY_CHANNEL_MAX_ATTEMPTS` | `3` | Total attempts per channel per client request, including the first. |
| `PROXY_CHANNEL_RETRY_DELAY_MS` | `500` | Delay between attempts on the same channel; no delay when moving to another channel. |
| `PROXY_CACHE_KEY_POOL_SIZE` | `100` | Exact-key LRU history capacity; never overrides route priority. |
| `PROXY_QUOTA_COOLDOWN_MS` | `7200000` | Cooldown after an upstream reports quota/spend exhaustion (for example `codex_quota_exhausted`, `额度已用完`). This breaker also applies to channels with `disable_cooldown` and shows as a violet `quota` badge on the monitor. |
| `PROXY_FALLBACK_ON_RETRYABLE_4XX` | `1` | Retry selected retryable client-status upstream failures. |
| `PROXY_FALLBACK_ON_COMPAT_4XX` | `1` | Retry configured compatibility-pattern 4xx failures. |
| `PROXY_FALLBACK_COMPAT_PATTERNS` | built-in list | Extra messages that qualify for compatibility fallback. |
| `PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS` | built-in list | Client-input errors that must not fall back. |

Health scopes:

- Ordinary Responses models share one channel-level window; compact uses the isolated scopes described above. Two failures followed by success count as two failures and one success, not one successful request. Cancellation, client-input and proxy-internal errors do not enter the window.
- Every request starts at the highest-priority available channel, retries it up to the attempt limit, then moves forward. A later request returns to recovered higher-priority channels. The key pool tracks session history, without deduplication or sticky fallback routing.
- Quota exhaustion blocks the whole channel immediately, even with `disable_cooldown`. A delayed concurrent success never clears it. Administrator recovery or expiry permits requests again; a new quota error re-arms it.
- `/admin/monitor` exposes immediate open/restore actions. Restore clears all channel blocks and decision windows, retaining cumulative usage. Actions invalidate older health results. `POST /admin/channels/breaker` requires `channelId`, current `fingerprint`, and `action: "open" | "close"`.
- Successful output without usage is returned without retries; absent token fields stay unknown. SSE already sent to the client is never replayed.

Legacy `PROXY_CHANNEL_COOLDOWN_MS`, `PROXY_MODEL_CHANNEL_COOLDOWN_MS`, `PROXY_CHANNEL_FAILURE_THRESHOLD`, `PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD`, and `PROXY_HALF_OPEN_MAX_PROBES` are ignored with a warning. New policy values are validated and hot-reloaded; existing active cooldown deadlines are preserved.

If every candidate is blocked before any upstream request starts, the proxy returns `503 model_channels_unavailable` with `Retry-After`. If at least one upstream request starts and all usable route entries fail, it preserves `fallback_exhausted` semantics.

Reload validates the full candidate configuration first, then commits the runtime snapshot, health settings and topology synchronously. Stale leases from old requests cannot mutate the new topology.

## Request Normalization

```env
PROXY_CONVERT_SYSTEM_TO_DEVELOPER=1
PROXY_CLEAR_DEVELOPER_CONTENT=0
PROXY_CLEAR_SYSTEM_CONTENT=0
PROXY_CLEAR_INSTRUCTIONS=0
PROXY_OVERRIDE_INSTRUCTIONS_TEXT=
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line` removes gateway attribution lines that can break prompt-cache prefix stability. `strip_cch` keeps the line and removes only dynamic `cch=...` fields.

## Stream Mode

```env
PROXY_STREAM_MODE=normalized
```

- `normalized` parses upstream SSE events and forwards Responses-style events.
- `raw` passes upstream SSE through with less interpretation.

Clients can override stream mode with request body `proxy_stream_mode` or the `X-Proxy-Stream-Mode` header.

## Admin Editing and Secrets

The admin UI edits `.env` and `fallback.json`. Channel API keys are masked on read and require explicit replacement. Routing saves create `.bak` backups, write sensitive JSON with `0600`, validate before reload, and retain the previous runtime snapshot if reload fails.

When the admin API writes `.env`, comments, quotes, and multiline values are normalized. Clearing an inherited environment value still requires a process restart.

## Prompt Cache Hints

The proxy preserves client-provided `prompt_cache_retention` and `prompt_cache_key`. If absent, defaults can be injected:

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-prefix-key
```

Use only stable prompt prefix keys. Do not include timestamps, UUIDs, request IDs, or other per-request entropy.

## Debug Settings

```env
PROXY_LOG_REQUEST_BODY=0
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
```

Debug captures can contain full prompts and upstream responses. Keep them off unless actively investigating an issue.
