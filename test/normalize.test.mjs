import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStream } from '../lib/normalize.js'
import { decodeStructured } from '../lib/structured.js'
import { resolveTool } from '../lib/tools.js'

const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const source = async function* (chunks) { yield* chunks }
const finish = reason => ({ type: 'finish', reason: typeof reason === 'string' ? { kind: reason } : reason })
const read = { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const bash = { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command', 'description'], additionalProperties: false } }
const request = { tools: [read, bash] }
const replay = { response: { kind: 'test' }, blocks: [{ signature: 'opaque' }] }
const wire = (text, width = 7, reason = 'stop', nativeReplay = replay) => {
  const result = [{ type: 'block-start', index: 9, blockType: 'text' }]
  for (let start = 0; start < text.length; start += width) result.push({ type: 'text-delta', index: 9, text: text.slice(start, start + width) })
  result.push({ type: 'block-end', index: 9, block: { type: 'text', text } }, { ...finish(reason), replayState: nativeReplay })
  return result
}
const blocks = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
const textOf = chunks => blocks(chunks).filter(block => block.type === 'text').map(block => block.text).join('')
const toolsOf = chunks => blocks(chunks).filter(block => block.type === 'tool-call')
const run = (text, config = {}, options = request, reason = 'stop', width = 7) => collect(normalizeStream(source(wire(text, width, reason)), options, config))
const message = content => ({ id: 'msg_fixture', type: 'message', role: 'assistant', content, stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' })
const toolMessage = () => message([{ type: 'tool_use', id: 'call_fixture', name: 'Read', input: { file_path: 'sample.txt' } }])
const response = output => ({ id: 'resp_fixture', object: 'response', status: 'completed', output })
const item = value => ({ id: 'msg_out', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value }] })
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n')

test('leading reasoning wrappers survive every character boundary', async () => {
  for (const tag of ['thinking', 'think', 'analysis', 'reasoning']) {
    const input = `<${tag}>检查内容。\n完成。</${tag}>最终回答 ✅`
    for (const width of [1, 2, 5, 64]) {
      const output = await run(input, {}, request, 'stop', width)
      assert.deepEqual(blocks(output), [{ type: 'reasoning', text: '检查内容。\n完成。' }, { type: 'text', text: '最终回答 ✅' }])
      assert.equal(output.at(-1).replayState, undefined)
    }
  }
})

test('literal tags in prose, code, quotes and partial prefixes remain text', async () => {
  for (const input of ['示例：<thinking>不要转换</thinking>', '`<think>code</think>`', '```json\n{"type":"thinking"}\n```', '> <think>quote</think>', '<thi', ' data science']) {
    const output = await run(input, {}, request, 'stop', 1)
    assert.equal(textOf(output), input)
    assert.deepEqual(output.at(-1).replayState, replay)
  }
})

test('unclosed wrapper remains reasoning and subsequent text is not invented', async () => {
  const output = await run('<think>partial')
  assert.deepEqual(blocks(output), [{ type: 'reasoning', text: 'partial' }])
})

test('ordinary JSON, invalid shapes, arrays and fenced protocol examples stay unchanged', async () => {
  for (const input of ['{"hello":1}', '[{"type":"text","text":"value"}]', JSON.stringify({ object: 'response', id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [null] }] }), '```json\n' + JSON.stringify(toolMessage()) + '\n```', JSON.stringify({ type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', output: null } })]) {
    const output = await run(input)
    assert.equal(textOf(output), input)
    assert.equal(toolsOf(output).length, 0)
  }
})

test('Anthropic message JSON translates reasoning and text without importing inner billing', async () => {
  const payload = message([{ type: 'thinking', thinking: 'brief' }, { type: 'text', text: 'answer' }])
  payload.usage = { input_tokens: 9000, output_tokens: 999 }
  const chunks = wire(JSON.stringify(payload))
  chunks.splice(-1, 0, { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } })
  const output = await collect(normalizeStream(source(chunks), request))
  assert.deepEqual(blocks(output), [{ type: 'reasoning', text: 'brief' }, { type: 'text', text: 'answer' }])
  assert.deepEqual(output.filter(chunk => chunk.type === 'usage'), [{ type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }])
  assert.equal(output.at(-1).replayState, undefined)
})

test('JSON tool requests display by default and become real declared calls only with global opt-in', async () => {
  const payload = JSON.stringify(toolMessage())
  const shown = await run(payload)
  assert.equal(toolsOf(shown).length, 0)
  assert.match(textOf(shown), /未执行/)
  assert.equal(shown.at(-1).reason.kind, 'stop')
  const enabled = await run(payload, { allowJsonToolCalls: true })
  assert.deepEqual(toolsOf(enabled), [{ type: 'tool-call', id: 'call_fixture', name: 'read', arguments: '{"file_path":"sample.txt"}' }])
  assert.equal(enabled.at(-1).reason.kind, 'tool-calls')
})

test('undeclared tools, unsupported arguments, invalid JSON and duplicate IDs never dispatch', async () => {
  const calls = [
    { type: 'tool_use', id: 'c', name: 'not_declared', input: {} },
    { type: 'tool_use', id: 'c', name: 'Read', input: { file_path: 'x', pages: '1-3' } },
    { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'printf fixture', dangerouslyDisableSandbox: true } },
    { type: 'tool_use', id: 'c', name: 'Agent', input: { prompt: 'x' } },
    { type: 'tool_use', id: 'c', name: 'read', input: null },
  ]
  for (const call of calls) assert.equal(toolsOf(await run(JSON.stringify(message([call])), { allowJsonToolCalls: true })).length, 0)
  assert.equal(toolsOf(await run(JSON.stringify(message([toolMessage().content[0], toolMessage().content[0]])), { allowJsonToolCalls: true })).length, 0)
})

test('Responses completed output and SSE terminal translate once', async () => {
  const complete = response([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] }, item('done'), { id: 'fc', type: 'function_call', status: 'completed', call_id: 'call_r', name: 'read', arguments: '{"file_path":"x"}' }])
  const records = [{ type: 'response.created', response: { id: complete.id } }, { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'do' }, { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'done' }, { type: 'response.completed', response: complete }]
  for (const payload of [JSON.stringify(complete), records.map(record => `event: ${record.type}\r\ndata: ${JSON.stringify(record)}\r\n\r\n`).join('')]) {
    const output = await run(payload, { allowJsonToolCalls: true })
    assert.deepEqual(blocks(output).slice(0, 2), [{ type: 'reasoning', text: 'summary' }, { type: 'text', text: 'done' }])
    assert.equal(toolsOf(output).length, 1)
  }
})

