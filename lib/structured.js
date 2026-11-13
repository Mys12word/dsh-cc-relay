import { resolveTool } from './tools.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, type = 'text') => typeof value === 'string' && value ? [{ type, text: value }] : []
const log = value => [{ type: 'text', text: value }]
const valid = value => typeof value === 'string' && value.length > 0

function parseRecords(source) {
  try { return [JSON.parse(source)] } catch {}
  const lines = source.split(/\r?\n/).filter(line => line.trim())
  if (!lines.length) return undefined
  try {
    if (lines.some(line => line.startsWith('data:') || line.startsWith('event:'))) {
      const records = []
      for (const frame of source.split(/\r?\n\r?\n/)) {
        const data = []
        for (const line of frame.split(/\r?\n/)) {
          if (!line.trim() || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) continue
          if (!line.startsWith('data:')) return undefined
          data.push(line.slice(5).trimStart())
        }
        if (!data.length) continue
        const value = data.join('\n')
        if (value !== '[DONE]') records.push(JSON.parse(value))
      }
      return records.length ? records : undefined
    }
    return lines.map(line => JSON.parse(line))
  } catch { return undefined }
}

function anthropicContent(content, tools, observational = false) {
  if (!Array.isArray(content)) return undefined
  const blocks = []
  for (const block of content) {
    if (!object(block)) return undefined
    if (block.type === 'text' && typeof block.text === 'string') blocks.push(...text(block.text))
    else if (block.type === 'thinking' && typeof block.thinking === 'string') blocks.push(...text(block.thinking, 'reasoning'))
    else if (block.type === 'redacted_thinking') continue
    else if (block.type === 'tool_use') {
      if (observational) blocks.push(...log(`工具记录（外部客户端）：${block.name ?? 'unknown'}\n`))
      else {
        const tool = resolveTool({ id: block.id, name: block.name, arguments: block.input }, tools)
        if (!tool) return undefined
        blocks.push(tool)
      }
    } else return undefined
  }
  return blocks
}

function responseContent(items, tools) {
  if (!Array.isArray(items)) return undefined
  const blocks = []
  for (const item of items) {
    if (!object(item)) return undefined
    if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') blocks.push(...text(part.text))
        else if (part.type === 'refusal' && typeof part.refusal === 'string') blocks.push(...text(part.refusal))
        else return undefined
      }
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      if (item.summary.some(part => part.type !== 'summary_text' || typeof part.text !== 'string')) return undefined
      blocks.push(...text(item.summary.map(part => part.text).join('\n'), 'reasoning'))
    } else if (item.type === 'function_call') {
      if (item.status !== 'completed' || !valid(item.id)) return undefined
      const tool = resolveTool({ id: item.call_id, name: item.name, arguments: item.arguments }, tools)
      if (!tool) return undefined
      blocks.push(tool)
    } else return undefined
  }
  return blocks
}

function completedResponse(response, tools) {
  if (!object(response) || !valid(response.id) || !['response', undefined].includes(response.object)) return undefined
  if (['failed', 'cancelled', 'incomplete'].includes(response.status)) return { blocks: [], failure: '外部模型响应未完整结束。' }
  if (response.status !== 'completed') return undefined
  const blocks = responseContent(response.output, tools)
  return blocks && { blocks }
}

