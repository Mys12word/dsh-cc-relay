import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { RelayAdapter } from '../lib/provider.js'
import * as plugin from '../index.js'
import { installConfiguredRouting, registerModelTool, validateSelections } from '../lib/configured.js'

const collect = async source => { const result = []; for await (const chunk of source) result.push(chunk); return result }
const request = { provider: 'cc-relay', model: 'test-model', sessionId: 'runtime-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
const events = [
  { type: 'message_start', message: { id: 'msg_runtime', usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'runtime OK' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]

test('plugin Config and apply register a configurable provider in the real DSH runtime', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  ctx.provide('credentials', { resolve: async () => undefined })
  const config = plugin.Config({ models: [{ id: 'configured-model', input: ['text'] }] })
  plugin.apply(ctx, config)
  assert.deepEqual(llm.listProviders(), [{ id: 'cc-relay', name: 'CC 中转' }])
  const directory = llm.listConfigurableProviders()[0]
  assert.equal(directory.settingsNs, 'cc-relay')
  assert.deepEqual(directory.settingsPath, [])
  assert.equal((await llm.listModels('cc-relay'))[0].id, 'configured-model')
  const prepared = await llm.prepareCall({ provider: 'cc-relay', model: 'configured-model' })
  assert.equal(prepared.config.maxTokens, 32000)
  assert.equal(prepared.context.contextWindow, 200000)
  const chunks = await collect(prepared.stream({ ...request, ...prepared.config }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'INVALID_CONFIG')
})

test('real DSH LLM preparation, streaming and BlockAssembler accept the adapter', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  const a = new RelayAdapter([['cc-relay', { baseURL: 'https://fake.invalid', models: [{ id: 'test-model' }] }]], {
    resolveKey: async () => 'test-secret',
    fetch: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }),
  })
  const dispose = llm.registerAdapter(['cc-relay'], a)
  assert.equal((await llm.listModels('cc-relay'))[0].id, 'test-model')
  const model = await llm.resolveModelInfo('cc-relay', 'test-model')
  assert.deepEqual(model.inputModalities, ['text', 'image'])
  assert.equal(llm.imageRequestPricing('cc-relay', 'test-model'), undefined)
  const prepared = await llm.prepareCall({ provider: 'cc-relay', model: 'test-model' })
  const assembler = new BlockAssembler()
  for await (const chunk of prepared.stream({ ...request, ...prepared.config })) assembler.push(chunk)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'runtime OK' }])
  assert.deepEqual(assembler.usage, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 })
  assert.equal(assembler.finish.kind, 'stop')
  assert.equal(assembler.replayState.response.kind, 'dsh-cc-relay')
  dispose()
  assert.deepEqual(llm.listProviders(), [])
})

