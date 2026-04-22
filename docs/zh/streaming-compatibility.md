# 流式兼容性

[English](../streaming-compatibility.md) | [中文](./streaming-compatibility.md)

本文说明代理如何处理实现 OpenAI Responses API 的上游 provider 的流式返回，包括：

- SSE 线协议格式
- 请求结构
- `normalized` / `raw` 两种流模式
- 文本识别事件
- 多阶段超时
- missing usage 处理
- 调试捕获注意事项

所有示例都使用通用占位值，不包含真实 provider 名称、本地路径或事故编号。

---

## 目录

- [SSE 内容类型与事件格式](#sse-内容类型与事件格式)
- [网络 chunk 不是完整 JSON](#网络-chunk-不是完整-json)
- [上游 JSON 请求结构](#上游-json-请求结构)
- [流模式normalized-和-raw](#流模式normalized-和-raw)
- [哪些事件算作识别到文本](#哪些事件算作识别到文本)
- [超时阶段](#超时阶段)
- [Missing Usage](#missing-usage)
- [调试捕获警告](#调试捕获警告)

---

## SSE 内容类型与事件格式

代理向客户端返回流式结果时，会使用这些响应头：

```text
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
connection: keep-alive
```

每个 SSE 事件由一行 `event:` 和一行或多行 `data:` 组成，并以空行结尾：

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":" world"}

event: response.completed
data: {"type":"response.completed","response":{...}}
```

代理还会设置 CORS 头：

- `access-control-allow-origin: *`
- `POST, OPTIONS`
- `Content-Type, Authorization`

### 错误事件

如果 SSE 头已经发出之后，代理遇到超时或内部错误，会在流内发送一个终止性的 `error` 事件：

```text
event: error
data: {"type":"error","code":"server_error","message":"Upstream response stream did not produce text output within 12000ms","param":null,"sequence_number":5}
```

`sequence_number` 如果存在，表示这个错误大概发生在流中的哪个位置。

---

## 网络 chunk 不是完整 JSON

这是实现里最容易踩坑的点之一：上游返回的数据是网络 chunk，不是“一次 read 就是一条完整 JSON 事件”。

一个 TCP frame 或 HTTP/2 DATA frame 可能包含：

- 半条 SSE 事件（JSON 中途被截断）
- 多条完整 SSE 事件拼在一起
- 一个跨 chunk 的 `data:` 行

因此代理会先把文本缓冲起来，扫描 SSE 事件分隔符（`

` 或 `\r\n\r\n`），只有拿到完整事件块后才解析 JSON。

### 这意味着

- 不能把每次 `ReadableStream.read()` 返回的 chunk 直接当作一条完整事件解析
- 代理内部会维护一个 `pending` buffer
- 流结束后，如果还有尾部未处理的残余，也会再尝试 flush 一次

这其实就是 SSE 规范本身要求的处理方式，但在兼容各类 provider 时非常关键。

---

## 上游 JSON 请求结构

代理向上游 `/v1/responses` 发送的 POST JSON，大致会被规范化成这样：

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

### 关键字段

| 字段 | 说明 |
| --- | --- |
| `model` | 可能会先通过 model mapping 从客户端模型名改写成上游真实模型名 |
| `instructions` | 可能按代理设置被覆盖、清空或原样透传 |
| `input` | 字符串输入会被包装成标准 `message` 结构；默认会把 `system` 角色转换成 `developer` |
| `stream` | 由客户端请求决定为 `true` 或 `false` |
| `store` | 如果启用了 `force_store_false`，会被设置成 `false` |
| `prompt_cache_retention` | 客户端传入则保留；未传则可能由代理注入；支持 `in_memory` 和 `24h` |
| `prompt_cache_key` | 客户端传入则保留；未传则可能由代理注入；必须稳定，不能带随机值 |

### 代理内部字段

请求体中的 `proxy_stream_mode` 不会发给上游，它只在代理内部用于选择流模式。

---

## 流模式：`normalized` 和 `raw`

代理支持两种流模式，用来决定如何处理中间的上游 SSE 事件。

### `normalized`（默认）

`normalized` 模式会：

1. 解析每条上游 SSE 事件的 JSON payload
2. 对 payload 做 Responses 风格的规范化
3. 在识别到真正的 assistant 文本前，缓冲 pre-text 元数据事件
4. 再把规范化后的 payload 重新序列化成 JSON 写回 `data:`

规范化包括：

- 若存在 `response`，把 `response.object` 设为 `"response"`
- `response.status` 缺失时默认补成 `"completed"`
- 确保 `response.output` 一定是数组
- 将客户端请求时的模型名回填到 `model` 与 `response.model`
- 如果消息 item 缺少 role，则默认补成 `assistant`

示例：

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello","item":{"type":"message","role":"assistant"}}
```

### `raw`

`raw` 模式下，代理会尽量直接把上游 SSE 字节流转发给客户端：

1. 不重新解析再序列化 payload
2. 不在文本识别前缓冲事件
3. 客户端看到的更接近上游原始事件形状
4. 代理内部仍然会做 usage 提取和文本检测，用于 fallback 判定

如果上游 content-type 不标准，代理退化成文本 probe 路径时，`raw` 模式也可能输出解析过的 SSE，而不是完全原始字节。

### 流模式选择优先级

优先级从高到低：

1. 请求体中的 `proxy_stream_mode`
2. 请求头中的 `X-Proxy-Stream-Mode`
3. 环境变量 `PROXY_STREAM_MODE`

---

## 哪些事件算作识别到文本

代理会持续观察 SSE payload，判断是否已经真正产生 assistant 文本。这会影响：

- pre-text 缓冲何时 flush
- `first-text` 超时何时停止计时
- 在部分流异常后是否还能安全 fallback

### 会被算作“识别到文本”的事件

| 事件类型 | 条件 | 文本来源 |
| --- | --- | --- |
| `response.output_text.delta` | `payload.delta` 是字符串 | `delta` 长度 |
| `response.output_text.done` | `payload.text` 是字符串 | `text` 长度 |
| `response.content_part.done` | `payload.part.type === "output_text"` 且 `payload.part.text` 是字符串 | `part.text` 长度 |
| `response.completed` | `response.output` 中存在 `output_text` part | 累加文本长度 |
| `response.output_item.done` | `response` 或 `item` 的 `output` 中存在 `output_text` part | 累加文本长度 |

此外，如果代理提取出了 usage 并且 `outputTokens > 0`，也会把它视为一个“避免误判为空流”的信号。

### 不算作识别到文本的情况

- `response.created`
- `response.in_progress`
- `response.function_call_arguments.delta`
- 文本字段缺失、为空，或不是字符串
- 未知或非标准事件类型

---

## 超时阶段

流式请求中，代理会对多个阶段分别计时：

```text
Client request ──► [connect] ──► [first-byte] ──► [first-text] ──► [idle gaps] ──► Stream end
                  │             │                │                │
                  │             │                │                └─ stream-idle timeout
                  │             │                └─ first-text timeout
                  │             └─ first-byte timeout
                  └─ connect timeout
                  ────────────────────────────────────────────────────
                                     total timeout covers everything
```

### 各阶段说明

| 阶段 | 对应设置 | 默认值 | 触发条件 |
| --- | --- | --- | --- |
| connect | `PROXY_UPSTREAM_TIMEOUT_MS` | 8000ms | 上游迟迟不返回初始 HTTP headers |
| first-byte | `PROXY_FIRST_BYTE_TIMEOUT_MS` | 8000ms | 上游 headers 已返回，但响应体迟迟没有首个 byte/chunk |
| first-text | `PROXY_FIRST_TEXT_TIMEOUT_MS` | 0（关闭） | 迟迟没有识别到 assistant 文本 |
| idle | `PROXY_STREAM_IDLE_TIMEOUT_MS` | 15000ms | 连续两个 body chunk 之间空闲太久 |
| total | `PROXY_TOTAL_REQUEST_TIMEOUT_MS` | 45000ms | 从代理视角看，整个请求生命周期超过上限 |

### 超时与 fallback 的关系

超时发生时：

1. 如果客户端尚未收到任何 SSE 数据，代理仍可能尝试 fallback
2. 如果 SSE headers 已经发出，就只能在流内发 `error` 事件，不能再改 HTTP 状态码
3. 如果客户端已经收到了文本内容，则后续即便超时，也不会再 fallback，因为客户端已经消费了部分输出

### 超时错误消息

| 阶段 | 错误消息模式 |
| --- | --- |
| connect | `Upstream did not produce an initial response within Nms` |
| first-byte | `Upstream response body did not produce a first chunk within Nms` |
| first-text | `Upstream response stream did not produce text output within Nms` |
| idle | `Upstream response stream was idle for more than Nms` |
| total | `Upstream request exceeded total lifetime limit of Nms` |

---

## Missing Usage

代理会从 SSE 事件中尝试提取 usage 数据，通常来自带有 `response.usage` 的事件（例如 `response.completed`）。

### 什么时候会被视为 missing usage

以下情况会被标记为 missing usage：

- 流完整结束，但没有任何事件带出可提取的 usage
- 流在到达 `response.completed` 前因为超时或客户端断开而中断

### 可提取的 usage 字段

| 字段 | 来源 |
| --- | --- |
| `responseId` | `response.id` |
| `model` | `response.model` |
| `inputTokens` | `usage.input_tokens` |
| `outputTokens` | `usage.output_tokens` |
| `totalTokens` | `usage.total_tokens` |
| `cachedInputTokens` | `usage.input_tokens_details.cached_tokens` |
| `reasoningTokens` | `usage.output_tokens_details.reasoning_tokens` |

### Missing usage 与 fallback

对于流式响应来说，只有在客户端还没看到文本内容之前，missing usage 后再 fallback 才是安全的。如果流里已经产出了可识别文本，但最终没有 usage，代理会记录这个情况，但不会 fallback，因为客户端已经消费了输出。

非流式 JSON 响应没有这种“已经部分输出”的约束，因此在 usage 缺失时仍可能走 fallback 逻辑。

### Missing usage 与统计

即便某一条流缺失 usage，代理仍然会在内部计数中记录这次请求。`/admin/stats` 返回的 `usageResponses`、`usageInputTokens`、`usageOutputTokens` 只统计那些真正成功提取到 usage 的流。

---

## 调试捕获警告

在某些失败场景下，代理会把调试信息写入磁盘。这些文件包含敏感数据，例如：

- 完整 prompt
- 模型输出
- provider 特有的错误内容

### SSE failure capture

如果代理收到的 SSE 无法重建为合法响应对象，并且启用了 `PROXY_SSE_FAILURE_DEBUG`，就可能写出：

- 一个 `.json` 元数据文件：请求 ID、上游状态码、content type、时间戳
- 一个 `.sse.txt` 原始文本文件：完整上游 SSE 文本

### Stream missing-usage capture

如果流结束后没有提取到 usage，并且启用了 `PROXY_STREAM_MISSING_USAGE_DEBUG`，就可能写出：

- 一个 `.json` 元数据文件：请求 ID、状态码、stream mode、chunk 数、字节数、事件数、时间戳
- 一个 `.sse.txt` 文件：完整收集到的上游文本

### 安全警告

1. 永远不要提交这些 capture 输出
2. 默认保持 debug capture 关闭，只在排障期间短时间开启
3. capture 文件里可能包含完整 prompt 与响应
4. 需要定期清理，否则既占磁盘又带来数据暴露风险
5. capture 目录只应允许具备相应权限的运维人员访问

### 相关配置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_SSE_FAILURE_DEBUG` | `0` | 开启 SSE failure 调试捕获 |
| `PROXY_SSE_FAILURE_DIR` | `captures/<instance>/sse-failures` | SSE failure 输出目录 |
| `PROXY_STREAM_MISSING_USAGE_DEBUG` | `0` | 开启 missing-usage 调试捕获 |
| `PROXY_STREAM_MISSING_USAGE_DIR` | `captures/<instance>/stream/missing-usage` | missing-usage 输出目录 |
