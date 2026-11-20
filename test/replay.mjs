// Replay a real session log through the usageBySource fold and compare its
// totals with an independent sum over the same durable usage events.
//
// Usage: node --experimental-strip-types? (plain JS) test/replay.mjs <session.v4.jsonl.zstd>

import fs from 'node:fs'
import zlib from 'node:zlib'
import { apply } from '../index.js'

let definition
await apply({ sessionProjections: { register: async candidate => { definition = candidate } } })
if (definition === undefined) throw new Error('plugin did not register a projection')

const MAGIC = 0xfd2fb528

function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length) {
    const magic = buf.readUInt32LE(off)
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      const size = buf.readUInt32LE(off + 4)
      frames.push([off, off + 8 + size])
      off += 8 + size
      continue
    }
    if (magic !== MAGIC) { off += 1; continue }
    let p = off + 4
    const fhd = buf[p]; p += 1
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    if (!singleSegment) p += 1
    p += [0, 1, 2, 4][dictFlag]
    p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]
    for (;;) {
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      const last = bh & 1
      const size = bh >> 3
      p += 3 + size
      if (last) break
      if (p > buf.length) throw new Error('frame overrun')
    }
    if (checksum) p += 4
    frames.push([off, p])
    off = p
  }
  return frames
}

function decode(file) {
  const buf = fs.readFileSync(file)
  const parts = []
  for (const [a, b] of splitFrames(buf)) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))) } catch {}
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
    .flatMap(raw => { try { return [JSON.parse(raw)] } catch { return [] } })
}

const file = process.argv[2]
if (file === undefined) { console.error('need a session log'); process.exit(2) }
const events = decode(file)

const bucketsOf = usage => usage === undefined || usage === null ? undefined : {
  uncachedInputTokens: usage.inputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  outputTokens: usage.outputTokens,
}

let state = definition.init({}, 0)
let expected = 0
let assistantEvents = 0
let compactionEvents = 0
let retries = 0
for (const event of events) {
  state = definition.apply(state, event)
  if (event.type === 'llm/retry-started') retries += 1
  if (event.type === 'assistant/message') {
    assistantEvents += 1
    const buckets = bucketsOf(event.data.usage)
    if (buckets !== undefined) expected += buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
  }
  if (event.type === 'compaction/summary') {
    compactionEvents += 1
    const buckets = bucketsOf(event.data.usage)
    if (buckets !== undefined) expected += buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
  }
}

const wire = definition.wire.view(state)
definition.stateSchema.parse(state)
definition.wire.viewSchema.parse(wire)

console.log('events', events.length, 'assistant', assistantEvents, 'compaction', compactionEvents, 'retries', retries)
for (const row of wire.rows) console.log('row', row.source, `${row.provider}/${row.model}`, row.totalTokens)
console.log('projection total', wire.total.totalTokens, 'expected', expected)
if (wire.total.totalTokens !== expected) {
  console.error('MISMATCH')
  process.exit(1)
}
console.log('OK')