test('Responses missing completion evidence and multiple responses remain plain JSON', async () => {
  const first = response([{ id: 'fc', type: 'function_call', status: 'completed', call_id: 'c', name: 'read', arguments: '{"file_path":"x"}' }])
  const invalid = [{ ...first, status: undefined }, { ...first, output: [{ ...first.output[0], status: undefined }] }]
  for (const value of invalid) assert.equal(toolsOf(await run(JSON.stringify(value), { allowJsonToolCalls: true })).length, 0)
  const payload = jsonl([{ type: 'response.completed', response: first }, { type: 'response.completed', response: { ...response([item('already done')]), id: 'r2' } }])
  assert.equal(textOf(await run(payload, { allowJsonToolCalls: true })), payload)
})

test('Responses partial display is ordered by output index and does not lose separate done items', async () => {
  const payload = jsonl([{ type: 'response.output_item.done', output_index: 1, item: item('B') }, { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'A' }])
  assert.deepEqual(blocks(await run(payload)), [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }])
})

test('Claude Code observations are readable, retain final result, and never execute tools', async () => {
  const payload = jsonl([{ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'working' }, { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'printf fixture' } }] } }, { type: 'result', subtype: 'success', result: 'FINAL' }])
  const output = await run(payload, { allowJsonToolCalls: true })
  assert.equal(toolsOf(output).length, 0)
  assert.match(textOf(output), /工具记录/)
  assert.match(textOf(output), /FINAL/)
})

test('Claude Code partial stream and assistant snapshots do not duplicate text', async () => {
  const records = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'other' }] } },
    { type: 'result', subtype: 'success', result: 'other' },
  ]
  assert.equal(textOf(await run(jsonl(records))), 'helloother')
})

test('Codex commands, declined calls and nested JSON answers are observations only', async () => {
  const nested = JSON.stringify(toolMessage())
  const payload = jsonl([{ type: 'thread.started', thread_id: 'thread' }, { type: 'turn.started' }, { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'printf fixture' } }, { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'printf fixture', aggregated_output: '', exit_code: null, status: 'declined' } }, { type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'summary' } }, { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: nested } }, { type: 'turn.completed' }])
  const output = await run(payload, { allowJsonToolCalls: true })
  assert.equal(toolsOf(output).length, 0)
  assert.match(textOf(output), /declined/)
  assert.ok(textOf(output).includes(nested))
})

test('outer errors, truncation and cancellation override inner successful tool JSON', async () => {
  for (const reason of [{ kind: 'max-tokens' }, { kind: 'error', failure: { code: 'AUTH', message: 'fixture' } }, { kind: 'aborted', failure: { code: 'ABORTED', message: 'fixture' } }]) {
    const output = await run(JSON.stringify(toolMessage()), { allowJsonToolCalls: true }, request, reason)
    assert.deepEqual(output.at(-1).reason, reason)
    assert.equal(toolsOf(output).length, 0)
  }
})

