# Responses API Compatibility Proxy 中文文档

[English](../../README.md) | [中文](./README.md)

这是一个 TypeScript 编写的兼容代理，用于探索和接入暴露 OpenAI 风格 `/v1/responses` 与 `/v1/models` 端点的上游 provider。

项目重点关注：

- Responses API 请求兼容与规范化
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

## 重要提醒

- 不要提交真实 `.env`、真实 `instances/proxy-*`、日志、captures、SSE 调试输出。
- `/admin` 默认只允许 localhost 访问；Docker 场景下如显式放开宿主机访问，也应保持在受控网络内。
- `prompt_cache_key` 必须稳定，不要带时间戳、随机值或 request id。

## 对应英文文档

如果你希望查看英文版本，请返回仓库首页：

- [English README](../../README.md)
