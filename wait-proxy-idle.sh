#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${1:-proxy-11234}"

if [[ $# -ge 2 ]]; then
  PORT="$2"
elif [[ "$INSTANCE_NAME" =~ ([0-9]+)$ ]]; then
  PORT="${BASH_REMATCH[1]}"
else
  PORT="${WAIT_PROXY_IDLE_PORT:-11236}"
fi

INTERVAL_SECONDS="${WAIT_PROXY_IDLE_INTERVAL:-0.5}"
SERVICE_NAME="${WAIT_PROXY_IDLE_SERVICE:-responses-proxy@${INSTANCE_NAME}}"
STATUS_URL="${WAIT_PROXY_IDLE_STATUS_URL:-http://127.0.0.1:${PORT}/healthz}"

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required but not available in PATH\n' >&2
  exit 127
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'node is required but not available in PATH\n' >&2
  exit 127
fi

if ! command -v systemctl >/dev/null 2>&1; then
  printf 'systemctl is required but not available in PATH\n' >&2
  exit 127
fi

if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
  printf '[wait-proxy-idle] %s is not active, allowing restart immediately\n' "$SERVICE_NAME" >&2
  exit 0
fi

extract_active_requests() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(input);
        if (typeof payload.activeRequests !== "number") {
          process.exit(2);
          return;
        }
        process.stdout.write(String(payload.activeRequests));
      } catch {
        process.exit(2);
      }
    });
  '
}

last_active_requests=""

while true; do
  if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
    printf '[wait-proxy-idle] %s stopped while waiting, allowing restart immediately\n' "$SERVICE_NAME" >&2
    exit 0
  fi

  if ! status_json="$(curl -fsS --max-time 2 "$STATUS_URL")"; then
    printf '[wait-proxy-idle] failed to query %s while %s is active\n' "$STATUS_URL" "$SERVICE_NAME" >&2
    exit 1
  fi

  if ! active_requests="$(printf '%s' "$status_json" | extract_active_requests)"; then
    printf '[wait-proxy-idle] failed to parse activeRequests from %s\n' "$STATUS_URL" >&2
    exit 1
  fi

  if [[ "$active_requests" == "0" ]]; then
    printf '[wait-proxy-idle] %s is idle on %s, continuing\n' "$SERVICE_NAME" "$STATUS_URL" >&2
    exit 0
  fi

  if [[ "$active_requests" != "$last_active_requests" ]]; then
    printf '[wait-proxy-idle] waiting for %s activeRequests=%s\n' "$SERVICE_NAME" "$active_requests" >&2
    last_active_requests="$active_requests"
  fi

  sleep "$INTERVAL_SECONDS"
done
