# Streaming Compatibility

This document describes how the proxy handles streaming responses from upstream providers that implement the OpenAI Responses API. It covers the SSE wire format, request shapes, stream modes, recognized events, timeout behavior, missing-usage handling, and debug capture semantics.

All examples use generic placeholder values. No real provider names, incident identifiers, or deployment-specific paths appear in this document.

---

## Table of Contents

- [SSE Content Type and Event Shape](#sse-content-type-and-event-shape)
- [Network Chunks Are Not JSON Documents](#network-chunks-are-not-json-documents)
- [Upstream JSON Request Shape](#upstream-json-request-shape)
- [Stream Modes: normalized and raw](#stream-modes-normalized-and-raw)
- [Recognized Text Event Shapes](#recognized-text-event-shapes)
- [Timeout Phases](#timeout-phases)
- [Missing Usage](#missing-usage)
- [Debug Capture Warnings](#debug-capture-warnings)

---

## SSE Content Type and Event Shape

The proxy emits Server-Sent Events to the client with the following response headers:

```
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
connection: keep-alive
```

Each SSE event consists of an `event:` line and one or more `data:` lines, terminated by a blank line:

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":" world"}

event: response.completed
data: {"type":"response.completed","response":{...}}

```

The proxy also sets CORS headers (`access-control-allow-origin: *`) and allows `POST, OPTIONS` with `Content-Type, Authorization` request headers.

### Error events

When the proxy encounters a timeout or internal failure after SSE headers have been committed, it sends a terminal error event:

```
event: error
data: {"type":"error","code":"server_error","message":"Upstream response stream did not produce text output within 12000ms","param":null,"sequence_number":5}

```

Error events use the `error` SSE event type. The `sequence_number` field, when present, indicates the approximate position in the stream where the error occurred.

---

## Network Chunks Are Not JSON Documents

A critical implementation detail: the data arriving from the upstream provider arrives as **network chunks**, not complete JSON documents. A single TCP frame or HTTP/2 DATA frame may contain:

- A partial SSE event (split mid-JSON).
- Multiple complete SSE events concatenated together.
- An incomplete `data:` line that spans two chunks.

The proxy handles this by buffering incoming text and scanning for the SSE block separator (`\n\n` or `\r\n\r\n`). Only when a complete block is found does it parse the event and its JSON payload.

### Implications

- You cannot treat each `ReadableStream` read result as a parseable SSE event.
- The proxy accumulates a `pending` buffer and extracts events only when full `\n\n`-delimited blocks are available.
- Partial data at the end of the stream is flushed after the upstream body completes.

This is the same buffering discipline required by the SSE specification, but it is a common source of integration bugs when consumers expect one chunk = one event.

---

## Upstream JSON Request Shape

The proxy sends a JSON POST body to the upstream `/v1/responses` endpoint. The normalized upstream body looks like this:

```json
{
  "model": "my-model-v2",
  "instructions": "You are a helpful assistant.",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Hello"
        }
      ]
    }
  ],
  "stream": true,
  "store": false,
  "prompt_cache_retention": "in_memory",
  "prompt_cache_key": "stable-prefix-key"
}
```

### Key fields

| Field | Notes |
| --- | --- |
| `model` | May be remapped from the client's requested model via the proxy's model mapping configuration. |
| `instructions` | May be overridden, cleared, or passed through depending on proxy settings. |
| `input` | Normalized: string input is wrapped into a single `user` message with an `input_text` content part. `system` role messages are converted to `developer` by default. |
| `stream` | Set to `true` or `false` based on the client request. |
| `store` | Set to `false` when the proxy's `force_store_false` setting is enabled. |
| `prompt_cache_retention` | Valid client-provided values are preserved. Supported values are `in_memory` and `24h`; if absent, the proxy default is injected. |
| `prompt_cache_key` | Client-provided value is preserved. If absent, the proxy default is injected. Must be stable (no timestamps, random values, or request ids). |

### Proxy-internal fields

The request body field `proxy_stream_mode` is stripped before forwarding upstream. It is used only by the proxy to select the stream mode.

---

## Stream Modes: normalized and raw

The proxy supports two stream modes that control how upstream SSE events are processed before being forwarded to the client.

### normalized (default)

In `normalized` mode, the proxy:

1. **Parses** each upstream SSE event's JSON payload.
2. **Normalizes** the payload by:
   - Setting `response.object` to `"response"` if a response object is present.
   - Ensuring `response.status` defaults to `"completed"`.
   - Ensuring `response.output` is an array.
   - Forwarding the client's requested model name in existing `model` and `response.model` fields.
   - Setting `item.role` to `"assistant"` for message items that lack a role.
3. **Buffers** pre-text events on the standard `text/event-stream` path until recognized assistant text is detected, then flushes them all at once. This prevents the client from seeing metadata events (like `response.created`) before any actual content has been produced. If the stream ends without recognized text or a usage output-token signal, these buffered pre-text events are not sent to the client. The non-standard content-type probe path may emit parsed events immediately.
4. **Re-serializes** the normalized payload as JSON in the `data:` line.

Example normalized event:

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello","item":{"type":"message","role":"assistant"}}

```

### raw

In `raw` mode on the standard SSE path, the proxy:

1. Passes upstream SSE bytes through to the client with minimal interpretation.
2. Does not parse or re-serialize event payloads.
3. Does not buffer events before text detection.
4. Still tracks usage extraction and text detection internally for fallback decisions, but the client sees the unmodified upstream byte stream.

Use `raw` mode when the client wants to handle upstream event shapes directly without proxy normalization. If an upstream returns a non-standard content type and the proxy has to probe the body as text, raw mode can still emit parsed SSE events rather than byte-for-byte upstream chunks.

### Selecting the mode

The stream mode is determined in this priority order:

1. `proxy_stream_mode` field in the request body (`"normalized"` or `"raw"`).
2. `X-Proxy-Stream-Mode` request header (`"normalized"` or `"raw"`).
3. The `PROXY_STREAM_MODE` environment variable default.

---

## Recognized Text Event Shapes

The proxy monitors SSE event payloads to detect when actual assistant text content has been produced. This detection drives several critical behaviors: pre-text buffering, first-text timeout tracking, and fallback eligibility after incomplete streams.

### Events that count as recognized text

| Event type | Condition | Text source |
| --- | --- | --- |
| `response.output_text.delta` | `payload.delta` is a string | Length of `delta` |
| `response.output_text.done` | `payload.text` is a string | Length of `text` |
| `response.content_part.done` | `payload.part.type === "output_text"` and `payload.part.text` is a string | Length of `part.text` |
| `response.completed` | Contains a `response` object with an `output` array containing `output_text` parts | Sum of all `text` lengths |
| `response.output_item.done` | Contains a `response` or `item` object with an `output` array containing `output_text` parts | Sum of all `text` lengths |

Additionally, if the proxy extracts usage data with `outputTokens > 0`, this is treated as an anti-false-positive signal: even if no recognized text was detected at the event level, the stream is considered to have produced content. This can cause buffered events to be flushed and can prevent fallback paths that are only safe before client-visible content exists.

### What is NOT recognized text

- Events with `type` values outside the list above (e.g., `response.created`, `response.in_progress`, `response.function_call_arguments.delta`).
- Events where the relevant text field is missing, empty, or not a string.
- Events with unknown or non-standard `type` values.

---

## Timeout Phases

The proxy applies multiple layered timeouts to streaming requests. Each timeout corresponds to a distinct phase of the request lifecycle:

```
Client request ──► [connect] ──► [first-byte] ──► [first-text] ──► [idle gaps] ──► Stream end
                  │             │                │                │
                  │             │                │                └─ stream-idle timeout
                  │             │                └─ first-text timeout
                  │             └─ first-byte timeout
                  └─ connect timeout
                  ────────────────────────────────────────────────────
                                     total timeout covers everything
```

### Phase descriptions

| Phase | Setting | Default | Trigger |
| --- | --- | --- | --- |
| **connect** | `PROXY_UPSTREAM_TIMEOUT_MS` | 8000ms | Aborts if the upstream server does not return initial HTTP headers within the limit. |
| **first-byte** | `PROXY_FIRST_BYTE_TIMEOUT_MS` | 8000ms | Aborts if the upstream response body does not produce its first byte within the limit. Resets to idle timer after first chunk. |
| **first-text** | `PROXY_FIRST_TEXT_TIMEOUT_MS` | 0 (disabled) | Aborts if no recognized assistant text is detected within the limit. Active for normalized standard SSE streams, disabled for raw standard SSE streams, and active for non-standard content-type probe streams. Cleared immediately when text is recognized. |
| **idle** | `PROXY_STREAM_IDLE_TIMEOUT_MS` | 15000ms | Aborts if the gap between consecutive response body chunks exceeds the limit. Resets on each new chunk. |
| **total** | `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | 45000ms | Hard ceiling on the entire request lifetime from the proxy's perspective, regardless of individual phase timers. |

### Timeout and fallback interaction

When a timeout fires:

1. If the client has not yet received any SSE data, the proxy may attempt a **fallback** to another upstream endpoint.
2. If the client has already started receiving SSE events (headers committed), the proxy sends a terminal `error` event inside the SSE stream and does not attempt fallback. The HTTP status cannot be changed after SSE headers are committed.
3. If recognized text was written to the client, fallback is skipped even if the stream later times out, because the client has already consumed partial output.

### Timeout error messages

The proxy generates descriptive timeout messages:

| Phase | Message pattern |
| --- | --- |
| connect | `Upstream did not produce an initial response within Nms` |
| first-byte | `Upstream response body did not produce a first chunk within Nms` |
| first-text | `Upstream response stream did not produce text output within Nms` |
| idle | `Upstream response stream was idle for more than Nms` |
| total | `Upstream request exceeded total lifetime limit of Nms` |

---

## Missing Usage

Usage data (token counts) is extracted from SSE event payloads. The proxy looks for a `response.usage` object inside events that carry a response object, typically `response.completed`.

### When usage is considered missing

A stream is flagged as having missing usage when:

- The stream completed (all chunks received, upstream closed the body) but no event contained an extractable usage object.
- The stream was interrupted by a timeout or client disconnect before a `response.completed` event could arrive.

### Extracted usage fields

When usage is present, the proxy extracts:

| Field | Source |
| --- | --- |
| `responseId` | `response.id` |
| `model` | `response.model` |
| `inputTokens` | `usage.input_tokens` |
| `outputTokens` | `usage.output_tokens` |
| `totalTokens` | `usage.total_tokens` |
| `cachedInputTokens` | `usage.input_tokens_details.cached_tokens` |
| `reasoningTokens` | `usage.output_tokens_details.reasoning_tokens` |

### Missing usage and fallback

For streaming responses, fallback after missing usage is only safe before client-visible text has been delivered. If a stream completes with recognized text content but without extractable usage, the proxy records the missing usage condition but does not fallback, because the client has already consumed output. Non-streaming JSON responses do not have that same partial-stream constraint and may still use fallback policy when usage is missing.

### Missing usage and stats

Even when usage is missing from a particular stream, the proxy still records the request in its internal counters. The admin stats endpoint (`/admin/stats`) reports aggregate `usageResponses`, `usageInputTokens`, and `usageOutputTokens` counts based on streams where usage was successfully extracted.

---

## Debug Capture Warnings

The proxy can write debug captures to disk when specific failure conditions are detected. These captures contain **sensitive data** including full prompt text, model responses, and provider-specific error details.

### SSE failure capture

When the proxy receives an SSE payload that cannot be reconstructed into a valid response object, it may write debug files (if `PROXY_SSE_FAILURE_DEBUG` is enabled):

- A `.json` metadata file with the request ID, upstream status, content type, and timestamp.
- A `.sse.txt` file containing the raw upstream response text.

### Stream missing-usage capture

When a stream completes without extractable usage data, the proxy may write debug files (if `PROXY_STREAM_MISSING_USAGE_DEBUG` is enabled):

- A `.json` metadata file with request ID, upstream status, stream mode, chunk count, byte count, event count, and timestamp.
- A `.sse.txt` file containing the full collected upstream text.

### Safety warnings

1. **Never commit capture output.** Debug capture directories (`captures/`) should be in `.gitignore` and never checked into version control.
2. **Keep debug captures disabled by default.** Enable them only during active incident investigation and disable immediately afterward.
3. **Capture files contain full prompts and responses.** They may include user data, API responses, and provider-specific internal details.
4. **Rotate or delete captures regularly.** Capture files accumulate over time and can consume disk space as well as represent a data exposure risk.
5. **Restrict file system access.** The capture directory should only be accessible to operators with appropriate access levels.

### Configuration reference

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROXY_SSE_FAILURE_DEBUG` | `0` | Enable SSE failure debug capture. |
| `PROXY_SSE_FAILURE_DIR` | `captures/<instance>/sse-failures` | Directory for SSE failure captures. |
| `PROXY_STREAM_MISSING_USAGE_DEBUG` | `0` | Enable missing-usage debug capture. |
| `PROXY_STREAM_MISSING_USAGE_DIR` | `captures/<instance>/stream/missing-usage` | Directory for missing-usage captures. |