test('configured-model flag reuses source endpoint/key, keeps replay and returns to original adapter', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  let calls = 0, key = 'first-source-key'
  const captured = [], refs = []
  const source = new RelayAdapter([['gateway', { baseURL: 'https://unused.invalid', models: [{ id: 'claude-test', maxTokens: 8192 }, { id: 'other' }] }]], {})
  const original = { providerInfo: source.providerInfo.bind(source), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined, imageRequestTarget: source.imageRequestTarget.bind(source), listModels: source.listModels.bind(source), resolveModel: async (provider, model) => ({ ...source.modelInfo(provider, model), reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }), prepareCall: async (provider, model) => ({ model: await original.resolveModel(provider, model), stream: options => original.stream(options) }), stream: async function* () { calls++; yield { type: 'finish', reason: { kind: 'stop' } } } }
  llm.registerAdapter(['gateway'], original)
  llm.registerConfigurableProviders([{ provider: 'gateway', displayName: 'Existing gateway', settingsNs: 'source-settings', settingsPath: ['providers', 'gateway'] }])
  const values = { providers: { gateway: { baseURL: 'https://source.example/anthropic', apiKeyEnv: 'EXISTING_KEY', models: [{ id: 'claude-test', maxTokens: 8192 }], headers: { 'x-source': 'kept' } } } }
  ctx.provide('settings', { describe: () => [{ ns: 'source-settings', value: structuredClone(values) }] })
  ctx.provide('credentials', { resolve: async ref => { refs.push(ref); return { value: key } } })
  const config = { ccOnlyModels: [{ provider: 'gateway', model: 'claude-test', authMode: 'bearer' }], headers: { 'x-other-relay': 'must-not-leak' } }
  const output = [
    events[0],
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'native reasoning' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'source-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_cc', name: 'Read', input: { file_path: 'demo.txt' } } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
  ]
  installConfiguredRouting(ctx, () => config, { resolveKey: async ref => (await ctx.credentials.resolve(ref))?.value, fetch: async (url, options) => { captured.push({ url, headers: options.headers, body: JSON.parse(options.body) }); const reply = captured.length === 1 ? output : events; return new Response(reply.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')) } })
  const tool = { name: 'read', description: 'Read', parameters: { type: 'object' } }
  const prepared = await llm.prepareCall({ provider: 'gateway', model: 'claude-test' })
  assert.equal(prepared.config.reasoningEffort, 'high')
  const options = { ...request, ...prepared.config, tools: [tool] }
  const before = structuredClone(options)
  const assembler = new BlockAssembler()
  for await (const chunk of prepared.stream(Object.freeze(options))) assembler.push(chunk)
  assert.deepEqual(options, before)
  assert.equal(calls, 0)
  assert.equal(assembler.finish.kind, 'tool-calls')
  assert.equal(captured[0].url, 'https://source.example/anthropic/v1/messages')
  assert.equal(captured[0].headers.get('authorization'), 'Bearer first-source-key')
  assert.equal(captured[0].headers.get('x-source'), 'kept')
  assert.equal(captured[0].headers.get('x-other-relay'), null)
  assert.equal(captured[0].body.model, 'claude-test')
  assert.equal(captured[0].body.max_tokens, 8192)
  assert.equal(captured[0].body.thinking, undefined)
  assert.equal(captured[0].body.tools[0].name, 'Read')
  key = 'rotated-source-key'
  const history = [...request.messages, { role: 'assistant', source: { kind: 'model', provider: 'gateway', model: 'claude-test', replayState: assembler.replayState }, content: assembler.blocks() }, { role: 'tool', source: { kind: 'tool', callId: 'call_cc' }, toolCallId: 'call_cc', content: [{ type: 'text', text: 'actual result' }] }]
  const chunks = await collect(llm.stream({ provider: 'gateway', model: 'claude-test', messages: history, tools: [tool] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(captured[1].headers.get('authorization'), 'Bearer rotated-source-key')
  assert.equal(captured[1].body.messages[1].content[0].signature, 'source-signature')
  assert.equal(captured[1].body.messages.at(-1).content[0].tool_use_id, 'call_cc')
  assert.deepEqual(refs, ['EXISTING_KEY', 'EXISTING_KEY'])
  await collect(llm.stream({ provider: 'gateway', model: 'other', messages: request.messages }))
  assert.equal(calls, 1)
  config.ccOnlyModels = []
  await collect(llm.stream({ provider: 'gateway', model: 'claude-test', messages: request.messages }))
  assert.equal(calls, 2)
})

test('configured CC failure stays terminal and never falls back to the original adapter', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  let originalCalls = 0, fetched = 0
  const original = new RelayAdapter([['gateway', { models: [{ id: 'test-model' }] }]], {})
  original.stream = async function* () { originalCalls++; yield { type: 'finish', reason: { kind: 'stop' } } }
  llm.registerAdapter(['gateway'], original)
  llm.registerConfigurableProviders([{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'source', settingsPath: [] }])
  let value = { baseURL: 'https://source.invalid', apiKeyEnv: 'SOURCE_KEY' }
  ctx.provide('settings', { describe: () => [{ ns: 'source', value }] })
  installConfiguredRouting(ctx, () => ({ ccOnlyModels: [{ provider: 'gateway', model: 'test-model' }] }), { resolveKey: async () => 'key', fetch: async () => { fetched++; return new Response('{"error":{"message":"wrong key"}}', { status: 401 }) } })
  const result = await collect(llm.stream({ ...request, provider: 'gateway' }))
  assert.equal(result.at(-1).reason.failure.code, 'AUTH')
  assert.equal(result.at(-1).reason.failure.status, 401)
  value = { baseURL: 'https://source.invalid' }
  const missing = await collect(llm.stream({ ...request, provider: 'gateway' }))
  assert.equal(missing.at(-1).reason.failure.code, 'INVALID_CONFIG')
  assert.equal(fetched, 1)
  assert.equal(originalCalls, 0)
  assert.throws(() => validateSelections([{ provider: 'gateway', model: 'a' }, { provider: 'gateway', model: 'a' }]))
})

test('plugin activates routing and model tool together with settings, and tool writes only its flag', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  const tools = [], writes = []
  let flags = []
  const source = new RelayAdapter([['gateway', { models: [{ id: 'test-model' }] }]], {})
  llm.registerAdapter(['gateway'], source)
  llm.registerConfigurableProviders([{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'source', settingsPath: [] }])
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('tools', { register: definition => { tools.push(definition); return () => {} } })
  ctx.provide('settings', {
    describe: () => [{ ns: 'cc-relay', revision: 4, value: { ccOnlyModels: flags } }, { ns: 'source', value: { baseURL: 'https://source.invalid', apiKeyEnv: 'SOURCE_KEY', models: [{ id: 'test-model' }] } }],
    mutate: async (ns, ops, revision) => { writes.push({ ns, ops, revision }); flags = ops[0].value },
  })
  plugin.apply(ctx, plugin.Config({}))
  await new Promise(resolve => setImmediate(resolve))
  const definition = tools.find(item => item.name === 'cc_relay_models')
  assert.ok(definition, 'tool registered through nested optional injection')
  const exec = { signal: new AbortController().signal }
  const listed = await definition.execute({ action: 'list' }, exec)
  assert.equal(listed.models.find(item => item.model === 'test-model').ccOnly, false)
  const result = await definition.execute({ action: 'set', provider: 'gateway', model: 'test-model', enabled: true }, exec)
  assert.equal(result.updated, true)
  assert.equal(writes[0].ns, 'cc-relay')
  assert.equal(writes[0].revision, 4)
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['ccOnlyModels'], value: [{ provider: 'gateway', model: 'test-model', authMode: 'bearer' }] }])
  assert.equal(JSON.stringify(writes).includes('SOURCE_KEY'), false)
  await definition.execute({ action: 'set', provider: 'gateway', model: 'test-model', enabled: false }, exec)
  assert.deepEqual(flags, [])
})

