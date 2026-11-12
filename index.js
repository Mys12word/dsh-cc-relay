import z from '@deepseek-ai/schemastery'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { RelayAdapter } from './lib/provider.js'
import { RelayError } from './lib/protocol.js'
import { installConfiguredRouting, registerModelTool, validateSelections } from './lib/configured.js'

export const name = 'cc-relay'
export const inject = ['llm', 'credentials']

const capacity = () => z.number().step(1).min(1)
const modelSchema = z.object({
  id: z.string().required().description('中转站提供的精确模型 ID。'),
  name: z.string().description('模型显示名称。'),
  contextWindow: capacity().description('模型上下文容量；留空使用默认值。'),
  maxTokens: capacity().description('单次最大输出 token；留空使用默认值。'),
  input: z.array(z.union(['text', 'image'])).default(['text', 'image']).description('模型接受的输入类型。'),
})

export const Config = z.object({
  baseURL: z.string().default('').volatile().description('中转站 API 根地址，可包含 /v1；留空时只注册配置入口。'),
  apiKeyEnv: z.string().role('credential-ref').default('CC_RELAY_API_KEY').volatile().description('DSH 凭据引用；在模型设置填 API Key，不要在这里填密钥。'),
  authMode: z.union(['bearer', 'x-api-key']).default('bearer').volatile().description('中转认证方式。Claude Code 常用 bearer；普通 Anthropic API 常用 x-api-key。'),
  models: z.array(modelSchema).default([]).volatile().description('填写此站支持的模型 ID，保存后出现在模型选择器。'),
  ccOnlyModels: z.array(z.object({
    provider: z.string().required().description('已配置模型的原提供方 ID。'),
    model: z.string().required().description('已配置模型的精确 ID。'),
    authMode: z.union(['bearer', 'x-api-key']).default('bearer').description('复用原密钥时的认证方式。'),
  })).default([]).volatile().description('将指定的已配置模型设为仅 CC：复用其原地址和密钥，通过兼容插件调用。'),
  defaultContextWindow: capacity().default(200000).volatile().description('模型未单独设置时的上下文容量。'),
  defaultMaxTokens: capacity().default(32000).volatile().description('单次默认输出 token 上限；不是累计额度限制。'),
  promptCache: z.boolean().default(true).volatile().description('在请求末尾添加 Anthropic ephemeral 缓存断点。'),
  streamIdleTimeoutMs: capacity().max(2147483647).default(300000).volatile().description('流连接无数据的超时毫秒数。'),
  maxRequestImages: capacity().default(20).volatile().description('单个请求保留的图片数量上限。'),
  maxRequestImageBytes: capacity().default(20971520).volatile().description('单个请求图片 base64 总字节预算。'),
  headers: z.dict(z.string()).default({}).volatile().description('站点要求的额外请求头；认证信息只通过 DSH 凭据读取。'),
  compatibility: z.object({
    enabled: z.boolean().default(true).description('CC 请求兼容：客户端头、会话 metadata、系统开头和真实工具名称映射。'),
    cliVersion: z.string().default('2.1.287').description('兼容请求头中的 CLI 版本，可按站点要求修改。'),
    systemOpener: z.string().default("You are Claude Code, Anthropic's official CLI for Claude.").description('兼容请求的系统开头；站点不需要时可清空。'),
    stripModelSuffix: z.boolean().default(true).description('移除 [1m] 模型后缀，同时发送长上下文 beta。'),
    betas: z.array(z.string()).default([]).description('站点明确支持的 anthropic-beta 标识，默认不添加。'),
  }).volatile(),
})

const PROVIDER = 'cc-relay'
function plain(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key,
    value && typeof value.get === 'function' ? structuredClone(value.get()) : structuredClone(value)]))
}

export function apply(ctx, config) {
  let cachedJSON
  let cached
  const generations = new Set()
  const dependencies = {
    attributionHeaders,
    resolveKey: async ref => (await ctx.credentials.resolve(ref))?.value,
    fileText: ref => ctx.llm.fileRequestText(ref),
    readImage: async (ref, signal) => {
      const service = ctx.get('attachments')
      if (!service) throw new RelayError('图片输入需要 DSH attachment 服务。', 'UNSUPPORTED_CONTENT')
      return service.readImage(ref, signal)
    },
  }
  const current = () => {
    const raw = plain(config)
    const serialized = JSON.stringify(raw)
    if (cached && serialized === cachedJSON) return cached
    const next = new RelayAdapter([[PROVIDER, { ...raw, displayName: 'CC 中转' }]], dependencies)
    // Prepared calls may retain an older generation before it opens a network stream.
    // Keep every generation owned until unload so those handles cannot outlive this plugin.
    generations.add(next)
    cached = next
    cachedJSON = serialized
    return next
  }
  current()
  validateSelections(plain(config).ccOnlyModels)
  const settingsNs = ctx.fiber.entry?.options.id ?? 'cc-relay'
  ctx.inject(['settings'], child => {
    installConfiguredRouting(child, () => plain(config), dependencies)
    registerModelTool(child, () => plain(config), settingsNs)
  })
  const adapter = {
    providerInfo: () => ({ id: PROVIDER, name: 'CC 中转' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (provider, model, image) => current().imageRequestTarget(provider, model, image),
    listModels: provider => current().listModels(provider),
    resolveModel: (provider, model, signal) => current().resolveModel(provider, model, signal),
    prepareCall: (provider, model, signal) => current().prepareCall(provider, model, signal),
    stream: options => current().stream(options),
  }
  ctx.effect(() => () => { for (const generation of generations) generation.dispose(); generations.clear() })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'CC 中转',
    settingsNs: ctx.fiber.entry?.options.id ?? 'cc-relay',
    settingsPath: [],
    nativeAuth: { env: ['CC_RELAY_API_KEY'], oauth: false },
  }])
  // The Loader emits this event on this plugin's context after volatile Config changes.
  ctx.on('loader/volatile-update', () => {
    try {
      validateSelections(plain(config).ccOnlyModels)
      current()
      ctx.emit('llm/models-updated', PROVIDER)
    } catch (error) {
      ctx.logger.warn(`CC 中转配置尚不可用：${error instanceof RelayError ? error.message : '请检查配置格式。'}`)
    }
  })
}
