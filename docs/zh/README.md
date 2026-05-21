# Responses API Compatibility Proxy 中文文档

[English](../../README.md) | [中文](./README.md)

这是一个 TypeScript 编写的兼容代理，用于探索和接入暴露 OpenAI 风格 `/v1/responses` 与 `/v1/models` 端点的上游 provider。

项目重点关注：

- Responses API 请求兼容与规范化
- Claude Code / Anthropic billing header 清理，避免动态 `cch=...` 破坏 prompt cache 前缀稳定性
- 普通 JSON 返回与 SSE 流式返回处理
- fallback 路由与冷却/熔断策略
- 本地运行时管理后台 `/admin`
- prompt cache hint 透传与 best effort 注入

这不是 OpenAI 官方项目。

## 中文文档导航

- [快速开始](./quickstart.md)
- [示例](./examples.md)
- [配置说明](./configuration.md)
- [流式兼容性](./streaming-compatibility.md)
- [运维说明](./operations.md)
- [发布检查清单](./publishing-checklist.md)

## 适合谁

这套文档主要面向：

- 想快速跑起一个 Responses API 兼容代理的开发者
- 想测试不同上游 provider 兼容性的工程师
- 需要处理 SSE、fallback、运行时配置、运维部署的使用者

## 推荐阅读顺序

1. 先看 [快速开始](./quickstart.md)
2. 再看 [配置说明](./configuration.md)
3. 如果需要排查流式问题，继续看 [流式兼容性](./streaming-compatibility.md)
4. 如果要部署、Docker 化或使用 systemd，查看 [运维说明](./operations.md)

## 兼容亮点：Claude Billing Header 清理

如果请求会先经过 Claude Code 相关网关，`x-anthropic-billing-header: ...` 这类 attribution 文本可能会被转进 OpenAI Responses 的 `instructions` 或 system/developer 文本块里。

其中动态的 `cch=...` 很容易破坏基于前缀的 prompt cache 匹配，即使 `prompt_cache_key` 本身是稳定的。

建议保持默认配置：

```env
PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line
```

`strip_line` 会删除整行 billing header；如果你需要保留 attribution 文本，可以改成 `strip_cch`，只删除动态 `cch=...` 字段。这个设置不会修改 user role 内容。详情见 [配置说明](./configuration.md)。

## 重要提醒

- 不要提交真实 `.env`、真实 `instances/proxy-*`、日志、captures、SSE 调试输出。
- `/admin` 默认只允许 localhost 访问；Docker 场景下如显式放开宿主机访问，也应保持在受控网络内。
- `prompt_cache_key` 必须稳定，不要带时间戳、随机值或 request id。

## 对应英文文档

如果你希望查看英文版本，请返回仓库首页：

- [English README](../../README.md)
