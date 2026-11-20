import { TaggedText } from './tagged-text.js'
import { decodeStructured } from './structured.js'

const DEFAULT_LIMIT = 2 * 1024 * 1024
function prefixMode(source) {
  const trimmed = source.trimStart()
  if (!trimmed) return 'wait'
  if (trimmed[0] === '{') return 'json'
  if (['data:', 'event:'].some(prefix => trimmed.startsWith(prefix))) return 'json'
  if (['data:', 'event:'].some(prefix => prefix.startsWith(trimmed))) return 'wait'
  return 'text'
}
const terminalFailure = signal => ({ type: 'finish', reason: { kind: signal?.aborted ? 'aborted' : 'error', failure: { code: signal?.aborted ? 'ABORTED' : 'STREAM_CLOSED', message: signal?.aborted ? '模型请求已取消。' : '模型流提前结束。' } } })
function closeBlock(index, block, observations, origin) {
  // Track out of band: no extra properties on provider or DSH stream records.
  if (observations && block.type === 'reasoning' && block.text?.trim()) observations.set(block, origin)
  return { type: 'block-end', index, block }
}

function* blockChunks(blocks, observations, origin) {
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else if (block.text) yield { type: block.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text }
    yield closeBlock(index, block, observations, origin)
  }
}

// Atomic JSON conversion: hold only responses whose leading text looks like a
// protocol envelope. Never combine it with an existing native tool/reasoning block.
async function* structuredStream(source, options, config, observations) {
  const limit = Number.isSafeInteger(config.maxStructuredChars) ? config.maxStructuredChars : DEFAULT_LIMIT
  let buffered = [], size = 0, passthrough = config.structuredJson === false, finish = false
  const texts = new Map()
  for await (const chunk of source) {
    if (chunk.type === 'usage') { yield chunk; continue }
    if (passthrough) { yield chunk; if (chunk.type === 'finish') { finish = true; break }; continue }
    buffered.push(chunk)
    if ('index' in chunk) {
      const isText = chunk.type === 'text-delta' || chunk.type === 'block-start' && chunk.blockType === 'text' || chunk.type === 'block-end' && chunk.block.type === 'text'
      if (!isText) passthrough = true
      else {
        if (!texts.has(chunk.index)) texts.set(chunk.index, { text: '', closed: false })
        const state = texts.get(chunk.index)
        if (chunk.type === 'text-delta' && !state.closed) { state.text += chunk.text; size += chunk.text.length }
        if (chunk.type === 'block-end' && !state.closed) {
          size += Math.max(0, chunk.block.text.length - state.text.length)
          state.text = chunk.block.text; state.closed = true
        }
        if (prefixMode([...texts.values()].map(item => item.text).join('')) === 'text') passthrough = true
      }
    }
    if (size > limit || buffered.length > 16384) passthrough = true
    if (chunk.type === 'finish') {
      finish = true
      const success = ['stop', 'tool-calls'].includes(chunk.reason.kind) && !options.signal?.aborted
      const raw = [...texts.values()].map(item => item.text).join('')
      const decoded = !passthrough && success ? decodeStructured(raw, options.tools ?? []) : undefined
      if (decoded && config.allowJsonToolCalls !== true) decoded.blocks = decoded.blocks.map(block => block.type === 'tool-call' ? { type: 'text', text: `工具请求（JSON 文本，未执行）：${block.name}\n${block.arguments}\n` } : block)
      if (decoded) {
        yield* blockChunks(decoded.blocks, observations, decoded.source)
        // The outer request owns billing. Inner agent logs must not add usage.
        for (const item of buffered) if (item.type === 'usage') yield item
        const reason = decoded.failure ? { kind: 'error', failure: { code: 'EXTERNAL_AGENT_ERROR', message: decoded.failure } } : decoded.finish ? { kind: decoded.finish } : decoded.blocks.some(block => block.type === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' }
        const { replayState: _nativeReplay, ...rest } = chunk
        yield { ...rest, reason }
      } else yield* buffered
      buffered = []
      break
    }
    if (passthrough) { yield* buffered; buffered = []; texts.clear() }
  }
  if (!finish) { yield* buffered; yield terminalFailure(options.signal) }
}

class TextState {
  constructor(output) {
    this.output = output
    this.lexer = new TaggedText((type, text) => this.emit(type, text))
    this.current = undefined
    this.segments = []
    this.received = ''
    this.closed = false
  }
  emit(type, text) {
    if (!text) return
    if (!this.current || this.current.type !== type) {
      this.closeSegment()
      this.current = { type, text: '', index: this.output.nextIndex++ }
      this.segments.push(this.current)
      this.output.queue.push({ type: 'block-start', index: this.current.index, blockType: type })
    }
    this.current.text += text
    this.output.queue.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: this.current.index, text })
  }
  beginPlain() {
    this.lexer.finish()
    this.lexer.leading = false
    if (!this.segments.length) {
      this.current = { type: 'text', text: '', index: this.output.nextIndex++ }
      this.segments.push(this.current)
      this.output.queue.push({ type: 'block-start', index: this.current.index, blockType: 'text' })
    }
  }
  closeSegment() {
    if (!this.current) return
    const { type, text, index } = this.current
    this.output.queue.push(closeBlock(index, { type, text }, this.output.observations, 'tags'))
    this.current = undefined
  }
  feed(text) { this.received += text; this.lexer.push(text) }
  end(authoritative) {
    if (this.closed) return
    if (typeof authoritative === 'string') {
      if (authoritative.startsWith(this.received)) this.feed(authoritative.slice(this.received.length))
      else if (!this.lexer.converted) {
        // A native adapter may repair its final text. Keep its authoritative end.
        this.lexer.finish()
        if (!this.current) this.emit('text', this.received)
        if (this.current) this.current.text = authoritative
      } else this.output.invalid = true
    }
    this.lexer.finish()
    if (!this.segments.length) {
      const index = this.output.nextIndex++
      this.segments.push({ index, type: 'text', text: '' })
      this.output.queue.push({ type: 'block-start', index, blockType: 'text' }, { type: 'block-end', index, block: { type: 'text', text: '' } })
    }
    this.closeSegment()
    this.closed = true
    this.output.changed ||= this.lexer.converted
  }
}

