import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// Execute the production pure aggregation functions, not a duplicate implementation.
const start = source.indexOf('    const ZERO =')
const end = source.indexOf('    const COLUMNS =', start)
assert.ok(start > 0 && end > start)
const { groupUsageRows } = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return { groupUsageRows } })()`)
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
test('visible details use exact numbers for all five buckets; compact mode keeps the button', () => {
 assert.match(source,/exact\(buckets\[field\]\)/)
 for (const name of ['usage.input','usage.output','usage.cacheRead','usage.cacheWrite','usage.grandTotal']) assert.ok(source.includes(name))
 assert.ok(!source.includes("if (mode === 'compact')"))
 assert.match(source,/priority: -1/)
})
