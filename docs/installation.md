# Installation

## Prerequisites

- DSH `0.1.0-rc.7` (recommended and tested)
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

## Install into DSH

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

The sync command does not install DSH. It requires a `dsh` executable on `PATH`, or a deliberately configured `DSH_BIN`. It performs no work while `memory.enabled` is false.

The v0.4.0 host and UI packages still declare the runtime peer range
`@deepseek-ai/dsh@^0.1.0-rc.6`, so DSH `rc.6` remains peer-compatible. The
repository's reproducible clean-room and local integration baseline is
`0.1.0-rc.7`, because the registry's `rc.6` transitive peer graph is not
resolvable by plain `npm ci`. DSH `rc.8` and later are unverified. Avoid an
unversioned `npx` or global install that can silently select a newer
prerelease; verify the selected executable with `dsh --version` before
installation and testing.