async function* taggedStream(source, config, observations) {
  if (config.reasoningTags === false) { yield* source; return }
  const output = { nextIndex: 0, queue: [], changed: false, invalid: false, observations }
  const states = new Map()
  const flush = function* () { yield* output.queue; output.queue.length = 0 }
  const getText = index => {
    if (!states.has(index)) {
      for (const state of states.values()) if (state instanceof TextState && !state.closed && !state.segments.length) state.beginPlain()
      states.set(index, new TextState(output))
    }
    return states.get(index)
  }
  const native = index => {
    if (!states.has(index)) states.set(index, { index: output.nextIndex++ })
    return states.get(index)
  }
  for await (const chunk of source) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') { getText(chunk.index); yield* flush() }
    else if (chunk.type === 'text-delta') { const state = getText(chunk.index); if (!state.closed) state.feed(chunk.text); yield* flush() }
    else if (chunk.type === 'block-end' && chunk.block.type === 'text') { getText(chunk.index).end(chunk.block.text); yield* flush() }
    else if (chunk.type === 'finish') {
      for (const state of states.values()) if (state instanceof TextState) state.end()
      yield* flush()
      const reason = output.invalid && ['stop', 'tool-calls'].includes(chunk.reason.kind) ? { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: '模型流的最终文本与增量不一致。' } } : chunk.reason
      if (output.changed || output.invalid) { const { replayState: _nativeReplay, ...rest } = chunk; yield { ...rest, reason } }
      else yield chunk
    } else if ('index' in chunk) {
      // Flush a pending leading tag prefix before another block enters the log,
      // preserving the original relative order for unusual interleaved streams.
      for (const state of states.values()) if (state instanceof TextState && !state.closed && !state.segments.length) state.beginPlain()
      yield* flush()
      const state = native(chunk.index)
      yield { ...chunk, index: state.index }
    } else yield chunk
  }
}

// Standard providers normally close one block before starting the next. Queue
// interleaved later blocks until their predecessors close so expanded reasoning
// segments keep the original block order, including replay array positions.
async function* orderedStream(source, config) {
  const order = [], groups = new Map()
  const limit = config.maxStructuredChars ?? DEFAULT_LIMIT
  let bytes = 0
  const emitReady = function* () {
    while (order.length) {
      const group = groups.get(order[0])
      for (const chunk of group.queue) { bytes -= chunk.text?.length ?? chunk.block?.text?.length ?? chunk.argumentsDelta?.length ?? 0; yield chunk }
      group.queue.length = 0
      if (!group.closed) break
      groups.delete(order.shift())
    }
  }
  for await (const chunk of source) {
    if (!('index' in chunk)) {
      if (chunk.type === 'finish') {
        for (const group of groups.values()) group.closed = true
        yield* emitReady()
      }
      yield chunk
      continue
    }
    if (!groups.has(chunk.index)) { groups.set(chunk.index, { queue: [], closed: false }); order.push(chunk.index) }
    const group = groups.get(chunk.index)
    group.queue.push(chunk)
    bytes += chunk.text?.length ?? chunk.block?.text?.length ?? chunk.argumentsDelta?.length ?? 0
    if (chunk.type === 'block-end') group.closed = true
    yield* emitReady()
    if (bytes > limit || groups.size > 4096) {
      // Only later blocks blocked behind an open predecessor consume this budget.
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: '交错模型流的等待内容超出兼容缓冲上限。' } } }
      return
    }
  }
}

async function* observeConversions(source, observations, onConversion) {
  for await (const chunk of source) {
    if (chunk.type === 'block-end' && observations.has(chunk.block)) {
      const origin = observations.get(chunk.block)
      observations.delete(chunk.block)
      // Statistics must never change or fail the model stream.
      try { onConversion(origin) } catch {}
    }
    yield chunk
  }
}

// One invocation of the original adapter; no sockets, credentials or tool execution.
export function normalizeStream(source, options = {}, config = {}) {
  const observer = config.onReasoningConversion
  const observations = typeof observer === 'function' ? new WeakMap() : undefined
  const stream = taggedStream(structuredStream(orderedStream(source, config), options, config, observations), config, observations)
  return observations ? observeConversions(stream, observations, observer) : stream
}
