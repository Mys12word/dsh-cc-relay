import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const pluginRoot = process.env.CC_TEST_PLUGIN_ROOT
  ? pathToFileURL(resolve(process.env.CC_TEST_PLUGIN_ROOT) + '/')
  : new URL('../', import.meta.url)
const { Config, apply } = await import(new URL('index.js', pluginRoot))
const { normalizeStream } = await import(new URL('lib/normalize.js', pluginRoot))
const { STATS_ROUTE } = await import(new URL('lib/stats.js', pluginRoot))

const finish = (kind = 'stop', extra = {}) => ({ type: 'finish', reason: { kind }, ...extra })
function textChunks(text, { split = false, terminal = finish() } = {}) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...(split ? [...text] : [text]).map(text => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(terminal ? [terminal] : []),
  ]
}
async function* stream(chunks) { yield* chunks }
async function collect(source) { const chunks = []; for await (const chunk of source) chunks.push(chunk); return chunks }
function assembled(chunks) {
  const a = new BlockAssembler()
  for (const chunk of chunks) a.push(chunk)
  return a
}
async function convert(text, config = {}, options = {}) {
  return assembled(await collect(normalizeStream(stream(textChunks(text)), options, config)))
}
const tool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } }
const toolEnvelope = (name = tool.name, args = { path: 'README.md' }) => JSON.stringify({
  id: 'chat-compat', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
})

// These checks exercise the installed BlockAssembler, not a duplicate assembler.
test('volatile config defaults and range validation work in the selected Schemastery', () => {
  const config = Config({})
  assert.equal(config.allowJsonToolCalls.get(), false)
  assert.equal(config.maxStructuredChars.get(), 2097152)
  assert.throws(() => Config({ maxStructuredChars: 100 }))
})

test('ordinary text and literal tag examples are preserved', async () => {
  for (const text of ['plain answer', 'Example: <thinking>literal</thinking>', '`<thinking>code</thinking>`', '```xml\n<thinking>code</thinking>\n```']) {
    assert.deepEqual((await convert(text)).blocks(), [{ type: 'text', text }])
  }
})

test('all four reasoning tags survive every-character chunk boundaries', async () => {
  for (const tag of ['thinking', 'think', 'analysis', 'reasoning']) {
    const chunks = await collect(normalizeStream(stream(textChunks(`<${tag}>reason</${tag}>answer`, { split: true }))))
    assert.deepEqual(assembled(chunks).blocks(), [{ type: 'reasoning', text: 'reason' }, { type: 'text', text: 'answer' }])
    assert.equal(chunks.filter(x => x.type === 'finish').length, 1)
  }
})

test('native reasoning, tool calls, usage and signed replay pass through', async () => {
  const usage = { inputTokens: 7, outputTokens: 3 }
  const call = { type: 'tool-call', id: 'native-call', name: tool.name, arguments: '{"path":"a"}' }
  const replayState = { response: { signature: 'test-only' }, blocks: [{ opaque: 1 }, { opaque: 2 }] }
  const chunks = [
    { type: 'block-start', index: 2, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 2, text: 'native' }, { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'native' } },
    { type: 'block-start', index: 6, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 6, id: call.id, name: call.name, argumentsDelta: call.arguments }, { type: 'block-end', index: 6, block: call },
    { type: 'usage', usage }, finish('tool-calls', { replayState }),
  ]
  const result = assembled(await collect(normalizeStream(stream(chunks))))
  assert.deepEqual(result.blocks(), [{ type: 'reasoning', text: 'native' }, call])
  assert.deepEqual(result.usage, usage)
  assert.deepEqual(result.replayState, replayState)
})

test('converted reasoning drops native replay signatures', async () => {
  const chunks = textChunks('<thinking>reason</thinking>answer', { terminal: finish('stop', { replayState: { response: { signature: 'old' } } }) })
  assert.equal(assembled(await collect(normalizeStream(stream(chunks)))).replayState, undefined)
})

test('Anthropic Messages JSON becomes separate reasoning and text', async () => {
  const value = { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }], stop_reason: 'end_turn' }
  assert.deepEqual((await convert(JSON.stringify(value))).blocks(), [{ type: 'reasoning', text: 'reason' }, { type: 'text', text: 'answer' }])
})

test('OpenAI completed Responses JSON is decoded', async () => {
  const value = { id: 'resp-1', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }
  assert.deepEqual((await convert(JSON.stringify(value))).blocks(), [{ type: 'text', text: 'answer' }])
})

