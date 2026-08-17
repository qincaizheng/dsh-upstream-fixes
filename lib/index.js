/**
 * Host half of @dsh-external/dsh-upstream-fixes: a cordis function plugin
 * carrying the repair hooks described in README.md:
 *
 *  - lib/client.js registers a client-modules shim so dsh-sidechain's client
 *    bundle can require its deep runtime source path, and redirects the
 *    plugin-console panel's update/version requests to the real-update
 *    routes below (fix 4).
 *  - scripts/install-aliases.mjs (postinstall) creates the scoped-name
 *    symlinks that dsh-auto-approval's bundle patch references but were
 *    never published.
 *  - this module provides an `httpServer` service alias: plugins built
 *    against older dsh releases (e.g. dsh-vision-toolkit@0.1.2) inject the
 *    legacy `httpServer` key, but the current webserver registers itself as
 *    `webServer`. The alias points both names at the same instance, so the
 *    legacy inject resolves and its routes actually attach.
 *  - fix 4: real plugin updates. The plugin-console panel's update button
 *    only runs `pnpm update <name>` — a no-op for link:/file: local
 *    dependencies (the mainstream third-party install shape) and
 *    range-bound for registry deps. This module serves:
 *      GET/POST /api/upstream-fixes/versions — cached version checks that
 *      cover local git remotes (upstream package.json version).
 *      POST /api/upstream-fixes/update — real update: local git repos get
 *      `git pull --ff-only` (+ rebuild when a build script exists),
 *      everything else gets `pnpm update --latest`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { classifySpec, gitHead, gitRemoteHead, localDirFromSpec, remotePackageVersion } from './update.js'

export const name = 'upstream-fixes'
export const inject = ['webServer']

/** DSH home (env override; tests point this at a temp dir). */
export function dshHome() {
  const env = process.env.DSH_HOME?.trim()
  return env !== undefined && env !== '' ? resolve(env) : join(homedir(), '.dsh')
}

/** Web profile directory. */
export function profileDir() {
  return join(dshHome(), 'profiles', 'web')
}

