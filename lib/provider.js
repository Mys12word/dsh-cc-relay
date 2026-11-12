import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { apiRoot, buildRequest, parseSSE, providerFailure, RelayError, safeProviderMessage } from './protocol.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value, fallback, field) => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RelayError(`${field} 必须是正整数。`, 'INVALID_CONFIG')
  return resolved
}

export function normalizeProfile(provider, raw = {}) {
  if (typeof provider !== 'string' || !provider.length || provider.length > 512 || /[\x00-\x1f\x7f]/.test(provider)) throw new RelayError('Provider ID 必须为不含控制字符的非空字符串。', 'INVALID_CONFIG')
  if (!record(raw)) throw new RelayError(`Provider ${provider} 配置必须是对象。`, 'INVALID_CONFIG')
  const compatibility = raw.compatibility ?? {}
  const headers = new Headers(raw.headers ?? {})
  for (const name of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization', 'anthropic-version']) {
    if (headers.has(name)) throw new RelayError(`请用 apiKeyEnv/authMode 设置认证；自定义 headers 不接受 ${name}。`, 'INVALID_CONFIG')
  }
  if (!['bearer', 'x-api-key'].includes(raw.authMode ?? 'bearer')) throw new RelayError('authMode 仅支持 bearer 或 x-api-key。', 'INVALID_CONFIG')
  const ref = raw.apiKeyEnv ?? 'CC_RELAY_API_KEY'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new RelayError('apiKeyEnv 必须是凭据引用名称，不能直接填写密钥。', 'INVALID_CONFIG')
  const maxTokens = positive(raw.defaultMaxTokens, 32000, 'defaultMaxTokens')
  const contextWindow = positive(raw.defaultContextWindow, 200000, 'defaultContextWindow')
  const ids = new Set()
  const models = (raw.models ?? []).map(source => {
    if (!record(source) || typeof source.id !== 'string' || !source.id.trim() || ids.has(source.id)) throw new RelayError('models 需要唯一且非空的 id。', 'INVALID_CONFIG')
    ids.add(source.id)
    const input = source.input?.length ? [...source.input] : ['text', 'image']
    if (input.some(item => !['text', 'image'].includes(item)) || !input.includes('text')) throw new RelayError('模型 input 必须包含 text，可同时包含 image。', 'INVALID_CONFIG')
    return { id: source.id, name: source.name || source.id, input, maxTokens: positive(source.maxTokens, maxTokens, 'models.maxTokens'), contextWindow: positive(source.contextWindow, contextWindow, 'models.contextWindow') }
  })
  const deviceId = raw.deviceId || createHash('sha256').update(`dsh-cc-relay\0${hostname()}\0${userInfo().username}`).digest('hex')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) throw new RelayError('deviceId 仅接受 1–128 个字母、数字、下划线或短横线。', 'INVALID_CONFIG')
  const cliVersion = compatibility.cliVersion || '2.1.287'
  if (!/^\d+\.\d+\.\d+$/.test(cliVersion)) throw new RelayError('compatibility.cliVersion 必须是三段数字版本。', 'INVALID_CONFIG')
  const betas = compatibility.betas ?? []
  if (!Array.isArray(betas) || betas.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item))) throw new RelayError('compatibility.betas 必须是 beta 标识符数组。', 'INVALID_CONFIG')
  return Object.freeze({
    provider,
    displayName: raw.displayName || provider,
    baseURL: raw.baseURL ? apiRoot(raw.baseURL) : '',
    apiKeyEnv: ref,
    authMode: raw.authMode ?? 'bearer',
    headers: Object.fromEntries(headers),
    models,
    maxTokens,
    contextWindow,
    input: ['text', 'image'],
    deviceId,
    promptCache: raw.promptCache !== false,
    streamIdleTimeoutMs: positive(raw.streamIdleTimeoutMs, 300000, 'streamIdleTimeoutMs'),
    maxRequestImages: positive(raw.maxRequestImages, 20, 'maxRequestImages'),
    maxRequestImageBytes: positive(raw.maxRequestImageBytes, 20 * 1024 * 1024, 'maxRequestImageBytes'),
    compatibility: {
      enabled: compatibility.enabled !== false,
      cliVersion,
      systemOpener: compatibility.systemOpener ?? "You are Claude Code, Anthropic's official CLI for Claude.",
      stripModelSuffix: compatibility.stripModelSuffix !== false,
      betas: [...betas],
    },
  })
}

