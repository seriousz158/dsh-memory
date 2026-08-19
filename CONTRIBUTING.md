# Contributing

Thank you for improving `dsh-memory`.

## Development rules

- Use only synthetic transcripts, credentials, paths, and repositories in tests and examples.
- Never attach or commit a real `.dsh` directory, memory repository, session log, browser profile, credential file, or production configuration.
- Preserve the browser boundary: client code can call the fixed memory service but cannot choose an arbitrary filesystem path.
- Preserve clear safety semantics: target-only mutation, recovery checkpoint before clearing, clear commit after clearing, symlink refusal, and no implicit disabling of `memory.enabled`.
- Keep the public host/UI API backward compatible within a minor release.

## Local checks

```zsh
npm ci
npm test
zsh tools/secret-scan.sh
```

The test suite is intentionally local-only. Do not add tests that start a live DSH host, Chrome, a LaunchAgent, or a paid provider.

## Pull requests

1. Create a focused branch.
2. Add or update a regression test for observable behavior.
3. Run the local checks above.
4. Describe storage-layout, API, compatibility, and security effects in the pull request.
5. Do not include generated artifacts or real memory data.

## Versioning

- Patch releases fix portability, documentation, tests, or bugs without changing public contracts.
- Minor releases add backward-compatible settings/API fields.
- Major releases are required for changes to memory paths, `memory.clear` semantics, confirmation text, remote method contracts, or safety guarantees.
