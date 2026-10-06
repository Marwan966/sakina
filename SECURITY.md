# Security policy

Report vulnerabilities privately through this repository's **Security → Report a vulnerability** feature. Do not open a public issue containing credentials, exploitation details that expose users, or conversation data. If private reporting is unavailable, contact the repository owner before sharing sensitive details.

Supported version: the latest reviewed `main` release. Security fixes should include a regression test and a check of server/client boundaries.

## Release controls

- Fresh standalone history; private monorepo history is not imported.
- Blank credential examples; `.env`, deployment state, local logs, captures and generated SQL are ignored.
- Pattern and exact-value release scanning, plus Gitleaks history scanning and GitHub public secret protection where enabled.
- Least-privilege CI with pinned actions, no persisted checkout credentials and no production API keys.
- Authenticated Edge access to expensive Quran RPCs, private quota data, bounded inputs and fail-closed admission.
- A separate session-signing secret, strict same-origin controls and short-lived HTTP-only session grants.

Checks reduce risk; no audit or scanner can certify 100% security. A key exposed outside this repository must still be revoked at its provider. A clean repository scan does not establish that an operator rotated previously exposed credentials.
