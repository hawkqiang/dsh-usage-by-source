/**
 * Composer usage entry: replaces the shipped `usage` dock cell with a
 * source-plus-model breakdown. The figures come from the host projection
 * `usageBySource`; direct subagent sessions are added from their own
 * checkpointed projection values, and the shipped `tokenUsage` total is only
 * a fallback when the host unit is absent.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-usage-by-source',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = '@local/dsh-usage-by-source'

    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (typeof reactDom?.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      // A shell without react-dom still renders the panel inline.
    }

    const zh = {
      'usage.pill': '{value} tok',
      'usage.title': 'Token 用量',
      'usage.input': '非缓存输入', 'usage.output': '输出',
      'usage.cacheRead': '缓存读取', 'usage.cacheWrite': '缓存写入',
      'usage.models': '按模型汇总', 'usage.sources': '按来源汇总', 'usage.grandTotal': '全部模型合计',
      'usage.close': '关闭',
      'usage.accounting': '合计 = 非缓存输入 + 输出 + 缓存读取 + 缓存写入。缓存属于输入，未重复计入非缓存输入；数字来自已记录用量，未单独报告的缓存按 0 计。',
      'usage.colSource': '来源',
      'usage.colModel': '模型',
      'usage.colTokens': '用量',
      'usage.total': '合计',
      'usage.empty': '还没有可统计的用量',
      'usage.cacheHit': '缓存命中 {percent}%',
      'usage.source.main': '主对话',
      'usage.source.compaction': '上下文压缩',
      'usage.source.subagent': '子代理',
      'usage.source.other': '其他',
      'usage.unknownModel': '模型未记录',
      'usage.buckets': '输入 {input} · 缓存读 {cacheRead} · 缓存写 {cacheWrite} · 输出 {output}',
      'usage.note.subagent': '子代理用量取自其会话检查点，可能略滞后。',
      'usage.note.noSource': '按来源的统计暂不可用，只显示会话合计。',
    }

    const en = {
      'usage.pill': '{value} tok',
      'usage.title': 'Token usage',
      'usage.input': 'Uncached input', 'usage.output': 'Output',
      'usage.cacheRead': 'Cache read', 'usage.cacheWrite': 'Cache write',
      'usage.models': 'By model', 'usage.sources': 'By source', 'usage.grandTotal': 'All models total',
      'usage.close': 'Close',
      'usage.accounting': 'Total = uncached input + output + cache read + cache write. Cache is input but is not counted twice. Counts reflect logged usage; unreported cache buckets count as 0.',
      'usage.colSource': 'Source',
      'usage.colModel': 'Model',
      'usage.colTokens': 'Tokens',
      'usage.total': 'Total',
      'usage.empty': 'No billed usage yet',
      'usage.cacheHit': 'Cache hit {percent}%',
      'usage.source.main': 'Main chat',
      'usage.source.compaction': 'Compaction',
      'usage.source.subagent': 'Subagents',
      'usage.source.other': 'Other',
      'usage.unknownModel': 'Model not recorded',
      'usage.buckets': 'Input {input} · cache read {cacheRead} · cache write {cacheWrite} · output {output}',
      'usage.note.subagent': 'Subagent usage comes from their session checkpoints and may lag slightly.',
      'usage.note.noSource': 'Usage by source is unavailable, so only the session total is shown.',
    }

    const FALLBACKS = zh

    /** Translate through the slot's locale seat, with a local fallback for a missing seat. */
    function translate(t, key, values) {
      if (typeof t === 'function') {
        const text = t(key, values)
        if (text !== key) return text
      }
      const template = FALLBACKS[key] ?? key
      if (values === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match))
    }

    /** Group thousands without depending on the browser locale. */
    function exact(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Compact token count: 517 / 12.2K / 517K / 1.2M. */
    function compact(value) {
      const scaled = candidate => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1_000) return String(value)
      if (value < 1_000_000) return `${scaled(value / 1_000)}K`
      if (value < 1_000_000_000) return `${scaled(value / 1_000_000)}M`
      return `${scaled(value / 1_000_000_000)}B`
    }

    const ZERO = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 }

    /** Sum bucket records. */
    function addBuckets(left, right) {
      return {
        uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
        cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
        cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        totalTokens: left.totalTokens + right.totalTokens,
      }
    }

    /** Merge routes across calls and descendants without adding projection totals again. */
    function groupUsageRows(rows, bySource) {
      const groups = new Map()
      for (const row of rows) {
        const key = JSON.stringify(bySource ? [row.source] : [row.provider, row.model])
        const previous = groups.get(key)
        groups.set(key, { ...row, key, buckets: addBuckets(previous?.buckets ?? ZERO, row.buckets) })
      }
      return [...groups.values()].sort((a, b) => b.buckets.totalTokens - a.buckets.totalTokens || a.key.localeCompare(b.key))
    }

    const COLUMNS = [
      ['uncachedInputTokens', 'usage.input'], ['outputTokens', 'usage.output'],
      ['cacheReadTokens', 'usage.cacheRead'], ['cacheWriteTokens', 'usage.cacheWrite'],
      ['totalTokens', 'usage.total'],
    ]
    function bucketCard(key, label, buckets, t) {
      return h('section', { className: 'dsu-card', key },
        h('h3', { className: 'dsu-cardTitle' }, label),
        h('dl', { className: 'dsu-metrics' }, ...COLUMNS.map(([field, title]) =>
          h('div', { key: field }, h('dt', null, translate(t, title)), h('dd', null, exact(buckets[field]))))))
    }

    /** Billed prompt tokens: the three disjoint prompt-side buckets. */
    function promptTokens(buckets) {
      return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
    }

    /** Cache-hit percentage text, or null without prompt input. */
    function cacheHitText(buckets, t) {
      const prompt = promptTokens(buckets)
      if (prompt === 0) return null
      const percent = Math.min(100, Math.round((buckets.cacheReadTokens / prompt) * 1000) / 10)
      return translate(t, 'usage.cacheHit', { percent })
    }

    /** One source/model display label. */
    function modelText(row, t) {
      if (row.provider !== '' && row.model !== '') return `${row.provider}/${row.model}`
      if (row.model !== '') return row.model
      if (row.provider !== '') return row.provider
      return translate(t, 'usage.unknownModel')
    }

    /** Small database glyph for the pill and dialog heading. */
    function glyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none' },
        h('ellipse', { cx: 8, cy: 4, rx: 5.5, ry: 2.25, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M2.5 4v8c0 1.24 2.46 2.25 5.5 2.25s5.5-1.01 5.5-2.25V4', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M2.5 8c0 1.24 2.46 2.25 5.5 2.25s5.5-1.01 5.5-2.25', stroke: 'currentColor', strokeWidth: 1.2 }))
    }

    const CSS = `
      .dsu-anchor { display: inline-flex; min-width: 0; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
      .dsu-pill { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; max-width: 100%; padding: 1px 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap; }
      .dsu-pill svg { width: 14px; height: 14px; flex: none; }
      button.dsu-pill { cursor: pointer; }
      button.dsu-pill[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
      @media (hover: hover) { button.dsu-pill:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); } }
      .dsu-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .dsu-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: min(440px, calc(100vw - 24px)); padding: 14px 16px; border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; cursor: default; }
      .dsu-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--dsw-alias-label-primary); font-weight: 500; }
      .dsu-head .dsu-heading { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .dsu-head .dsu-heading svg { flex: none; }
      .dsu-head .dsu-headTotal { font-variant-numeric: tabular-nums; }
      .dsu-rule { margin: 8px 0 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .dsu-table { display: flex; flex-direction: column; gap: 6px; }
      .dsu-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; align-items: baseline; gap: 10px; }
      .dsu-row.dsu-columns { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
      .dsu-source { color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dsu-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
      .dsu-count { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
      .dsu-row.dsu-totalRow { margin-top: 2px; padding-top: 6px; border-top: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); font-weight: 500; }
      .dsu-row.dsu-totalRow .dsu-source, .dsu-row.dsu-totalRow .dsu-count { color: var(--dsw-alias-label-primary); }
      .dsu-empty { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); }
      .dsu-panel { max-height: calc(100dvh - 24px); overflow-y: auto; }
      .dsu-card { padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
      .dsu-cardTitle, .dsu-sectionTitle { margin: 0 0 8px; font: inherit; font-weight: 600; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
      .dsu-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; margin: 0; }
      .dsu-metrics dt { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
      .dsu-metrics dd { margin: 2px 0 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .dsu-sources { margin-top: 12px; }
      .dsu-sources summary { cursor: pointer; }
      .dsu-close { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; padding: 4px; }
      @media (max-width: 380px) { .dsu-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      .dsu-note { margin: 10px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
    `

    /** The composer entry: a reading pill plus its portaled breakdown dialog. */
    function UsageBySource(props) {
      const { sessionId, useProjection, useSessions, usePerformanceUsage, t } = props
      const mode = usePerformanceUsage(value => value)
      const usage = useProjection('usageBySource')
      const shipped = useProjection('tokenUsage')
      const sessionList = useSessions(state => state)
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState({ bottom: 64, left: 12 })
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const rows = React.useMemo(() => {
        const collected = []
        if (usage !== undefined && usage !== null && Array.isArray(usage.rows)) {
          for (const row of usage.rows) collected.push({ source: row.source, provider: row.provider, model: row.model, buckets: row })
        }
        // Every descendant subagent session is part of this conversation's
        // spend. Each child carries its own projection value; walk direct
        // children and their children through the session list's parent links.
        const byId = sessionList?.byId
        const projections = sessionList?.projectionsBySession
        if (usage !== undefined && usage !== null && byId !== undefined) {
          const childrenByParent = new Map()
          for (const id of Object.keys(byId)) {
            const summary = byId[id]
            if (summary === undefined || summary.origin !== 'subagent' || summary.parentSessionId === undefined) continue
            const siblings = childrenByParent.get(summary.parentSessionId)
            if (siblings === undefined) childrenByParent.set(summary.parentSessionId, [id])
            else siblings.push(id)
          }
          const queue = [sessionId]
          const seen = new Set(queue)
          while (queue.length > 0) {
            const parent = queue.shift()
            for (const child of childrenByParent.get(parent) ?? []) {
              if (seen.has(child)) continue
              seen.add(child)
              queue.push(child)
              const value = projections?.[child]?.values?.['usageBySource']
              if (value === undefined || value === null || !Array.isArray(value.rows)) continue
              for (const row of value.rows) {
                collected.push({ source: 'subagent', provider: row.provider, model: row.model, buckets: row })
              }
            }
          }
        }
        collected.sort((left, right) => right.buckets.totalTokens - left.buckets.totalTokens
          || left.source.localeCompare(right.source)
          || left.model.localeCompare(right.model))
        return collected
      }, [usage, sessionList, sessionId])

      const models = React.useMemo(() => groupUsageRows(rows, false), [rows])
      const sources = React.useMemo(() => groupUsageRows(rows, true), [rows])
      const summed = React.useMemo(() => {
        let buckets = { ...ZERO }
        for (const row of rows) buckets = addBuckets(buckets, row.buckets)
        return buckets
      }, [rows])

      const legacy = usage === undefined || usage === null
      const legacyBuckets = legacy && shipped !== undefined && shipped !== null
        ? {
            uncachedInputTokens: shipped.uncachedInputTokens,
            cacheReadTokens: shipped.cacheReadTokens,
            cacheWriteTokens: shipped.cacheWriteTokens,
            outputTokens: shipped.outputTokens,
            totalTokens: shipped.uncachedInputTokens + shipped.cacheReadTokens + shipped.cacheWriteTokens + shipped.outputTokens,
          }
        : null
      const total = legacy ? (legacyBuckets ?? ZERO) : summed
      const hasAny = total.totalTokens > 0

      React.useEffect(() => {
        if (!open) return undefined
        const close = event => { if (event.key === 'Escape') setOpen(false) }
        const outside = event => {
          if (panelRef.current?.contains(event.target)) return
          if (rootRef.current?.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', close)
        document.addEventListener('pointerdown', outside, true)
        return () => {
          document.removeEventListener('keydown', close)
          document.removeEventListener('pointerdown', outside, true)
        }
      }, [open])

      if (!hasAny) return null

      const hit = cacheHitText(total, t)

      const toggle = () => {
        if (!open) {
          const rect = rootRef.current?.getBoundingClientRect()
          if (rect !== undefined) {
            setPosition({
              bottom: Math.max(8, window.innerHeight - rect.top + 8),
              left: Math.max(12, Math.min(rect.left, window.innerWidth - 452)),
            })
          }
        }
        setOpen(!open)
      }

      const panel = open
        ? h('div', {
            ref: panelRef,
            className: 'dsu-panel',
            role: 'dialog',
            'aria-label': translate(t, 'usage.title'),
            style: { bottom: `${position.bottom}px`, left: `${position.left}px`, maxHeight: `calc(100dvh - ${position.bottom + 12}px)` },
          },
          h('div', { className: 'dsu-head' },
            h('span', { className: 'dsu-heading' }, glyph(), translate(t, 'usage.title')),
            h('span', { className: 'dsu-headTotal' }, exact(total.totalTokens)),
            h('button', { type: 'button', className: 'dsu-close', onClick: () => { setOpen(false); rootRef.current?.querySelector('button')?.focus() } }, translate(t, 'usage.close'))),
          h('div', { className: 'dsu-rule', 'aria-hidden': true }),
          legacy
            ? h('p', { className: 'dsu-note' }, translate(t, 'usage.note.noSource'))
            : h('div', null,
                h('h2', { className: 'dsu-sectionTitle' }, translate(t, 'usage.models')),
                ...models.map(row => bucketCard(row.key, modelText(row, t), row.buckets, t))),
          bucketCard('grand-total', translate(t, 'usage.grandTotal'), total, t),
          !legacy && sources.length > 0 ? h('details', { className: 'dsu-sources' },
            h('summary', null, translate(t, 'usage.sources')),
            ...sources.map(row => bucketCard(row.key, translate(t, `usage.source.${row.source}`), row.buckets, t))) : null,
          h('p', { className: 'dsu-note' }, translate(t, 'usage.accounting')),
          rows.some(row => row.source === 'subagent')
            ? h('p', { className: 'dsu-note' }, translate(t, 'usage.note.subagent'))
            : null)
        : null

      return h('span', { ref: rootRef, className: 'dsu-anchor', 'data-composer-stat': 'usage' },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'dsu-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': `${translate(t, 'usage.title')} · ${exact(total.totalTokens)}`,
          onClick: toggle,
        },
        glyph(),
        h('span', { className: 'dsu-label' },
          mode === 'compact' && hit !== null ? hit : translate(t, 'usage.pill', { value: compact(total.totalTokens) }),
          mode !== 'compact' && hit !== null ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, ` · ${hit}`) : null)),
        null,
        panel !== null && createPortal !== null ? createPortal(panel, document.body) : panel)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-by-source: dictionaries')
        const mode = createModeStore(ctx)
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'usage',
          // Lower priority shadows the shipped priority-0 cell; order only positions it.
          priority: -1,
          order: 1,
          locale: NS,
          inject: () => ({ hooks: { performanceUsage: mode } }),
        }, UsageBySource))
      },
    }
  },
})

/** Read the chat performance-usage preference into a local observable. */
function createModeStore(ctx) {
  let value = 'detailed'
  const listeners = new Set()
  const store = {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const set = next => {
    if (next !== 'compact' && next !== 'detailed') return
    if (next === value) return
    value = next
    for (const listener of listeners) listener()
  }
  ctx.inject(['configForms'], scope => {
    let form
    try {
      form = scope.configForms.get('ui-chat')
    } catch {
      return
    }
    if (form === undefined || typeof form.getSnapshot !== 'function') return
    const adopt = () => { set(form.getSnapshot()?.value?.performanceUsage) }
    adopt()
    const off = form.subscribe(adopt)
    ctx.effect(() => () => { off() })
  })
  return store
}