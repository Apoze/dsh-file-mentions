import assert from 'node:assert/strict'
import test from 'node:test'

let plugin
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => { plugin = factory(() => ({})) },
  },
}
await import('../lib/client.js')
delete globalThis.window

test('uses the current DSH uiConversation service', () => {
  let definition
  const slots = { inject() {} }
  plugin.apply({
    effect() {},
    get(name) {
      if (name === 'slots') return slots
      if (name === 'uiConversation') return { events: { register(value) { definition = value } } }
    },
  })

  assert.deepEqual(plugin.inject, ['slots', 'uiConversation'])
  assert.equal(definition.kind, 'mentionedPaths')
})
