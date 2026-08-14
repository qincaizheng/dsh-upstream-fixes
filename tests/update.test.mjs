/**
 * Unit tests for lib/update.js: dependency-spec classification and git
 * remote inspection, driven through a fake exec — no network, no real
 * repositories.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifySpec,
  gitHead,
  gitRemoteHead,
  localDirFromSpec,
  remotePackageVersion,
} from '../lib/update.js'

/** exec fake: map keyed by '<file> <args...>' -> result or builder fn. */
function fakeExec(table) {
  return (file, args) => {
    const key = [file, ...args].join(' ').replace(/ -C [^ ]+/, ' -C <dir>')
    const entry = table[key]
    const value = typeof entry === 'function' ? entry(args) : entry
    return value ?? { status: 1, stdout: '', stderr: 'no script for ' + key }
  }
}

describe('classifySpec', () => {
  it('classifies local, git, and registry specs', () => {
    assert.equal(classifySpec('link:/Users/me/plugins/x'), 'local')
    assert.equal(classifySpec('file:../relative/dir'), 'local')
    assert.equal(classifySpec('github:owner/repo#ref'), 'git')
    assert.equal(classifySpec('git+https://example.com/repo.git'), 'git')
    assert.equal(classifySpec('git@github.com:o/r.git'), 'git')
    assert.equal(classifySpec('https://example.com/repo.git#v1'), 'git')
    assert.equal(classifySpec('^1.2.3'), 'registry')
    assert.equal(classifySpec('1.2.3'), 'registry')
    assert.equal(classifySpec('*'), 'registry')
  })
})

describe('localDirFromSpec', () => {
  it('keeps absolute paths and resolves relative ones against the profile', () => {
    assert.equal(localDirFromSpec('link:/abs/dir', '/profile/web'), '/abs/dir')
    assert.equal(localDirFromSpec('link:../plugins/x', '/profile/web'), '/profile/plugins/x')
  })
  it('resolves symlinks to their real target', () => {
    const root = mkdtempSync(join(tmpdir(), 'ufx-spec-'))
    try {
      const target = join(root, 'real')
      mkdirSync(target)
      const link = join(root, 'alias')
      symlinkSync(target, link, 'dir')
      // macOS tmpdir lives behind /private — compare resolved paths.
      assert.equal(localDirFromSpec('link:' + link, '/profile/web'), realpathSync(target))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('gitRemoteHead', () => {
  it('reports a non-repository', () => {
    const state = gitRemoteHead('/nowhere', fakeExec({
      'git -C <dir> rev-parse HEAD': { status: 128, stdout: '', stderr: 'not a repo' },
    }))
    assert.equal(state.error, 'not a git repository')
    assert.equal(state.behind, undefined)
  })
  it('reports no upstream when neither @{u} nor origin/HEAD resolve', () => {
    const exec = fakeExec({
      'git -C <dir> rev-parse HEAD': { status: 0, stdout: 'abc1234\n' },
      'git -C <dir> rev-parse --abbrev-ref --symbolic-full-name @{u}': { status: 128, stdout: '' },
      'git -C <dir> symbolic-ref --quiet refs/remotes/origin/HEAD': { status: 128, stdout: '' },
    })
    const state = gitRemoteHead('/repo', exec)
    assert.equal(state.error, 'no upstream configured')
    assert.equal(state.head, 'abc1234')
  })
  it('falls back to origin/HEAD when @{u} is unset', () => {
    const exec = fakeExec({
      'git -C <dir> rev-parse HEAD': { status: 0, stdout: 'abc1234\n' },
      'git -C <dir> rev-parse --abbrev-ref --symbolic-full-name @{u}': { status: 128, stdout: '' },
      'git -C <dir> symbolic-ref --quiet refs/remotes/origin/HEAD': { status: 0, stdout: 'refs/remotes/origin/main\n' },
      'git -C <dir> fetch --quiet origin': { status: 0, stdout: '' },
      'git -C <dir> rev-parse refs/remotes/origin/main': { status: 0, stdout: 'def5678\n' },
    })
    const state = gitRemoteHead('/repo', exec)
    assert.equal(state.error, undefined)
    assert.equal(state.head, 'abc1234')
    assert.equal(state.remote, 'def5678')
    assert.equal(state.upstreamRef, 'refs/remotes/origin/main')
  })
  it('returns an error when the fetch fails', () => {
    const exec = fakeExec({
      'git -C <dir> rev-parse HEAD': { status: 0, stdout: 'abc1234\n' },
      'git -C <dir> rev-parse --abbrev-ref --symbolic-full-name @{u}': { status: 0, stdout: 'origin/main\n' },
      'git -C <dir> fetch --quiet origin': { status: 128, stdout: '', stderr: 'network down' },
    })
    const state = gitRemoteHead('/repo', exec)
    assert.equal(state.error, 'network down')
    assert.equal(state.remote, undefined)
  })
})

describe('gitHead / remotePackageVersion', () => {
  it('reads HEAD and the upstream package.json version', () => {
    const pkg = JSON.stringify({ name: 'x', version: '1.2.3' })
    const exec = fakeExec({
      'git -C <dir> rev-parse HEAD': { status: 0, stdout: 'abc1234\n' },
      'git -C <dir> show refs/remotes/origin/main:package.json': { status: 0, stdout: pkg },
    })
    assert.equal(gitHead('/repo', exec), 'abc1234')
    assert.equal(remotePackageVersion('/repo', 'refs/remotes/origin/main', exec), '1.2.3')
  })
  it('returns null when the remote has no version', () => {
    const exec = fakeExec({
      'git -C <dir> show refs/remotes/origin/main:package.json': { status: 0, stdout: '{ "name": "x" }' },
    })
    assert.equal(remotePackageVersion('/repo', 'refs/remotes/origin/main', exec), null)
  })
})
