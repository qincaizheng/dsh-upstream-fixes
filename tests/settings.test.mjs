/**
 * Tests for the settings auto-expose bridge (fix 6): the host routes that
 * serve the full redacted namespace list and run writes for namespaces the
 * official ApiProxy whitelist would refuse. The cordis context is faked —
 * no real settings document is touched.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/** Build apply()'s context with a fake settings service and captured routes. */
async function bootWith(settings) {
  const { apply } = await import('../lib/index.js')
  let routes = null
  const ctx = {
    webServer: { register: (route) => { routes = route; return () => {} } },
    get: (key) => (key === 'settings' ? settings : undefined),
    reflect: { provide: () => {} },
    effect: (fn) => { fn() },
  }
  apply(ctx)
  const call = (url, method, body) => new Promise((resolve) => {
    const req = { url, method, on(event, cb) {
      if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(body)))
      if (event === 'end') queueMicrotask(cb)
      if (event === 'error') {}
    } }
    const res = { statusCode: 0, setHeader() {}, end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload) }) } }
    routes.handler(req, res)
  })
  return { call, routes }
}

function fakeSettings(overrides = {}) {
  const calls = []
  const descriptors = [
    { ns: 'whitelisted', schema: {}, value: { a: 1 }, base: { a: 0 }, applies: 'live', secrets: [{ path: ['key'], set: true }], revision: 3 },
    { ns: 'task-board', schema: {}, value: { b: 2 }, applies: 'live', secrets: [], revision: 7 },
  ]
  return {
    writable: true,
    documentPath: '/tmp/settings.yaml',
    calls,
    describe: (options) => { calls.push(['describe', options]); return descriptors },
    mutate: async (ns, ops, rev) => { calls.push(['mutate', ns, ops, rev]); if (overrides.mutateError) throw overrides.mutateError; if (overrides.mutateThrowConflict) throw { message: 'conflict', expected: 1, actual: 2 }; descriptors[1] = { ...descriptors[1], revision: 8, value: { b: 3 } } },
    update: async (ns, section, rev) => { calls.push(['update', ns, section, rev]) },
    replace: async (ns, section, rev) => { calls.push(['replace', ns, section, rev]) },
  }
}

describe('settings describe bridge', () => {
  it('serves every registered namespace in the official wire shape', async () => {
    const settings = fakeSettings()
    const { call } = await bootWith(settings)
    const res = await call('/api/upstream-fixes/settings/describe', 'GET', undefined)
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.writable, true)
    assert.equal(res.body.hasDocument, true)
    assert.equal(res.body.namespaces.length, 2)
    const taskBoard = res.body.namespaces.find((row) => row.ns === 'task-board')
    assert.deepEqual(taskBoard, { ns: 'task-board', schema: {}, value: { b: 2 }, applies: 'live', secrets: [], revision: 7 })
    const whitelisted = res.body.namespaces.find((row) => row.ns === 'whitelisted')
    assert.deepEqual(whitelisted.secrets, [{ path: ['key'], set: true }])
    assert.deepEqual(whitelisted.base, { a: 0 })
    assert.equal(settings.calls[0][0], 'describe')
    assert.deepEqual(settings.calls[0][1], { redactSecrets: true })
  })
  it('reports the settings service as unavailable when absent', async () => {
    const { call } = await bootWith(undefined)
    const res = await call('/api/upstream-fixes/settings/describe', 'GET', undefined)
    assert.equal(res.body.ok, false)
  })
})

describe('settings write bridge', () => {
  it('mutate: runs the write and returns the new namespace view', async () => {
    const settings = fakeSettings()
    const { call } = await bootWith(settings)
    const res = await call('/api/upstream-fixes/settings/mutate', 'POST', JSON.stringify({ ns: 'task-board', ops: [{ op: 'set', path: ['b'], value: 3 }], expectedRevision: 7 }))
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.result.ok, true)
    assert.equal(res.body.result.value.ns, 'task-board')
    assert.equal(res.body.result.value.revision, 8)
    assert.deepEqual(res.body.result.value.value, { b: 3 })
    const writes = settings.calls.filter((entry) => entry[0] !== 'describe')
    assert.deepEqual(writes, [['mutate', 'task-board', [{ op: 'set', path: ['b'], value: 3 }], 7]])
  })
  it('mutate: maps a validation failure to settings-rejected', async () => {
    const settings = fakeSettings({ mutateError: new Error('schema says no') })
    const { call } = await bootWith(settings)
    const res = await call('/api/upstream-fixes/settings/mutate', 'POST', JSON.stringify({ ns: 'task-board', ops: [] }))
    assert.equal(res.body.result.ok, false)
    assert.equal(res.body.result.code, 'settings-rejected')
    assert.equal(res.body.result.message, 'schema says no')
    assert.deepEqual(res.body.result.details, { ns: 'task-board' })
  })
  it('mutate: maps expected/actual conflicts to settings-conflict', async () => {
    const settings = fakeSettings({ mutateThrowConflict: true })
    const { call } = await bootWith(settings)
    const res = await call('/api/upstream-fixes/settings/mutate', 'POST', JSON.stringify({ ns: 'task-board', ops: [], expectedRevision: 1 }))
    assert.equal(res.body.result.ok, false)
    assert.equal(res.body.result.code, 'settings-conflict')
    assert.deepEqual(res.body.result.details, { ns: 'task-board', expected: 1, actual: 2 })
  })
  it('update/replace route to the matching service methods', async () => {
    const settings = fakeSettings()
    const { call } = await bootWith(settings)
    await call('/api/upstream-fixes/settings/update', 'POST', JSON.stringify({ ns: 'task-board', section: { b: 9 }, expectedRevision: 7 }))
    await call('/api/upstream-fixes/settings/replace', 'POST', JSON.stringify({ ns: 'task-board', section: { b: 10 } }))
    const writes = settings.calls.filter((entry) => entry[0] !== 'describe')
    assert.deepEqual(writes, [
      ['update', 'task-board', { b: 9 }, 7],
      ['replace', 'task-board', { b: 10 }, undefined],
    ])
  })
  it('refuses an empty namespace', async () => {
    const settings = fakeSettings()
    const { call } = await bootWith(settings)
    const res = await call('/api/upstream-fixes/settings/mutate', 'POST', JSON.stringify({ ops: [] }))
    assert.equal(res.body.result.ok, false)
    assert.equal(res.body.result.code, 'settings-rejected')
  })
})
