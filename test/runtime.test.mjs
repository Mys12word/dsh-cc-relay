import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import * as pi from '@deepseek-ai/dsh-llm-pi-ai'
import * as plugin from '../index.js'

const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result }
const assemble = chunks => { const result = new BlockAssembler(); chunks.forEach(chunk => result.push(chunk)); return result }
const options = { provider: 'existing', model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
const textChunks = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { fixture: true }, blocks: [{ signature: 'native' }] } }]
class FixtureAdapter extends LlmAdapter {
  calls = []
  output = '<think>reasoning</think>answer'
  providerInfo(provider) { return { id: provider, name: 'Existing' } }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 10000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } } }
  async *stream(request) { this.calls.push(request); yield* textChunks(this.output) }
}
async function fixture(t, config = {}) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  const original = new FixtureAdapter()
  llm.registerAdapter(['existing'], original)
  let child
  ctx.plugin(owner => { child = owner; plugin.apply(owner, plugin.Config(config)) })
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, llm, original, child }
}
const read = { name: 'read', description: 'Read UTF-8', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }

test('plugin adds no providers, configurable models, credentials dependency or tools', async t => {
  const { llm } = await fixture(t)
  assert.deepEqual(plugin.inject, ['llm'])
  assert.deepEqual(llm.listProviders(), [{ id: 'existing', name: 'Existing' }])
  assert.deepEqual(llm.listConfigurableProviders(), [])
  assert.equal(plugin.Config({}).allowJsonToolCalls.get(), false)
  const output = assemble(await collect(llm.stream(options)))
  assert.deepEqual(output.blocks(), [{ type: 'reasoning', text: 'reasoning' }, { type: 'text', text: 'answer' }])
  assert.equal(output.replayState, undefined)
})

test('real DSH prepareCall keeps original provider, effort, controls and immutable request', async t => {
  const { llm, original } = await fixture(t)
  const prepared = await llm.prepareCall({ provider: 'existing', model: 'fixture', maxTokens: 1024 })
  assert.equal(prepared.config.reasoningEffort, 'high')
  const input = { ...options, ...prepared.config, tools: [read] }
  const before = structuredClone(input)
  Object.freeze(input)
  const output = assemble(await collect(prepared.stream(input)))
  assert.equal(output.finish.kind, 'stop')
  assert.equal(original.calls.length, 1)
  assert.equal(original.calls[0].provider, 'existing')
  assert.equal(original.calls[0].reasoningEffort, 'high')
  assert.equal(original.calls[0].maxTokens, 1024)
  assert.deepEqual(input, before)
})

test('native replay survives unmodified output and unloading removes only the wrapper', async t => {
  const { llm, original, child } = await fixture(t)
  original.output = 'ordinary'
  const plain = assemble(await collect(llm.stream(options)))
  assert.deepEqual(plain.replayState, { response: { fixture: true }, blocks: [{ signature: 'native' }] })
  await child.fiber.dispose()
  original.output = '<think>raw</think>after unload'
  const raw = assemble(await collect(llm.stream(options)))
  assert.deepEqual(raw.blocks(), [{ type: 'text', text: original.output }])
  assert.deepEqual(llm.listProviders(), [{ id: 'existing', name: 'Existing' }])
})

test('default JSON observations never create executable blocks in real BlockAssembler', async t => {
  const { llm, original } = await fixture(t)
  original.output = JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_json', name: 'read', input: { file_path: 'fixture.txt' } }] })
  const message = assemble(await collect(llm.stream({ ...options, tools: [read] })))
  assert.equal(message.blocks().some(block => block.type === 'tool-call'), false)
  assert.match(message.blocks()[0].text, /未执行/)
  assert.equal(message.finish.kind, 'stop')
})

