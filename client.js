window.__ModuleLoader__.load({
  id: 'dsh-cc-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-cc-relay'
    const dictionaries = {
      zh: {
        title: 'CC 中转配置', endpoint: 'Base URL', key: 'API Key', models: '模型 ID（每行一个）',
        mode: '认证方式', compat: '启用 CC 请求兼容', save: '保存', saving: '保存中…',
        loading: '加载中…', saved: '已保存，在对话模型选择器选择 CC 中转下的模型。',
        keySaved: '已有密钥，留空保留', keyEmpty: '填写你的中转站密钥',
        retry: '重新加载', required: '请填写完整 HTTP(S) 地址和至少一个模型 ID。',
        invalid: 'Base URL 不能包含账号、密码、查询参数或 fragment。',
        partial: '地址和模型已保存，密钥保存失败，请重新填写后保存。',
        note: '使用中转站给出的精确模型 ID；此处不自动测试网络或消耗额度。',
        configured: '已配置模型 · 仅 CC', ccOnly: '仅 CC', filter: '搜索提供方或模型', noModels: '暂无已配置模型。',
        reuse: '勾选后复用原提供方的地址和 API Key，继续选择原模型即可；取消勾选恢复原调用。思考使用上游默认值，原思考档位不转发。',
        sourceRequired: '请先在原提供方保存 Base URL 和 API Key。', missingSource: '原提供方已移除，可取消此标记。',
        flagsSaved: '已保存仅 CC 设置，下次请求生效。', sourceChanged: '原提供方配置已变化，请重新加载后保存。',
      },
      en: {
        title: 'CC relay settings', endpoint: 'Base URL', key: 'API key', models: 'Model IDs (one per line)',
        mode: 'Authentication', compat: 'Enable CC request compatibility', save: 'Save', saving: 'Saving…',
        loading: 'Loading…', saved: 'Saved. Select a model under CC relay in the conversation model picker.',
        keySaved: 'Key saved; leave blank to keep it', keyEmpty: 'Enter your relay API key',
        retry: 'Reload', required: 'Enter a full HTTP(S) URL and at least one model ID.',
        invalid: 'The URL must not include credentials, a query, or a fragment.',
        partial: 'Address and models saved, but the key was not saved. Re-enter the key and save.',
        note: 'Use exact model IDs from your relay. Saving does not test the endpoint or consume model credits.',
        configured: 'Configured models · CC only', ccOnly: 'CC only', filter: 'Search provider or model', noModels: 'No configured models.',
        reuse: 'Reuse the original endpoint and API key and keep selecting the same model. Uncheck to restore its original adapter. Reasoning uses the upstream default; original effort controls are not forwarded.',
        sourceRequired: 'Save a Base URL and API key in the original provider first.', missingSource: 'The original provider was removed; you can clear this flag.',
        flagsSaved: 'CC-only settings saved for subsequent requests.', sourceChanged: 'Source settings changed. Reload before saving.',
      },
    }
    const css = `.cc-relay-form{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}.cc-relay-form summary{cursor:pointer;font-weight:500}.cc-relay-form label{display:flex;flex-direction:column;gap:5px}.cc-relay-form input:not([type=checkbox]),.cc-relay-form textarea,.cc-relay-form select{box-sizing:border-box;max-width:100%;width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 10px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill)}.cc-relay-form input:focus-visible,.cc-relay-form textarea:focus-visible,.cc-relay-form select:focus-visible,.cc-relay-form button:focus-visible{outline:2px solid var(--dsw-alias-state-info-label);outline-offset:2px}.cc-relay-form .cc-relay-check{display:flex;flex-direction:row;align-items:center;gap:8px}.cc-relay-form button{font:inherit;padding:8px 14px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);cursor:pointer;align-self:flex-start}.cc-relay-form button:disabled{opacity:.55;cursor:default}.cc-relay-form .cc-relay-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0}.cc-relay-form .cc-relay-error{color:var(--dsw-alias-state-error-primary);margin:0}.cc-relay-form .cc-relay-saved{color:var(--dsw-alias-state-success-primary);margin:0}.cc-relay-form fieldset{border:0;padding:0;margin:10px 0 0;min-width:0;display:flex;flex-direction:column;gap:12px}`
    function createCard(ctx, t) {
      return function RelaySettings(props) {
        const ns = props.provider?.settingsNs ?? 'cc-relay'
        const [view, setView] = React.useState(null)
        const [endpoint, setEndpoint] = React.useState('')
        const [models, setModels] = React.useState('')
        const [key, setKey] = React.useState('')
        const [mode, setMode] = React.useState('bearer')
        const [compat, setCompat] = React.useState(true)
        const [hasKey, setHasKey] = React.useState(props.keyConfigured === true)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        const [saved, setSaved] = React.useState(false)
        const [reload, setReload] = React.useState(0)
        const mounted = React.useRef(false)
        const saving = React.useRef(false)
        const [expanded, setExpanded] = React.useState(true)
        React.useEffect(() => {
          mounted.current = true
          let active = true
          setError('')
          ;(async () => {
            try {
              const response = await ctx.remote.settings.describe()
              if (!response.ok) throw new Error(response.error.message)
              const found = response.value.namespaces.find(item => item.ns === ns)
              if (!found) throw new Error(`Settings namespace unavailable: ${ns}`)
              const ref = found.value.apiKeyEnv || 'CC_RELAY_API_KEY'
              const credential = await ctx.remote.credentials.describe([ref])
              if (!credential.ok) throw new Error(credential.error.message)
              if (!active) return
              setView({ ...found, writable: response.value.writable })
              setEndpoint(found.value.baseURL || '')
              setModels((found.value.models || []).map(item => item.id).join('\n'))
              setMode(found.value.authMode || 'bearer')
              setCompat(found.value.compatibility?.enabled !== false)
              setHasKey(credential.value[ref]?.configured === true)
            } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Settings unavailable') }
          })()
          return () => { active = false; mounted.current = false }
        }, [ns, reload])
        const save = async event => {
          event.preventDefault()
          if (saving.current || busy || !view) return
          saving.current = true
          setBusy(true); setError(''); setSaved(false)
          try {
            const ids = [...new Set(models.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
            if (!endpoint.trim() || !ids.length) throw new Error(t('required'))
            let url
            try { url = new URL(endpoint.trim()) } catch { throw new Error(t('required')) }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(t('invalid'))
            const existing = view.value.models || []
            const nextModels = ids.map(id => existing.find(item => item.id === id) || { id, input: ['text', 'image'] })
            const response = await ctx.remote.settings.mutate(ns, [
              { op: 'set', path: ['baseURL'], value: endpoint.trim() },
              { op: 'set', path: ['models'], value: nextModels },
              { op: 'set', path: ['authMode'], value: mode },
              { op: 'set', path: ['compatibility', 'enabled'], value: compat },
            ], view.revision)
            if (!response.ok) throw new Error(response.error.message)
            if (mounted.current) setView({ ...response.value, writable: view.writable })
            if (key.trim()) {
              const ref = response.value.value.apiKeyEnv || 'CC_RELAY_API_KEY'
              const stored = await ctx.remote.credentials.set(ref, key.trim())
              if (!stored.ok) throw new Error(`${t('partial')} ${stored.error.message}`)
              if (mounted.current) { setHasKey(true); setKey('') }
            }
            if (mounted.current) setSaved(true)
          } catch (failure) {
            if (mounted.current) setError(failure instanceof Error ? failure.message : 'Save failed')
          } finally { saving.current = false; if (mounted.current) setBusy(false) }
        }
        const field = (label, control) => h('label', null, h('span', null, label), control)
        return h('details', { className: 'cc-relay-form', open: expanded, onToggle: event => setExpanded(event.currentTarget.open) },
          h('style', null, css),
          h('summary', null, t('title')),
          !view ? h('p', { className: 'cc-relay-note' }, t('loading')) : h('form', { onSubmit: save },
            h('fieldset', { disabled: busy || !view.writable },
              field(t('endpoint'), h('input', { value: endpoint, onChange: e => setEndpoint(e.target.value), type: 'url', placeholder: 'https://relay.example', spellCheck: false, autoComplete: 'url', required: true })),
              field(t('key'), h('input', { value: key, onChange: e => setKey(e.target.value), type: 'password', autoComplete: 'new-password', placeholder: t(hasKey ? 'keySaved' : 'keyEmpty'), spellCheck: false })),
              field(t('models'), h('textarea', { value: models, onChange: e => setModels(e.target.value), rows: 4, spellCheck: false, required: true })),
              field(t('mode'), h('select', { value: mode, onChange: e => setMode(e.target.value) }, h('option', { value: 'bearer' }, 'Authorization: Bearer'), h('option', { value: 'x-api-key' }, 'x-api-key'))),
              h('label', { className: 'cc-relay-check' }, h('input', { type: 'checkbox', checked: compat, onChange: e => setCompat(e.target.checked) }), t('compat')),
              h('p', { className: 'cc-relay-note' }, t('note')),
              h('button', { type: 'submit', disabled: busy || !view.writable }, t(busy ? 'saving' : 'save')))),
          error ? h('p', { role: 'alert', className: 'cc-relay-error' }, error) : null,
          !view && error ? h('button', { type: 'button', onClick: () => setReload(value => value + 1) }, t('retry')) : null,
          saved ? h('p', { role: 'status', className: 'cc-relay-saved' }, t('saved')) : null)
      }
    }
    function createConfiguredCard(ctx, t) {
      const identity = row => JSON.stringify([row.provider, row.model])
      const at = (value, path) => path.reduce((node, key) => node && Object.hasOwn(node, key) ? node[key] : undefined, value)
      return function ConfiguredModels() {
        const [view, setView] = React.useState(null)
        const [rows, setRows] = React.useState([])
        const [flags, setFlags] = React.useState([])
        const [filter, setFilter] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        const [saved, setSaved] = React.useState(false)
        const [reload, setReload] = React.useState(0)
        const mounted = React.useRef(false)
        const saving = React.useRef(false)
        React.useEffect(() => {
          mounted.current = true
          let active = true
          setError(''); setView(null)
          ;(async () => {
            try {
              const responses = await Promise.all([ctx.remote.settings.describe(), ctx.remote.llm.listConfigurableProviders(), ctx.remote.session.modelCatalog()])
              for (const response of responses) if (!response.ok) throw new Error(response.error.message)
              const [settings, directory, catalog] = responses.map(response => response.value)
              const config = settings.namespaces.find(item => item.ns === 'cc-relay')
              if (!config) throw new Error('CC settings unavailable')
              const profiles = new Map(directory.map(source => [source.provider, { source, descriptor: settings.namespaces.find(item => item.ns === source.settingsNs) }]))
              const originals = config.value.ccOnlyModels || []
              const result = new Map()
              const add = (provider, model, name) => {
                if (provider === 'cc-relay') return
                const item = profiles.get(provider)
                const profile = item && at(item.descriptor?.value, item.source.settingsPath)
                const unavailable = !profile?.baseURL || !profile?.apiKeyEnv
                const row = { provider, model, name: name || model, unavailable, source: item?.source, sourceRevision: item?.descriptor?.revision }
                result.set(identity(row), row)
              }
              for (const group of catalog.groups) for (const model of group.models) add(group.id, model.id, model.name)
              for (const [provider, item] of profiles) {
                const profile = at(item.descriptor?.value, item.source.settingsPath)
                for (const model of profile?.models || []) add(provider, model.id, model.name)
              }
              for (const flag of originals) if (!result.has(identity(flag))) add(flag.provider, flag.model, flag.model)
              if (!active) return
              setView({ ...config, writable: settings.writable })
              setRows([...result.values()]); setFlags(originals)
            } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Settings unavailable') }
          })()
          return () => { active = false; mounted.current = false }
        }, [reload])
        const update = (row, enabled, mode) => {
          setSaved(false)
          setFlags(previous => {
            const old = previous.find(item => identity(item) === identity(row))
            const next = previous.filter(item => identity(item) !== identity(row))
            if (enabled) next.push({ provider: row.provider, model: row.model, authMode: mode || old?.authMode || 'bearer' })
            return next
          })
        }
        const save = async event => {
          event.preventDefault()
          if (saving.current || !view) return
          saving.current = true; setBusy(true); setError(''); setSaved(false)
          try {
            const latest = await ctx.remote.settings.describe()
            if (!latest.ok) throw new Error(latest.error.message)
            for (const flag of flags) {
              const row = rows.find(item => identity(item) === identity(flag))
              const old = (view.value.ccOnlyModels || []).some(item => identity(item) === identity(flag))
              if ((!row?.source || row.unavailable) && !old) throw new Error(t('sourceRequired'))
              if (row?.source) {
                const descriptor = latest.value.namespaces.find(item => item.ns === row.source.settingsNs)
                if (descriptor?.revision !== row.sourceRevision) throw new Error(t('sourceChanged'))
              }
            }
            const response = await ctx.remote.settings.mutate(view.ns, [{ op: 'set', path: ['ccOnlyModels'], value: flags }], view.revision)
            if (!response.ok) throw new Error(response.error.message)
            if (mounted.current) { setView({ ...response.value, writable: view.writable }); setSaved(true) }
          } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Save failed') }
          finally { saving.current = false; if (mounted.current) setBusy(false) }
        }
        const needle = filter.trim().toLowerCase()
        return h('section', { className: 'cc-relay-form', 'aria-label': t('configured') },
          h('style', null, css), h('h3', null, t('configured')), h('p', { className: 'cc-relay-note' }, t('reuse')),
          !view ? h('p', { className: 'cc-relay-note' }, t('loading')) : h('form', { onSubmit: save },
            h('fieldset', { disabled: busy || !view.writable },
              h('input', { type: 'search', value: filter, placeholder: t('filter'), 'aria-label': t('filter'), onChange: event => setFilter(event.target.value) }),
              ...rows.filter(row => !needle || `${row.provider} ${row.model} ${row.name}`.toLowerCase().includes(needle)).map(row => {
                const flag = flags.find(item => identity(item) === identity(row))
                return h('div', { key: identity(row), className: 'cc-relay-model-row' },
                  h('label', { className: 'cc-relay-check' }, h('input', { type: 'checkbox', checked: !!flag, disabled: row.unavailable && !flag, 'aria-label': `${t('ccOnly')} ${row.provider} / ${row.model}`, onChange: event => update(row, event.target.checked) }),
                    h('span', null, row.name, h('small', { className: 'cc-relay-note' }, ` ${row.provider} / ${row.model}`))),
                  flag ? h('select', { value: flag.authMode || 'bearer', 'aria-label': `${t('mode')} ${row.model}`, onChange: event => update(row, true, event.target.value) }, h('option', { value: 'bearer' }, 'Authorization: Bearer'), h('option', { value: 'x-api-key' }, 'x-api-key')) : null,
                  row.unavailable ? h('p', { className: 'cc-relay-note' }, t(row.source ? 'sourceRequired' : 'missingSource')) : null)
              }),
              !rows.length ? h('p', null, t('noModels')) : null,
              h('button', { type: 'submit', disabled: busy || !view.writable }, t(busy ? 'saving' : 'save')))),
          error ? h('p', { role: 'alert', className: 'cc-relay-error' }, error) : null,
          saved ? h('p', { role: 'status', className: 'cc-relay-saved' }, t('flagsSaved')) : null,
          h('button', { type: 'button', disabled: busy, onClick: () => { setSaved(false); setReload(value => value + 1) } }, t('retry')))
      }
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        const t = ctx.locale.bind(NS)
        const Card = createCard(ctx, t)
        const ConfiguredCard = createConfiguredCard(ctx, t)
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({ name: 'settings.models.provider-card', key: 'cc-relay' }, Card))
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'cc-relay-configured' }, ConfiguredCard))
      },
    }
  },
})