function usageOf(raw, previous = {}) {
  const n = (key, fallback) => Number.isSafeInteger(raw?.[key]) && raw[key] >= 0 ? raw[key] : fallback
  const input = n('input_tokens', previous.uncachedInput ?? 0)
  const read = n('cache_read_input_tokens', previous.cacheReadTokens ?? 0)
  const write = n('cache_creation_input_tokens', previous.cacheWriteTokens ?? 0)
  const output = n('output_tokens', previous.outputTokens ?? 0)
  return { uncachedInput: input, inputTokens: input + read + write, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, totalTokens: input + read + write + output }
}

function publicUsage(usage) {
  const { uncachedInput, ...result } = usage
  return result
}

function terminal(reason, toolCalls) {
  if (reason === 'tool_use') {
    if (!toolCalls) throw new RelayError('中转站以 tool_use 结束但未返回工具调用。', 'MALFORMED_RESPONSE')
    return { kind: 'tool-calls' }
  }
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return { kind: 'max-tokens' }
  if (['end_turn', 'stop_sequence', 'refusal'].includes(reason)) {
    if (toolCalls) throw new RelayError('中转站返回工具调用但没有 tool_use 结束标记。', 'MALFORMED_RESPONSE')
    return { kind: 'stop' }
  }
  throw new RelayError(`中转站返回了无法处理的 stop_reason：${String(reason)}`, 'MALFORMED_RESPONSE')
}

async function* translate(events, names, model, apiKey) {
  const blocks = new Map()
  const replay = []
  let usage = usageOf({})
  let stopReason
  let started = false
  let visible = false
  let tools = 0
  let responseId
  let argumentsError
  const toolIds = new Set()
  for await (const event of events) {
    if (event.type === 'ping') continue
    if (event.type === 'error') {
      const status = event.error?.type === 'rate_limit_error' ? 429 : event.error?.type === 'authentication_error' ? 401 : 500
      throw providerFailure(status, JSON.stringify({ error: event.error }), apiKey)
    }
    if (event.type === 'message_start') {
      if (started) throw new RelayError('中转站返回重复的 message_start。', 'MALFORMED_RESPONSE')
      started = true
      responseId = event.message?.id
      usage = usageOf(event.message?.usage, usage)
    } else if (event.type === 'content_block_start') {
      if (!started || !Number.isSafeInteger(event.index) || event.index < 0 || blocks.has(event.index)) throw new RelayError('中转站流块序号或顺序无效。', 'MALFORMED_RESPONSE')
      const raw = event.content_block
      if (!record(raw)) throw new RelayError('中转站缺少 content_block。', 'MALFORMED_RESPONSE')
      const state = { type: raw.type, text: raw.text ?? raw.thinking ?? '', raw, json: '', signature: raw.signature ?? '', closed: false, position: blocks.size }
      if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(raw.type)) throw new RelayError(`不支持的中转响应块：${raw.type}`, 'UNSUPPORTED_CONTENT')
      if (typeof state.text !== 'string' || typeof state.signature !== 'string' || raw.type === 'redacted_thinking' && typeof raw.data !== 'string') throw new RelayError('中转站内容块的字段格式无效。', 'MALFORMED_RESPONSE')
      if (raw.type === 'tool_use') {
        if (typeof raw.id !== 'string' || !raw.id || toolIds.has(raw.id) || !names.reverse.has(raw.name)) throw new RelayError('中转站返回了未声明的工具或无效工具 ID。', 'MALFORMED_RESPONSE')
        toolIds.add(raw.id)
        state.name = names.reverse.get(raw.name)
        state.id = raw.id
      }
      replay.push(null)
      blocks.set(event.index, state)
      const blockType = raw.type === 'tool_use' ? 'tool-call' : raw.type === 'text' ? 'text' : 'reasoning'
      yield { type: 'block-start', index: event.index, blockType }
      if (raw.type === 'tool_use') yield { type: 'tool-call-delta', index: event.index, id: raw.id, name: state.name, argumentsDelta: '' }
      else if (state.text) yield { type: raw.type === 'text' ? 'text-delta' : 'reasoning-delta', index: event.index, text: state.text }
    } else if (event.type === 'content_block_delta') {
      const state = blocks.get(event.index)
      if (!state || state.closed) throw new RelayError('中转站流增量缺少对应的开放块。', 'MALFORMED_RESPONSE')
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta' && state.type === 'text') {
        state.text += delta.text
        yield { type: 'text-delta', index: event.index, text: delta.text }
      } else if (delta.type === 'thinking_delta' && state.type === 'thinking') {
        state.text += delta.thinking
        yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
      } else if (delta.type === 'signature_delta' && state.type === 'thinking') state.signature += delta.signature
      else if (delta.type === 'input_json_delta' && state.type === 'tool_use') {
        state.json += delta.partial_json
        yield { type: 'tool-call-delta', index: event.index, id: state.id, name: state.name, argumentsDelta: delta.partial_json }
      } else throw new RelayError('中转站返回了与块类型不匹配的流增量。', 'MALFORMED_RESPONSE')
    } else if (event.type === 'content_block_stop') {
      const state = blocks.get(event.index)
      if (!state || state.closed) throw new RelayError('中转站关闭了无效的流块。', 'MALFORMED_RESPONSE')
      state.closed = true
      let block
      if (state.type === 'tool_use') {
        tools++
        let input
        try { input = state.json ? JSON.parse(state.json) : state.raw.input ?? {} } catch {
          argumentsError ??= new RelayError(`工具 ${state.name} 返回无效 JSON 参数。`, 'MALFORMED_RESPONSE')
          continue
        }
        if (!record(input)) {
          argumentsError ??= new RelayError('工具参数必须是 JSON 对象。', 'MALFORMED_RESPONSE')
          continue
        }
        block = { type: 'tool-call', id: state.id, name: state.name, arguments: JSON.stringify(input) }
        replay[state.position] = { type: 'tool_use' }
      } else if (state.type === 'text') {
        block = { type: 'text', text: state.text }
        replay[state.position] = { type: 'text' }
        if (state.text.length) visible = true
      } else {
        block = { type: 'reasoning', text: state.text }
        replay[state.position] = state.type === 'thinking' ? { type: 'thinking', signature: state.signature } : { type: 'redacted_thinking', data: state.raw.data }
      }
      yield { type: 'block-end', index: event.index, block }
    } else if (event.type === 'message_delta') {
      usage = usageOf(event.usage, usage)
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
    } else if (event.type === 'message_stop') {
      if (!started) throw new RelayError('中转站流缺少 message_start。', 'MALFORMED_RESPONSE')
      const reason = terminal(stopReason, tools)
      if (argumentsError && reason.kind !== 'max-tokens') throw argumentsError
      if ([...blocks.values()].some(block => !block.closed) && reason.kind !== 'max-tokens') throw new RelayError('中转站流仍有未关闭的内容块。', 'MALFORMED_RESPONSE')
      if (!visible && !tools && reason.kind === 'stop') throw new RelayError('中转站没有返回回复内容。', 'EMPTY_RESPONSE')
      yield { type: 'usage', usage: publicUsage(usage) }
      yield { type: 'finish', reason, replayState: { response: { kind: 'dsh-cc-relay', version: 1, model, ...(typeof responseId === 'string' ? { id: responseId } : {}) }, blocks: replay } }
      return
    } else if (event.type === '__done') break
    else throw new RelayError(`中转站返回未知流事件：${String(event.type)}`, 'MALFORMED_RESPONSE')
  }
  throw new RelayError('中转站流提前结束，未收到 message_stop。', 'STREAM_CLOSED')
}

