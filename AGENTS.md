这个项目现在主要用于探索兼容 OpenAI Responses API 的上游 provider，重点是如何通过 response api 进行调用与兼容处理。

模型需要先理解 OpenAI Responses API 的规范文档，尤其是请求结构、普通 JSON 返回和流式 SSE 事件格式。

需要分析如何请求，以及如何解析返回值，重点仍然是流式返回时的数据包、异常路径和兼容性处理。

主上游 provider 现在通过 `.env` 中的以下字段定义：

- `PRIMARY_PROVIDER_NAME`
- `PRIMARY_PROVIDER_BASE_URL`
- `PRIMARY_PROVIDER_API_KEY`

其中主响应端点约定为在 `PRIMARY_PROVIDER_BASE_URL` 的基础上拼接 `/v1/responses`，模型列表端点拼接 `/v1/models`。

fallback provider 仍然使用 `config.json` 中的 `fallback_api_config` 配置。

请使用 ai-sdk 来进行开发，ai-sdk 是由 vercel 官方推出的一个套装，具体需要查阅其文档来了解流程。

补充：代理层现在已经支持对 OpenAI 风格 prompt caching 做 best effort 请求侧增强。

- 如果客户端请求体已经带有 `prompt_cache_retention` 或 `prompt_cache_key`，代理会直接保留并向上游透传。
- 如果客户端没有带，而环境变量里配置了默认值，代理会自动注入：
  - `PROXY_PROMPT_CACHE_RETENTION=in_memory|24h`
  - `PROXY_PROMPT_CACHE_KEY=<stable-key>`
- 这些只是请求侧 hint，真正是否命中 cache、是否支持 extended retention，仍然取决于上游 provider。
- 做相关开发或排查时，需要特别关注 prompt 前缀稳定性，不要把随机值、时间戳、request id 放进 `prompt_cache_key`。