function claudeRecords(records) {
  const blocks = [], seen = new Set(), stream = new Map()
  const streamedMessages = new Set(records.filter(record => record.type === 'stream_event' && record.event?.type === 'message_start').map(record => record.event.message?.id).filter(Boolean))
  let observed = false, streaming = false, complete = false
  const append = (key, value) => { if (!seen.has(key)) { blocks.push(...value); seen.add(key) } }
  for (const record of records) {
    if (!object(record)) return undefined
    if (record.type === 'system' && valid(record.subtype)) { observed = true; continue }
    if (record.type === 'stream_event' && object(record.event)) {
      observed = true; streaming = true
      const event = record.event
      if (event.type === 'message_start') { stream.clear(); continue }
      if (event.type === 'content_block_start') {
        const b = event.content_block
        if (!object(b) || !Number.isSafeInteger(event.index) || stream.has(event.index)) return undefined
        stream.set(event.index, { ...b, text: b.text ?? '', thinking: b.thinking ?? '' })
      } else if (event.type === 'content_block_delta') {
        const b = stream.get(event.index), d = event.delta
        if (!b || !object(d)) return undefined
        if (d.type === 'text_delta' && typeof d.text === 'string') b.text += d.text
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') b.thinking += d.thinking
        else if (!['signature_delta', 'input_json_delta'].includes(d.type)) return undefined
      } else if (event.type === 'content_block_stop') {
        const b = stream.get(event.index)
        if (!b) return undefined
        const result = anthropicContent([b], [], true)
        if (!result) return undefined
        blocks.push(...result); stream.delete(event.index)
      } else if (event.type === 'message_stop') complete = true
      else if (!['message_delta', 'ping'].includes(event.type)) return undefined
    } else if (record.type === 'assistant' && record.message?.role === 'assistant') {
      observed = true
      // SDK partial streams and assistant envelopes describe the same output.
      if (streamedMessages.has(record.message.id) || streaming && !streamedMessages.size) continue
      const result = anthropicContent(record.message.content, [], true)
      if (!result) return undefined
      append(record.uuid ?? JSON.stringify(record.message), result)
      complete = true
    } else if (record.type === 'user' && Array.isArray(record.message?.content)) {
      observed = true
      if (record.message.content.some(item => item.type !== 'tool_result')) return undefined
      for (const item of record.message.content) {
        const body = typeof item.content === 'string' ? item.content : Array.isArray(item.content) && item.content.every(part => part.type === 'text') ? item.content.map(part => part.text).join('\n') : ''
        blocks.push(...log(`工具结果（外部客户端）${item.is_error ? '：失败' : ''}\n${body}\n`))
      }
    } else if (record.type === 'result' && valid(record.subtype)) {
      observed = true; complete = true
      if (record.is_error || record.subtype !== 'success') return { blocks, failure: '外部 Claude Code 运行失败。' }
      if (typeof record.result === 'string' && !blocks.some(block => block.type === 'text' && block.text === record.result)) blocks.push(...text(record.result))
      if (record.structured_output !== undefined) blocks.push(...text(JSON.stringify(record.structured_output, null, 2)))
    } else return undefined
  }
  return observed && complete && !stream.size ? { blocks } : undefined
}

