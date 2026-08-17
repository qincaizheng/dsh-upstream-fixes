# @dsh-external/dsh-upstream-fixes

Compatibility fixes for broken third-party dsh plugins, packaged as one
installable bundle plugin so every user gets the same repair without editing
the broken packages or their profile config by hand.

## What it fixes

### 1. dsh-sidechain@0.6.2 — deep runtime source import in the client bundle

The package's client bundle requires
`@deepseek-ai/dsh-client-runtime/src/client/sessions/context-provenance.ts`,
which is not in the client module table (and the published runtime ships no
`src/`). Loading the web UI fails with `missed the module table`.

Fix: this plugin's client bundle registers, during the `immediately` prefetch
tier (before any plugin factory materializes), a shim factory for that exact
specifier that delegates to the public
`@deepseek-ai/dsh-client-runtime/client` entry.

### 2. dsh-vision-toolkit@0.1.2 — legacy `httpServer` service key

The package attaches its Web routes by injecting the legacy `httpServer`
service, but the current webserver registers itself as `webServer`, so the
inject never resolves: `/_dsh/vision-toolkit/settings` falls through to the
SPA index and the settings panel dies with
`Unexpected token '<', "<!doctype "... is not valid JSON`.

Fix: this plugin's host half provides an `httpServer` alias pointing at the
same `webServer` service instance, so the legacy inject resolves and the
routes attach. The alias is skipped if a real `httpServer` service exists.

### 3. plugin-console@0.1.0 — the update button never performs a real update

The plugin-console panel's 更新 button only runs `pnpm update <name>` inside
the profile. That is a **no-op for `link:`/`file:` local dependencies** (the
mainstream shape for third-party plugins — every user plugin in this profile
is one) and range-bound for registry dependencies (an exact pin like
`0.1.0-rc.1` never moves, `^` ranges only move inside the range). Clicking
更新 does nothing visible.

Fix, without editing plugin-console:

- the client bundle (loaded in the `immediately` tier, before any settings
  panel exists) installs a `fetch` bridge that redirects the panel's update
  request to `/api/upstream-fixes/update` and merges this plugin's local-git
  rows into the panel's version reads;
- the host half serves two routes:
  - `POST /api/upstream-fixes/update` — **real update**: `link:`/`file:`
    dependencies that are git repositories get `git pull --ff-only` (plus a
    best-effort `pnpm build` when the plugin ships a build script and has
    `node_modules`); everything else gets `pnpm update --latest`, which
    chases the newest published version regardless of range, followed by a
    `dsh.profile.bundles` membership reconcile.
  - `GET/POST /api/upstream-fixes/versions[/refresh]` — cached version
    checks that cover local git remotes (the upstream `package.json`
    version, compared semver-style so the panel's update button appears
    exactly when a newer release exists).

Bundle plugins still need a web restart after the update; client-only
plugins need a page refresh.

### 4. dsh-task-board + dsh-ssh — sidebar entry buttons glued together

The two plugins inject their sidebar rows as plain DOM buttons
(`data-dsh-taskboard-entry` / `data-dsh-ssh-entry`) directly into the sidebar
root — siblings with no wrapper and no vertical margin, so the two rows touch
and render as one glued block.

Fix: this plugin's client bundle injects one small stylesheet at the
`immediately` tier:

```css
[data-dsh-taskboard-entry], [data-dsh-ssh-entry] { margin: 2px 0; }
```

Both plugins' own `.entry` rules never set `margin`, so the attribute
selector applies cleanly without fighting their styles (and it still applies
when only one of the two plugins is installed). Client-side only: a page
refresh is enough.

### 5. dsh-host-apiproxy — hardcoded settings namespace whitelist

The official ApiProxy decides which settings namespaces the Web client may
read and write through a hardcoded allowlist (`WEB_SETTINGS_NAMESPACES`:
agent-loop, shell, locale, permission, ui-conversation, ui-theme,
web-search-deepseek; plus product namespaces and the dynamic model-provider
namespaces). A plugin namespace outside the list answers
`settings-not-exposed` even though its owner registered it — so third-party
settings cards (task-board, dsh-ssh, ...) never appear on the settings page.

Fix, without touching the official package:

- the host half serves the **full** redacted settings view and a write seam:
  - `GET /api/upstream-fixes/settings/describe` — every registered
    namespace (redactSecrets, same wire shape as the official view);
  - `POST /api/upstream-fixes/settings/{mutate,update,replace}` — writes
    against the host settings service with the official result envelope
    (`settings-rejected` / `settings-conflict` mapping included).
- the client bundle intercepts the RPC fetches (`POST /api/settings.*`):
  `settings.describe` responses get the missing namespaces merged in
  (rpcId echo preserved, official schemas still parse), and writes for
  namespaces the official whitelist does not serve are routed through the
  bridge above.

Net effect: the settings page **automatically reads and writes every
registered namespace** — no whitelist maintenance. Trade-off to keep in
mind: this removes the official default-deny boundary for browser settings
access, so any namespace a plugin registers becomes editable from the Web
UI (the describe side stays secret-redacted, matching the official view).
Node-half route + client bridge: restart `dsh web`, then refresh the page.

## Install

Clone the repository and add the plugin by its local path:

```sh
git clone https://github.com/qincaizheng/dsh-upstream-fixes.git ~/.dsh/plugins/dsh-upstream-fixes
dsh plugin --profile web add ~/.dsh/plugins/dsh-upstream-fixes
```

## Remove

```sh
dsh plugin --profile web rm @dsh-external/dsh-upstream-fixes
```
