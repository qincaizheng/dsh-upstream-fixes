# @dsh-external/dsh-upstream-fixes

Compatibility fixes for two broken third-party dsh plugins, packaged as one
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

## Install

```sh
dsh plugin --profile web add @dsh-external/dsh-upstream-fixes
```

The postinstall runs automatically for registry installs. If you installed
from a local path (postinstall does not run for `link:` deps), or the links
ever go stale, repair with:

```sh
node scripts/install-aliases.mjs   # from inside this plugin directory
```

## Remove

```sh
dsh plugin --profile web rm @dsh-external/dsh-upstream-fixes
```

Removing the plugin does not delete the symlinks; delete them manually if you
also remove the broken plugins.
