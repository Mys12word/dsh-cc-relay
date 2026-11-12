import { createHash, randomUUID } from 'node:crypto'

export class RelayError extends Error {
  constructor(message, code = 'INVALID_REQUEST', facts = {}) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    this.failure = Object.freeze({ message, code, ...facts })
  }
}

export function apiRoot(baseURL) {
  let url
  try { url = new URL(baseURL) } catch { throw new RelayError('请配置中转站的完整 HTTP(S) Base URL。', 'INVALID_CONFIG') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RelayError('Base URL 必须为不含账号、密码、查询参数和 fragment 的 HTTP(S) 地址。', 'INVALID_CONFIG')
  }
  const root = url.href.replace(/\/+$/, '').replace(/\/v1\/messages$/, '/v1')
  return root.endsWith('/v1') ? root : `${root}/v1`
}

export function sessionUUID(provider, sessionId) {
  if (!sessionId) return randomUUID()
  const hex = createHash('sha256').update(`${provider}\0${sessionId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const CC_NAMES = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep', subagent: 'Agent' }
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function toolNames(options, compatibility) {
  const names = new Set((options.tools ?? []).map(tool => tool.name))
  for (const message of options.messages ?? []) for (const block of message.content ?? []) {
    if (block.type === 'tool-call') names.add(block.name)
  }
  const used = new Map()
  const forward = new Map()
  for (const name of [...names].sort()) {
    let wire = compatibility ? CC_NAMES[name] ?? name : name
    if (wire !== name && names.has(wire)) wire = name
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(wire)) {
      wire = `${wire.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
    }
    if (used.has(wire) && used.get(wire) !== name) throw new RelayError('工具名称映射发生冲突。', 'UNSUPPORTED_CONTENT')
    used.set(wire, name)
    forward.set(name, wire)
  }
  const active = new Set((options.tools ?? []).map(tool => tool.name))
  const reverse = new Map([...used].filter(([, name]) => active.has(name)))
  return { forward, reverse }
}

function toolArguments(raw, name) {
  let value
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { throw new RelayError(`历史工具 ${name} 的参数不是有效 JSON。`, 'UNSUPPORTED_CONTENT') }
  if (!isRecord(value)) throw new RelayError(`工具 ${name} 的参数必须是 JSON 对象。`, 'UNSUPPORTED_CONTENT')
  return value
}

function plainText(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function savedBlock(message, position, options) {
  const replay = message.source?.replayState
  if (message.source?.provider !== options.provider || message.source?.model !== options.model || replay?.response?.kind !== 'dsh-cc-relay' || replay.response.version !== 1 || replay.response.model !== options.model) return undefined
  return replay.blocks?.[position]
}

async function contentBlocks(message, config, dependencies, options, names) {
  const blocks = []
  for (const [position, block] of (message.content ?? []).entries()) {
    if (block.type === 'text') {
      if (block.text.length) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      if (message.role !== 'assistant') throw new RelayError('非 assistant 消息不能包含工具调用。', 'UNSUPPORTED_CONTENT')
      blocks.push({ type: 'tool_use', id: block.id, name: names.forward.get(block.name) ?? block.name, input: toolArguments(block.arguments, block.name) })
    } else if (block.type === 'reasoning') {
      const saved = savedBlock(message, position, options)
      if (saved?.type === 'thinking' && typeof saved.signature === 'string' && saved.signature.length) {
        blocks.push({ type: 'thinking', thinking: block.text, signature: saved.signature })
      } else if (saved?.type === 'redacted_thinking' && typeof saved.data === 'string') {
        blocks.push({ type: 'redacted_thinking', data: saved.data })
      }
    } else if (block.type === 'image') {
      const ref = block.attachment
      if (block.offloaded || !config.input.includes('image')) {
        blocks.push({ type: 'text', text: `[Image ${ref.attachmentId}${block.offloaded ? ' offloaded' : '; image input disabled'}]` })
        continue
      }
      if (!['user', 'tool'].includes(message.role)) throw new RelayError('图片只能出现在用户消息或工具结果中。', 'UNSUPPORTED_CONTENT')
      if (!dependencies.readImage) throw new RelayError('图片输入需要 DSH attachment 服务。', 'UNSUPPORTED_CONTENT')
      const image = await dependencies.readImage(ref, options.signal)
      const bytes = image.data instanceof Uint8Array ? image.data : image.bytes instanceof Uint8Array ? image.bytes : undefined
      if (!bytes) throw new RelayError('Attachment 服务未返回可用图片字节。', 'UNSUPPORTED_CONTENT')
      blocks.push({ type: 'text', text: `[Image attachment: ${ref.attachmentId}]` })
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType ?? ref.mediaType, data: Buffer.from(bytes).toString('base64') } })
    } else if (block.type === 'file') {
      blocks.push({ type: 'text', text: dependencies.fileText?.(block.attachment) ?? `[File ${block.attachment.attachmentId}: ${block.attachment.name}]` })
    } else if (!['tool-addition', 'tool-removal'].includes(block.type)) {
      throw new RelayError(`不支持的消息块：${block.type}`, 'UNSUPPORTED_CONTENT')
    }
  }
  return blocks
}