test('JSON tool calls stay observational by default', async () => {
  const result = await convert(toolEnvelope(), {}, { tools: [tool] })
  assert.ok(result.blocks().every(block => block.type !== 'tool-call'))
  assert.match(result.blocks().map(x => x.text).join(''), /未执行/)
})

test('explicit JSON tool mode accepts only declared valid tools', async () => {
  const result = await convert(toolEnvelope(), { allowJsonToolCalls: true }, { tools: [tool] })
  assert.deepEqual(result.blocks(), [{ type: 'tool-call', id: 'call-1', name: tool.name, arguments: '{"path":"README.md"}' }])
  assert.equal(result.finish.kind, 'tool-calls')
  for (const input of [toolEnvelope('unknown'), toolEnvelope(tool.name, { path: 'a', extra: 1 }), '{"incomplete":']) {
    const invalid = await convert(input, { allowJsonToolCalls: true }, { tools: [tool] })
    assert.ok(invalid.blocks().every(block => block.type !== 'tool-call'))
  }
})

test('Claude Code tool activity never becomes a new tool call', async () => {
  const value = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-call', name: tool.name, input: { path: 'x' } }] } }
  const result = await convert(JSON.stringify(value), { allowJsonToolCalls: true }, { tools: [tool] })
  assert.ok(result.blocks().every(block => block.type !== 'tool-call'))
  assert.match(result.blocks().map(x => x.text).join(''), /外部客户端/)
})

test('Codex completed command records are observation only', async () => {
  const value = { type: 'item.completed', item: { id: 'item-1', type: 'command_execution', command: 'echo ok', status: 'completed', exit_code: 0, aggregated_output: 'ok' } }
  const result = await convert(JSON.stringify(value), { allowJsonToolCalls: true }, { tools: [tool] })
  assert.ok(result.blocks().every(block => block.type !== 'tool-call'))
  assert.match(result.blocks().map(x => x.text).join(''), /echo ok/)
})

test('error, cancellation and truncated outer finishes do not create JSON tools', async () => {
  for (const kind of ['error', 'aborted', 'max-tokens']) {
    const terminal = { type: 'finish', reason: { kind, ...(['error', 'aborted'].includes(kind) ? { failure: { code: 'ABORTED', message: 'test' } } : {}) } }
    const result = assembled(await collect(normalizeStream(stream(textChunks(toolEnvelope(), { terminal })), { tools: [tool] }, { allowJsonToolCalls: true })))
    assert.equal(result.finish.kind, kind)
    assert.ok(result.blocks().every(block => block.type !== 'tool-call'))
  }
})

test('oversize candidates are preserved without truncation', async () => {
  const raw = JSON.stringify({ id: 'resp-large', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(1500) }] }] })
  assert.deepEqual((await convert(raw, { maxStructuredChars: 1024 })).blocks(), [{ type: 'text', text: raw }])
})

test('outer usage arrives before buffered candidate completion', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const usage = { inputTokens: 2, outputTokens: 1 }
  async function* input() { yield { type: 'text-delta', index: 0, text: '{"' }; yield { type: 'usage', usage }; await gate; yield finish('aborted') }
  const output = normalizeStream(input())
  assert.deepEqual((await output.next()).value, { type: 'usage', usage })
  release()
  await collect(output)
})

test('consumer return closes the source exactly once', async () => {
  let closed = 0
  async function* input() { try { yield* textChunks('visible answer') } finally { closed++ } }
  const output = normalizeStream(input())
  await output.next()
  await output.return()
  assert.equal(closed, 1)
})

test('missing terminal finish becomes a stream error', async () => {
  const result = assembled(await collect(normalizeStream(stream(textChunks('answer', { terminal: null })))))
  assert.equal(result.finish.kind, 'error')
  assert.equal(result.finish.failure.code, 'STREAM_CLOSED')
})

const jsonl = (...records) => records.map(record => JSON.stringify(record)).join('\n')
const sse = (...records) => records.map(record => `data: ${JSON.stringify(record)}\n\n`).join('')
const recorded = (chunks, counts, config = {}) => collect(normalizeStream(stream(chunks), {}, {
  ...config, onReasoningConversion: origin => counts.push(origin),
}))

