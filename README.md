# CC 中转 — DSH Provider

为 DSH 注册独立的 `cc-relay` 模型提供方。面向 Anthropic Messages 兼容中转接口，可开启 CC 请求兼容模式；不需要安装本机 Claude Code，也不读取 Claude 订阅 OAuth。

## 已配置模型设为仅 CC（0.2.0）

在 Harness 网页版 **设置 → 模型** 底部的 **已配置模型 · 仅 CC** 面板中，搜索并勾选模型，选择认证方式后保存。之后继续选择原提供方下的原模型；只有勾选的精确“提供方 + 模型 ID”通过本插件调用。取消勾选并保存即可恢复原适配器。

复用原提供方已保存的 `baseURL`、`apiKeyEnv` 和自定义请求头，密钥仍由 DSH 每次请求读取，不复制到插件配置。不需要在独立 CC 中转表单重填地址或密钥。源提供方须保存明确的 Base URL 和 API Key 引用；订阅登录、账号令牌及云厂商原生鉴权不参与此模式。原协议即使是 OpenAI，勾选后也改用 Anthropic Messages，因此站点必须提供该接口。

还可在聊天中要求设置，例如“把 gateway 的 claude-model 设为仅 CC”，由 `cc_relay_models` 工具列出或修改标记。保存本身不调用模型接口、不消耗模型额度。手机原生界面继续使用原模型；此专用管理面板位于 Harness Web。

仅 CC 请求强制启用 CC 兼容，思考使用上游默认行为，原提供方的 reasoning effort 不转发。流式、工具及签名回传由插件处理，失败直接报告，不尝试原适配器。插件在发送时读取原提供方配置；若从准备请求到发送之间更改了配置，以发送时的地址和密钥引用为准，不能保证沿用原适配器准备时的快照。原提供方仍负责模型选择器中的能力信息和请求准备校验，重试沿用原提供方策略。

插件的高级配置中新增 `ccOnlyModels`：

```yaml
ccOnlyModels:
  - provider: gateway
    model: your-exact-model-id
    authMode: bearer
```

## 独立中转配置

安装后在 Harness 网页版的 **设置 → 模型 → CC 中转 → CC 中转配置** 填写。手机原生界面暂未提供该专用表单，可从本机网页 `http://127.0.0.1:3080` 打开。更换已安装版本后，若安装工具提示需要重启，请在 DSH Go 设置中重启本机引擎，再刷新网页。

填写以下三项：

1. **Base URL**：你的中转站地址。`https://example.com`、`https://example.com/v1` 或带路径前缀的根地址均可。
2. **API Key**：填写中转站密钥，保存在 DSH 凭据服务中。默认引用为 `CC_RELAY_API_KEY`，配置文件不存密钥。
3. **模型**：加入中转站提供的精确模型 ID，再从对话模型选择器选择该模型。

其余设置在插件的自动配置页中。一个配置例子（密钥单独在模型页填写）：

```yaml
- id: cc-relay
  config:
    baseURL: https://your-relay.example
    apiKeyEnv: CC_RELAY_API_KEY
    authMode: bearer
    models:
      - id: your-exact-model-id
        name: 我的中转 Claude
        contextWindow: 200000
        maxTokens: 32000
        input: [text, image]
    compatibility:
      enabled: true
      cliVersion: 2.1.287
      stripModelSuffix: true
      betas: []
```

`authMode: bearer` 发送 `Authorization: Bearer <key>`；`x-api-key` 发送 Anthropic 风格的密钥头。按站点文档选择。无地址和模型的初始安装只增加配置入口，不发送网络请求，也不改变当前模型。

## CC 请求兼容

开启后作用于独立 `cc-relay`；已标记的仅 CC 模型始终启用以下兼容行为：

- 发送 CC 形式的客户端头、`x-app: cli` 和稳定的 `x-claude-code-session-id`，并保留 DSH 产品标识。
- 请求体 `metadata.user_id` 包含与请求头一致的会话 UUID；机器标识仅使用本机信息的 SHA-256 摘要。
- 前置兼容用的系统开头；保留 DSH 原有系统文本。
- 把实际存在的 DSH `bash/read/write/edit/glob/grep/subagent` 分别映射成 `Bash/Read/Write/Edit/Glob/Grep/Agent`，收到调用后映射回 DSH 原名。原参数 schema 不变，工具仍由 DSH 执行和审批。
- 可移除模型 `[1m]` 后缀并发送 `context-1m-2025-08-07`。其他 beta 仅在配置中指定时发送。

不添加不存在的占位工具，不提供 CLI 的全部私有协议。关闭兼容模式后使用常规 Anthropic Messages 请求。各站点客户端校验不同，兼容模式不代表所有 CC-only 渠道都会接受；请使用你有权调用且允许此接法的中转渠道。如果站点要求官方客户端的完整行为，需使用该站允许的官方 CLI/SDK 路径。

## 已实现

- 流式文本、原生 reasoning 块投影到 DSH 独立的 reasoning 通道；回复正文不注入 `<thinking>` 标签。
- 原始 JSON 工具参数、多个工具结果、历史消息和同模型签名回传。
- 图片附件 base64 输入和文件引用文本，遵循 DSH 附件接口。
- token 与缓存用量、结束原因、取消、卸载取消、空闲超时、HTTP/SSE 错误分类、错误信息密钥脱敏。
- 独立中转的配置变更影响后续请求，已准备请求保持其配置；仅 CC 标记在发送时生效，已发出的请求保持该次读取的配置。

## 限制与测试范围

- 没有累计 token 额度或累计工具次数限制；单次 `maxTokens`、上下文容量和图片预算仍受模型、DSH 与站点限制。插件不改变中转商计费或配额。
- 第一版不主动发送 `thinking`、`reasoning_effort` 或 `output_config` 控制，使用上游模型默认行为，也不在 DSH 宣告可选 reasoning effort。
- 发送只支持 Anthropic Messages SSE；可复用已配置的模型列表，不把 OpenAI 格式转换为上游请求，也不自动向站点发现模型。独立中转的模型 ID 需手动配置。
- 不自动执行或自动放行工具；沿用当前 DSH preset 和审批设置。
- 本地模拟中转站测试不证明真实中转可用。真实联调需要站点 URL、精确模型 ID，以及在 DSH 中本地保存的密钥。

## 开发验证

```sh
npm run check
npm test
```

有 DSH 运行时安装目录时可运行额外契约测试：

```sh
DSH_RUNTIME_ROOT=/opt/dsh/node_modules \
  node --import ./test/runtime-register.mjs \
  --test test/runtime.test.mjs
```

测试使用 localhost 模拟中转站，不调用外部模型、不使用真实凭据。运行时测试 loader 仅用于验证，不是插件运行依赖。包内 `files` 清单限定安装产物，测试源码保留在工作区源码包中。

## 参考资料

- [pi-cc-shim 的公开协议兼容说明](https://www.npmjs.com/package/pi-cc-shim)：不同网关会检查客户端头、系统开头、metadata 和工具名称；本实现不导入其代码。
- [Claude Code 网关配置](https://code.claude.com/docs/en/llm-gateway-connect)：网关地址与认证变量。
- [渠道区分示例](https://doc.voltapi.ai/quick-start)：CC 专用与不限客户端渠道需要分别核实。

本项目为独立的 DSH 插件，图标为本项目原创 SVG，不代表 Anthropic 官方产品。
