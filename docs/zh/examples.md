# 示例

[English](../examples.md) | [中文](./examples.md)

下面所有示例都使用占位值和公开安全的模型名，不包含真实 provider 或密钥。

## 非流式请求

```bash
curl -s http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"public-alias-model","input":"Reply with exactly OK.","stream":false}'
```

## 流式请求

```bash
curl -N http://127.0.0.1:11234/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"public-alias-model","input":"Count to three.","stream":true}'
```

## 模型别名映射示例

`model-map.json`:

```json
{
  "model_mappings": {
    "public-alias-model": "my-model-v2"
  }
}
```

请求体：

```json
{
  "model": "public-alias-model",
  "input": "Summarize this text.",
  "stream": false
}
```

客户端仍然请求 `public-alias-model`，但代理会把它改写成真正上游模型 `my-model-v2` 再发出去。

## fallback provider 示例

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

建议优先使用 `api_key_env`，这样真实密钥仍保存在本地 env 文件里，而不是跟踪到 JSON 中。

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

`.env` 中的默认注入值：

```env
PROXY_PROMPT_CACHE_RETENTION=in_memory
PROXY_PROMPT_CACHE_KEY=stable-summary-prefix
```

`prompt_cache_key` 必须稳定，不要包含时间戳、UUID、request id 或任何每次请求都不同的值。

## 什么时候用 `normalized`，什么时候用 `raw`

如果你希望代理先解析并规范化上游 SSE 事件，再转发给客户端，使用 `normalized`：

```env
PROXY_STREAM_MODE=normalized
```

如果你希望客户端直接处理上游事件形状，减少代理端解释，使用 `raw`：

```env
PROXY_STREAM_MODE=raw
```

你也可以按请求覆盖流模式：

- 请求体中的 `proxy_stream_mode`
- 请求头中的 `X-Proxy-Stream-Mode`

都会覆盖环境变量默认值。