test('each supported tag counts once per emitted block rather than once per delta', async () => {
  const counts = []
  for (const tag of ['THINKING', 'think', 'analysis', 'reasoning']) {
    const chunks = textChunks(`<${tag}>reason</${tag}>answer`, { split: true })
    assert.equal(assembled(await recorded(chunks, counts)).blocks()[0].type, 'reasoning')
  }
  const merged = '<think>first</think><analysis>second</analysis>answer'
  const separate = '<think>first</think>\n<analysis>second</analysis>answer'
  for (const [raw, expected] of [[merged, 1], [separate, 2]]) {
    const blocks = assembled(await recorded(textChunks(raw, { split: true }), counts)).blocks()
    assert.equal(blocks.filter(block => block.type === 'reasoning').length, expected)
  }
  assert.deepEqual(counts, Array(7).fill('tags'))
})

test('all structured formats report exactly the reasoning blocks they convert', async () => {
  const message = { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'anthropic' }, { type: 'text', text: 'answer' }], stop_reason: 'end_turn' }
  const response = { id: 'resp-1', object: 'response', status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'responses' }] }] }
  const claudeMessage = { id: 'claude-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'claude' }] }
  const claudeEvent = event => ({ type: 'stream_event', event })
  const item = { type: 'reasoning', id: 'item-1', text: 'codex' }
  const chat = (object, field, content, stop) => ({ object, choices: [{ index: 0, [field]: content, finish_reason: stop }] })
  const fixtures = [
    ['anthropic', JSON.stringify(message)],
    ['anthropic', sse({ type: 'message_start' }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'anthropic' } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' })],
    ['openaiResponses', JSON.stringify(response)],
    ['openaiResponses', sse({ type: 'response.reasoning_summary_text.delta', delta: 'responses' }, { type: 'response.completed', response })],
    ['openaiChat', JSON.stringify(chat('chat.completion', 'message', { role: 'assistant', reasoning_content: 'chat', content: 'answer' }, 'stop'))],
    ['openaiChat', sse(chat('chat.completion.chunk', 'delta', { reasoning_content: 'chat' }, null), chat('chat.completion.chunk', 'delta', { content: 'answer' }, 'stop'))],
    ['codex', jsonl({ type: 'thread.started' }, { type: 'item.updated', item }, { type: 'item.completed', item }, { type: 'item.completed', item }, { type: 'turn.completed' })],
    ['claudeCode', jsonl(claudeEvent({ type: 'message_start', message: { id: claudeMessage.id } }),
      claudeEvent({ type: 'content_block_start', index: 0, content_block: claudeMessage.content[0] }),
      claudeEvent({ type: 'content_block_stop', index: 0 }), claudeEvent({ type: 'message_stop' }),
      { type: 'assistant', message: claudeMessage }, { type: 'result', subtype: 'success', result: 'answer' })],
  ]
  for (const [origin, raw] of fixtures) {
    const counts = []
    const chunks = textChunks(raw, { split: true })
    const output = await recorded(chunks, counts)
    assert.deepEqual(output, await collect(normalizeStream(stream(chunks))), `observation changes the output for ${origin}`)
    assert.equal(assembled(output).blocks().filter(block => block.type === 'reasoning').length, 1, origin)
    assert.deepEqual(counts, [origin])
  }
})

test('native, empty, literal and unconverted responses do not count', async () => {
  const counts = []
  const native = { type: 'reasoning', text: 'native' }
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: native.text },
    { type: 'block-end', index: 0, block: native }, finish(),
  ]
  assert.deepEqual(assembled(await recorded(chunks, counts)).blocks(), [native])
  for (const raw of ['<thinking></thinking>ok', '<think> \n </think>ok', '`<think>literal</think>`', 'Example: <analysis>x</analysis>', '{"type":"thinking","text":"not an envelope"}', toolEnvelope()]) {
    await recorded(textChunks(raw), counts)
  }
  await recorded(textChunks('<thinking>disabled</thinking>'), counts, { reasoningTags: false })
  await recorded(textChunks(JSON.stringify({ object: 'response', id: 'resp', status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'not emitted' }] }] }), { terminal: finish('max-tokens') }), counts)
  assert.deepEqual(counts, [])
})

test('only emitted blocks count; observation errors cannot fail the model response', async () => {
  const counts = []
  const chunks = textChunks('<think>visible delta</think>answer', { split: true })
  const iterator = normalizeStream(stream(chunks), {}, { onReasoningConversion: origin => counts.push(origin) })
  assert.equal((await iterator.next()).value.type, 'block-start')
  assert.equal((await iterator.next()).value.type, 'reasoning-delta')
  await iterator.return()
  assert.deepEqual(counts, [])
  const observation = { onReasoningConversion: () => { throw Error('ignored statistic failure') } }
  const result = await collect(normalizeStream(stream(chunks), {}, observation))
  assert.equal(assembled(result).finish.kind, 'stop')
  assert.equal(assembled(result).blocks()[0].text, 'visible delta')
})

