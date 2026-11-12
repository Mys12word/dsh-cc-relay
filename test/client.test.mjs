import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { setImmediate } from 'node:timers/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

// Exercise the published module and its real handlers without a browser or a
// second React installation. This verifies contracts, not rendered appearance.
function setup(overrides = {}) {
  let cursor = 0, pendingEffects = [], module, Card, tree
  const hooks = [], cleanups = [], writes = [], keys = [], registrations = []
  const view = {
    ns: 'cc-relay', revision: 7,
    value: { baseURL: 'https://relay.example', apiKeyEnv: 'CC_RELAY_API_KEY', authMode: 'bearer', compatibility: { enabled: true }, models: [{ id: 'existing', name: 'Keep display name', maxTokens: 4096, input: ['text'] }] },
  }
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() } },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { value: { current: initial } }
      return hooks[index].value
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) {
        hooks[index] = { deps }
        pendingEffects.push(effect)
      }
    },
  }
  const ctx = {
    slots: {
      inject(name, callback) { assert.ok(['settings.models.provider-card', 'settings.models.footer'].includes(name)); return callback() },
      register(options, component) { registrations.push(options); if ((options.name === 'settings.models.footer') === !!overrides.configured) Card = component; return () => {} },
    },
    locale: { register() { return () => {} }, bind() { return key => key } },
    effect(callback) { const cleanup = callback(); if (cleanup) cleanups.push(cleanup) },
    remote: {
      llm: { listConfigurableProviders: async () => ({ ok: true, value: [{ provider: 'gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'] }] }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'gateway', name: 'Gateway', models: [{ id: 'claude-test', name: 'Already configured' }, { id: 'other-model' }] }] } }) },
      settings: {
        describe: async () => ({ ok: true, value: { writable: true, namespaces: [structuredClone(view), { ns: 'llm-pi-ai', revision: 3, value: { providers: { gateway: { baseURL: 'https://source.example', apiKeyEnv: 'GATEWAY_KEY', models: [{ id: 'claude-test', name: 'Already configured' }, { id: 'other-model' }] } } } }] } }),
        mutate: async (ns, ops, revision) => {
          writes.push({ ns, ops, revision })
          if (overrides.mutate) return overrides.mutate(ns, ops, revision)
          const updated = structuredClone(view)
          updated.revision++
          for (const op of ops) {
            let object = updated.value
            for (const part of op.path.slice(0, -1)) object = object[part] ??= {}
            object[op.path.at(-1)] = op.value
          }
          return { ok: true, value: updated }
        },
      },
      credentials: {
        describe: async () => ({ ok: true, value: { CC_RELAY_API_KEY: { configured: true, writable: true } } }),
        set: async (ref, value) => { keys.push({ ref, value }); return overrides.setKey ? overrides.setKey(ref, value) : { ok: true } },
      },
    },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { module = value } } }, URL, Error, Map, Set,
  })
  assert.equal(module.id, 'dsh-cc-relay')
  const exports = module.factory(name => { assert.equal(name, 'react'); return React })
  exports.apply(ctx)
  const render = () => {
    cursor = 0
    tree = Card({ provider: { provider: 'cc-relay', settingsNs: 'cc-relay' }, keyConfigured: true })
    for (const effect of pendingEffects.splice(0)) { const dispose = effect(); if (dispose) cleanups.push(dispose) }
    return tree
  }
  const find = (predicate, node = tree) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) { const found = find(predicate, child); if (found) return found }
  }
  const change = (type, value, inputType) => {
    const control = find(node => node.type === type && (!inputType || node.props.type === inputType))
    assert.ok(control, `missing ${type} ${inputType ?? ''}`)
    control.props.onChange({ target: { value } })
    render()
  }
  return {
    exports, registrations, writes, keys, render, find, change,
    async ready() { render(); await setImmediate(); render() },
    async save() { const form = find(node => node.type === 'form'); assert.ok(form); await form.props.onSubmit({ preventDefault() {} }); render() },
    dispose() { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}

test('configured-model footer saves only exact CC flags and never copies source credentials', async t => {
  const app = setup({ configured: true }); t.after(() => app.dispose()); await app.ready()
  assert.ok(app.registrations.some(item => item.name === 'settings.models.footer'))
  assert.equal(app.find(node => node.type === 'input' && node.props.type === 'password'), undefined)
  const check = app.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'].includes('claude-test'))
  assert.ok(check)
  check.props.onChange({ target: { checked: true } }); app.render(); await app.save()
  assert.equal(app.writes.length, 1)
  assert.equal(app.writes[0].revision, 7)
  const flag = app.writes[0].ops[0]
  assert.equal(flag.path[0], 'ccOnlyModels')
  assert.deepEqual(JSON.parse(JSON.stringify(flag.value)), [{ provider: 'gateway', model: 'claude-test', authMode: 'bearer' }])
  assert.equal(app.keys.length, 0)
  assert.equal(JSON.stringify(app.writes).includes('GATEWAY_KEY'), false)
  assert.equal(JSON.stringify(app.writes).includes('source.example'), false)
  const enabled = app.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'].includes('claude-test'))
  enabled.props.onChange({ target: { checked: false } }); app.render(); await app.save()
  assert.equal(app.writes[1].ops[0].value.length, 0)
})

test('configured-model footer reports rejected save without success', async t => {
  const app = setup({ configured: true, mutate: async () => ({ ok: false, error: { message: 'settings conflict' } }) })
  t.after(() => app.dispose()); await app.ready(); await app.save()
  assert.ok(app.find(node => node.props.role === 'alert'))
  assert.equal(app.find(node => node.props.role === 'status'), undefined)
})

test('client registers the exact keyed provider-card slot and loads a write-only key input', async t => {
  const app = setup(); t.after(() => app.dispose())
  assert.equal(app.registrations[0].key, 'cc-relay')
  assert.ok(app.exports.inject.includes('remote.settings'))
  assert.ok(app.exports.inject.includes('remote.credentials'))
  await app.ready()
  const password = app.find(node => node.type === 'input' && node.props.type === 'password')
  assert.equal(password.props.value, '')
  assert.equal(password.props.placeholder, 'keySaved')
  assert.equal(app.writes.length, 0)
  assert.equal(app.keys.length, 0)
})

test('save preserves model metadata and keeps secrets out of settings mutations', async t => {
  const app = setup(); t.after(() => app.dispose()); await app.ready()
  app.change('input', 'https://new-relay.example/v1', 'url')
  app.change('textarea', 'existing\nnew-model\nexisting')
  app.change('input', 'sk-local-test-key', 'password')
  await app.save()
  assert.equal(app.writes.length, 1)
  assert.equal(app.writes[0].ns, 'cc-relay')
  assert.equal(app.writes[0].revision, 7)
  assert.equal(JSON.stringify(app.writes).includes('sk-local-test-key'), false)
  const models = app.writes[0].ops.find(op => op.path[0] === 'models').value
  assert.equal(models.length, 2)
  assert.equal(models[0].name, 'Keep display name')
  assert.equal(models[0].maxTokens, 4096)
  assert.deepEqual(app.keys, [{ ref: 'CC_RELAY_API_KEY', value: 'sk-local-test-key' }])
  assert.equal(app.find(node => node.type === 'input' && node.props.type === 'password').props.value, '')
  assert.ok(app.find(node => node.props.role === 'status'))
})

test('blank key preserves the stored credential and invalid URL causes no writes', async t => {
  const app = setup(); t.after(() => app.dispose()); await app.ready()
  await app.save()
  assert.equal(app.keys.length, 0)
  assert.equal(app.writes.length, 1)
  app.change('input', 'https://user:secret@relay.example', 'url')
  await app.save()
  assert.equal(app.writes.length, 1)
  assert.ok(app.find(node => node.props.role === 'alert'))
})

test('failed settings save never writes a credential or reports success', async t => {
  const app = setup({ mutate: async () => ({ ok: false, error: { message: 'settings conflict' } }) })
  t.after(() => app.dispose()); await app.ready()
  app.change('input', 'test-secret', 'password')
  await app.save()
  assert.equal(app.keys.length, 0)
  assert.ok(app.find(node => node.props.role === 'alert'))
  assert.equal(app.find(node => node.props.role === 'status'), undefined)
})

test('partial credential failure is visible and keeps the input for a retry', async t => {
  const app = setup({ setKey: async () => ({ ok: false, error: { message: 'credential rejected' } }) })
  t.after(() => app.dispose()); await app.ready()
  app.change('input', 'test-secret', 'password')
  await app.save()
  assert.equal(app.writes.length, 1)
  assert.match(app.find(node => node.props.role === 'alert').children.join(''), /partial/)
  assert.equal(app.find(node => node.type === 'input' && node.props.type === 'password').props.value, 'test-secret')
})
