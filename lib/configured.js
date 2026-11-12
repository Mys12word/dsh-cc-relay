import { projectImagesForTextModel, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import { RelayAdapter } from './provider.js'
import { RelayError } from './protocol.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => record(value) && Object.hasOwn(value, key) ? value[key] : undefined
export const routeKey = (provider, model) => JSON.stringify([provider, model])

export function validateSelections(items = []) {
  if (!Array.isArray(items)) throw new RelayError('仅 CC 模型配置必须是数组。', 'INVALID_CONFIG')
  const seen = new Set()
  return items.map(item => {
    if (!record(item) || typeof item.provider !== 'string' || !item.provider || item.provider === 'cc-relay' || typeof item.model !== 'string' || !item.model.trim() || !['bearer', 'x-api-key'].includes(item.authMode ?? 'bearer')) throw new RelayError('仅 CC 设置需要原提供方、精确模型 ID 和有效认证方式。', 'INVALID_CONFIG')
    const key = routeKey(item.provider, item.model)
    if (seen.has(key)) throw new RelayError('仅 CC 模型配置重复。', 'INVALID_CONFIG')
    seen.add(key)
    return { provider: item.provider, model: item.model, authMode: item.authMode ?? 'bearer' }
  })
}

export function sourceProfile(directory, descriptors, provider) {
  const source = directory.find(item => item.provider === provider)
  if (!source) throw new RelayError('原模型提供方没有可读取的配置入口。', 'INVALID_CONFIG')
  const descriptor = descriptors.find(item => item.ns === source.settingsNs)
  let profile = descriptor?.value
  for (const part of source.settingsPath) profile = own(profile, part)
  if (!record(profile)) throw new RelayError('原模型提供方配置不存在，请刷新模型设置。', 'INVALID_CONFIG')
  if (typeof profile.baseURL !== 'string' || !profile.baseURL) throw new RelayError('请先在原提供方保存 Base URL，再启用仅 CC。', 'INVALID_CONFIG')
  if (typeof profile.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) throw new RelayError('请先在原提供方保存 API Key；仅 CC 复用 API Key 引用，不使用订阅登录。', 'INVALID_CONFIG')
  return { source, profile }
}

function configuredModels(ctx, flags) {
  const result = []
  const descriptors = ctx.settings.describe({ redactSecrets: true })
  for (const source of ctx.llm.listConfigurableProviders()) {
    if (source.provider === 'cc-relay') continue
    let profile = descriptors.find(item => item.ns === source.settingsNs)?.value
    for (const part of source.settingsPath) profile = own(profile, part)
    if (!record(profile)) continue
    const models = Array.isArray(profile.models) ? profile.models : []
    for (const model of models) {
      if (typeof model.id !== 'string') continue
      let unavailable
      try { sourceProfile([source], descriptors, source.provider) } catch (error) { unavailable = error.message }
      const flag = flags.find(item => item.provider === source.provider && item.model === model.id)
      result.push({ provider: source.provider, model: model.id, name: model.name || model.id, ccOnly: !!flag, authMode: flag?.authMode ?? 'bearer', ...(unavailable ? { unavailable } : {}) })
    }
  }
  return result
}

export function installConfiguredRouting(ctx, getConfig, dependencies) {
  const generations = new Set()
  const lifetime = new AbortController()
  const selected = () => validateSelections(getConfig().ccOnlyModels)
  ctx.on('llm/stream', (options, next) => {
    const raw = getConfig()
    // A malformed flag for one route must never break unrelated providers.
    // Validate a matching route inside the terminal-error boundary below.
    const matching = Array.isArray(raw.ccOnlyModels) ? raw.ccOnlyModels.filter(item => record(item) && item.provider === options.provider && item.model === options.model) : []
    if (!matching.length) return next()
    // Capture the source profile when dispatch begins; no original request is
    // mutated, and no original dispatch is attempted after a CC failure.
    let captured, captureFailure
    try { captured = sourceProfile(ctx.llm.listConfigurableProviders(), ctx.settings.describe(), options.provider) }
    catch (error) { captureFailure = error }
    return (async function* () {
      let relay
      try {
        if (captureFailure) throw captureFailure
        const flag = validateSelections(matching)[0]
        const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
        signal.throwIfAborted()
        const { profile } = captured
        const metadata = await ctx.llm.resolveModelInfo(options.provider, options.model, signal)
        signal.throwIfAborted()
        const model = profile.models?.find(item => item.id === options.model)
        relay = new RelayAdapter([[options.provider, {
          ...raw, baseURL: profile.baseURL, headers: profile.headers ?? {}, apiKeyEnv: profile.apiKeyEnv, authMode: flag.authMode,
          models: [{ id: options.model, name: metadata.name, contextWindow: metadata.context?.contextWindow, maxTokens: metadata.defaultMaxTokens ?? model?.maxTokens ?? profile.defaultMaxTokens ?? profile.maxTokens ?? raw.defaultMaxTokens, input: metadata.inputModalities ?? ['text'] }],
          streamIdleTimeoutMs: profile.streamIdleTimeoutMs ?? raw.streamIdleTimeoutMs,
          compatibility: { ...raw.compatibility, enabled: true },
        }]], dependencies)
        generations.add(relay)
        // Mirror the public core projection for an adapter without historical
        // tool declarations. Only current tools remain executable.
        const projected = projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)
        let messages = metadata.inputModalities?.includes('image') === false ? projectImagesForTextModel(projected.messages) : projected.messages
        // Foreign provider metadata never enters this serializer. Keep native
        // relay signatures only for the exact original provider/model pair.
        messages = messages.map(message => {
          const source = message.source
          if (message.role !== 'assistant' || source?.replayState === undefined || source.provider === options.provider && source.model === options.model && source.replayState?.response?.kind === 'dsh-cc-relay') return message
          const { replayState: _replay, ...neutral } = source
          return { ...message, source: neutral }
        })
        // Turning on CC explicitly opts into upstream-default reasoning. An
        // original provider's effort vocabulary cannot be reused on this wire.
        const { reasoningEffort: _effort, ...request } = options
        yield* relay.stream({ ...request, messages, tools: projected.tools, signal })
      } catch (error) {
        const aborted = options.signal?.aborted || lifetime.signal.aborted
        const failure = error instanceof RelayError ? error.failure : { code: aborted ? 'ABORTED' : 'INVALID_CONFIG', message: aborted ? '仅 CC 请求已取消。' : '仅 CC 请求失败，请检查原提供方地址、模型和 API Key 配置。' }
        yield { type: 'finish', reason: { kind: aborted || failure.code === 'ABORTED' ? 'aborted' : 'error', failure } }
      } finally { if (relay) { relay.dispose(); generations.delete(relay) } }
    })()
  })
  ctx.effect(() => () => { lifetime.abort(); for (const generation of generations) generation.dispose(); generations.clear() })
  return { list: () => configuredModels(ctx, selected()) }
}

