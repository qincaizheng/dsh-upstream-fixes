/**
 * Host half of @dsh-external/dsh-upstream-fixes: a no-op cordis function
 * plugin. Its only jobs are (1) to exist as a loader entry so the client
 * half below gets composed into the web boot graph, and (2) to carry the
 * postinstall repair script (scripts/install-aliases.mjs).
 *
 * All actual repair work lives in:
 *  - scripts/install-aliases.mjs — creates the scoped-name symlinks that
 *    dsh-auto-approval's bundle patch references but were never published.
 *  - lib/client.js — registers a client-modules shim so dsh-sidechain's
 *    client bundle can require its deep runtime source path.
 */
export const name = 'upstream-fixes'
export const inject = []
export function apply() {}
