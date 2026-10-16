# Development and release validation

Use Node.js 22, 24 or 26. Install the committed dependency tree with `npm ci`, build with `npm run build`, and run `npm test`. Tests must use isolated configuration directories and a mock Home Assistant server; never supply production credentials to a test harness.

## Review checklist

- Confirm all 13 public tool names remain available and the MCP initialization version matches `package.json`.
- Exercise strict runtime validation, confirmation booleans, allowed light domains and numeric/color boundaries before any API mutation.
- Verify an external mixed-device scene stays unchanged; unreadable scene configuration must not trigger whole-scene activation.
- Verify ownership, explicit legacy copying, per-URL data isolation, atomic writes, locks and corrupt-store handling.
- Verify nested brightness/color change detection, dynamic blackout metadata and legacy mired conversion.
- Verify timeout cancellation and failure reporting; writes must not be retried blindly. Test partial failures without physical lights.
- Keep `scene_diagnose` passive by default. Mark connectivity and scene activation tests as mutations.

Passing mock tests does not prove physical bulb timing or every Home Assistant release. Any hardware compatibility check needs a separate disposable test installation and explicitly chosen targets. Do not describe unperformed hardware tests as successful.

`npm run verify` runs the repository validation wrapper; `npm run verify:package` checks the packaged artifact in isolation. Review these scripts before use and keep their checks consistent with CI.

## Release checklist

1. Review source changes, tests, README, changelog and security guidance together. Record material limitations.
2. Synchronize package and lockfile versions, MCP handshake and registry metadata. Keep Node support and CI aligned.
3. Run clean install, build, regression and stdio protocol checks on supported Node versions. Review `npm audit` results rather than presenting an audit score as proof of security.
4. Inspect `npm pack --dry-run`, then create the tarball and install it in an isolated temporary directory. Confirm packaged startup and tools. Include required runtime files and documentation; exclude credentials, backup stores and test artifacts.
5. Review GitHub workflow permissions, pinned action revisions, dependency updates, secret scanning and available repository protections. Confirm the repository's release and npm package match the tested artifact.
6. Publish only with authorized maintainer credentials, preserving the existing human authorship. Verify the installed registry artifact after publication and retain an identifiable rollback package.

## Local installation update

Inventory each launcher and installation separately: global packages, pinned npx launchers, source checkouts and containerized or remote consumers can use different versions. Record the current command, package version and protected data backup before changing it. Install the verified artifact, reload the consuming client and perform passive protocol/read checks. Preserve endpoint identities and secrets; do not replace unrelated client configuration.

For failures, stop the affected writer, preserve diagnostic output with secrets redacted, and use the package plus matching configuration/data backup to roll back. See [upgrade and recovery](UPGRADING.md).
