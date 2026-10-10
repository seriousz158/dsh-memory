# Installation

## Prerequisites

- DSH desktop app `0.2.0-rc.2` (0.2.x), or the DSH web runtime `0.1.0-rc.7`
- Node.js 22.x
- Python 3.11.x
- Git available on `PATH`
- A local clone of this repository

Install the pinned DSH runtime yourself, then install the plugin repository
dependencies:

```zsh
npm install --global @deepseek-ai/dsh@0.1.0-rc.7
dsh --version
git clone https://github.com/seriousz158/dsh-memory.git
cd dsh-memory
npm ci --ignore-scripts
```

## DSH desktop app (0.2.x)

The desktop app (`/Applications/DeepSeek Harness.app`, DSH `0.2.0-rc.2` and
later 0.2.x) uses the `desktop` profile under `~/.dsh/profiles/desktop`. Only
packages listed in that profile's `dsh.profile.bundles` are activated; a plain
`file:` dependency is installed but never loaded. Install the aggregate bundle
through the plugin manager so it lands in `bundles`:

```zsh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add /absolute/path/to/dsh-memory
```

Rules for the desktop profile:

- Install **either** the aggregate `dsh-git-memory` bundle (recommended; it
  ships its own settings client) **or** the split `dsh-memory` +
  `dsh-memory-ui` pair, never both: two clients mounting the same `memory`
  remote fail with "already mounted".
- The app is usually started from Finder or the Dock, which do not pass shell
  exports. Keep the memory repository at the default
  `~/.dsh/storages/memory`; do not rely on `DSH_MEMORY_ROOT` for the app.
- `memory.enabled` is a live (volatile) setting: toggling Settings → 长期记忆
  takes effect for the next model call without a restart. It is stored as the
  `memory` entry's config in `~/.dsh/profiles/desktop/cordis.patch.yml`, and the
  scheduled synchronizer honors it there.
- The settings `settings.yaml` of older DSH homes is imported once by the app
  and renamed to `settings.yaml.imported`.

For the scheduled synchronizer on desktop, see [Optional scheduled sync](#optional-scheduled-sync):
it finds the app's bundled CLI automatically when `dsh` is not on `PATH`.

## Install into DSH (web runtime 0.1.x)

### Public bundle

For a normal DSH profile, install the combined host + Web client bundle:

```zsh
# GitHub source install (no npm login required)
dsh plugin --profile web add github:seriousz158/dsh-memory

# Use this shorter form after the public npm package is published
dsh plugin --profile web add dsh-git-memory
```

The package declares a `dsh.bundle` patch and a Web `dsh.client` entry. DSH
therefore adds the memory host row and discovers the settings UI from the same
package; no manual `cordis.patch.yml` edit or profile symlink is needed.

### Local source checkout

```zsh
./integrations/dsh/install.sh
```

The default DSH home is `$HOME/.dsh`. To use another DSH home or a separate
memory repository, configure both values in the environment that will also
start DSH later:

```zsh
export DSH_HOME="$HOME/.config/dsh"
export DSH_MEMORY_ROOT="$HOME/Documents/dsh-memory-data"
./integrations/dsh/install.sh
# Start DSH from this configured environment too.
```

The installer resolves this repository from its own script location and creates two links under the selected DSH profile. It preserves unrelated root-level Cordis patch entries, rejects unexpected package links, and refuses a symlinked `profiles/` or `node_modules/` path that would escape the chosen DSH home. It also initializes a missing memory root as a local Git repository and restores private permissions on an existing complete root. Re-run it after pulling an updated clone; it is intended to be idempotent.

## Optional custom memory root

Set an absolute `DSH_MEMORY_ROOT` only when you need storage outside the
default DSH home. Use the same pair for the installer, the DSH host, manual
validation, and scheduled sync; a one-time command assignment is not persisted
for later terminal or LaunchAgent processes:

```zsh
export DSH_HOME="$HOME/.dsh"
export DSH_MEMORY_ROOT="$HOME/Documents/dsh-memory-data"
./integrations/dsh/install.sh
# Run `dsh` from this environment, or configure these values in its launcher.
```

The host validates the final layout and refuses symbolic links/non-Git roots. The browser UI cannot configure this value.

## Enable and initialize

Restart DSH, then open Settings → 长期记忆. The setting defaults to enabled. The installer has already initialized the selected memory root; an incomplete, unsafe, or non-Git root is refused instead of being silently reused.

You can explicitly validate the existing root and restore its private permissions:

```zsh
./integrations/dsh/dsh-memory-init

# With custom paths, pass the same values:
DSH_HOME="/absolute/path/to/dsh-home" \
  DSH_MEMORY_ROOT="/absolute/path/to/memory" \
  ./integrations/dsh/dsh-memory-init
```

## Optional scheduled sync

The provided plist is a template. Copy it only after replacing the repository
location with your actual local clone, then load it using your normal
LaunchAgent workflow. It defaults to no run at load and a one-hour interval.
Its command explicitly sets the default `DSH_HOME` and `DSH_MEMORY_ROOT`. If
you use custom values, replace **both** assignments in the template before
loading it: a LaunchAgent does not reliably inherit the one-time shell exports
used during installation.

The sync command does not install DSH. It uses, in order: an explicit
`DSH_BIN` (never second-guessed), a `dsh` executable on `PATH`, then the CLI
bundled with the desktop app (`$DSH_APP_BUNDLE`, default
`/Applications/DeepSeek Harness.app`, then `~/Applications`). It performs no
work while `memory.enabled` is false, whether that value comes from the desktop
profile patch or from a legacy `settings.yaml`.

Session discovery accepts every session-log generation (`session.jsonl`,
`session.v3.jsonl.zstd`, desktop 0.2's `session.v4.jsonl.zstd`, …) and delivers
only the newest generation of each session. It skips sessions whose
`session.lock` is still held by a running DSH process (checked with `lsof`),
the synchronizer's own staging sessions, and throwaway working directories
under the system temp locations (set
`DSH_MEMORY_SYNC_INCLUDE_TMP=1` to include the latter). Every real run writes a
metadata-only `.sync/heartbeat.json` (time, exit code, candidate count) so a
health check can distinguish an idle synchronizer from a stalled one.
The wrapper also discovers a local Homebrew or nvm Node runtime when launchd
starts with a minimal `PATH`; no interactive shell profile is required.

The v0.8.4 host and UI packages still declare the runtime peer range
`@deepseek-ai/dsh@^0.1.0-rc.6`, so DSH `rc.6` remains peer-compatible. The
repository's reproducible clean-room and local integration baseline is
`0.1.0-rc.7`, because the registry's `rc.6` transitive peer graph is not
resolvable by plain `npm ci`. DSH `rc.8` and later are unverified. Avoid an
unversioned `npx` or global install that can silently select a newer
prerelease; verify the selected executable with `dsh --version` before
installation and testing.
