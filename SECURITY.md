# Security policy

## Supported version

Security fixes are applied to the latest released `0.x` version.

## Reporting a vulnerability

Please use a private GitHub Security Advisory for this repository. If that path is unavailable, open a minimal issue asking for a private contact channel; do not place technical exploit details in the public issue.

Never attach real DSH memory, session archives, browser profiles, credential files, authentication data, or unredacted model transcripts to an issue, pull request, log, or advisory.

Include only:

- the released package version and DSH/Node/Python versions;
- a minimal synthetic reproduction;
- the observed and expected behavior;
- a description of the confidentiality, integrity, or availability impact.

## Scope

High-priority areas include symbolic-link/path handling, Git index/commit handling, settings remotes, transcript filtering, environment inheritance, and accidental data publication.

If a credential or real private data reaches any Git remote, assume it is exposed: revoke/rotate it first, then contact the maintainer for remediation. Removing a file from a later commit does not make the earlier exposure safe.
