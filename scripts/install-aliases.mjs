/**
 * Postinstall repair: make the scoped package names referenced by
 * dsh-auto-approval@0.1.0's cordis.patch.yml resolve to the packages that
 * actually exist on npm (published under bare names).
 *
 * Creates symlinks in $DSH_HOME/profiles/node_modules — the fallback
 * node_modules shared by every profile, which pnpm never manages — so the
 * aliases survive profile reinstalls and apply to all profiles at once.
 * Idempotent: existing correct links are kept, dangling links are replaced.
 */
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)

/** scoped name referenced by the broken patch -> bare name published on npm */
const ALIASES = [
  ['@deepseek-ai/dsh-auto-approval', 'dsh-auto-approval'],
  ['@deepseek-ai/dsh-client-ui-auto-approval', 'dsh-client-ui-auto-approval'],
]

function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

function resolvePkgDir(spec) {
  // Registry installs: this package sits inside the profile's node_modules,
  // so its own dependency resolution finds the hoisted packages.
  try {
    return dirname(require.resolve(`${spec}/package.json`))
  } catch {}
  // link:/file installs: this package lives outside the profile tree. Fall
  // back to scanning every profile's node_modules for the hoisted package.
  const profilesDir = join(dshHome(), 'profiles')
  if (!existsSync(profilesDir)) throw new Error(`cannot resolve ${spec}`)
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(profilesDir, entry.name, 'node_modules', spec, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
  }
  throw new Error(`cannot resolve ${spec} in any profile node_modules`)
}

function linkPointsAt(link, target) {
  if (!existsSync(link)) return false
  try {
    return realpathSync(link) === realpathSync(target)
  } catch {
    return false // dangling link
  }
}

const fallback = join(dshHome(), 'profiles', 'node_modules')
let failed = 0

for (const [alias, bare] of ALIASES) {
  const link = join(fallback, alias)
  let existing = lstatSync(link, { throwIfNoEntry: false })
  if (existing !== undefined && existing.isDirectory() && !existing.isSymbolicLink()) {
    console.warn(`[dsh-upstream-fixes] ${link} is a real directory, not a link — leaving it alone`)
    continue
  }
  let target
  try {
    target = resolvePkgDir(bare)
  } catch (error) {
    console.warn(`[dsh-upstream-fixes] skip ${alias}: cannot resolve ${bare} (${String(error.message ?? error)})`)
    failed++
    continue
  }
  if (linkPointsAt(link, target)) {
    console.log(`[dsh-upstream-fixes] ok ${alias} -> ${target}`)
    continue
  }
  try {
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { force: true })
    symlinkSync(target, link, 'dir')
    console.log(`[dsh-upstream-fixes] linked ${alias} -> ${target}`)
  } catch (error) {
    console.error(`[dsh-upstream-fixes] failed to link ${alias}: ${String(error)}`)
    failed++
  }
}

if (failed > 0) process.exitCode = 1