export function registerModelTool(ctx, getConfig, settingsNs) {
  ctx.inject(['tools', 'settings'], child => {
    child.tools.register({
      name: 'cc_relay_models',
      description: '列出已配置模型或设置“仅 CC”；开启后复用原地址和 API Key，经 CC 插件调用，仍选择原模型，思考使用上游默认值。保存不测试网络。',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'set'] },
        provider: { type: 'string', description: 'set 时填写 list 返回的原提供方 ID。' },
        model: { type: 'string', description: 'set 时填写精确模型 ID。' },
        enabled: { type: 'boolean', description: 'set 时必填：true 开启仅 CC，false 恢复原调用。' },
        authMode: { type: 'string', enum: ['bearer', 'x-api-key'], description: '开启时的认证方式，默认 bearer。' },
      }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: args => args?.action === 'list',
      async execute(args, exec) {
        if (args.action === 'list') {
          const flags = validateSelections(getConfig().ccOnlyModels)
          const models = configuredModels(child, flags)
          for (const provider of child.llm.listProviders()) {
            if (provider.id === 'cc-relay') continue
            for (const model of await child.llm.listModels(provider.id).catch(() => [])) {
              if (models.some(item => item.provider === provider.id && item.model === model.id)) continue
              const flag = flags.find(item => item.provider === provider.id && item.model === model.id)
              let unavailable
              try { sourceProfile(child.llm.listConfigurableProviders(), child.settings.describe({ redactSecrets: true }), provider.id) } catch (error) { unavailable = error.message }
              models.push({ provider: provider.id, model: model.id, name: model.name, ccOnly: !!flag, authMode: flag?.authMode ?? 'bearer', ...(unavailable ? { unavailable } : {}) })
            }
          }
          return { models }
        }
        if (args.action !== 'set' || typeof args.enabled !== 'boolean' || typeof args.provider !== 'string' || typeof args.model !== 'string') throw new RelayError('set 需要 provider、model、enabled。', 'INVALID_REQUEST')
        exec.signal?.throwIfAborted()
        const view = child.settings.describe({ redactSecrets: true }).find(item => item.ns === settingsNs)
        if (!view) throw new RelayError('CC 插件设置不可写。', 'INVALID_CONFIG')
        const flags = validateSelections(view.value.ccOnlyModels)
        const previous = flags.find(item => item.provider === args.provider && item.model === args.model)
        const next = flags.filter(item => item.provider !== args.provider || item.model !== args.model)
        if (args.enabled) {
          sourceProfile(child.llm.listConfigurableProviders(), child.settings.describe({ redactSecrets: true }), args.provider)
          await child.llm.resolveModelInfo(args.provider, args.model, exec.signal)
          next.push({ provider: args.provider, model: args.model, authMode: args.authMode ?? previous?.authMode ?? 'bearer' })
        }
        validateSelections(next)
        exec.signal?.throwIfAborted()
        await child.settings.mutate(settingsNs, [{ op: 'set', path: ['ccOnlyModels'], value: next }], view.revision)
        return { updated: true, provider: args.provider, model: args.model, enabled: args.enabled }
      },
    })
  })
}
