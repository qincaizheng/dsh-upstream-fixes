/**
 * Host half of @dsh-external/dsh-upstream-fixes: a cordis function plugin
 * carrying the repair hooks described in README.md:
 *
 *  - lib/client.js registers a client-modules shim so dsh-sidechain's client
 *    bundle can require its deep runtime source path.
 *  - scripts/install-aliases.mjs (postinstall) creates the scoped-name
 *    symlinks that dsh-auto-approval's bundle patch references but were
 *    never published.
 *  - this module provides an `httpServer` service alias: plugins built
 *    against older dsh releases (e.g. dsh-vision-toolkit@0.1.2) inject the
 *    legacy `httpServer` key, but the current webserver registers itself as
 *    `webServer`. The alias points both names at the same instance, so the
 *    legacy inject resolves and its routes actually attach.
 */
export const name = 'upstream-fixes'
export const inject = ['webServer']
export function apply(ctx) {
  // Skip when a real httpServer service already exists (e.g. a future dsh
  // version restores the legacy name) — never shadow a genuine provider.
  if (ctx.get('httpServer') !== undefined) return
  return ctx.reflect.provide('httpServer', ctx.webServer)
}