async function withRuntime(config, adapter, run) {
  const ctx = new Context()
  try {
    const llm = new LlmRuntime(ctx)
    const handle = llm.registerAdapter(['compat-test'], adapter)
    apply(ctx, Config(config))
    try { return await run(llm) } finally { handle() }
  } finally { await ctx.fiber.dispose() }
}
class LocalAdapter extends LlmAdapter {
  calls = 0
  seen
  constructor(chunks) { super(); this.chunks = chunks }
  async *stream(options) { this.calls++; this.seen = options; yield* this.chunks }
}

test('real Cordis waterfall and prepareCall convert a response exactly once', async () => {
  const adapter = new LocalAdapter(textChunks('<thinking>reason</thinking>answer'))
  await withRuntime({}, adapter, async llm => {
    const prepared = await llm.prepareCall({ provider: 'compat-test', model: 'local' })
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }]
    const controller = new AbortController()
    const result = assembled(await collect(prepared.stream({ ...prepared.config, messages, signal: controller.signal })))
    assert.equal(result.finish.kind, 'stop')
    assert.deepEqual(result.blocks(), [{ type: 'reasoning', text: 'reason' }, { type: 'text', text: 'answer' }])
    assert.equal(adapter.calls, 1)
    assert.deepEqual(adapter.seen.messages, messages)
    assert.equal(adapter.seen.signal, controller.signal)
  })
})

test('real runtime uses volatile config when permitting JSON tools', async () => {
  const adapter = new LocalAdapter(textChunks(toolEnvelope()))
  await withRuntime({ allowJsonToolCalls: true }, adapter, async llm => {
    const prepared = await llm.prepareCall({ provider: 'compat-test', model: 'local' })
    const result = assembled(await collect(prepared.stream({ ...prepared.config, messages: [], tools: [tool] })))
    assert.equal(result.finish.kind, 'tool-calls')
    assert.equal(result.blocks()[0].type, 'tool-call')
    assert.equal(adapter.calls, 1)
  })
})

test('owner-only statistics endpoint reports live conversion totals and unloads cleanly', async () => {
  const ctx = new Context()
  try {
    const connection = new HostConnectionService(ctx, [], {})
    const handler = connection.createSharedFetchHandler('/api')
    const llm = new LlmRuntime(ctx)
    const adapter = new LocalAdapter(textChunks('<analysis>one</analysis>answer'))
    llm.registerAdapter(['compat-test'], adapter)
    const row = ctx.plugin({ apply, inject: ['llm'] }, Config({}))
    await row.await()
    const request = () => new Request(`http://127.0.0.1${STATS_ROUTE}`)
    const read = () => handler.fetch(request(), connection.browserPeer)
    assert.equal((await handler.fetch(request(), { principal: { kind: 'not-owner' } })).status, 403)
    const first = await read()
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await first.json(), { total: 0, bySource: { tags: 0, claudeCode: 0, codex: 0, anthropic: 0, openaiChat: 0, openaiResponses: 0 } })
    const prepared = await llm.prepareCall({ provider: 'compat-test', model: 'local' })
    const result = assembled(await collect(prepared.stream({ ...prepared.config, messages: [] })))
    assert.equal(result.blocks()[0].text, 'one')
    assert.equal(adapter.calls, 1)
    const stats = await (await read()).json()
    assert.equal(stats.total, 1)
    assert.equal(stats.bySource.tags, 1)
    assert.equal((await (await read()).json()).total, 1)
    await row.dispose()
    assert.equal((await read()).status, 404)
  } finally { await ctx.fiber.dispose() }
})

test('real runtime cancellation retains aborted outcome and does not dispatch a tool', async () => {
  const controller = new AbortController()
  class Cancelling extends LlmAdapter {
    calls = 0
    async *stream(options) { this.calls++; yield { type: 'text-delta', index: 0, text: '{' }; controller.abort(); options.signal.throwIfAborted() }
  }
  const adapter = new Cancelling()
  await withRuntime({ allowJsonToolCalls: true }, adapter, async llm => {
    const prepared = await llm.prepareCall({ provider: 'compat-test', model: 'local' }, controller.signal)
    const result = assembled(await collect(prepared.stream({ ...prepared.config, messages: [], tools: [tool], signal: controller.signal })))
    assert.equal(result.finish.kind, 'aborted')
    assert.ok(result.blocks().every(block => block.type !== 'tool-call'))
    assert.equal(adapter.calls, 1)
  })
})
