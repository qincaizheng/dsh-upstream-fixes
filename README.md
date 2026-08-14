# @dsh-external/dsh-upstream-fixes

Compatibility fixes for broken third-party dsh plugins, packaged as one
installable bundle plugin so every user gets the same repair without editing
the broken packages or their profile config by hand.

## What it fixes

### 1. dsh-auto-approval@0.1.0 — scoped package names that were never published

The package's `cordis.patch.yml` mounts its plugins as
`@deepseek-ai/dsh-auto-approval` and `@deepseek-ai/dsh-client-ui-auto-approval`,
but both are published on npm under **bare names** (`dsh-auto-approval`,
`dsh-client-ui-auto-approval`); the scoped names do not exist. `dsh web` dies
at boot with `ERR_MODULE_NOT_FOUND`.

Fix: a postinstall script (`scripts/install-aliases.mjs`) symlinks the scoped
names to the real packages in `$DSH_HOME/profiles/node_modules` (pnpm never
manages that directory, so the links survive profile reinstalls). The entries,
their ids, and the client bundle's self-registration id then all agree.

### 2. dsh-sidechain@0.6.2 — deep runtime source import in the client bundle

The package's client bundle requires
`@deepseek-ai/dsh-client-runtime/src/client/sessions/context-provenance.ts`,
which is not in the client module table (and the published runtime ships no
`src/`). Loading the web UI fails with `missed the module table`.

Fix: this plugin's client bundle registers, during the `immediately` prefetch
tier (before any plugin factory materializes), a shim factory for that exact
specifier that delegates to the public
`@deepseek-ai/dsh-client-runtime/client` entry.

### 3. dsh-vision-toolkit@0.1.2 — legacy `httpServer` service key

The package attaches its Web routes by injecting the legacy `httpServer`
service, but the current webserver registers itself as `webServer`, so the
inject never resolves: `/_dsh/vision-toolkit/settings` falls through to the
SPA index and the settings panel dies with
`Unexpected token '<', "<!doctype "... is not valid JSON`.

Fix: this plugin's host half provides an `httpServer` alias pointing at the
same `webServer` service instance, so the legacy inject resolves and the
routes attach. The alias is skipped if a real `httpServer` service exists.

### 4. plugin-console@0.1.0 — the update button never performs a real update

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

### 5. dsh-task-board + dsh-ssh — sidebar entry buttons glued together

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

### 6. dsh-host-apiproxy — hardcoded settings namespace whitelist

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

### 7. Own side-chat feature (dsh-sidechain replacement)

Replaces the dsh-sidechain plugin with an in-house implementation —
**dsh-sidechain is no longer needed and can be uninstalled.** Written from
scratch against the official SDK (subagent service + fork provider + command
registry + better-sidebar tab registry), no sidechain code copied.

Host half registers two slash commands:

- `/side <question>` — durable **continuable** child on the official fork
  backend; later messages keep the same conversation (the panel's composer).
- `/btw <question>` — **one-shot** background child; its answer lands in the
  child log and the run is disposed in the background once it settles.
  A bare `/btw` (no arguments) just **opens the Side chat panel**.
- `/btw` is **ephemeral**: the card renders nothing in the main
  conversation (the question text is never recorded either), and shortly
  after the run settles the child is archived and its persisted session is
  physically deleted — no history remains. The official command lifecycle
  events themselves cannot be suppressed by a plugin (the dispatcher always
  appends `command/run`/`command/done`); they stay invisible in the UI.
- `/chat <message>` — **pure-chat** continuable child with an empty tool
  allowlist: it can only converse, no tools visible or executable.
- the commands **carry the recent parent conversation tail** into the
  child prompt (the fork seed only covers completed turns — a fresh
  conversation or an unfinished turn would otherwise leave the child
  without context).

Client half provides:

- a **Side chat tab in dsh-better-sidebar** (official registry): child list
  with live state, embedded transcript (3s polling while visible), interrupt
  for running ones, and **one** bottom composer — with no child selected it
  starts a brand-new pure-chat conversation through a direct host route
  (`POST /api/upstream-fixes/sidechat/start`, nothing recorded in the main
  conversation), with a continuable child selected the same input replies
  to it; a hidden legacy `sidechain` alias recovers tabs persisted from
  before the rename (better-sidebar keeps open tabs in localStorage —
  without the alias they would render as a permanent "plugin not loaded"
  orphan);
- command cards for `/side` and `/btw` that **auto-open the tab** (and
  preselect the child) when the command settles — once per child per
  browser tab, so historical cards never re-trigger the popup — plus a
  manual "view in sidebar" jump;
- a Ctrl/Cmd+Shift+E shortcut and a session-header 侧聊 toggle, both opening
  the tab.

Both halves live in this plugin — no floating panel, no DOM surgery. Restart
`dsh web` (host commands) and refresh the page (client bundle).

## Install

Clone the repository and add the plugin by its local path:

```sh
git clone https://github.com/qincaizheng/dsh-upstream-fixes.git ~/.dsh/plugins/dsh-upstream-fixes
dsh plugin --profile web add ~/.dsh/plugins/dsh-upstream-fixes
```

`dsh plugin add` with a file path installs a `link:` dependency, and pnpm does
not run postinstall scripts for linked packages. Create the alias symlinks
manually:

```sh
node ~/.dsh/plugins/dsh-upstream-fixes/scripts/install-aliases.mjs
```

The same command doubles as a repair tool: re-run it whenever the links go
stale (profile reinstall, DSH home move, ...). If you install the package
from a registry instead, the postinstall runs automatically.

Fix 4 (real plugin updates) is a Node-half route: after installing or
updating this package, restart `dsh web` and refresh the page. Then open
设置 → 插件, click 检查更新, and the 更新 button performs a real update
(git pull for local git plugins, `pnpm update --latest` for registry ones).

## Remove

```sh
dsh plugin --profile web rm @dsh-external/dsh-upstream-fixes
```

Removing the plugin does not delete the symlinks; delete them manually if you
also remove the broken plugins.