async function readBounded(response, maxBytes = 64 * 1024) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = '', size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const part = value.subarray(0, maxBytes - size)
      size += part.length
      text += decoder.decode(part, { stream: true })
    }
    return text + decoder.decode()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export class RelayAdapter {
  constructor(profiles, dependencies) {
    this.profiles = new Map(profiles.map(([name, raw]) => [name, normalizeProfile(name, raw)]))
    this.dependencies = dependencies ?? {}
    this.active = new Set()
    this.closed = false
  }
  profile(provider) {
    const profile = this.profiles.get(provider)
    if (!profile) throw new RelayError('不存在的中转 Provider。', 'NO_ADAPTER')
    return profile
  }
  providerInfo(provider) { return { id: provider, name: this.profile(provider).displayName } }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes } }
  async listModels(provider) {
    const p = this.profile(provider)
    return p.models.map(m => ({ provider, id: m.id, name: m.name, inputModalities: [...m.input] }))
  }
  modelInfo(provider, model) {
    const p = this.profile(provider)
    const found = p.models.find(item => item.id === model)
    return { provider, id: model, name: found?.name ?? model, inputModalities: [...(found?.input ?? ['text', 'image'])], context: { contextWindow: found?.contextWindow ?? p.contextWindow }, defaultMaxTokens: found?.maxTokens ?? p.maxTokens }
  }
  async resolveModel(provider, model, signal) { signal?.throwIfAborted(); return this.modelInfo(provider, model) }
  async prepareCall(provider, model, signal) {
    const metadata = await this.resolveModel(provider, model, signal)
    return { model: metadata, stream: options => this.stream(options) }
  }
  async *stream(options) {
    if (this.closed) throw new RelayError('中转插件已卸载。', 'ABORTED')
    if (options.reasoningEffort !== undefined) throw new RelayError('第一版不接受 reasoningEffort；使用模型默认值。', 'UNSUPPORTED_REASONING_EFFORT')
    options.signal?.throwIfAborted()
    const p = this.profile(options.provider)
    if (!p.baseURL) throw new RelayError('请先在插件设置填写中转站 baseURL。', 'INVALID_CONFIG')
    const rawKey = await this.dependencies.resolveKey(p.apiKeyEnv)
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) throw new RelayError(`请在 DSH 凭据中设置 ${p.apiKeyEnv}。`, 'MISSING_CREDENTIAL')
    if (!/^[\x21-\x7e]+$/.test(key)) throw new RelayError('中转站密钥格式无效，请填写原始 API Key。', 'INVALID_CREDENTIAL')
    if (this.closed || options.signal?.aborted) throw new RelayError('中转请求已取消。', 'ABORTED')
    const controller = new AbortController()
    this.active.add(controller)
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
    let timer
    let timedOut = false
    const pulse = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, p.streamIdleTimeoutMs)
      timer.unref?.()
    }
    try {
      const metadata = this.modelInfo(options.provider, options.model)
      const request = await buildRequest({ ...options, signal }, { ...p, input: metadata.inputModalities, maxTokens: metadata.defaultMaxTokens }, this.dependencies)
      let imageBytes = 0, imageCount = 0
      for (const message of request.body.messages) {
        for (const block of message.content) {
          const images = block.type === 'image' ? [block] : block.type === 'tool_result' && Array.isArray(block.content) ? block.content.filter(part => part.type === 'image') : []
          for (const image of images) { imageCount++; imageBytes += Buffer.byteLength(image.source.data) }
        }
      }
      if (imageCount > p.maxRequestImages || imageBytes > p.maxRequestImageBytes) throw new RelayError('中转请求图片数量或大小超出插件预算，请移除旧图片或调整预算。', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: Math.max(1, imageCount - p.maxRequestImages) })
      const headers = new Headers(this.dependencies.attributionHeaders?.() ?? { 'user-agent': 'dsh-cc-relay/0.1.0' })
      for (const [name, value] of Object.entries(p.headers)) headers.set(name, value)
      headers.set('content-type', 'application/json')
      headers.set('accept', 'text/event-stream')
      headers.set('anthropic-version', '2023-06-01')
      const attribution = this.dependencies.attributionHeaders?.() ?? {}
      if (p.compatibility.enabled) {
        const own = attribution['user-agent'] ?? 'dsh-cc-relay/0.1.0'
        headers.set('user-agent', `claude-cli/${p.compatibility.cliVersion} (external, cli) ${own}`)
        headers.set('x-app', 'cli')
        headers.set('x-claude-code-session-id', request.sessionId)
      } else for (const [name, value] of Object.entries(attribution)) headers.set(name, value)
      if (request.betas.length) headers.set('anthropic-beta', request.betas.join(','))
      if (p.authMode === 'bearer') headers.set('authorization', `Bearer ${key}`)
      else headers.set('x-api-key', key)
      signal.throwIfAborted()
      pulse()
      const response = await (this.dependencies.fetch ?? fetch)(`${p.baseURL}/messages`, { method: 'POST', headers, body: JSON.stringify(request.body), signal, redirect: 'error' })
      pulse()
      if (!response.ok) throw providerFailure(response.status, await readBounded(response), key, response.headers)
      if (!response.body) throw new RelayError('中转站没有返回响应体。', 'EMPTY_RESPONSE')
      yield* translate(parseSSE(response.body, pulse), request.names, options.model, key)
    } catch (error) {
      if (timedOut) throw new RelayError('等待中转站响应超时。', 'TIMEOUT')
      if (signal.aborted) throw new RelayError('中转请求已取消。', 'ABORTED')
      if (error instanceof RelayError) throw error
      throw new RelayError(safeProviderMessage('中转请求传输失败，请核对地址、网络及协议。', key), 'TRANSPORT')
    } finally {
      clearTimeout(timer)
      controller.abort()
      this.active.delete(controller)
    }
  }
  dispose() { this.closed = true; for (const controller of this.active) controller.abort(); this.active.clear() }
}
