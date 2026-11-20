import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Exercise the lazy client module without a browser, DOM, or React renderer.
// The registry double models the documented same-cell priority election.
function loadPlugin() {
  let module
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { module = value } } } })
  assert.equal(module.id, '@local/dsh-usage-by-source')
  return module.factory(name => {
    if (name === 'react') return { createElement() {} }
    if (name === 'react-dom') return {}
    throw new Error(`Unexpected dependency: ${name}`)
  })
}

for (const shippedFirst of [true, false]) {
  test(`usage replacement coexists and restores shipped cell (shipped first: ${shippedFirst})`, () => {
    const cells = []
    const disposers = []
    const shipped = { name: 'conversation.composer.dock', id: 'usage', priority: 0, order: 1 }
    const register = (options, component) => {
      const priority = options.priority ?? 0
      assert.ok(!cells.some(cell => cell.name === options.name && cell.id === options.id && cell.priority === priority),
        'same-cell, same-priority registration conflict')
      const cell = { ...options, priority, component }
      cells.push(cell)
      return () => cells.splice(cells.indexOf(cell), 1)
    }
    const winner = () => [...cells].sort((a, b) => a.priority - b.priority)[0]
    if (shippedFirst) register(shipped)
    const plugin = loadPlugin()
    plugin.apply({
      effect(effect) { disposers.push(effect()) },
      locale: { register() { return () => {} } },
      inject() {}, // Optional configForms is absent; preference defaults remain valid.
      slots: {
        inject(name, callback) {
          assert.equal(name, 'conversation.composer.dock')
          disposers.push(callback())
        },
        register,
      },
    })
    if (!shippedFirst) register(shipped)
    assert.equal(cells.length, 2)
    assert.equal(winner().priority, -1)
    assert.equal(winner().order, 1)
    assert.equal(winner().id, 'usage')
    assert.equal(typeof winner().component, 'function')
    assert.equal(winner().locale, '@local/dsh-usage-by-source')
    assert.equal(winner().inject().hooks.performanceUsage.getSnapshot(), 'detailed')
    for (const dispose of disposers.reverse()) dispose?.()
    assert.equal(cells.length, 1)
    assert.equal(winner().priority, 0)
  })
}