/** Read the profile manifest ({} when missing/malformed). */
export function readProfileManifest() {
  try {
    return JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

function writeProfileManifest(manifest) {
  writeFileSync(join(profileDir(), 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** Installed version of a package (profile node_modules/<name>/package.json). */
function installedVersion(name) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(), 'node_modules', name, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Whether the installed package declares dsh.bundle (bundle layer candidate). */
function exportsBundlePatch(name) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(), 'node_modules', name, 'package.json'), 'utf8'))
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/**
 * Keep one package's bundle-layer membership honest after a pnpm update: a
 * package that now declares dsh.bundle joins dsh.profile.bundles; one that
 * lost the declaration leaves. Mirrors the console's reconcile for the
 * single updated package (the console reconciles on install/remove).
 */
function reconcileBundleMembership(name) {
  const manifest = readProfileManifest()
  if (typeof manifest.dependencies?.[name] !== 'string') return
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const declares = exportsBundlePatch(name)
  if (declares && !bundles.includes(name)) {
    bundles.push(name)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeProfileManifest(manifest)
    console.log('[dsh-upstream-fixes] reconciled bundle layer +' + name)
  } else if (!declares && bundles.includes(name)) {
    bundles.splice(bundles.indexOf(name), 1)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeProfileManifest(manifest)
    console.log('[dsh-upstream-fixes] reconciled bundle layer -' + name)
  }
}

/* ---------------- version checks ---------------- */

/** npm registry latest version; null when not queryable. */
function npmViewLatest(name) {
  try {
    const result = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8', timeout: 15_000 })
    const text = (result.stdout ?? '').trim()
    if (result.status === 0 && /^\d+(\.\d+)+/.test(text)) return text.split('\n')[0].trim()
  } catch {
    /* fall through */
  }
  return null
}

/** name -> { latest, checkedAt } (process memory; 30s minimum refresh). */
const versionCache = new Map()
let lastVersionRefreshAt = 0
const VERSION_REFRESH_MIN_MS = 30 * 1000

/**
 * Check one dependency's latest: local git repos compare against the
 * upstream package.json version (fetch first), everything else falls back
 * to npm view. The panel only understands semver equality, so a git repo
 * whose upstream released a new version reports that version as `latest`.
 */
function checkLatestFor(name, spec) {
  if (classifySpec(spec) === 'local') {
    const dir = localDirFromSpec(spec, profileDir())
    if (!existsSync(dir)) {
      versionCache.set(name, { latest: null, checkedAt: Date.now() })
      return
    }
    const state = gitRemoteHead(dir)
    if (state.remote === undefined) {
      versionCache.set(name, { latest: null, checkedAt: Date.now() })
      return
    }
    versionCache.set(name, {
      latest: remotePackageVersion(dir, state.upstreamRef),
      checkedAt: Date.now(),
    })
    return
  }
  versionCache.set(name, { latest: npmViewLatest(name), checkedAt: Date.now() })
}

/** Version rows for every local (link:/file:) dependency. */
export function versionRows() {
  const manifest = readProfileManifest()
  const deps = manifest.dependencies ?? {}
  const rows = []
  for (const [name, spec] of Object.entries(deps)) {
    if (classifySpec(spec) !== 'local') continue
    const cached = versionCache.get(name)
    rows.push({
      name,
      latest: cached?.latest ?? null,
      checked: cached !== undefined,
    })
  }
  return rows
}

/** Refresh the cache for all local deps (30s minimum interval). */
export function refreshVersions(force = false) {
  const now = Date.now()
  if (!force && now - lastVersionRefreshAt < VERSION_REFRESH_MIN_MS) return false
  lastVersionRefreshAt = now
  const manifest = readProfileManifest()
  const deps = manifest.dependencies ?? {}
  for (const [name, spec] of Object.entries(deps)) {
    if (classifySpec(spec) === 'local') checkLatestFor(name, spec)
  }
  return true
}

/* ---------------- real update ---------------- */

/** Rebuild a freshly-pulled plugin when it ships a build script (best effort). */
function tryRebuild(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof manifest.scripts?.build !== 'string') return ''
    if (!existsSync(join(dir, 'node_modules'))) return '（目录无 node_modules，跳过构建）'
    const result = spawnSync('pnpm', ['build'], { cwd: dir, encoding: 'utf8', timeout: 180_000 })
    return result.status === 0 ? '，已重新构建' : '，重新构建失败（可手动 pnpm build）'
  } catch {
    return ''
  }
}

/**
 * Real update for one dependency:
 *  - link:/file: + git repository -> `git pull --ff-only` (+ best-effort
 *    rebuild); a pull that moves nothing is reported as up to date.
 *  - anything else (registry semver / git source) -> `pnpm update --latest`
 *    (jumps to the newest published version, not just the declared range),
 *    followed by a bundle-layer membership reconcile.
 * Returns { ok, updated, message }; never throws.
 */
