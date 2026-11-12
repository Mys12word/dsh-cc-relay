import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { RelayAdapter, normalizeProfile } from '../lib/provider.js'
import { apiRoot, buildRequest, parseSSE, providerFailure, toolNames } from '../lib/protocol.js'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const tool = { name: 'read', description: 'Read a UTF-8 workspace file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const collect = async iterable => { const result = []; for await (const item of iterable) result.push(item); return result }
const wire = events => events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('')
const start = { type: 'message_start', message: { id: 'msg_test', role: 'assistant', usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }
const end = reason => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 4 } }, { type: 'message_stop' }]
const textEvents = text => [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]
const toolEvents = json => [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } }, { type: 'content_block_stop', index: 0 }, ...end('tool_use')]
const defaultProfile = extra => ({ baseURL: 'http://127.0.0.1:1', models: [{ id: 'test-model', input: ['text', 'image'] }], ...extra })
const adapter = (extra = {}, dependencies = {}) => new RelayAdapter([['cc-relay', defaultProfile(extra)]], { resolveKey: async () => 'sk-test-secret-key', attributionHeaders: () => ({ 'user-agent': 'deepseek-harness/test (+https://example.invalid)' }), ...dependencies })
const request = extra => ({ provider: 'cc-relay', model: 'test-model', messages: [user('读一下文件')], tools: [tool], sessionId: 'dsh-session-123', ...extra })

async function localServer(t, handler) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

async function bodyOf(req) { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body) }

function streamResponse(events) { return new Response(wire(events), { headers: { 'content-type': 'text/event-stream' } }) }

test('real local HTTP: CC request, streamed tool call, DSH result and final reply', async t => {
  const requests = []
  const baseURL = await localServer(t, async (req, res) => {
    const body = await bodyOf(req)
    requests.push(body)
    assert.equal(req.url, '/v1/messages')
    assert.equal(req.headers.authorization, 'Bearer sk-test-secret-key')
    assert.match(req.headers['user-agent'], /^claude-cli\//)
    assert.match(req.headers['user-agent'], /deepseek-harness/)
    assert.equal(req.headers['x-app'], 'cli')
    assert.equal(JSON.parse(body.metadata.user_id).session_id, req.headers['x-claude-code-session-id'])
    assert.match(body.system[0].text, /^You are Claude Code/)
    assert.equal(body.tools[0].name, 'Read')
    assert.deepEqual(body.tools[0].input_schema, tool.parameters)
    assert.equal(body.thinking, undefined)
    if (requests.length === 2) {
      assert.equal(body.messages.at(-2).content[0].type, 'tool_use')
      assert.equal(body.messages.at(-1).content[0].tool_use_id, 'tool_1')
      assert.equal(body.messages.at(-1).content[0].content[0].text, 'actual file contents')
      assert.equal(body.metadata.user_id, requests[0].metadata.user_id)
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const output = wire(requests.length === 1 ? toolEvents('{"file_path":"sample.txt"}') : textEvents('读取完成 ✅'))
    const bytes = Buffer.from(output)
    // Split in the middle of UTF-8 characters, JSON strings and CRLF boundaries.
    for (let i = 0; i < bytes.length; i += 11) res.write(bytes.subarray(i, i + 11))
    res.end()
  })
  const a = adapter({ baseURL })
  const firstInput = request()
  const snapshot = structuredClone(firstInput)
  const first = await collect(a.stream(firstInput))
  assert.deepEqual(firstInput, snapshot)
  const call = first.find(chunk => chunk.type === 'block-end').block
  assert.deepEqual(call, { type: 'tool-call', id: 'tool_1', name: 'read', arguments: '{"file_path":"sample.txt"}' })
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  assert.deepEqual(first.at(-2).usage, { inputTokens: 19, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 23 })
  const second = await collect(a.stream(request({ messages: [firstInput.messages[0], { role: 'assistant', source: { provider: 'cc-relay', model: 'test-model', replayState: first.at(-1).replayState }, content: [call] }, { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'actual file contents' }] }] })))
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.equal(second.find(chunk => chunk.type === 'block-end').block.text, '读取完成 ✅')
  assert.equal(requests.length, 2)
  assert.equal(a.active.size, 0)
})

test('native Anthropic mode preserves DSH attribution and x-api-key auth', async () => {
  let captured
  const a = adapter({ compatibility: { enabled: false }, authMode: 'x-api-key' }, { fetch: async (url, options) => { captured = { url, ...options }; return streamResponse(textEvents('ok')) } })
  await collect(a.stream(request()))
  const body = JSON.parse(captured.body)
  assert.equal(captured.headers.get('authorization'), null)
  assert.equal(captured.headers.get('x-api-key'), 'sk-test-secret-key')
  assert.match(captured.headers.get('user-agent'), /^deepseek-harness\//)
  assert.equal(captured.headers.get('x-app'), null)
  assert.equal(body.metadata, undefined)
  assert.equal(body.tools[0].name, 'read')
  assert.equal(body.system, undefined)
})

test('HTTP and SSE failures carry stable codes without exposing keys', async () => {
  const key = 'sk-test-secret-key'
  const a = adapter({}, { fetch: async () => new Response(JSON.stringify({ error: { message: `only Claude Code clients: ${key}` } }), { status: 403, headers: { 'x-request-id': 'req-123' } }) })
  await assert.rejects(collect(a.stream(request())), error => error.code === 'CLIENT_RESTRICTED' && error.failure.requestId === 'req-123' && !error.message.includes(key))
  const b = adapter({}, { fetch: async () => streamResponse([{ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }]) })
  await assert.rejects(collect(b.stream(request())), error => error.code === 'RATE_LIMIT' && error.failure.status === 429)
  const c = providerFailure(429, '{}', key, new Headers({ 'retry-after': '2' }))
  assert.equal(c.failure.providerRetryAfterMs, 2000)
})

test('cancellation and plugin unload stop a live stream', async t => {
  const baseURL = await localServer(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire([start])) })
  for (const unload of [false, true]) {
    const a = adapter({ baseURL })
    const controller = new AbortController()
    const pending = collect(a.stream(request({ signal: controller.signal })))
    const timer = setTimeout(() => unload ? a.dispose() : controller.abort(), 60)
    try { await assert.rejects(pending, error => error.code === 'ABORTED') } finally { clearTimeout(timer) }
    assert.equal(a.active.size, 0)
  }
})

