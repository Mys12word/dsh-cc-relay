window.__ModuleLoader__.load({
  id: 'dsh-cc-relay',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const sources = ['tags', 'claudeCode', 'codex', 'anthropic', 'openaiChat', 'openaiResponses']
    const labels = {
      zh: {
        title: '思考转换统计', total: '已转换的思考块',
        scope: '累计当前 DSH 宿主自本次启用以来的转换，不含模型原生思考。刷新页面不清零；重启 DSH 或重新启用插件会清零。',
        loading: '正在读取转换统计…', ready: '统计已同步。',
        unavailable: '暂时无法读取统计，将自动重试。', stale: '更新失败，当前显示上次读取的统计，将自动重试。',
        tags: '思考标签', claudeCode: 'Claude Code / Agent SDK', codex: 'Codex',
        anthropic: 'Anthropic Messages', openaiChat: 'OpenAI Chat Completions', openaiResponses: 'OpenAI Responses',
      },
      en: {
        title: 'Reasoning conversions', total: 'Converted reasoning blocks',
        scope: 'Counts this DSH host since activation, excluding native reasoning. Reloading this page keeps the count; restarting DSH or re-enabling the plugin resets it.',
        loading: 'Loading conversion statistics…', ready: 'Statistics synced.',
        unavailable: 'Could not load statistics. Will retry automatically.', stale: 'Showing the last available counts. Will retry automatically.',
        tags: 'Reasoning tags', claudeCode: 'Claude Code / Agent SDK', codex: 'Codex',
        anthropic: 'Anthropic Messages', openaiChat: 'OpenAI Chat Completions', openaiResponses: 'OpenAI Responses',
      },
    }
    const row = {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
      minHeight: 36, padding: '6px 2px', borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      fontSize: 13, lineHeight: '20px',
    }
    const secondary = { color: 'var(--dsw-alias-label-secondary)' }
    const valueStyle = { margin: 0, flexShrink: 0, textAlign: 'end', fontVariantNumeric: 'tabular-nums' }
    const statusStyle = { ...secondary, margin: 0, fontSize: 13, lineHeight: '20px' }
    const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }
    const validCount = n => Number.isSafeInteger(n) && n >= 0

    function Statistics({ t }) {
      const [{ stats, failed }, setState] = useState({ stats: undefined, failed: false })
      useEffect(() => {
        const controller = new AbortController()
        let timer
        async function refresh() {
          try {
            const result = await fetch('api/dsh-cc-relay/reasoning-conversions', {
              cache: 'no-store', mode: 'same-origin', credentials: 'same-origin', redirect: 'error',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
            })
            if (!result.ok) throw new Error('Statistics unavailable')
            const data = await result.json()
            if (!validCount(data?.total) || !sources.every(key => validCount(data.bySource?.[key])) ||
                sources.reduce((sum, key) => sum + data.bySource[key], 0) !== data.total) throw new Error('Invalid statistics')
            if (!controller.signal.aborted) setState(previous => !previous.failed &&
              previous.stats?.total === data.total && sources.every(key => previous.stats.bySource[key] === data.bySource[key])
              ? previous : { stats: data, failed: false })
          } catch {
            if (!controller.signal.aborted) setState(previous => previous.failed ? previous : { ...previous, failed: true })
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(refresh, 5000)
          }
        }
        void refresh()
        return () => { controller.abort(); clearTimeout(timer) }
      }, [])
      const renderRow = (key, count, total = false) => h('div', { key, style: row },
        h('dt', { style: total ? { fontWeight: 600 } : secondary }, t(key)),
        h('dd', { style: total ? { ...valueStyle, fontWeight: 600 } : valueStyle }, count.toLocaleString()),
      )
      return h('section', { 'aria-label': t('title'), style: { display: 'grid', gap: 8 } },
        h('h4', { style: { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 500 } }, t('title')),
        h('p', { style: { ...secondary, margin: 0, fontSize: 12, lineHeight: '18px' } }, t('scope')),
        h('p', { role: 'status', style: stats && !failed ? visuallyHidden : statusStyle },
          t(failed ? (stats ? 'stale' : 'unavailable') : (stats ? 'ready' : 'loading'))),
        stats && h('dl', { style: { margin: 0 } }, renderRow('total', stats.total, true), ...sources.map(key => renderRow(key, stats.bySource[key]))),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('ccRelayStats', labels), 'cc-relay: statistics locale')
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section', id: 'cc-relay-reasoning-stats', locale: 'ccRelayStats',
        }, ({ subject, t }) => subject.kind === 'bundle' && subject.pkg.name === 'dsh-cc-relay' ? h(Statistics, { t }) : null))
      },
    }
  },
})