test('global JSON opt-in keeps call IDs and accepts correlated next-turn tool result', async t => {
  const { llm, original } = await fixture(t, { allowJsonToolCalls: true })
  original.output = JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_json', name: 'Read', input: { file_path: 'fixture.txt' } }] })
  const first = assemble(await collect(llm.stream({ ...options, tools: [read] })))
  assert.equal(first.finish.kind, 'tool-calls')
  assert.deepEqual(first.blocks(), [{ type: 'tool-call', id: 'call_json', name: 'read', arguments: '{"file_path":"fixture.txt"}' }])
  const assistant = createAssistantMessage({ content: first.blocks(), source: { provider: 'existing', model: 'fixture' } })
  const result = createToolResultMessage({ callId: 'call_json', content: [{ type: 'text', text: 'fixture contents' }] })
  original.output = 'done'
  await collect(llm.stream({ ...options, tools: [read], messages: [...options.messages, assistant, result] }))
  assert.equal(original.calls.length, 2)
  assert.equal(original.calls.at(-1).messages.at(-1).toolCallId, 'call_json')
})

test('original adapter failure remains terminal and makes no fallback request', async t => {
  const { llm, original } = await fixture(t)
  let count = 0
  original.stream = async function* () { count++; throw Object.assign(new Error('fixture transport failure'), { code: 'TRANSPORT' }) }
  const output = assemble(await collect(llm.stream(options)))
  assert.equal(output.finish.kind, 'error')
  assert.equal(count, 1)
})

test('actual pi-ai HTTP serialization remains on original route through a JSON tool round trip', async t => {
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part
      const body = JSON.parse(raw)
      requests.push({ path: request.url, authorization: request.headers.authorization, marker: request.headers['x-fixture'], body })
      const content = requests.length === 1 ? JSON.stringify({ id: 'msg_http', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_http', name: 'read', input: { file_path: 'fixture.txt' } }] }) : '<think>brief</think>HTTP done'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch { response.writeHead(500); response.end('fixture server failure') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  ctx.provide('credentials', { resolve: async ref => { assert.equal(ref, 'FIXTURE_ONLY_KEY'); return { value: 'local-fixture-key' } }, readRecord: async () => undefined })
  pi.apply(ctx, pi.Config({ providers: { 'fixture-route': { api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_ONLY_KEY', headers: { 'x-fixture': 'kept' }, models: [{ id: 'fixture-model', input: ['text'], contextWindow: 10000, maxTokens: 2048, reasoningEfforts: false }] } } }))
  plugin.apply(ctx, plugin.Config({ allowJsonToolCalls: true }))
  const input = { provider: 'fixture-route', model: 'fixture-model', messages: options.messages, tools: [read], maxTokens: 256 }
  const first = assemble(await collect(llm.stream(input)))
  assert.equal(first.finish.kind, 'tool-calls', JSON.stringify(first.finish))
  assert.deepEqual(first.blocks(), [{ type: 'tool-call', id: 'call_http', name: 'read', arguments: '{"file_path":"fixture.txt"}' }])
  const assistant = createAssistantMessage({ content: first.blocks(), source: { provider: input.provider, model: input.model } })
  const result = createToolResultMessage({ callId: 'call_http', content: [{ type: 'text', text: 'HTTP fixture contents' }] })
  const second = assemble(await collect(llm.stream({ ...input, messages: [...input.messages, assistant, result] })))
  assert.equal(second.finish.kind, 'stop', JSON.stringify(second.finish))
  assert.deepEqual(second.blocks(), [{ type: 'reasoning', text: 'brief' }, { type: 'text', text: 'HTTP done' }])
  assert.deepEqual(second.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].path, '/v1/chat/completions')
  assert.equal(requests[0].authorization, 'Bearer local-fixture-key')
  assert.equal(requests[0].marker, 'kept')
  assert.equal(requests[0].body.model, 'fixture-model')
  assert.equal(requests[0].body.tools[0].function.name, 'read')
  assert.equal(requests[1].body.messages.find(message => message.role === 'tool').tool_call_id, 'call_http')
  assert.equal(llm.listProviders().some(provider => provider.id === 'cc-relay'), false)
})
