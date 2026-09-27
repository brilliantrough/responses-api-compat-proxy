# 示例

[English](../examples.md) | [中文](./examples.md)

下面所有示例都使用占位值和 `fallback.json` 中已配置的模型名。

## 带别名和 fallback 的路由配置

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

代理会把 canonical model 字符串转发给所有 channel。客户端请求 `public-alias-model` 时，会使用 `my-model-v2` 的 route 和 health state。

## 非流式请求

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model-v2","input":"Reply with exactly OK.","stream":false}'
```

## 流式请求

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"public-alias-model","input":"Count to three.","stream":true}'
```

## 省略 model

请求体省略 `model` 时，代理使用 `default_model`，如果它是 alias 会先解析到 canonical model：

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"input":"Use the default configured model.","stream":false}'
```

## Prompt Cache Hints

请求体：

```json
{
  "model": "public-alias-model",
  "input": "Summarize the following text.",
  "prompt_cache_retention": "in_memory",
  "prompt_cache_key": "stable-summary-prefix"
}
```

`.env` 默认注入：

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-summary-prefix
```

`prompt_cache_key` 必须稳定，不要包含时间戳、UUID、request id 或任何按请求变化的值。

## Claude Billing Header 兼容

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`strip_line` 删除网关转换后的整行 `x-anthropic-billing-header: ...`。`strip_cch` 保留整行，只删除动态 `cch=...` 字段。

## `normalized` 与 `raw`

```env
PROXY_STREAM_MODE=normalized
```

使用 `normalized` 时，代理会解析并规范化上游 SSE。使用 `raw` 时，客户端直接消费更接近上游原始形状的 SSE。

也可以通过请求体 `proxy_stream_mode` 或请求头 `X-Proxy-Stream-Mode` 按请求覆盖。