function codexRecords(records) {
  const blocks = [], seen = new Set()
  let recognized = false
  for (const record of records) {
    if (!object(record)) return undefined
    if (['thread.started', 'turn.started'].includes(record.type)) { recognized = true; continue }
    if (record.type === 'turn.failed' || record.type === 'error') return { blocks, failure: '外部 Codex 运行失败。' }
    if (record.type === 'turn.completed') { recognized = true; continue }
    if (!['item.started', 'item.updated', 'item.completed'].includes(record.type) || !object(record.item)) return undefined
    const item = record.item
    if (!valid(item.id) || !valid(item.type)) return undefined
    recognized = true
    if (record.type !== 'item.completed' || seen.has(item.id)) continue
    seen.add(item.id)
    if (item.type === 'agent_message' && typeof item.text === 'string') blocks.push(...text(item.text))
    else if (item.type === 'reasoning' && typeof item.text === 'string') blocks.push(...text(item.text, 'reasoning'))
    else if (item.type === 'command_execution' && typeof item.command === 'string') {
      blocks.push(...log(`命令记录（外部客户端，${item.status ?? 'completed'}，退出码 ${item.exit_code ?? '未知'}）\n${item.command}\n${item.aggregated_output ?? ''}\n`))
    } else if (['file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'todo_list', 'error'].includes(item.type)) {
      blocks.push(...log(`外部客户端记录：${item.type}\n${JSON.stringify(item)}\n`))
    } else return undefined
  }
  return recognized && blocks.length ? { blocks } : undefined
}

function responsesRecords(records, tools) {
  const deltas = new Map(), complete = new Map()
  let recognized = false, ended = false
  const keyOf = event => `${event.output_index ?? 0}:${event.content_index ?? event.summary_index ?? 0}`
  const terminals = records.filter(record => ['response.completed', 'response.done', 'response.failed', 'response.incomplete'].includes(record?.type))
  if (terminals.length > 1 || terminals.length === 1 && records.at(-1) !== terminals[0]) return undefined
  const ids = new Set(records.map(record => record.response?.id).filter(Boolean))
  if (ids.size > 1) return undefined
  for (const record of records) {
    if (!object(record) || typeof record.type !== 'string' || !record.type.startsWith('response.')) return undefined
    recognized = true
    if (['response.completed', 'response.done'].includes(record.type)) return completedResponse(record.response, tools)
    if (['response.failed', 'response.incomplete'].includes(record.type)) return { blocks: [], failure: '外部模型响应未完整结束。' }
    if (record.type === 'response.output_item.done') {
      const result = responseContent([record.item], tools)
      if (!result) return undefined
      complete.set(record.output_index ?? complete.size, result); ended = true
    } else if (record.type === 'response.output_text.delta' || record.type === 'response.reasoning_summary_text.delta') {
      if (typeof record.delta !== 'string') return undefined
      const key = keyOf(record), previous = deltas.get(key)
      deltas.set(key, { type: record.type.includes('reasoning') ? 'reasoning' : 'text', text: (previous?.text ?? '') + record.delta })
    } else if (record.type === 'response.output_text.done' || record.type === 'response.reasoning_summary_text.done') {
      if (typeof record.text !== 'string') return undefined
      deltas.set(keyOf(record), { type: record.type.includes('reasoning') ? 'reasoning' : 'text', text: record.text }); ended = true
    } else if (!['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done'].includes(record.type)) return undefined
  }
  // A bare done event can display text. A tool call needs a completed response.
  const entries = [...complete.entries()].map(([index, blocks]) => ({ index, sub: 0, blocks }))
  for (const [key, block] of deltas) {
    const [index, sub] = key.split(':').map(Number)
    if (!complete.has(index)) entries.push({ index, sub, blocks: [block] })
  }
  const blocks = entries.sort((a, b) => a.index - b.index || a.sub - b.sub).flatMap(entry => entry.blocks)
  if (blocks.some(block => block.type === 'tool-call')) return undefined
  return recognized && ended && blocks.length ? { blocks } : undefined
}

function anthropicStream(records, tools) {
  const states = new Map(), content = []
  let started = false, ended = false, stop
  for (const event of records) {
    if (!object(event)) return undefined
    if (event.type === 'ping') continue
    if (event.type === 'error') return { blocks: [], failure: '外部 Anthropic 响应失败。' }
    if (event.type === 'message_start') { if (started) return undefined; started = true }
    else if (event.type === 'content_block_start') {
      if (!started || !Number.isSafeInteger(event.index) || states.has(event.index) || !object(event.content_block)) return undefined
      states.set(event.index, { ...event.content_block, json: '', text: event.content_block.text ?? '', thinking: event.content_block.thinking ?? '' })
    } else if (event.type === 'content_block_delta') {
      const state = states.get(event.index), delta = event.delta
      if (!state || state.closed || !object(delta)) return undefined
      if (delta.type === 'text_delta' && state.type === 'text' && typeof delta.text === 'string') state.text += delta.text
      else if (delta.type === 'thinking_delta' && state.type === 'thinking' && typeof delta.thinking === 'string') state.thinking += delta.thinking
      else if (delta.type === 'input_json_delta' && state.type === 'tool_use' && typeof delta.partial_json === 'string') state.json += delta.partial_json
      else if (delta.type !== 'signature_delta') return undefined
    } else if (event.type === 'content_block_stop') {
      const state = states.get(event.index)
      if (!state || state.closed) return undefined
      state.closed = true
      if (state.type === 'tool_use' && state.json) { try { state.input = JSON.parse(state.json) } catch { return undefined } }
      content.push(state)
    } else if (event.type === 'message_delta') stop = event.delta?.stop_reason ?? stop
    else if (event.type === 'message_stop') ended = true
    else return undefined
  }
  if (!started || !ended || [...states.values()].some(state => !state.closed)) return undefined
  if (!['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(stop)) return undefined
  const blocks = anthropicContent(content, tools)
  if (!blocks || blocks.some(block => block.type === 'tool-call') && stop !== 'tool_use') return undefined
  return { blocks: stop === 'max_tokens' ? blocks.filter(block => block.type !== 'tool-call') : blocks, finish: stop === 'max_tokens' ? 'max-tokens' : undefined }
}

function chatRecords(records, tools) {
  const output = [], calls = new Map()
  let full = false, stop
  for (const record of records) {
    if (!object(record) || !['chat.completion', 'chat.completion.chunk'].includes(record.object) || !Array.isArray(record.choices)) return undefined
    if (!record.choices.length) continue
    if (record.choices.length !== 1 || (record.choices[0].index ?? 0) !== 0) return undefined
    const choice = record.choices[0], message = choice.message ?? choice.delta
    if (!object(message) || message.role && message.role !== 'assistant') return undefined
    if (message.content != null && typeof message.content !== 'string') return undefined
    output.push(...text(message.reasoning_content ?? message.reasoning, 'reasoning'), ...text(message.content))
    for (const call of message.tool_calls ?? []) {
      if (call.type && call.type !== 'function') return undefined
      const key = call.index ?? calls.size
      const state = calls.get(key) ?? { id: '', name: '', arguments: '' }
      if (call.id) state.id = call.id
      if (call.function?.name) state.name += call.function.name
      if (call.function?.arguments) state.arguments += call.function.arguments
      calls.set(key, state)
    }
    stop = choice.finish_reason ?? stop
    full ||= record.object === 'chat.completion'
  }
  if (!full && !stop) return undefined
  if (calls.size && stop !== 'tool_calls') return undefined
  for (const call of calls.values()) { const tool = resolveTool(call, tools); if (!tool) return undefined; output.push(tool) }
  return { blocks: output, finish: stop === 'length' ? 'max-tokens' : undefined }
}

// Only complete, unquoted protocol envelopes qualify. Unknown JSON and Markdown
// examples are returned unchanged by the caller. No metadata mutates credentials.
function decode(source, tools = []) {
  const records = parseRecords(source.trim())
  if (!records?.length || !records.every(object)) return undefined
  const first = records[0]
  let result
  if (records.length === 1 && first.type === 'message' && first.role === 'assistant' && valid(first.id) && ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(first.stop_reason)) {
    const blocks = anthropicContent(first.content, tools)
    if (blocks) {
      if (blocks.some(block => block.type === 'tool-call') && first.stop_reason !== 'tool_use') return undefined
      result = { blocks, finish: first.stop_reason === 'max_tokens' ? 'max-tokens' : undefined }
    }
  } else if (records.length === 1 && (first.object === 'response' || first.type === 'response')) result = completedResponse(first, tools)
  else if (['system', 'assistant', 'stream_event', 'user', 'result'].includes(first.type)) result = claudeRecords(records)
  else if (['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed', 'turn.failed'].includes(first.type)) result = codexRecords(records)
  else if (first.type?.startsWith('response.')) result = responsesRecords(records, tools)
  else if (['message_start', 'content_block_start', 'ping'].includes(first.type)) result = anthropicStream(records, tools)
  else if (['chat.completion', 'chat.completion.chunk'].includes(first.object)) result = chatRecords(records, tools)
  if (!result || !result.failure && !result.blocks.length) return undefined
  // Duplicate IDs make the complete envelope ambiguous. Never replay either call.
  const ids = new Set()
  for (const block of result.blocks) if (block.type === 'tool-call') {
    if (ids.has(block.id)) return undefined
    ids.add(block.id)
  }
  return result
}

export function decodeStructured(source, tools = []) {
  try { return decode(source, tools) } catch { return undefined }
}