test('unloading configured routing during metadata resolution prevents network dispatch', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  let release, announce, fetched = 0
  const entered = new Promise(resolve => { announce = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const original = new RelayAdapter([['gateway', { models: [{ id: 'test-model' }] }]], {})
  original.resolveModel = async (provider, model) => { announce(); await waiting; return original.modelInfo(provider, model) }
  llm.registerAdapter(['gateway'], original)
  llm.registerConfigurableProviders([{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'source', settingsPath: [] }])
  ctx.provide('settings', { describe: () => [{ ns: 'source', value: { baseURL: 'https://source.invalid', apiKeyEnv: 'SOURCE_KEY' } }] })
  let owner
  ctx.plugin(child => {
    owner = child
    installConfiguredRouting(child, () => ({ ccOnlyModels: [{ provider: 'gateway', model: 'test-model' }] }), { resolveKey: async () => 'key', fetch: async () => { fetched++; throw new Error('must not fetch') } })
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(owner)
  const result = collect(llm.stream({ ...request, provider: 'gateway' }))
  await entered
  await owner.fiber.dispose()
  release()
  const chunks = await result
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(fetched, 0)
})

test('malformed flags fail only their exact route and leave unrelated models usable', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  let originalCalls = 0
  const original = new RelayAdapter([['gateway', { models: [{ id: 'test-model' }, { id: 'other' }] }]], {})
  original.stream = async function* () { originalCalls++; yield { type: 'finish', reason: { kind: 'stop' } } }
  llm.registerAdapter(['gateway'], original)
  llm.registerConfigurableProviders([{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'source', settingsPath: [] }])
  ctx.provide('settings', { describe: () => [{ ns: 'source', value: { baseURL: 'https://source.invalid', apiKeyEnv: 'KEY' } }] })
  const flag = { provider: 'gateway', model: 'test-model' }
  installConfiguredRouting(ctx, () => ({ ccOnlyModels: [flag, flag] }), { resolveKey: async () => 'key' })
  const unrelated = await collect(llm.stream({ ...request, provider: 'gateway', model: 'other' }))
  assert.equal(unrelated.at(-1).reason.kind, 'stop')
  assert.equal(originalCalls, 1)
  const selected = await collect(llm.stream({ ...request, provider: 'gateway' }))
  assert.equal(selected.at(-1).reason.kind, 'error')
  assert.equal(selected.at(-1).reason.failure.code, 'INVALID_CONFIG')
  assert.equal(originalCalls, 1)
})

test('adapter failures normalize to DSH terminal chunks', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const llm = new LlmRuntime(ctx)
  const a = new RelayAdapter([['cc-relay', { baseURL: 'https://fake.invalid' }]], {
    resolveKey: async () => 'test-secret',
    fetch: async () => new Response('{"error":{"message":"wrong key"}}', { status: 401 }),
  })
  llm.registerAdapter(['cc-relay'], a)
  const chunks = await collect(llm.stream(request))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
  assert.equal(chunks.at(-1).reason.failure.status, 401)
})
