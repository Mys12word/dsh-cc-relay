# 模型响应自动兼容 — DSH

0.3.0 改为默认自动识别响应的 Host 插件。继续在 DSH 中选择原来已配置的模型即可；不再注册「CC 中转」提供商，也不再提供逐模型「仅 CC」开关、专用模型表单或 `cc_relay_models` 工具。

## 自动处理什么

- 回复开头的 `<thinking>`、`<think>`、`<analysis>`、`<reasoning>` 包裹，转换到 DSH 的独立思考区；支持标签和内容分散在多个流增量中。正文中讨论标签、Markdown 代码和引用不作此转换。
- 完整的 Anthropic Messages JSON、Messages SSE 文本，以及 OpenAI Chat Completions / Responses JSON、Responses SSE 文本，转换为 DSH 文本、思考和工具请求记录。
- Claude Code `stream-json` / Agent SDK 的 assistant、stream_event、tool_result、result，以及 Codex `exec --json` 的 reasoning、agent_message、命令、文件与 MCP 记录，转换成可读消息。流事件与最终快照避免重复展示。
- 原适配器已经正确生成的思考、工具调用、用量、错误和取消继续通过。转换不产生额外模型请求。

纯文本里的 JSON 工具请求默认显示为「未执行」记录；原生 DSH 工具调用保持正常执行。代码示例和真正的 JSON 调用在内容上可能完全一样，自动识别形状不能确定其用途。

如果某个上游明确把完整模型协议 JSON 当作实际调用返回，可在插件高级设置中开启 **allowJsonToolCalls**，这是所有模型共用的一个总开关。开启后，完整 JSON 中的客户端工具请求只有在名称、参数匹配本次请求实际声明的工具时，才转换为 DSH 工具调用，之后仍由 DSH 执行及审批。不要用于经常要求模型原样展示工具协议示例的会话。

Claude Code 和 Codex CLI 的工具活动始终是观察记录，不参与上述执行开关：它们已由外部客户端负责，不能再执行一次。未声明工具、未知参数、无效 JSON、缺少结束标记、截断或失败响应不生成新调用；不递归解析回答字符串里的 JSON。

## 请求与范围

插件只包装公开的 `llm/stream` 事件并调用一次 `next()`。原提供方继续负责地址、认证、OAuth、请求协议、模型能力、图片、思考档位、准备阶段快照、网络超时、重试和取消。插件不读取或复制密钥，不修改系统提示词、请求头或发送内容。

这是响应内容兼容，不会解除站点的客户端准入限制，也不会自动修复错误的请求协议。如果原适配器在得到文本之前就因为鉴权、协议不匹配而失败，外层响应转换无法取回已被丢弃的原始 HTTP/SSE 数据。

转换只发生在本次模型输出上，旧会话日志不会改写。已转换内容不复用旧原生 replay/signature，避免旧签名与新内容错配；下次发送由原适配器按 DSH 标准消息重建，部分协议可能省略没有有效签名的历史思考。未转换的内容保留原 replay。

停用或卸载后，后续请求恢复原适配器输出；已经开始的请求会完成进入时的转换。网络取消仍由原适配器及调用方负责。

## 配置

默认安装即可自动运行，仅有两个高级字段：

```yaml
allowJsonToolCalls: false
maxStructuredChars: 2097152
```

`maxStructuredChars` 是候选 JSON 的缓冲字符上限。超出时按原文输出，不截断普通回复、不限制 token 总量或工具次数。异常交错流的等待队列也受此预算保护。普通文本即时流出；候选 JSON 等完整结束后才进行原子转换。用量快照即时透传，只使用原请求用量，内层 JSON 的计费记录不会重复相加。

旧版 `baseURL`、`models`、`apiKeyEnv`、`compatibility`、`ccOnlyModels` 等字段在 0.3.0 中不再起作用；已保存的原提供方与凭据不受影响。原先只配置在独立 `cc-relay` 下的模型需要在 DSH 普通提供方中配置后使用。

## 备份与验证

升级前保留 0.2.0 安装包、源码包、完整 Git bundle 和提交标签，便于恢复。0.3.0 安装包只包含新的 Host 实现，不包含旧 Client、旧 RelayAdapter 或逐模型路由代码。

```sh
npm run check
npm test
DSH_RUNTIME_ROOT=/opt/dsh/node_modules npm run test:runtime
```

测试包含逐字符标签分割、代码与普通 JSON、多个内容块、CLI 观察流去重、Responses/Messages 转换、声明工具校验、取消、截断、缓冲预算、签名隔离、真实 DSH `BlockAssembler` / `prepareCall`，以及原 pi-ai 适配器通过 localhost 模拟 OpenAI 接口进行的工具往返。测试使用合成数据和本地假密钥，不调用真实模型站点；不能据此宣称所有上游都兼容。

## 格式资料

- [Claude Code headless 与 JSON 输出](https://code.claude.com/docs/en/headless.md)
- [Agent SDK 流式输出与完成快照](https://code.claude.com/docs/en/agent-sdk/streaming-output.md)
- [Claude SDK 工具执行循环](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)
- [Anthropic Messages 流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming.md)
- [Codex exec JSONL 事件源码](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)
- [OpenAI Responses 输出类型](https://github.com/openai/openai-python/tree/main/src/openai/types/responses)

包名 `dsh-cc-relay` 保留以便原位升级；插件显示名为「模型响应自动兼容」。本项目原创 SVG 图标，MIT 许可。
