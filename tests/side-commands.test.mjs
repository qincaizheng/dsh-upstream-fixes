/**
 * Tests for the /side command definition and the subagent dispatch rules (own side-chat
 * implementation): the handlers drive the official subagent service,
 * refuse empty input and missing backends, and always dispose one-shot
 * runs once they settle.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sideCommandsDefinition, parentContext, contextPrompt, startSideChat, parseNamedRequest, readSubagentModels, subagentModelsPath, tokenize, autoSelectModel, resolveDispatch, installDispatchRule } from '../lib/index.js'

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

describe('named subagent models', () => {
  it('parses a leading configured name into a strict model override', () => {
    const models = { work: { provider: 'r', model: 'deepseek-v4-flash' } }
    assert.deepEqual(parseNamedRequest('work 帮我总结', models), {
      name: 'work',
      prompt: '帮我总结',
      agentOptions: { provider: 'r', model: 'deepseek-v4-flash' },
    })
  })
  it('keeps the untouched question when no name matches', () => {
    const models = { work: { provider: 'r', model: 'deepseek-v4-flash' } }
    assert.deepEqual(parseNamedRequest('随便 问个问题', models), { prompt: '随便 问个问题' })
    assert.deepEqual(parseNamedRequest('work', models), { prompt: 'work' })
    assert.deepEqual(parseNamedRequest('work   ', models), { prompt: 'work   ' })
  })
  it('persists and reloads the config file', () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-models-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      assert.deepEqual(readSubagentModels(), {})
      mkdirSync(join(home), { recursive: true })
      writeFileSync(subagentModelsPath(), JSON.stringify({ work: { provider: 'r', model: 'deepseek-v4-flash' } }))
      assert.deepEqual(readSubagentModels(), { work: { provider: 'r', model: 'deepseek-v4-flash' } })
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('/side strictly uses the configured model for a named dispatch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-models-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const subagents = makeSubagents()
    try {
      writeFileSync(subagentModelsPath(), JSON.stringify({ work: { provider: 'r', model: 'deepseek-v4-flash' } }))
      const result = await commands(subagents).side.handler({ agent: {}, rawInput: 'work 整理文档', signal: undefined })
      assert.equal(result.kind, 'success')
      const [, spec] = subagents.calls[0]
      assert.equal(spec.label, 'work')
      assert.deepEqual(spec.request.agentOptions, { provider: 'r', model: 'deepseek-v4-flash' })
      assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '整理文档' }])
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('startSideChat strictly uses the configured model for a named dispatch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-models-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const calls = []
    const agent = { session: { id: 'parent-1' } }
    try {
      writeFileSync(subagentModelsPath(), JSON.stringify({ work: { provider: 'r', model: 'deepseek-v4-flash' } }))
      const ctx = {
        get: (key) => {
          if (key === 'agents') return { get: () => agent }
          if (key === 'subagents') return {
            getProvider: () => ({ name: 'fork' }),
            startContinuable: async (spec) => { calls.push(spec); return { childId: CHILD } },
          }
          return undefined
        },
      }
      const result = await startSideChat(ctx, 'parent-1', 'work 写个函数')
      assert.equal(result.ok, true)
      const spec = calls[0]
      assert.equal(spec.label, 'work')
      assert.deepEqual(spec.request.agentOptions, { provider: 'r', model: 'deepseek-v4-flash' })
      assert.deepEqual(spec.request.toolFilter, { allow: [] })
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('auto-select by description', () => {
  const MODELS = {
    work: { description: '代码、工程与调试任务', provider: 'r', model: 'deepseek-v4-flash' },
    writer: { description: '文案、写作与润色', provider: 'r', model: 'deepseek-v4-plus' },
  }
  it('tokenizes CJK and latin words', () => {
    assert.deepEqual(tokenize('帮我 Debug 一个函数'), ['帮我', 'debug', '一个函数'])
  })
  it('picks the entry with the best description overlap', () => {
    const best = autoSelectModel('帮我润色这段文案', MODELS)
    assert.equal(best.name, 'writer')
    assert.deepEqual(best.agentOptions, { provider: 'r', model: 'deepseek-v4-plus' })
  })
  it('returns null when nothing matches', () => {
    assert.equal(autoSelectModel('今天天气怎么样', MODELS), null)
  })
  it('explicit name wins over auto-selection', () => {
    const resolved = resolveDispatch('work 帮我改个 bug', MODELS)
    assert.equal(resolved.name, 'work')
    assert.equal(resolved.prompt, '帮我改个 bug')
    assert.equal(resolved.auto, undefined)
  })
  it('auto-selects and keeps the full question as the prompt', () => {
    const resolved = resolveDispatch('帮我润色这段文案', MODELS)
    assert.equal(resolved.name, 'writer')
    assert.equal(resolved.prompt, '帮我润色这段文案')
    assert.equal(resolved.auto, true)
  })
  it('falls back to the plain question when nothing matches', () => {
    const resolved = resolveDispatch('今天天气怎么样', MODELS)
    assert.deepEqual(resolved, { prompt: '今天天气怎么样' })
  })
  it('startSideChat auto-routes by description when no name is given', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-models-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const calls = []
    const agent = { session: { id: 'parent-1' } }
    try {
      writeFileSync(subagentModelsPath(), JSON.stringify({
        work: { description: '代码、工程与调试任务', provider: 'r', model: 'deepseek-v4-flash' },
      }))
      const ctx = {
        get: (key) => {
          if (key === 'agents') return { get: () => agent }
          if (key === 'subagents') return {
            getProvider: () => ({ name: 'fork' }),
            startContinuable: async (spec) => { calls.push(spec); return { childId: CHILD } },
          }
          return undefined
        },
      }
      const result = await startSideChat(ctx, 'parent-1', '帮我调试这段代码')
      assert.equal(result.ok, true)
      const spec = calls[0]
      assert.equal(spec.label, 'work')
      assert.deepEqual(spec.request.agentOptions, { provider: 'r', model: 'deepseek-v4-flash' })
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('global dispatch rule (fork provider interceptor)', () => {
  it('routes a one-shot dispatch by explicit name and overrides the prompt', () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-models-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const seen = []
    try {
      writeFileSync(subagentModelsPath(), JSON.stringify({
        work: { description: '代码任务', provider: 'r', model: 'deepseek-v4-flash' },
      }))
      const provider = { name: 'fork', start: async (request) => { seen.push(request); return { id: 'run-1' } } }
      const installed = installDispatchRule({ getProvider: () => provider })
      assert.equal(installed, true)
      return provider.start({
        label: '原来的标签',
        prompt: [{ type: 'text', text: 'work 整理文档' }],
        parent: {},
        signal: undefined,
      }).then(() => {
        assert.equal(seen.length, 1)
        assert.equal(seen[0].label, 'work')
        assert.deepEqual(seen[0].agentOptions, { provider: 'r', model: 'deepseek-v4-flash' })
        assert.deepEqual(seen[0].prompt, [{ type: 'text', text: '整理文档' }])
      })
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('passes through untouched when nothing matches', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ufx-models-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const seen = []
    try {
      writeFileSync(subagentModelsPath(), JSON.stringify({ work: { description: '代码任务', provider: 'r', model: 'deepseek-v4-flash' } }))
      const provider = { name: 'fork', start: async (request) => { seen.push(request); return { id: 'run-1' } } }
      installDispatchRule({ getProvider: () => provider })
      const request = { label: 'keep', prompt: [{ type: 'text', text: '今天天气怎么样' }], parent: {}, signal: undefined }
      await provider.start(request)
      assert.equal(seen[0], request)
    } finally {
      process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
  it('is idempotent', () => {
    const provider = { name: 'fork', start: async () => ({ id: 'run-1' }) }
    const subagents = { getProvider: () => provider }
    assert.equal(installDispatchRule(subagents), true)
    assert.equal(installDispatchRule(subagents), false)
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