export function updateInstalledPlugin(name) {
  const manifest = readProfileManifest()
  const spec = manifest.dependencies?.[name]
  if (typeof spec !== 'string') {
    return { ok: false, updated: false, message: name + ' 不在 web profile 依赖中（内置/模板插件无需更新）' }
  }
  if (classifySpec(spec) === 'local') {
    const dir = localDirFromSpec(spec, profileDir())
    if (!existsSync(dir)) {
      return { ok: false, updated: false, message: '本地依赖目录不存在：' + dir }
    }
    const before = gitHead(dir)
    if (before === undefined) {
      return { ok: false, updated: false, message: name + ' 是本地目录依赖但不是 git 仓库：没有远程源可拉取，直接改目录内容即可' }
    }
    const pulled = spawnSync('git', ['-C', dir, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 120_000 })
    if (pulled.status !== 0) {
      const tail = ((pulled.stderr ?? '') + (pulled.stdout ?? '')).trim().slice(-400)
      return { ok: false, updated: false, message: name + ' git pull 失败：' + (tail || '未知错误') + '（本地有改动或已分叉时请先手动处理）' }
    }
    const after = gitHead(dir)
    const changed = after !== undefined && after !== before
    checkLatestFor(name, spec)
    if (!changed) {
      return { ok: true, updated: false, message: name + ' 已是最新（' + before.slice(0, 7) + '）' }
    }
    const rebuildNote = tryRebuild(dir)
    const restart = exportsBundlePatch(name) ? '——bundle 需重启 web 生效' : '——刷新页面生效'
    return { ok: true, updated: true, message: name + ' 已拉取 ' + before.slice(0, 7) + ' → ' + after.slice(0, 7) + rebuildNote + restart }
  }
  // registry semver / git source: --latest chases the newest version
  // (plain `pnpm update` stays inside the declared range, and exact pins
  // never move — both are why the console's button 'did nothing').
  const before = installedVersion(name)
  const result = spawnSync('pnpm', ['update', '--latest', name], { cwd: profileDir(), encoding: 'utf8', timeout: 180_000 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  if (result.status !== 0) {
    return { ok: false, updated: false, message: 'pnpm update 失败：' + output.slice(-500) }
  }
  reconcileBundleMembership(name)
  const after = installedVersion(name)
  checkLatestFor(name, spec)
  if (before === after || after === undefined) {
    return { ok: true, updated: false, message: name + ' 已是最新（' + (after ?? before ?? '?') + '）' }
  }
  const restart = exportsBundlePatch(name) ? '——重启 web 生效' : '——刷新页面生效'
  return { ok: true, updated: true, message: name + ' 已更新 ' + (before ?? '?') + ' → ' + after + restart }
}

/* ---------------- settings auto-expose bridge ---------------- */

/**
 * Mirror of the official ApiProxy namespaceView wire shape
 * (dsh-host-apiproxy): ns/schema/value/base?/user?/applies/secrets/revision.
 * The client parses write responses against the same zod schema, so the
 * fields must match exactly.
 */
function namespaceView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map((secret) => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

/**
 * Run one settings write against the host settings service and shape the
 * result into the official RpcResult envelope the client parses. Conflict
 * errors are detected by their expected/actual fields (the service class
 * itself is an external dependency this bundle must not import).
 */
function settingsWriteResult(settings, mode, ns, section, expectedRevision) {
  if (settings === undefined) {
    return { ok: false, code: 'internal', message: 'settings service unavailable', details: {} }
  }
  return (async () => {
    try {
      if (mode === 'update') await settings.update(ns, section, expectedRevision)
      else if (mode === 'replace') await settings.replace(ns, section, expectedRevision)
      else await settings.mutate(ns, section, expectedRevision)
    } catch (error) {
      const isConflict = error !== null && typeof error === 'object' && ('expected' in error || 'actual' in error)
      if (isConflict) {
        return {
          ok: false,
          code: 'settings-conflict',
          message: error.message ?? String(error),
          details: { ns, ...(error.expected === undefined ? {} : { expected: error.expected }), ...(error.actual === undefined ? {} : { actual: error.actual }) },
        }
      }
      return { ok: false, code: 'settings-rejected', message: error instanceof Error ? error.message : String(error), details: { ns } }
    }
    const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns)
    if (descriptor === undefined) {
      return { ok: false, code: 'internal', message: 'settings namespace disposed after write', details: { ns } }
    }
    return { ok: true, value: namespaceView(descriptor) }
  })()
}

/* ---------------- named subagent models ---------------- */

/** Config file: subagent name -> { provider, model }. */
export function subagentModelsPath() {
  return join(dshHome(), 'upstream-fixes-subagent-models.json')
}

/** Read the name->model config ({} when absent/malformed). */
export function readSubagentModels() {
  try {
    const parsed = JSON.parse(readFileSync(subagentModelsPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeSubagentModels(models) {
  mkdirSync(dirname(subagentModelsPath()), { recursive: true })
  writeFileSync(subagentModelsPath(), JSON.stringify(models, undefined, 2) + '\n')
}

/**
 * Install the global dispatch rule on the fork provider: every one-shot
 * dispatch through it (including the model's own subagent tools) resolves
 * the name->model config and overrides label/agentOptions/prompt when a
 * binding applies. Idempotent; a missing provider is a silent no-op.
 */
export function installDispatchRule(subagents) {
  if (subagents === undefined || typeof subagents.getProvider !== 'function') return false
  const provider = subagents.getProvider(FORK_PROVIDER)
  if (provider === undefined || provider.__upstreamFixesRouted === true) return false
  const originalStart = provider.start.bind(provider)
  provider.start = (request) => {
    const text = promptTextOf(request.prompt)
    if (text === '') return originalStart(request)
    const resolved = resolveDispatch(text, readSubagentModels())
    if (resolved.name === undefined && resolved.agentOptions === undefined) return originalStart(request)
    return originalStart({
      ...request,
      ...(resolved.name !== undefined ? { label: resolved.name } : {}),
      ...(resolved.agentOptions !== undefined ? { agentOptions: resolved.agentOptions } : {}),
      ...(resolved.prompt !== text ? { prompt: textPrompt(resolved.prompt) } : {}),
    })
  }
  provider.__upstreamFixesRouted = true
  console.log('[dsh-upstream-fixes] global subagent dispatch rule installed on provider ' + String(provider.name ?? FORK_PROVIDER))
  return true
}

/**
 * Global model catalog (providers + model ids/names) for the settings
 * page — the settings surface has no session, so it cannot use the
 * session-scoped llm.models RPC.
 */
export async function modelCatalog(ctx) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: false, message: 'LLM 服务不可用' }
  }
  try {
    const groups = []
    for (const provider of await llm.listProviders()) {
      try {
        const models = await llm.listModels(provider)
        groups.push({
          id: provider.id,
          name: provider.name,
          models: (models ?? []).map((model) => ({ id: model.id, name: model.name })),
        })
      } catch {
        // 单个 provider 目录失败不阻塞整体。
      }
    }
    return { ok: true, groups }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Named dispatch: when the request's first token matches a configured
 * subagent name, the child is labelled with that name and STRICTLY runs on
 * the configured provider/model (agentOptions override the inherited parent
 * model). Anything else keeps the untouched question.
 */
export function parseNamedRequest(question, models) {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(question)
  if (match === null) return { prompt: question }
  const entry = models?.[match[1]]
  if (entry === undefined || entry === null || typeof entry !== 'object' || typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
    return { prompt: question }
  }
  const rest = match[2].trim()
  if (rest === '') return { prompt: question }
  return { name: match[1], prompt: rest, agentOptions: { provider: entry.provider, model: entry.model } }
}

/** Split into lowercase word tokens (CJK runs stay as single tokens). */
export function tokenize(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0)
}

/**
 * Auto-select the best subagent for a request by overlap between the
 * request and each entry's name + description. Whole tokens hit at weight 2;
 * CJK runs additionally match on character bigrams (so a full sentence like
 * 「帮我调试这段代码」 still hits a description containing 「调试」/「代码」).
 * Returns the best entry with a positive score, or null when nothing matches.
 */
export function autoSelectModel(question, models) {
  const tokens = tokenize(question)
  if (tokens.length === 0) return null
  let best = null
  for (const [name, entry] of Object.entries(models ?? {})) {
    if (entry === null || typeof entry !== 'object' || typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue
    const haystack = (name + ' ' + (typeof entry.description === 'string' ? entry.description : '')).toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += 2
        continue
      }
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i += 1) {
        const pair = chars[i] + chars[i + 1]
        if (/[\u4e00-\u9fff]/u.test(chars[i]) && /[\u4e00-\u9fff]/u.test(chars[i + 1]) && haystack.includes(pair)) score += 1
      }
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { name, score, agentOptions: { provider: entry.provider, model: entry.model } }
    }
  }
  return best
}

/**
 * Dispatch resolution: an explicit leading name wins (user specified);
 * otherwise the request is auto-routed to the best-matching subagent by
 * description overlap; otherwise the plain question keeps the parent model.
 */
export function resolveDispatch(question, models) {
  const explicit = parseNamedRequest(question, models)
  if (explicit.name !== undefined) return explicit
  const auto = autoSelectModel(question, models)
  if (auto !== null) {
    return { prompt: question, name: auto.name, agentOptions: auto.agentOptions, auto: true }
  }
  return { prompt: question }
}

/* ---------------- direct side-chat start (no command dispatch) ---------------- */

/**
 * Start a pure-chat side child for a conversation session directly —
 * without going through the slash-command pipeline, so nothing is recorded
 * in the MAIN conversation (the panel's composer calls this route instead
 * of sending a /chat prompt).
 */
export async function startSideChat(ctx, sessionId, text) {
  const question = String(text ?? '').trim()
  if (question === '') return { ok: false, message: '消息不能为空' }
  const agents = ctx.get?.('agents')
  const agent = agents?.get?.(sessionId)
  if (agent === undefined) return { ok: false, message: '找不到该会话的 agent（会话未激活或不存在）' }
  const subagents = ctx.get?.('subagents')
  if (subagents === undefined || typeof subagents.startContinuable !== 'function') {
    return { ok: false, message: '子代理服务不可用' }
  }
  if (subagents.getProvider?.(FORK_PROVIDER) === undefined) {
    return { ok: false, message: '缺少子代理 fork 后端（@deepseek-ai/dsh-subagent-fork-in-process）' }
  }
  try {
    const resolved = resolveDispatch(question, readSubagentModels())
    const { childId } = await subagents.startContinuable({
      provider: FORK_PROVIDER,
      label: resolved.name ?? shortLabel(question),
      request: {
        parent: agent,
        prompt: textPrompt(contextPrompt(agent, resolved.prompt)),
        signal: AbortSignal.timeout(60_000),
        // 纯对话：空工具白名单 = 子会话看不到也执行不了任何工具。
        toolFilter: { allow: [] },
        // 命名/自动路由：严格遵守配置的 provider/model。
        ...(resolved.agentOptions !== undefined ? { agentOptions: resolved.agentOptions } : {}),
      },
    })
    return { ok: true, childId }
  } catch (error) {
    return { ok: false, message: '启动侧边聊天失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}

/* ---------------- wiring ---------------- */

function registerRoutes(webServer, ctx) {
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {}
  const dispose = webServer.register({
    kind: 'prefix',
    path: '/api/upstream-fixes',
    handler: (req, res) => {
      const json = (status, body) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      const readBody = () => new Promise((done, fail) => {
        let body = ''
        req.on?.('data', (chunk) => { body += chunk.toString('utf8') })
        req.on?.('end', () => done(body))
        req.on?.('error', fail)
      })
      const url = req.url ?? '/'
      const method = (req.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0] ?? '/'
      void (async () => {
        try {
          if (method === 'GET' && (path === '/api/upstream-fixes/versions' || path === '/api/upstream-fixes/versions/')) {
            json(200, { ok: true, versions: versionRows() })
            return
          }
          if (method === 'POST' && (path === '/api/upstream-fixes/versions/refresh' || path === '/api/upstream-fixes/versions/refresh/')) {
            const did = refreshVersions(false)
            json(200, { ok: true, refreshed: did, versions: versionRows() })
            return
          }
          if (method === 'POST' && (path === '/api/upstream-fixes/update' || path === '/api/upstream-fixes/update/')) {
            let parsed = {}
            try { parsed = JSON.parse(await readBody()) } catch { /* keep {} */ }
            const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
            if (name.length === 0) {
              json(400, { ok: false, message: 'update needs a package name' })
              return
            }
            const result = updateInstalledPlugin(name)
            json(result.ok ? 200 : 502, result)
            return
          }
          // Settings auto-expose: full (redacted) namespace list for the
          // client bridge, bypassing the official hardcoded whitelist.
          if (method === 'GET' && (path === '/api/upstream-fixes/settings/describe' || path === '/api/upstream-fixes/settings/describe/')) {
            const settings = ctx.get('settings')
            if (settings === undefined) {
              json(200, { ok: false, message: 'settings service unavailable' })
              return
            }
            json(200, {
              ok: true,
              writable: settings.writable,
              hasDocument: settings.documentPath !== undefined,
              namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
            })
            return
          }
          // 子代理名称 -> 模型配置（面板「模型」区读写）。
          if (method === 'GET' && (path === '/api/upstream-fixes/subagent-models' || path === '/api/upstream-fixes/subagent-models/')) {
            json(200, { ok: true, models: readSubagentModels() })
            return
          }
          if (method === 'POST' && (path === '/api/upstream-fixes/subagent-models' || path === '/api/upstream-fixes/subagent-models/')) {
            let parsed = {}
            try { parsed = JSON.parse(await readBody()) } catch { /* keep {} */ }
            const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
            if (name === '') {
              json(400, { ok: false, message: '需要子代理名称' })
              return
            }
            const models = readSubagentModels()
            if (parsed.remove === true) {
              delete models[name]
              writeSubagentModels(models)
              json(200, { ok: true, models })
              return
            }
            const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : ''
            const model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
            if (provider === '' || model === '') {
              json(400, { ok: false, message: '需要 provider 与 model' })
              return
            }
            const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
            models[name] = {
              ...(description === '' ? {} : { description }),
              provider,
              model,
            }
            writeSubagentModels(models)
            json(200, { ok: true, models })
            return
          }
          // 设置页全局模型目录（无会话上下文）。
          if (method === 'GET' && (path === '/api/upstream-fixes/model-catalog' || path === '/api/upstream-fixes/model-catalog/')) {
            const catalog = await modelCatalog(ctx)
            json(catalog.ok ? 200 : 502, catalog)
            return
          }
          // 面板「直接对话」入口：不经命令系统，主会话零记录。
          if (method === 'POST' && (path === '/api/upstream-fixes/sidechat/start' || path === '/api/upstream-fixes/sidechat/start/')) {
            let parsed = {}
            try { parsed = JSON.parse(await readBody()) } catch { /* keep {} */ }
            const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
            const text = typeof parsed.text === 'string' ? parsed.text : ''
            const result = await startSideChat(ctx, sessionId, text)
            json(result.ok ? 200 : 502, result)
            return
          }
          const settingsMatch = /^\/api\/upstream-fixes\/settings\/(mutate|update|replace)$/.exec(path)
          if (method === 'POST' && settingsMatch !== null) {
            const mode = settingsMatch[1]
            let parsed = {}
            try { parsed = JSON.parse(await readBody()) } catch { /* keep {} */ }
            const ns = typeof parsed.ns === 'string' ? parsed.ns : ''
            if (ns.length === 0) {
              json(200, { ok: true, result: { ok: false, code: 'settings-rejected', message: 'settings write needs a namespace', details: {} } })
              return
            }
            const settings = ctx.get('settings')
            const result = await settingsWriteResult(
              settings,
              mode,
              ns,
              mode === 'mutate' ? parsed.ops : parsed.section,
              parsed.expectedRevision,
            )
            json(200, { ok: true, result })
            return
          }
          json(404, { ok: false, message: 'not found' })
        } catch (error) {
          json(500, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      })()
    },
  })
  return dispose
}

/* ---------------- side chat commands (/side /chat) ---------------- */

/** Provider name the official in-process fork backend registers as. */
export const FORK_PROVIDER = 'fork'

/** One user text block. */
function textPrompt(text) {
  return [{ type: 'text', text }]
}

/** Extract the joined text of content blocks ('' when none). */
function promptTextOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Extract the text of one user/assistant message event. */
function messageText(event) {
  if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return ''
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Recent parent conversation tail (user/assistant messages), for the child
 * prompt. The fork provider only seeds COMPLETED turns, so a fresh
 * conversation — or one whose current turn has not ended — would leave the
 * child without context; carrying an explicit recent tail guarantees the
 * child understands what the question refers to.
 */
export function parentContext(agent, maxMessages = 8, maxChars = 4000) {
  try {
    const events = agent?.session?.events
    if (!Array.isArray(events)) return ''
    const lines = []
    for (const event of events) {
      const text = messageText(event)
      if (text === '') continue
      lines.push((event.type === 'user/message' ? '用户：' : '助手：') + text)
    }
    let joined = lines.slice(-maxMessages).join('\n')
    if (joined.length > maxChars) joined = joined.slice(0, maxChars) + '…'
    return joined
  } catch {
    return ''
  }
}

/** The child prompt: the question, with the parent tail prepended when any. */
export function contextPrompt(agent, question) {
  const context = parentContext(agent)
  if (context === '') return question
  return '当前对话上下文（最近的对话记录，仅用于理解问题背景）：\n' + context + '\n---\n问题：' + question
}

/** Durable child label: one trimmed line, capped. */
function shortLabel(text) {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > 40 ? line.slice(0, 40) + '…' : line
}

/**
 * /side command definition (own implementation, driving the official
 * subagent service + fork provider): a durable continuable child; later
 * messages keep the same conversation (the panel's composer).
 */
export function sideCommandsDefinition(subagents) {
  const unavailable = (what) => ({
    kind: 'error',
    text: '子代理服务不可用，无法启动' + what,
  })
  const noFork = (what) => ({
    kind: 'error',
    text: '缺少子代理 fork 后端（@deepseek-ai/dsh-subagent-fork-in-process），无法启动' + what,
  })
  const missing = (what) => {
    if (subagents === undefined) return unavailable(what)
    if (subagents.getProvider?.(FORK_PROVIDER) === undefined) return noFork(what)
    return undefined
  }
  return [
    {
      name: 'side',
      description: 'Start a continuable side conversation in a background child',
      recordInput: false,
      input: { hint: '<question>' },
      handler: async ({ agent, rawInput, signal }) => {
        const question = rawInput.trim()
        if (question === '') return { kind: 'error', text: '/side 需要一个问题：/side <问题>' }
        const refuse = missing('侧边对话')
        if (refuse !== undefined) return refuse
        try {
          const resolved = resolveDispatch(question, readSubagentModels())
          const { childId } = await subagents.startContinuable({
            provider: FORK_PROVIDER,
            label: resolved.name ?? shortLabel(question),
            request: {
              parent: agent,
              prompt: textPrompt(contextPrompt(agent, resolved.prompt)),
              signal,
              ...(resolved.agentOptions !== undefined ? { agentOptions: resolved.agentOptions } : {}),
            },
          })
          return { kind: 'success', text: '已启动侧边对话 ' + childId + '（可在侧栏面板继续对话）' }
        } catch (error) {
          return { kind: 'error', text: '启动侧边对话失败：' + (error instanceof Error ? error.message : String(error)) }
        }
      },
    },
  ]
}

export function apply(ctx) {
  // Skip when a real httpServer service already exists (e.g. a future dsh
  // version restores the legacy name) — never shadow a genuine provider.
  if (ctx.get('httpServer') === undefined) {
    ctx.reflect.provide('httpServer', ctx.webServer)
  }
  ctx.effect(() => registerRoutes(ctx.webServer, ctx), 'upstream-fixes: real-update routes + settings bridge')
  // 全局派发规则：拦截 fork 提供者的 start——所有经该提供者的一步派发
  // （含模型工具发起的子代理）都经过命名/描述路由。continuable 派发
  // 不经过 provider.start，由上方命令与直连路由各自解析。
  ctx.inject(['subagents'], (subCtx) => {
    installDispatchRule(subCtx.get('subagents'))
  })
  // /side：命令注册是可选面——没有命令服务时静默跳过（不阻塞插件）。
  ctx.inject(['commands'], (commandCtx) => {
    const subagents = commandCtx.get('subagents')
    for (const definition of sideCommandsDefinition(subagents)) {
      commandCtx.commands.register(definition)
    }
  })
}
