# Installation

## Prerequisites

- DSH `0.1.0-rc.6`
- Node.js 22.x
- Python 3.11.x
- Git available on `PATH`
- A local clone of this repository

Install the matching DSH version yourself, then install the plugin repository dependencies:

```zsh
npm install --global @deepseek-ai/dsh@0.1.0-rc.6
git clone https://github.com/seriousz158/dsh-memory.git
cd dsh-memory
npm ci
```

## Install into DSH

```zsh
./integrations/dsh/install.sh
```

The default DSH home is `$HOME/.dsh`. To target a different existing DSH home:

```zsh
DSH_HOME="$HOME/.config/dsh" ./integrations/dsh/install.sh
```

The installer resolves this repository from its own script location and creates two links under the selected DSH profile. It preserves unrelated Cordis patch entries. Re-run it after pulling an updated clone; it is intended to be idempotent.

## Optional custom memory root

Start DSH with an absolute `DSH_MEMORY_ROOT` only when you need storage outside the default DSH home:

```zsh
export DSH_MEMORY_ROOT="$HOME/Documents/dsh-memory-data"
```

The host validates the final layout and refuses symbolic links/non-Git roots. The browser UI cannot configure this value.

## Enable and initialize

Restart DSH, then open Settings → 长期记忆. The setting defaults to enabled. The first memory operation initializes a local Git repository in the selected memory root.

You can explicitly initialize it:

```zsh
./integrations/dsh/dsh-memory-init
```

## Optional scheduled sync

The provided plist is a template. Copy it only after replacing the repository location with your actual local clone, then load it using your normal LaunchAgent workflow. It defaults to no run at load and a one-hour interval.

The sync command does not install DSH. It requires a `dsh` executable on `PATH`, or a deliberately configured `DSH_BIN`. It performs no work while `memory.enabled` is false.
