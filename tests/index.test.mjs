/**
 * Integration tests for the Node half's real-update logic, against a temp
 * DSH_HOME (process.env.DSH_HOME) — never the live ~/.dsh profile:
 *
 *  - local git plugin: link: dep pointing at a clone whose upstream gains
 *    a new commit -> updateInstalledPlugin pulls it and reports the change.
 *  - local non-git directory -> clean failure with a helpful message.
 *  - registry plugin: pnpm update --latest really moves an exact pin.
 *  - unknown package -> clean failure.
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homes = []
const dirs = []

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fakeHome(profileManifest) {
  const home = tempDir('ufx-home-')
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify(profileManifest, undefined, 2))
  homes.push(home)
  return home
}

function git(cwd, args) {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('updateInstalledPlugin (local git)', () => {
  it('pulls new commits and rebuilds the local plugin', async () => {
    // upstream repo with a versioned package.json
    const upstream = tempDir('ufx-up-')
    git(upstream, ['init', '-b', 'main'])
    git(upstream, ['config', 'user.email', 't@example.com'])
    git(upstream, ['config', 'user.name', 'Tester'])
    writeFileSync(join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
    git(upstream, ['add', '.'])
    git(upstream, ['commit', '-m', 'v1.0.0'])
    // clone = the user's local install
    const clone = tempDir('ufx-clone-')
    git(join(tmpdir()), ['clone', upstream, clone])
    // profile depends on it via link:
    const home = fakeHome({ dependencies: { 'demo-plugin': 'link:' + clone } })
    // node_modules view of the plugin (version before the pull)
    const installed = join(home, 'profiles', 'web', 'node_modules', 'demo-plugin')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
    process.env.DSH_HOME = home
    const { updateInstalledPlugin, versionRows, refreshVersions } = await import('../lib/index.js')
    // give the clone node_modules so the post-pull rebuild runs
    mkdirSync(join(clone, 'node_modules'))
    // upstream releases 1.1.0 with a build script (rebuild path)
    writeFileSync(join(upstream, 'package.json'), JSON.stringify({
      name: 'demo-plugin',
      version: '1.1.0',
      scripts: { build: 'node -e "1"' },
    }))
    git(upstream, ['add', '.'])
    git(upstream, ['commit', '-m', 'v1.1.0'])
    const result = updateInstalledPlugin('demo-plugin')
    assert.equal(result.ok, true)
    assert.equal(result.updated, true)
    assert.match(result.message, /已拉取 [0-9a-f]{7} → [0-9a-f]{7}/)
    assert.match(result.message, /已重新构建/)
    // local clone moved to the upstream HEAD
    const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const upstreamHead = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    assert.equal(head, upstreamHead)
    // version check now reports the pulled version
    refreshVersions(true)
    const rows = versionRows()
    const row = rows.find((entry) => entry.name === 'demo-plugin')
    assert.equal(row.latest, '1.1.0')
    assert.equal(row.checked, true)
    // a second update is a no-op
    const again = updateInstalledPlugin('demo-plugin')
    assert.equal(again.ok, true)
    assert.equal(again.updated, false)
  })

  it('fails cleanly for a non-git local directory', async () => {
    const dir = tempDir('ufx-plain-')
    const home = fakeHome({ dependencies: { 'demo-plugin': 'link:' + dir } })
    process.env.DSH_HOME = home
    const { updateInstalledPlugin } = await import('../lib/index.js')
    const result = updateInstalledPlugin('demo-plugin')
    assert.equal(result.ok, false)
    assert.match(result.message, /不是 git 仓库/)
  })

  it('fails cleanly for a package outside the profile dependencies', async () => {
    const home = fakeHome({ dependencies: {} })
    process.env.DSH_HOME = home
    const { updateInstalledPlugin } = await import('../lib/index.js')
    const result = updateInstalledPlugin('nope')
    assert.equal(result.ok, false)
    assert.match(result.message, /不在 web profile 依赖中/)
  })
})

describe('updateInstalledPlugin (registry)', () => {
  it('pnpm update --latest really moves an exact pin', { timeout: 300_000 }, async () => {
    // skip when pnpm is unavailable (no package-manager tooling on the box)
    const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
    if (probe.status !== 0) return
    const home = fakeHome({ dependencies: { 'left-pad': '1.1.3' } })
    process.env.DSH_HOME = home
    const profile = join(home, 'profiles', 'web')
    const install = spawnSync('pnpm', ['install'], { cwd: profile, encoding: 'utf8', timeout: 240_000 })
    if (install.status !== 0) return // registry unreachable — skip
    const { updateInstalledPlugin } = await import('../lib/index.js')
    const result = updateInstalledPlugin('left-pad')
    assert.equal(result.ok, true)
    assert.equal(result.updated, true)
    assert.match(result.message, /已更新 1\.1\.3 → 1\.3\.0/)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['left-pad'], '1.3.0')
  })
})