test('idle timeout ends a stalled response', async t => {
  const baseURL = await localServer(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire([start])) })
  const a = adapter({ baseURL, streamIdleTimeoutMs: 40 })
  await assert.rejects(collect(a.stream(request())), error => error.code === 'TIMEOUT')
})

test('malformed JSON tool arguments and truncated SSE do not become successful calls', async () => {
  const a = adapter({}, { fetch: async () => streamResponse(toolEvents('{bad')) })
  await assert.rejects(collect(a.stream(request())), error => error.code === 'MALFORMED_RESPONSE')
  const b = adapter({}, { fetch: async () => streamResponse(textEvents('cut').slice(0, -1)) })
  await assert.rejects(collect(b.stream(request())), error => error.code === 'STREAM_CLOSED')
})

test('SSE supports multiline data, comments, LF/CRLF and bounded event sizes', async () => {
  const body = new Response(': hello\r\nevent: ping\r\ndata: {"type":\r\ndata: "ping"}\r\n\r\n').body
  assert.deepEqual(await collect(parseSSE(body)), [{ event: 'ping', type: 'ping' }])
  await assert.rejects(collect(parseSSE(new Response(`data: ${'a'.repeat(120)}\n\n`).body, undefined, 64)), error => error.code === 'MALFORMED_RESPONSE')
})

test('URLs, credential headers and model metadata are validated', () => {
  assert.equal(apiRoot('https://example.test/anthropic/v1/messages/'), 'https://example.test/anthropic/v1')
  assert.equal(apiRoot('https://example.test'), 'https://example.test/v1')
  for (const url of ['file:///tmp/key', 'https://user:secret@example.test', 'https://example.test?api_key=secret']) assert.throws(() => apiRoot(url))
  assert.throws(() => normalizeProfile('cc-relay', { headers: { Authorization: 'secret' } }))
  assert.throws(() => normalizeProfile('cc-relay', { models: [{ id: 'x' }, { id: 'x' }] }))
  assert.throws(() => normalizeProfile('cc-relay', { apiKeyEnv: 'sk-the-key' }))
  const a = adapter()
  assert.equal(a.providerInfo('cc-relay').id, 'cc-relay')
})

test('images, [1m] suffix and cache breakpoints preserve source objects', async () => {
  const p = normalizeProfile('cc-relay', defaultProfile())
  const ref = { attachmentId: 'sha256:example', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
  const input = request({ model: 'test-model[1m]', messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'text', text: 'what?' }] }] })
  const original = structuredClone(input)
  const built = await buildRequest(input, p, { readImage: async () => ({ data: new Uint8Array([1, 2, 3, 4]), ref }) })
  assert.equal(built.body.model, 'test-model')
  assert.ok(built.betas.includes('context-1m-2025-08-07'))
  assert.equal(built.body.messages[0].content[1].source.data, 'AQIDBA==')
  assert.deepEqual(built.body.messages[0].content.at(-1).cache_control, { type: 'ephemeral' })
  assert.deepEqual(input, original)
})

test('native replay signatures stay scoped to the producing provider and model', async () => {
  const p = normalizeProfile('cc-relay', defaultProfile())
  const source = { provider: 'cc-relay', model: 'test-model', replayState: { response: { kind: 'dsh-cc-relay', version: 1, model: 'test-model' }, blocks: [{ type: 'thinking', signature: 'opaque-signature' }, { type: 'text' }] } }
  const messages = [user('hello'), { role: 'assistant', source, content: [{ type: 'reasoning', text: 'preserved private reasoning' }, { type: 'text', text: 'hello' }] }, user('continue')]
  const same = await buildRequest(request({ messages }), p)
  assert.equal(same.body.messages[1].content[0].signature, 'opaque-signature')
  const foreign = await buildRequest(request({ provider: 'other-relay', messages }), p)
  assert.deepEqual(foreign.body.messages[1].content, [{ type: 'text', text: 'hello' }])
})

test('tool aliases remain unambiguous beside original CC tool names', () => {
  const names = toolNames(request({ tools: [tool, { ...tool, name: 'Read' }] }), true)
  assert.equal(names.forward.get('read'), 'read')
  assert.equal(names.forward.get('Read'), 'Read')
  assert.equal(names.reverse.get('read'), 'read')
})