export async function buildRequest(options, config, dependencies = {}) {
  const names = toolNames(options, config.compatibility.enabled)
  const system = []
  const messages = []
  const addSystem = text => { if (text) system.push({ type: 'text', text }) }
  const append = (role, content) => {
    if (!content.length) return
    const last = messages.at(-1)
    if (last?.role === role) last.content.push(...content)
    else messages.push({ role, content })
  }
  if (config.compatibility.enabled && config.compatibility.systemOpener) addSystem(config.compatibility.systemOpener)
  if (options.system) addSystem(options.system)
  const pending = new Set()
  const seenCalls = new Set()
  for (const message of options.messages ?? []) {
    if (message.role === 'system') {
      if (!messages.length) addSystem(plainText(message.content ?? []))
      else {
        const reminder = plainText(message.content ?? [])
        if (reminder) append('user', [{ type: 'text', text: `<system-reminder>\n${reminder}\n</system-reminder>` }])
      }
      continue
    }
    const content = await contentBlocks(message, config, dependencies, options, names)
    if (message.role === 'tool') {
      if (!pending.has(message.toolCallId)) throw new RelayError('工具结果与历史工具调用不匹配。', 'UNSUPPORTED_CONTENT')
      pending.delete(message.toolCallId)
      append('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: content.length ? content : '', ...(message.isError ? { is_error: true } : {}) }])
      continue
    }
    if (pending.size) throw new RelayError('历史存在尚未返回结果的工具调用。', 'UNSUPPORTED_CONTENT')
    if (message.role === 'assistant') {
      for (const block of content) if (block.type === 'tool_use') {
        if (seenCalls.has(block.id)) throw new RelayError('历史中出现重复工具调用 ID。', 'UNSUPPORTED_CONTENT')
        seenCalls.add(block.id)
        pending.add(block.id)
      }
      append('assistant', content)
    } else if (message.role === 'user') append('user', content)
    else if (message.role === 'developer') {
      if (content.length) append('user', [{ type: 'text', text: '<developer-instructions>' }, ...content, { type: 'text', text: '</developer-instructions>' }])
    } else throw new RelayError(`不支持的消息角色：${message.role}`, 'UNSUPPORTED_CONTENT')
  }
  if (pending.size) throw new RelayError('请求末尾存在未完成的工具调用。', 'UNSUPPORTED_CONTENT')
  if (!messages.length || messages[0].role !== 'user') throw new RelayError('Anthropic 对话需要以用户内容开始。', 'INVALID_REQUEST')
  let model = options.model
  const uses1m = /\[1m\]$/i.test(model)
  if (config.compatibility.enabled && config.compatibility.stripModelSuffix) model = model.replace(/\[1m\]$/i, '')
  const body = { model, max_tokens: options.maxTokens ?? config.maxTokens, stream: true, messages }
  if (system.length) body.system = system
  if (options.tools?.length) {
    body.tools = options.tools.map(tool => ({ name: names.forward.get(tool.name), description: tool.description, input_schema: structuredClone(tool.parameters) }))
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.stop?.length) body.stop_sequences = [...options.stop]
  const sessionId = sessionUUID(options.provider, options.sessionId)
  if (config.compatibility.enabled) {
    body.metadata = { user_id: JSON.stringify({ device_id: config.deviceId, account_uuid: '', session_id: sessionId }) }
  }
  if (config.promptCache) {
    const tool = body.tools?.at(-1)
    if (tool) tool.cache_control = { type: 'ephemeral' }
    if (system.length) system.at(-1).cache_control = { type: 'ephemeral' }
    const last = messages.at(-1)?.content.at(-1)
    if (last && ['text', 'image', 'tool_result'].includes(last.type)) last.cache_control = { type: 'ephemeral' }
  }
  const betas = new Set(config.compatibility.enabled ? config.compatibility.betas : [])
  if (uses1m && config.compatibility.enabled && config.compatibility.stripModelSuffix) betas.add('context-1m-2025-08-07')
  return { body, names, sessionId, betas: [...betas] }
}

export async function* parseSSE(body, pulse = () => {}, maxEventBytes = 16 * 1024 * 1024) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let line = ''
  let lineBytes = 0
  let data = []
  let size = 0
  let event = ''
  let afterCR = false
  const finishLine = () => {
    const current = line
    line = ''
    lineBytes = 0
    if (!current) {
      if (!data.length) { event = ''; size = 0; return }
      const payload = data.join('\n')
      data = []; size = 0
      const name = event; event = ''
      if (payload === '[DONE]') return { type: '__done' }
      try { return { event: name, ...JSON.parse(payload) } } catch { throw new RelayError('中转站返回了无效的 SSE JSON。', 'MALFORMED_RESPONSE') }
    }
    if (current.startsWith(':')) return
    const colon = current.indexOf(':')
    const field = colon === -1 ? current : current.slice(0, colon)
    const value = colon === -1 ? '' : current.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') { data.push(value); size += Buffer.byteLength(value); }
    else if (field === 'event') event = value
    if (size > maxEventBytes) throw new RelayError('中转站单个流事件过大。', 'MALFORMED_RESPONSE')
  }
  const consume = function* (text) {
    for (const char of text) {
      if (afterCR) { afterCR = false; if (char === '\n') continue }
      if (char === '\r' || char === '\n') {
        if (char === '\r') afterCR = true
        const item = finishLine()
        if (item) yield item
      } else {
        line += char
        lineBytes += Buffer.byteLength(char)
        if (lineBytes + size > maxEventBytes) throw new RelayError('中转站单个流事件过大。', 'MALFORMED_RESPONSE')
      }
    }
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      pulse()
      yield* consume(decoder.decode(chunk.value, { stream: true }))
    }
    yield* consume(decoder.decode())
    if (line) { const item = finishLine(); if (item) yield item }
    if (data.length) { const item = finishLine(); if (item) yield item }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function safeProviderMessage(value, apiKey) {
  const raw = typeof value === 'string' ? value : '中转请求失败。'
  return (apiKey ? raw.split(apiKey).join('[REDACTED]') : raw)
    .replace(/\b(?:sk-ant-|sk-)[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .slice(0, 2000)
}

export function providerFailure(status, raw, apiKey, headers = new Headers()) {
  let payload
  try { payload = JSON.parse(raw) } catch {}
  const detail = payload?.error?.message ?? payload?.message
  const text = safeProviderMessage(typeof detail === 'string' ? detail : `中转站返回 HTTP ${status}。`, apiKey)
  let code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
  if (/context.{0,30}(exceed|long)|prompt.{0,15}too long/i.test(text)) code = 'CONTEXT_WINDOW_EXCEEDED'
  if (/quota|余额不足|insufficient.*(credit|balance)|credit balance/i.test(text)) code = 'QUOTA'
  if (/claude code.{0,40}(only|client)|only.{0,30}claude.?code|仅.*(claude.?code|cc)|client.{0,15}(validation|anomal)/i.test(text)) code = 'CLIENT_RESTRICTED'
  const requestId = headers.get('request-id') ?? headers.get('x-request-id')
  const retry = headers.get('retry-after')
  const delay = retry === null ? NaN : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
  return new RelayError(text, code, { status, ...(requestId ? { requestId } : {}), ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}) })
}
