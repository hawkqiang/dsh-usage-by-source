/**
 * Token usage by caller source and model.
 *
 * One client-visible session projection (`usageBySource`) folded from the
 * durable log: every billed Assistant settlement is attributed to the caller
 * it ran for (`main`) and to its provider/model route, while a compaction
 * summary's own model call is attributed to `compaction`. The client renders
 * the breakdown in the composer usage dialog and adds direct subagent
 * sessions from their own checkpoints.
 *
 * The wire value is the state's `wire` object, so an event that only moves
 * bookkeeping (`header`, `last`) publishes nothing.
 */

const KEY = 'usageBySource'
const VERSION = 1

const SOURCE_MAIN = 'main'
const SOURCE_COMPACTION = 'compaction'

const BUCKET_FIELDS = [
  'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens',
]

/** A fresh all-zero bucket record. */
function zeroBuckets() {
  return {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0,
  }
}

/** Non-negative safe integer test used by the state and view schemas. */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Validate the five bucket fields on any record that carries them. */
function parseBucketFields(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('usageBySource: bucket record must be an object')
  }
  for (const field of BUCKET_FIELDS) {
    if (!isCount(value[field])) throw new Error(`usageBySource: ${field} must be a non-negative integer`)
  }
  if (value.totalTokens !== value.uncachedInputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens) {
    throw new Error('usageBySource: totalTokens must equal the bucket sum')
  }
  return value
}

/** Validate a standalone bucket record in place and return it. */
function parseBuckets(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('usageBySource: bucket record must be an object')
  }
  if (Object.keys(value).length !== BUCKET_FIELDS.length) throw new Error('usageBySource: bucket record has wrong fields')
  return parseBucketFields(value)
}

/** Validate one route row: source/provider/model plus buckets. */
function parseRow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('usageBySource: row must be an object')
  }
  const expected = ['source', 'provider', 'model', ...BUCKET_FIELDS].sort().join(',')
  if (Object.keys(value).sort().join(',') !== expected) throw new Error('usageBySource: row has wrong fields')
  if (typeof value.source !== 'string' || typeof value.provider !== 'string' || typeof value.model !== 'string') {
    throw new Error('usageBySource: row attribution must be strings')
  }
  parseBucketFields(value)
  return value
}

/** Validate the client wire value. */
function parseWire(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('usageBySource: wire value must be an object')
  }
  if (!Array.isArray(value.rows)) throw new Error('usageBySource: rows must be an array')
  for (const row of value.rows) parseRow(row)
  parseBuckets(value.total)
  return value
}

/** Validate the checkpointed host state. */
function parseState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('usageBySource: state must be an object')
  }
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'header,last,wire') throw new Error('usageBySource: state has wrong fields')
  parseWire(value.wire)
  if (value.header !== null) {
    if (typeof value.header !== 'object' || typeof value.header.provider !== 'string' || typeof value.header.model !== 'string') {
      throw new Error('usageBySource: header must be null or a route')
    }
  }
  if (value.last !== null) {
    const last = value.last
    if (typeof last !== 'object' || !isCount(last.turn) || !isCount(last.step) || typeof last.key !== 'string') {
      throw new Error('usageBySource: last must be null or a replacement slot')
    }
    parseBuckets(last.buckets)
  }
  return value
}

const stateSchema = { parse: parseState }
const wireSchema = { parse: parseWire }

/** Sum two bucket records. */
function addBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  }
}

