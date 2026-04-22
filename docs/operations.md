# Operations

Deployment, process management, and operational procedures for the Responses API Compatibility Proxy.

Before pushing this repository to a public remote, review `docs/publishing-checklist.md`.

---

## Table of Contents

- [Multi-Instance Layout](#multi-instance-layout)
- [Do Not Commit Real Instance Directories](#do-not-commit-real-instance-directories)
- [Build and Run Commands](#build-and-run-commands)
- [Development Command](#development-command)
- [Health and Admin Endpoints](#health-and-admin-endpoints)
- [Local Admin UI](#local-admin-ui)
- [Logs and Captures — Ignored Directories](#logs-and-captures--ignored-directories)
- [Docker Deployment](#docker-deployment)
- [Safe Restart Pattern](#safe-restart-pattern)
- [Systemd Template](#systemd-template)
- [Migration from Local Working Directory](#migration-from-local-working-directory)

---

## Multi-Instance Layout

Each proxy instance is configured by a dedicated directory under `instances/`. The directory name conventionally matches the instance name and encodes the port for easy identification:

```
instances/
  example-11234/        ← shipped example template
    .env.example
    fallback.json.example
    model-map.json.example
  example-11235/        ← shipped example template
    .env.example
    fallback.json.example
    model-map.json.example
  proxy-11234/          ← runtime instance (gitignored)
    .env
    fallback.json
    model-map.json
  proxy-11235/          ← runtime instance (gitignored)
    .env
    fallback.json
    model-map.json
```

To add a new instance:

1. Copy an example directory:
   ```bash
   cp -r instances/example-11234 instances/proxy-NEWPORT
   ```
2. Edit `instances/proxy-NEWPORT/.env` — set `PORT`, `INSTANCE_NAME`, provider credentials, `PROXY_ENV_PATH`, and file paths.
3. Edit `instances/proxy-NEWPORT/fallback.json` and `model-map.json` as needed.
4. Start the instance using the systemd template or `npm run proxy:start`.

---

## Do Not Commit Real Instance Directories

The `.gitignore` excludes `instances/proxy-*/` so that real instance directories containing secrets and local runtime paths are never committed. Only the `example-*` template directories are tracked.

**Never commit:**

- `instances/proxy-*` directories.
- Real `.env` files.
- `config.json` or real `fallback.json` / `model-map.json` files with live credentials.
- `logs/`, `captures/`, or `sse-failures/` directories.
- Debug capture output.

---

## Build and Run Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript source to `dist/`. |
| `npm run proxy:start` | Run the compiled proxy from `dist/json-proxy.js`. Uses environment variables for configuration. |
| `npm run proxy` | Run the proxy through `tsx` without a separate compile step (convenience alias). |

Production deployments normally run `npm run build` first, then `npm run proxy:start`. The `run.sh` wrapper script handles both steps.

For a single local instance, you can also load an instance `.env` file explicitly:

```bash
env $(grep -v '^#' instances/proxy-11234/.env | xargs) npm run proxy:start
```

---

## Development Command

| Command | Purpose |
| --- | --- |
| `npm run proxy:dev` | Start the proxy via `tsx` for live development. |

This skips the explicit build step and runs the TypeScript source directly.

---

## Health and Admin Endpoints

### GET /healthz

Returns a JSON object with instance status, configuration summary, and the current `activeRequests` count. The response includes more configuration fields than this abbreviated example; use it as an operator-facing snapshot, not as a strict schema.

```json
{
  "ok": true,
  "instanceName": "proxy-11234",
  "activeRequests": 3,
  "maxConcurrentRequests": 128,
  "cachedResponses": 12,
  "port": 11234,
  "host": "0.0.0.0"
}
```

### GET /admin/stats

Returns detailed runtime statistics including per-endpoint health, fallback counts, usage aggregates, and all proxy counters. The object is intended for diagnostics and may grow as additional counters are added.

```json
{
  "instanceName": "proxy-11234",
  "activeRequests": 3,
  "stats": {
    "requestsTotal": 1500,
    "responsesJson": 200,
    "responsesSseNormalized": 1280,
    "responsesSseRaw": 15,
    "upstreamTimeouts": 5,
    "fallbackReasons": {
      "upstream5xx": 0,
      "headersOnlyTimeout": 1,
      "streamMissingUsage": 0
    },
    "usageResponses": 1400,
    "usageInputTokens": 250000,
    "usageOutputTokens": 80000
  },
  "endpointHealth": [
    {
      "name": "primary-provider",
      "state": "closed",
      "failureCount": 0,
      "successCount": 120
    }
  ]
}
```

### POST /admin/cache/clear

Clears the in-memory response cache. Returns the number of entries removed.

```json
{
  "ok": true,
  "clearedResponses": 12,
  "cachedResponses": 0
}
```

### GET /v1/models

Proxies the upstream `/v1/models` endpoint, applying model alias mappings.

### GET /v1/responses/:id

Looks up a previously cached response by ID. Returns `404` if not found.

### POST /v1/responses

Main proxy endpoint. Accepts OpenAI Responses API requests and forwards to the configured upstream provider with normalization, fallback, and streaming support.

**Warning:** These admin endpoints are intended for local or trusted-network operation. Do not expose them to the public internet without authentication and authorization.

---

## Local Admin UI

The proxy includes a browser-based admin UI for inspecting and editing configuration at runtime. Access it at:

```
http://127.0.0.1:<PORT>/admin
```

### Localhost-Only Constraint

All `/admin` endpoints (including the UI and API) are restricted to localhost connections (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Remote connections receive `403 Forbidden`. This constraint cannot be relaxed via configuration. If you need remote access, use an SSH tunnel or a local reverse proxy with authentication. Do not expose `/admin` directly to the public internet.

### UI Sections

The admin UI renders five sections:

1. **Overview** — Runtime version, restart-required fields, instance name, and port.
2. **Providers** — Primary provider environment fields (editable) and fallback provider table with name, base URL, API key mode, and configuration status.
3. **Model Mappings** — Editable key-value rows for model alias-to-target mappings. Use the "+ Add Mapping" button to add new rows.
4. **Runtime / Compatibility** — Read-only display of common runtime environment values (PORT, HOST, stream mode, timeouts, cache settings, etc.).
5. **Review & Apply** — Action buttons: Validate, Save, Reload, Rollback.

### Draft State and Dirty Indicator

Edits in the UI are tracked as a local draft. When the draft differs from the server configuration, an "Unsaved changes" badge appears. Refreshing the page discards the draft and reloads the current server configuration.

### Workflow

#### Validate

Click **Validate** to check the current draft without saving. The UI calls `POST /admin/config/validate` and displays validation results (valid or error list). No files are modified.

#### Save

Click **Save** to apply the draft:

1. The UI calls `PUT /admin/config` with the draft payload.
2. The server creates `.bak` backup files, writes the new configuration, and triggers a runtime reload.
3. On success, the UI reloads the configuration from the server.
4. If the reload detects `PORT` or `HOST` changes, a restart-required notice is displayed.

Secret fields that were not changed use `secretAction: "keep"` to preserve existing values. Only secrets with explicit new values are replaced.

#### Reload

Click **Reload** to re-read configuration files from disk without saving UI changes. The UI calls `POST /admin/config/reload`. This is useful when config files have been edited manually outside the UI.

#### Rollback

Click **Rollback** to restore the `.bak` files created by the last save:

1. The UI calls `POST /admin/config/rollback`.
2. The server restores `.bak` files and triggers a reload.
3. On success, the UI reloads the configuration from the server.

If no `.bak` files exist, rollback succeeds with an empty restored list.

### Provider Monitor

Open the live provider monitor on the proxy host:

```
http://127.0.0.1:<PORT>/admin/monitor
```

The monitor shows global proxy counters, provider circuit-breaker state, cooldown remaining, failure/success counts, recent failure reason, and a lightweight in-browser active-request trend.

The monitor polls `GET /admin/monitor/stats` once per second while the browser tab is visible. This endpoint is localhost-only and intentionally quiet: it does not write one log line per poll. Samples are kept only in browser memory for lightweight one-minute trends.

### Restart-Required Notice

When the runtime reload detects that `PORT` or `HOST` has changed (fields listed in `restartRequiredFields`), the admin UI shows a prominent restart-required notice. These changes take effect only after a full process restart (e.g., `systemctl restart`).

### Error Handling

API errors are displayed in the UI with a red notice. Common error scenarios:

- **Save fails**: Config saved to disk but runtime reload failed. The proxy continues using the prior configuration.
- **Rollback with no backups**: Returns success with an informational message; no files are restored.
- **Invalid draft**: Validation lists specific field-level errors.
- **Network/server errors**: Displayed with the error message from the API response.

---

## Logs and Captures — Ignored Directories

The `.gitignore` excludes these runtime directories:

| Directory | Contents | Risk |
| --- | --- | --- |
| `logs/` | Request logs. | May contain prompt fragments. |
| `captures/` | Debug captures from SSE failures and missing-usage diagnostics. | Contains full prompts and upstream responses. |
| `sse-failures/` | Raw upstream SSE text for failed reconstruction. | Contains full prompts and upstream responses. |
| `dist/` | Compiled output. | Rebuildable; no secrets expected. |

Debug captures are disabled by default. When enabled during incident investigation, disable them immediately afterward and delete captured files. These directories can contain full prompts, provider responses, and other sensitive operational data.

Relevant environment variables:

```env
PROXY_DEBUG_SSE=0
PROXY_SSE_FAILURE_DEBUG=0
PROXY_SSE_FAILURE_DIR=captures/proxy-11234/sse-failures
PROXY_STREAM_MISSING_USAGE_DEBUG=0
PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-11234/stream/missing-usage
PROXY_STREAM_MODE=normalized
```

---

## Docker Deployment

Docker is the simplest public deployment path for this project. It does not require systemd inside the container because the container runs the proxy directly as its single foreground process.

### Prepare a Runtime Instance Directory

Reuse the same runtime instance layout used by the non-Docker path:

```bash
cp -r instances/example-11234 instances/proxy-11234
cp instances/proxy-11234/.env.example instances/proxy-11234/.env
cp instances/proxy-11234/fallback.json.example instances/proxy-11234/fallback.json
cp instances/proxy-11234/model-map.json.example instances/proxy-11234/model-map.json
```

Edit `instances/proxy-11234/.env` and fill:

```env
PRIMARY_PROVIDER_NAME=primary-provider
PRIMARY_PROVIDER_BASE_URL=https://provider.example
PRIMARY_PROVIDER_API_KEY=your_api_key_here
PROXY_ENV_PATH=./instances/proxy-11234/.env
FALLBACK_CONFIG_PATH=./instances/proxy-11234/fallback.json
MODEL_MAP_PATH=./instances/proxy-11234/model-map.json
```

### Start Docker Compose

```bash
docker compose up --build
```

The provided `docker-compose.yaml`:

- builds the local `Dockerfile`,
- loads env values from `./instances/proxy-11234/.env`,
- mounts `./instances/proxy-11234` into the container at `/app/instances/proxy-11234`,
- publishes `127.0.0.1:${DOCKER_PROXY_PORT:-11234}:11234`,
- sets `PROXY_ADMIN_ALLOW_HOST=1` so the host can reach `/admin` through the mapped port.

If `11234` is already in use on the host, override the published host port:

```bash
DOCKER_PROXY_PORT=11334 docker compose up --build
```

### Access from the Host

After startup:

- API: `http://127.0.0.1:<host-port>/v1/responses`
- Config UI: `http://127.0.0.1:<host-port>/admin`
- Provider monitor: `http://127.0.0.1:<host-port>/admin/monitor`

### Logs and Lifecycle

Use Docker rather than systemd commands:

```bash
docker compose logs -f
docker compose down
```

### Editing Mounted Config

The admin UI writes to the mounted runtime files. Changes made through `/admin` persist back to the host files under `instances/proxy-11234/` because that directory is mounted read-write.

### Admin Access Safety

`PROXY_ADMIN_ALLOW_HOST=1` is intended only for Docker-style host access through the published port. It should remain an explicit opt-in.

The provided compose file binds the service to `127.0.0.1`, which keeps `/admin` reachable only from the host machine. If you change the port binding to `0.0.0.0` or publish it more broadly, you are also exposing admin access more broadly and should add additional protections.

---

## Safe Restart Pattern

To restart a proxy instance without dropping in-flight requests, use the `wait-proxy-idle.sh` script. It polls the `/healthz` endpoint and returns only when `activeRequests` reaches zero (or the service is already stopped).

### Usage

```bash
# Wait for a specific instance by name and port
./wait-proxy-idle.sh proxy-NEWPORT NEWPORT

# Then restart the service
systemctl --user restart responses-proxy@proxy-NEWPORT
```

### How it works

1. Checks whether the systemd service is active. If not, exits immediately (safe to proceed).
2. Polls `http://127.0.0.1:PORT/healthz` at a configurable interval (default 0.5s).
3. Extracts `activeRequests` from the JSON response using a lightweight Node.js inline parser.
4. When `activeRequests === 0`, exits with success — the service can be safely restarted.
5. If the service stops while waiting, exits immediately (safe to proceed).

### Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `WAIT_PROXY_IDLE_PORT` | Extracted from instance name suffix | Override the health check port. |
| `WAIT_PROXY_IDLE_INTERVAL` | `0.5` | Seconds between polls. |
| `WAIT_PROXY_IDLE_SERVICE` | `responses-proxy@<INSTANCE_NAME>` | systemd service name. |
| `WAIT_PROXY_IDLE_STATUS_URL` | `http://127.0.0.1:<PORT>/healthz` | Health endpoint URL. |

### Integration with systemd

```bash
# One-liner safe restart
./wait-proxy-idle.sh proxy-NEWPORT NEWPORT && systemctl --user restart responses-proxy@proxy-NEWPORT
```

---

## Systemd Template

A systemd service template is provided at `deploy/systemd/responses-proxy@.service.example`.

### Template contents

```ini
[Unit]
Description=Responses API Compatibility Proxy (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/responses-api-compat-proxy
EnvironmentFile=/opt/responses-api-compat-proxy/instances/%i/.env
ExecStart=/usr/bin/env npm run proxy:start
Restart=on-failure
RestartSec=5
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

### Installation

1. Copy the template to the appropriate systemd directory:

   For a **user-level** service:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp deploy/systemd/responses-proxy@.service.example ~/.config/systemd/user/responses-proxy@.service
   ```

   For a **system-level** service:
   ```bash
   sudo cp deploy/systemd/responses-proxy@.service.example /etc/systemd/system/responses-proxy@.service
   ```

2. Adjust `WorkingDirectory` and `EnvironmentFile` paths to match your deployment location.
3. Adjust `WantedBy` based on your installation mode:
   - User services: `WantedBy=default.target`
   - System services: `WantedBy=multi-user.target`
4. Enable and start the instance:
   ```bash
   # User service
   systemctl --user daemon-reload
   systemctl --user enable --now responses-proxy@proxy-NEWPORT

   # System service
   sudo systemctl daemon-reload
   sudo systemctl enable --now responses-proxy@proxy-NEWPORT
   ```

**Note:** The provided systemd example is a template. Operators should adapt `WorkingDirectory`, `EnvironmentFile`, `WantedBy`, instance naming, and installation mode (user vs system services) to match their deployment environment. Do not commit local systemd unit names, private hostnames, or deployment-specific absolute paths back into the repository.

### Instance parameter

The `%i` in the service name is replaced by the instance directory name. For example, `responses-proxy@proxy-11234` loads its environment from `instances/proxy-11234/.env`.

### TimeoutStopSec

The default `TimeoutStopSec=120` gives in-flight streaming requests up to two minutes to complete during a stop or restart. Adjust this value based on your `PROXY_TOTAL_REQUEST_TIMEOUT_MS` setting. If `PROXY_TOTAL_REQUEST_TIMEOUT_MS` is larger than `TimeoutStopSec`, systemd may force termination before the proxy's own total timeout expires.

---

## Migration from Local Working Directory

If the proxy was initially run from a local working directory (e.g., a home directory checkout) and is being migrated to a deployment path:

1. **Build at the target location:**
   ```bash
   cd /opt/responses-api-compat-proxy
   npm install --omit=dev
   npm run build
   ```

2. **Copy instance configurations:**
   ```bash
   mkdir -p instances/proxy-NEWPORT
   cp /path/to/old/instances/proxy-NEWPORT/.env instances/proxy-NEWPORT/.env
   cp /path/to/old/instances/proxy-NEWPORT/fallback.json instances/proxy-NEWPORT/fallback.json
   cp /path/to/old/instances/proxy-NEWPORT/model-map.json instances/proxy-NEWPORT/model-map.json
   ```

3. **Update file paths in `.env`:**
    Ensure `FALLBACK_CONFIG_PATH`, `MODEL_MAP_PATH`, and any debug directory paths reference the new location:
    ```env
    PROXY_ENV_PATH=./instances/proxy-NEWPORT/.env
    FALLBACK_CONFIG_PATH=./instances/proxy-NEWPORT/fallback.json
    MODEL_MAP_PATH=./instances/proxy-NEWPORT/model-map.json
    PROXY_SSE_FAILURE_DIR=captures/proxy-NEWPORT/sse-failures
    PROXY_STREAM_MISSING_USAGE_DIR=captures/proxy-NEWPORT/stream/missing-usage
    ```

4. **Install and start the systemd service** using the template (see above).

5. **Verify the migration:**
    ```bash
    curl -s http://127.0.0.1:NEWPORT/healthz
    curl -s http://127.0.0.1:NEWPORT/admin/stats
    curl -s http://127.0.0.1:NEWPORT/admin/monitor/stats
    ```

6. **Stop the old process** once the new instance is confirmed healthy.

7. **Clean up the old working directory** — remove any real instance directories, `.env` files, logs, and captures from the old location to avoid stale configuration or data exposure.