test('inner max_tokens and length retain truncation semantics', async () => {
  for (const payload of [{ ...message([{ type: 'text', text: 'cut' }]), stop_reason: 'max_tokens' }, { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }] }]) assert.equal((await run(JSON.stringify(payload))).at(-1).reason.kind, 'max-tokens')
})

test('interleaved blocks retain order and translated replay is removed', async () => {
  const chunks = [
    { type: 'block-start', index: 10, blockType: 'text' },
    { type: 'text-delta', index: 10, text: '<think>A' },
    { type: 'block-start', index: 70, blockType: 'text' },
    { type: 'text-delta', index: 70, text: 'B' },
    { type: 'text-delta', index: 10, text: '</think>C' },
    { type: 'block-end', index: 10, block: { type: 'text', text: '<think>A</think>C' } },
    { type: 'block-end', index: 70, block: { type: 'text', text: 'B' } },
    { ...finish('stop'), replayState: { response: {}, blocks: [{ signature: 'A' }, { signature: 'B' }] } },
  ]
  const output = await collect(normalizeStream(source(chunks), request))
  assert.deepEqual(blocks(output), [{ type: 'reasoning', text: 'A' }, { type: 'text', text: 'C' }, { type: 'text', text: 'B' }])
  assert.equal(output.at(-1).replayState, undefined)
})

test('plain interleaved blocks preserve signed replay positions', async () => {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: 'B' }, { type: 'text-delta', index: 0, text: 'A' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'A' } }, { type: 'block-end', index: 1, block: { type: 'text', text: 'B' } }, { ...finish('stop'), replayState: { response: {}, blocks: [{ signature: 'A' }, { signature: 'B' }] } }]
  const output = await collect(normalizeStream(source(chunks)))
  assert.deepEqual(blocks(output), [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }])
  assert.deepEqual(output.at(-1).replayState, chunks.at(-1).replayState)
})

test('buffer limits keep ordinary long output and oversized JSON intact', async () => {
  for (const value of ['x'.repeat(10000), JSON.stringify({ large: 'x'.repeat(10000) })]) {
    const output = await run(value, { maxStructuredChars: 1024 }, request, 'stop', 16384)
    assert.equal(textOf(output), value)
    assert.equal(output.at(-1).reason.kind, 'stop')
  }
})

test('usage arrives immediately before a buffered response is cancelled', async () => {
  let released
  const waiting = new Promise(resolve => { released = resolve })
  const upstream = async function* () { yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }; yield { type: 'text-delta', index: 0, text: '{' }; await waiting; yield finish({ kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } }) }
  const iterator = normalizeStream(upstream(), request)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'usage')
  released()
  const remainder = await collect(iterator)
  assert.equal(remainder.at(-1).reason.kind, 'aborted')
})

test('consumer return closes original iterator once, and missing finish is an error', async () => {
  let closed = 0
  const upstream = async function* () { try { yield { type: 'text-delta', index: 0, text: 'hello' }; yield finish('stop') } finally { closed++ } }
  for await (const chunk of normalizeStream(upstream())) { if (chunk.type === 'text-delta') break }
  assert.equal(closed, 1)
  const output = await collect(normalizeStream(source([{ type: 'text-delta', index: 0, text: 'lost connection' }])))
  assert.equal(output.at(-1).reason.failure.code, 'STREAM_CLOSED')
})

test('original reasoning, tool IDs, arguments and usage survive alongside normal text', async () => {
  const tool = { type: 'tool-call', id: 'c_native', name: 'read', arguments: '{"file_path":"x"}' }
  const chunks = [{ type: 'block-start', index: 3, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 3, text: 'native' }, { type: 'block-end', index: 3, block: { type: 'reasoning', text: 'native' } }, { type: 'block-start', index: 10, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 10, id: tool.id, name: tool.name, argumentsDelta: tool.arguments }, { type: 'block-end', index: 10, block: tool }, { ...finish('tool-calls'), replayState: replay }]
  const output = await collect(normalizeStream(source(chunks), request))
  assert.deepEqual(blocks(output), [{ type: 'reasoning', text: 'native' }, tool])
  assert.deepEqual(output.at(-1).replayState, replay)
})

test('tool aliases preserve unsupported fields as invalid, and do not map Agent or session tools', () => {
  assert.equal(resolveTool({ id: 'x', name: 'functions.exec_command', arguments: { cmd: 'printf fixture', yield_time_ms: 100 } }, [bash]), undefined)
  assert.equal(resolveTool({ id: 'x', name: 'Agent', arguments: { prompt: 'x' } }, [{ name: 'subagent', parameters: { type: 'object' } }]), undefined)
  assert.equal(resolveTool({ id: 'x', name: 'read', arguments: '[]' }, [read]), undefined)
  assert.equal(decodeStructured('{"type":"unknown"}'), undefined)
})
