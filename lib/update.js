/**
 * Update-support helpers (fix 4): dependency-source classification and git
 * remote inspection, pure over an injected exec so unit tests never touch
 * the real profile or network.
 *
 * The plugin-console panel's update button only runs `pnpm update <name>`
 * in the profile — a no-op for link:/file: local dependencies (the
 * mainstream install shape for third-party plugins) and range-bound for
 * registry dependencies. This module supplies the real-update primitives:
 *
 * - classifySpec: dependency spec -> local (link:/file:) / git / registry
 * - localDirFromSpec: local spec -> real directory (symlinks resolved)
 * - gitHead / gitRemoteHead: local HEAD vs upstream HEAD (fetch only moves
 *   remote-tracking refs — checking never writes user code)
 * - remotePackageVersion: the upstream package.json version (used for the
 *   panel's version display, which only understands semver equality)
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** spawnSync wrapper shaped like the console plugin's exec usage. */
export function gitExec(file, args, opts = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: opts.timeout ?? 60_000, ...opts })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Dependency spec classification: local directory / git source / registry semver. */
export function classifySpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return 'registry'
  if (spec.startsWith('link:') || spec.startsWith('file:')) return 'local'
  if (/^(git\+|github:|gitlab:|bitbucket:|git:\/\/|git@|ssh:)/.test(spec) || /\.git(?:#.*)?$/.test(spec)) return 'git'
  return 'registry'
}

/**
 * link:/file: spec -> real local directory. Relative specs resolve against
 * the profile directory (pnpm usually writes absolute paths already);
 * symlinked directories resolve to their target.
 */
export function localDirFromSpec(spec, profileDir) {
  const raw = spec.slice(spec.indexOf(':') + 1)
  const dir = isAbsolute(raw) ? raw : resolve(profileDir, raw)
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** git HEAD of a directory; undefined when not a repository / unreadable. */
export function gitHead(dir, exec = gitExec) {
  const result = exec('git', ['-C', dir, 'rev-parse', 'HEAD'])
  return result.status === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : undefined
}

/**
 * Upstream state of a local git repository: HEAD -> upstream ref (@{u},
 * falling back to origin/HEAD) -> fetch origin -> upstream HEAD. The fetch
 * only moves remote-tracking refs, so 'check for updates' never touches the
 * working tree; network failures come back as `error` instead of throwing.
 */
export function gitRemoteHead(dir, exec = gitExec) {
  const head = gitHead(dir, exec)
  if (head === undefined) return { error: 'not a git repository' }
  let upstream = exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.status !== 0) {
    // Clones without a tracking branch: fall back to origin/HEAD.
    upstream = exec('git', ['-C', dir, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  }
  if (upstream.status !== 0) return { head, error: 'no upstream configured' }
  const upstreamRef = upstream.stdout.trim()
  // @{u} yields 'origin/main'; the origin/HEAD fallback yields the full
  // 'refs/remotes/origin/main' ref — the remote name is 'origin' either way.
  const remoteName = upstreamRef.startsWith('refs/remotes/')
    ? upstreamRef.slice('refs/remotes/'.length).split('/')[0]
    : upstreamRef.split('/')[0] || 'origin'
  const fetched = exec('git', ['-C', dir, 'fetch', '--quiet', remoteName], { timeout: 120_000 })
  if (fetched.status !== 0) return { head, error: fetched.stderr.trim() || 'fetch failed' }
  const remote = exec('git', ['-C', dir, 'rev-parse', upstreamRef])
  if (remote.status !== 0) return { head, error: 'cannot resolve ' + upstreamRef }
  return { head, remote: remote.stdout.trim(), upstreamRef }
}

/**
 * The upstream package.json version (git show <ref>:package.json), or null
 * when unreadable / not a string. The console panel compares versions by
 * semver equality, so this is what makes its update button appear for local
 * git plugins whose upstream has released a newer version.
 */
export function remotePackageVersion(dir, upstreamRef, exec = gitExec) {
  const result = exec('git', ['-C', dir, 'show', upstreamRef + ':package.json'])
  if (result.status !== 0) return null
  try {
    const version = JSON.parse(result.stdout).version
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}

