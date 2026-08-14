/**
 * Tests for the /side /btw command definitions (own side-chat
 * implementation): the handlers drive the official subagent service,
 * refuse empty input and missing backends, and always dispose one-shot
 * runs once they settle.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sideCommandsDefinition, parentContext, contextPrompt, childSessionDir, cleanupEphemeralChild, startSideChat } from '../lib/index.js'

const CHILD = '11111111-2222-3333-4444-555555555555'
const RUN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function makeSubagents(overrides = {}) {
  const calls = []
  const run = {
    id: RUN,
    result: Promise.resolve({ status: 'completed' }),
    dispose: async () => { calls.push(['dispose', RUN]) },
  }
  return {
    calls,
    run,
    getProvider: (name) => (overrides.noFork === true ? undefined : { name }),
    startContinuable: async (spec) => { calls.push(['startContinuable', spec]); return { childId: CHILD } },
    start: async (name, request) => { calls.push(['start', name, request]); return run },
  }
}

function commands(subagents, hooks = {}) {
  return Object.fromEntries(sideCommandsDefinition(subagents, hooks).map((d) => [d.name, d]))
}

describe('parent context helpers', () => {
  it('extracts the recent message tail and caps the message count', () => {
    const events = []
    for (let i = 0; i < 10; i += 1) {
      events.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'u' + i }] } })
      events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'a' + i }] } })
    }
    const context = parentContext({ session: { events } }, 8)
    const lines = context.split('\n')
    assert.equal(lines.length, 8)
    assert.ok(lines[0].includes('u6'))
    assert.ok(lines.at(-1).includes('a9'))
  })
  it('ignores tool events and returns empty without messages', () => {
    assert.equal(parentContext({ session: { events: [{ type: 'tool/call', data: {} }] } }), '')
    assert.equal(parentContext({}), '')
    assert.equal(parentContext(undefined), '')
  })
  it('contextPrompt leaves a context-less question untouched', () => {
    assert.equal(contextPrompt({}, 'hello'), 'hello')
  })
})

describe('/side', () => {
  it('starts a continuable child and reports its id', async () => {
    const subagents = makeSubagents()
    const agent = { session: { id: 'parent-1' } }
    const result = await commands(subagents).side.handler({ agent, rawInput: '  hello world  ', signal: undefined })
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes(CHILD))
    const [, spec] = subagents.calls[0]
    assert.equal(spec.provider, 'fork')
    assert.equal(spec.request.parent, agent)
    assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'hello world' }])
    assert.ok(spec.label.length <= 40)
  })
  it('refuses an empty question', async () => {
    const result = await commands(makeSubagents()).side.handler({ agent: {}, rawInput: '   ', signal: undefined })
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('/side'))
  })
  it('reports a missing subagent service', async () => {
    const result = await commands(undefined).side.handler({ agent: {}, rawInput: 'x', signal: undefined })
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('子代理服务不可用'))
  })
  it('reports a missing fork provider', async () => {
    const result = await commands(makeSubagents({ noFork: true })).side.handler({ agent: {}, rawInput: 'x', signal: undefined })
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('fork'))
  })
  it('maps a start failure to a command error', async () => {
    const subagents = makeSubagents()
    subagents.startContinuable = async () => { throw new Error('boom') }
    const result = await commands(subagents).side.handler({ agent: {}, rawInput: 'x', signal: undefined })
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('boom'))
  })
})

describe('/btw', () => {
  it('starts a one-shot run, disposes after settle, and triggers the ephemeral cleanup', async () => {
    const subagents = makeSubagents()
    const cleaned = []
    const agent = { session: { id: 'parent-1' } }
    const result = await commands(subagents, { cleanupChild: (id) => { cleaned.push(id) } }).btw.handler({ agent, rawInput: 'quick question', signal: undefined })
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes(RUN))
    const [verb, provider, request] = subagents.calls[0]
    assert.equal(verb, 'start')
    assert.equal(provider, 'fork')
    assert.equal(request.parent, agent)
    // the background settle path must release the run, then clean up
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(subagents.calls.some((entry) => entry[0] === 'dispose'))
    assert.deepEqual(cleaned, [RUN])
  })
  it('opens the panel (success marker) when run without arguments', async () => {
    const subagents = makeSubagents()
    const result = await commands(subagents).btw.handler({ agent: {}, rawInput: '   ', signal: undefined })
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes('已打开侧栏面板'))
    assert.equal(subagents.calls.length, 0)
  })
  it('carries the parent conversation tail into the child prompt', async () => {
    const subagents = makeSubagents()
    const agent = {
      session: {
        id: 'parent-1',
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
          { type: 'assistant/message', data: { content: [{ type: 'text', text: '你好呀' }] } },
        ],
      },
    }
    const result = await commands(subagents).btw.handler({ agent, rawInput: '总结一下', signal: undefined })
    assert.equal(result.kind, 'success')
    const [, , request] = subagents.calls[0]
    const text = request.prompt[0].text
    assert.ok(text.includes('当前对话上下文'))
    assert.ok(text.includes('用户：你好'))
    assert.ok(text.includes('助手：你好呀'))
    assert.ok(text.includes('问题：总结一下'))
  })
})

describe('/chat', () => {
  it('starts a continuable child restricted to zero tools', async () => {
    const subagents = makeSubagents()
    const agent = {
      session: {
        id: 'parent-1',
        events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '之前聊过' }] } }],
      },
    }
    const result = await commands(subagents).chat.handler({ agent, rawInput: '陪我聊聊', signal: undefined })
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes(CHILD))
    assert.ok(result.text.includes('纯对话'))
    const [, spec] = subagents.calls[0]
    assert.equal(spec.provider, 'fork')
    assert.deepEqual(spec.request.toolFilter, { allow: [] })
    assert.ok(spec.request.prompt[0].text.includes('问题：陪我聊聊'))
  })
  it('refuses an empty message', async () => {
    const result = await commands(makeSubagents()).chat.handler({ agent: {}, rawInput: '', signal: undefined })
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('/chat'))
  })
})

describe('startSideChat (direct panel route)', () => {
  it('refuses an empty message', async () => {
    const ctx = { get: () => ({ get: () => ({}) }) }
    const result = await startSideChat(ctx, 'parent-1', '   ')
    assert.equal(result.ok, false)
  })
  it('reports a missing conversation agent', async () => {
    const ctx = { get: (key) => (key === 'agents' ? { get: () => undefined } : undefined) }
    const result = await startSideChat(ctx, 'parent-1', 'hello')
    assert.equal(result.ok, false)
    assert.ok(result.message.includes('agent'))
  })
  it('creates a pure-chat continuable child for the conversation agent', async () => {
    const calls = []
    const agent = { session: { id: 'parent-1', events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '之前聊过' }] } }] } }
    const subagents = {
      getProvider: () => ({ name: 'fork' }),
      startContinuable: async (spec) => { calls.push(spec); return { childId: CHILD } },
    }
    const ctx = {
      get: (key) => {
        if (key === 'agents') return { get: (id) => (id === 'parent-1' ? agent : undefined) }
        if (key === 'subagents') return subagents
        return undefined
      },
    }
    const result = await startSideChat(ctx, 'parent-1', '陪我聊聊')
    assert.deepEqual(result, { ok: true, childId: CHILD })
    const spec = calls[0]
    assert.equal(spec.provider, 'fork')
    assert.equal(spec.request.parent, agent)
    assert.deepEqual(spec.request.toolFilter, { allow: [] })
    assert.ok(spec.request.prompt[0].text.includes('问题：陪我聊聊'))
  })
})

describe('ephemeral /btw cleanup', () => {
  it('locates a child session dir across encoded workspace dirs', () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-ephem-'))
    try {
      const ws = join(home, 'sessions', '--Users-qdd-codex-workspace-oh-my-dsh--')
      const child = join(ws, CHILD)
      mkdirSync(child, { recursive: true })
      writeFileSync(join(child, 'session.jsonl'), '{}')
      assert.equal(childSessionDir(home, CHILD), child)
      assert.equal(childSessionDir(home, 'missing-id'), null)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('deletes the persisted session and archives the child', () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-ephem-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const ws = join(home, 'sessions', '--workspace--')
      const child = join(ws, CHILD)
      mkdirSync(child, { recursive: true })
      writeFileSync(join(child, 'session.jsonl'), '{}')
      const archived = []
      const ctx = { get: (key) => (key === 'workspaces' ? { archiveSession: async (id) => { archived.push(id) } } : undefined) }
      cleanupEphemeralChild(ctx, CHILD, 0)
      assert.equal(existsSync(child), false)
      assert.deepEqual(archived, [CHILD])
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})
