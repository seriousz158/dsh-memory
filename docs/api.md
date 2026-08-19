# API contract

`dsh-memory` exposes a local Typert remote namespace named `memory`.

The browser UI can call only this namespace. It cannot supply a memory path, execute Git, or request arbitrary filesystem operations.

## Setting

```text
memory.enabled: boolean
```

Default: `true`.

When the setting is changed, the host updates its memory system-prompt section immediately; the next model call observes the new state without restarting DSH.

## Methods

### `memory.getSettings()`

Success:

```json
{ "ok": true, "value": { "enabled": true } }
```

Failure:

```json
{ "ok": false, "error": { "code": "settings-unavailable" } }
```

### `memory.setEnabled({ enabled })`

Input:

```json
{ "enabled": false }
```

Success:

```json
{ "ok": true, "value": { "enabled": false } }
```

Failures use `settings-invalid-request`, `settings-unavailable`, or `settings-write-failed`.

### `memory.status()`

Success:

```json
{
  "ok": true,
  "value": {
    "empty": false,
    "dataFileCount": 6,
    "targetDirty": false,
    "recoverable": true
  }
}
```

This method reports metadata only. It never returns a memory document, Git diff, transcript, or credential.

Failures use `repo-unavailable` or `unsafe-layout`.

### `memory.clear({ confirmation })`

The only accepted confirmation is the exact machine value:

```json
{ "confirmation": "DELETE_MEMORY" }
```

Success when data was cleared:

```json
{
  "ok": true,
  "value": {
    "alreadyEmpty": false,
    "clearedFileCount": 6,
    "recoveryCommit": "<git commit id>",
    "clearCommit": "<git commit id>"
  }
}
```

Success for an already empty repository uses `alreadyEmpty: true`, `clearedFileCount: 0`, and `null` commit values.

Failures use stable codes:

| Code | Meaning |
| --- | --- |
| `repo-unavailable` | the configured memory root is not an accessible Git repository |
| `unsafe-layout` | the root or target layout includes an unsafe path/symbolic link |
| `checkpoint-failed` | the recovery checkpoint could not be built |
| `clear-failed` | clear staging or confirmation failed safely |
| `commit-failed` | live index/head update could not be completed safely |

The user interface shows a human-readable two-step confirmation before it sends the machine confirmation above.
