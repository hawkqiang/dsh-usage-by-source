import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// Execute the production pure aggregation functions, not a duplicate implementation.
const start = source.indexOf('    const ZERO =')
const end = source.indexOf('    const COLUMNS =', start)
assert.ok(start > 0 && end > start)
const { groupUsageRows, collectUsageRows, descendantSessionIds } = vm.runInNewContext(
  `(() => { ${source.slice(start, end)}; return { groupUsageRows, collectUsageRows, descendantSessionIds } })()`,
)
const buckets = (a,b,c,d) => ({ uncachedInputTokens:a, outputTokens:b, cacheReadTokens:c, cacheWriteTokens:d,totalTokens:a+b+c+d })
const rows = [
 {source:'main',provider:'one',model:'m',buckets:buckets(10,20,30,40)},
 {source:'compaction',provider:'one',model:'m',buckets:buckets(1,2,3,4)},
 {source:'subagent',provider:'one',model:'m',buckets:buckets(1,2,3,4)},
 {source:'subagent',provider:'one',model:'m',buckets:buckets(1,2,3,4)},
 {source:'main',provider:'two',model:'m',buckets:buckets(5,6,7,8)},
]
const plain = value => JSON.parse(JSON.stringify(value))
test('same model across calls, sources and children merges once; providers stay distinct', () => {
 const result = groupUsageRows(rows,false)
 assert.equal(result.length,2)
 assert.deepEqual(plain(result.find(r=>r.provider==='one').buckets),buckets(13,26,39,52))
 assert.deepEqual(plain(result.find(r=>r.provider==='two').buckets),buckets(5,6,7,8))
 assert.equal(result.reduce((n,r)=>n+r.buckets.totalTokens,0),156)
 assert.equal(rows[0].buckets.totalTokens,100)
})
test('source subtotals preserve every independent bucket without counting totals twice', () => {
 const result = groupUsageRows(rows,true)
 assert.equal(result.length,3)
 assert.deepEqual(plain(result.find(r=>r.source==='subagent').buckets),buckets(2,4,6,8))
 assert.deepEqual(plain(result.find(r=>r.source==='main').buckets),buckets(15,26,37,48))
 assert.equal(result.reduce((n,r)=>n+r.buckets.totalTokens,0),156)
 assert.deepEqual(plain(groupUsageRows([],false)),[])
})

/*
 * The session list spells the durable link `parentId` on `SessionSummary`; a
 * subagent row carries its view value as a summary hint (`projectionValues`)
 * and an explicitly read session carries it in `projectionsBySession`.
 */
const childValue = value => ({ values: { usageBySource: value } })
const hint = value => ({ projectionValues: { usageBySource: value } })
const sessionList = {
 byId: {
  root: { origin: undefined, parentId: undefined },
  child: { origin: 'subagent', parentId: 'root', ...hint({ rows: [{ source:'main', provider:'child', model:'c', ...buckets(7,8,9,10) }] }) },
  grand: { origin: 'subagent', parentId: 'child' },
  other: { origin: 'subagent', parentId: 'stranger', ...hint({ rows: [{ source:'main', provider:'x', model:'x', ...buckets(999,1,1,1) }] }) },
  plain: { origin: undefined, parentId: 'unrelated-root' },
 },
 projectionsBySession: {
  grand: childValue({ rows: [{ source:'main', provider:'grand', model:'g', ...buckets(1,2,3,4) }] }),
 },
}
const own = { rows: [{ source:'main', provider:'root', model:'r', ...buckets(100,200,300,400) }] }

test('descendants follow parentId through every depth, staying inside the root', () => {
 // A delegated child may arrive without an explicit origin; the parent link
 // alone establishes the lineage. A row with another origin is not spend.
 assert.deepEqual(plain(descendantSessionIds(sessionList, 'root')), ['child', 'grand'])
 assert.deepEqual(plain(descendantSessionIds({ byId: { ...sessionList.byId, odd: { origin: 'fork', parentId: 'root' } } }, 'root')), ['child', 'grand'])
 assert.deepEqual(plain(descendantSessionIds(sessionList, 'child')), ['grand'])
 assert.deepEqual(plain(descendantSessionIds(undefined, 'root')), [])
})

test('subagent spend is added back to the conversation from hint and shared value', () => {
 const collected = collectUsageRows(own, sessionList, 'root')
 assert.equal(collected.missing.length, 0)
 const totals = groupUsageRows(collected.rows, true)
 assert.deepEqual(plain(totals.find(r => r.source === 'subagent').buckets), buckets(8,10,12,14))
 assert.deepEqual(plain(totals.find(r => r.source === 'main').buckets), buckets(100,200,300,400))
 assert.equal(collected.rows.reduce((n, r) => n + r.buckets.totalTokens, 0), 1000 + 44)
})

test('a descendant with no value yet is reported once for an on-demand read', () => {
 const unresolved = {
  byId: sessionList.byId,
  projectionsBySession: {},
 }
 const collected = collectUsageRows(own, unresolved, 'root')
 // The child's summary hint already carries its value; the grandchild has none.
 assert.deepEqual(plain(collected.missing), ['grand'])
 assert.equal(collected.rows.length, 2)
 assert.equal(collectUsageRows(undefined, sessionList, 'root').rows.length, 2)
 const orphaned = { byId: { child: { origin: 'subagent', parentId: 'root' } } }
 assert.deepEqual(plain(collectUsageRows(own, orphaned, 'root').missing), ['child'])
})

test('visible details use exact numbers for all five buckets; compact mode keeps the button', () => {
 assert.match(source,/exact\(buckets\[field\]\)/)
 for (const name of ['usage.input','usage.output','usage.cacheRead','usage.cacheWrite','usage.grandTotal']) assert.ok(source.includes(name))
 assert.ok(!source.includes("if (mode === 'compact')"))
 assert.match(source,/priority: -1/)
 assert.ok(source.includes('prepareChildUsage'))
})