/** Subtract one bucket record from another, flooring each field at zero. */
function subtractBuckets(left, right) {
  return {
    uncachedInputTokens: Math.max(0, left.uncachedInputTokens - right.uncachedInputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    totalTokens: Math.max(0, left.totalTokens - right.totalTokens),
  }
}

/** Structural bucket equality used to skip a redundant replacement. */
function equalBuckets(left, right) {
  return BUCKET_FIELDS.every(field => left[field] === right[field])
}

/** Stable row identity. */
function rowKey(source, provider, model) {
  return `${source}\u0000${provider}\u0000${model}`
}

/** Split a row identity back into its three attribution fields. */
function rowParts(key) {
  const [source, provider, model] = key.split('\u0000')
  return { source, provider, model }
}

/** One source/provider/model row from fresh buckets. */
function makeRow(source, provider, model, buckets) {
  return { source, provider, model, ...buckets }
}

/** Add buckets to the route row, creating it on first use. */
function addRow(wire, source, provider, model, buckets) {
  const rows = wire.rows.slice()
  const index = rows.findIndex(row => row.source === source && row.provider === provider && row.model === model)
  if (index === -1) rows.push(makeRow(source, provider, model, buckets))
  else rows[index] = { ...rows[index], ...addBuckets(rows[index], buckets) }
  return { rows, total: addBuckets(wire.total, buckets) }
}

/** Remove buckets from one route row, dropping it once it is empty. */
function subtractRow(wire, key, buckets) {
  const { source, provider, model } = rowParts(key)
  const index = wire.rows.findIndex(row => row.source === source && row.provider === provider && row.model === model)
  if (index === -1) return wire
  const next = subtractBuckets(wire.rows[index], buckets)
  const rows = next.totalTokens === 0
    ? wire.rows.filter((_row, position) => position !== index)
    : wire.rows.with(index, { ...wire.rows[index], ...next })
  return { rows, total: subtractBuckets(wire.total, buckets) }
}

/** Provider-reported buckets from one usage sample, when it is complete enough to account. */
function readUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  const cacheReadTokens = usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens
  const cacheWriteTokens = usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens
  if (!isCount(cacheReadTokens) || !isCount(cacheWriteTokens)) return undefined
  return {
    uncachedInputTokens: usage.inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + cacheReadTokens + cacheWriteTokens + usage.outputTokens,
  }
}

/** Last usage chunk of a durable Assistant stream, mirroring the built-in token meter. */
function usageOf(data) {
  if (data === null || typeof data !== 'object') return undefined
  const direct = readUsage(data.usage)
  if (direct !== undefined) return direct
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk
    if (chunk?.type === 'usage') {
      const parsed = readUsage(chunk.usage ?? chunk)
      if (parsed !== undefined) return parsed
    }
  }
  return undefined
}

/** Provider/model route recorded on a settled Assistant message. */
function routeOf(event) {
  const source = event.data?.message?.source
  if (source === null || typeof source !== 'object') return undefined
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined
  if (source.provider === '' || source.model === '') return undefined
  return { provider: source.provider, model: source.model }
}

/** Provider/model route of the newest request envelope. */
function headerRouteOf(event) {
  const config = event.data?.header?.config
  if (config === null || typeof config !== 'object') return undefined
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
  return { provider: config.provider, model: config.model }
}

/** Same-route test. */
function sameRoute(left, right) {
  return left !== null && left !== undefined && left.provider === right.provider && left.model === right.model
}

const definition = {
  key: KEY,
  stateVersion: VERSION,
  stateSchema,
  init: () => ({ wire: { rows: [], total: zeroBuckets() }, last: null, header: null }),
  apply: (state, event) => {
    if (event.type === 'request/header') {
      const route = headerRouteOf(event)
      if (route === undefined) return state
      if (sameRoute(state.header, route)) return state
      return { ...state, header: route }
    }
    if (event.type === 'llm/retry-started') {
      const { turn, step } = event.data
      if (state.last === null || state.last.turn !== turn || state.last.step !== step) return state
      return { ...state, last: null }
    }
    if (event.type === 'compaction/summary') {
      const usage = usageOf(event.data)
      if (usage === undefined) return state
      const provider = typeof event.data.provider === 'string' ? event.data.provider : ''
      const model = typeof event.data.model === 'string' ? event.data.model : ''
      return { ...state, wire: addRow(state.wire, SOURCE_COMPACTION, provider, model, usage) }
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const usage = usageOf(event.data)
    if (usage === undefined) return state
    const { turn, step } = event.data
    const route = (event.type === 'assistant/message' ? routeOf(event) : undefined)
      ?? state.header
      ?? { provider: '', model: '' }
    const key = rowKey(SOURCE_MAIN, route.provider, route.model)
    if (state.last !== null && state.last.turn === turn && state.last.step === step) {
      if (state.last.key === key && equalBuckets(state.last.buckets, usage)) return state
      const wire = addRow(subtractRow(state.wire, state.last.key, state.last.buckets), SOURCE_MAIN, route.provider, route.model, usage)
      return { ...state, wire, last: { turn, step, key, buckets: usage } }
    }
    return {
      ...state,
      wire: addRow(state.wire, SOURCE_MAIN, route.provider, route.model, usage),
      last: { turn, step, key, buckets: usage },
    }
  },
  wire: { viewSchema: wireSchema, view: state => state.wire },
}

export const name = '@local/dsh-usage-by-source'
export const inject = ['sessionProjections']

/**
 * Register the usage-by-source projection.
 * @param ctx - plugin context.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(definition)
}