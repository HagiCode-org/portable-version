# portable-version

This repository automates Portable Version builds for HagiCode Desktop by resolving upstream Desktop and service releases, staging the fixed portable payload, packaging Desktop on the selected runner platforms, and publishing a deterministic GitHub Release.

## Trigger modes

The main workflow is `.github/workflows/portable-version-build.yml`.

It supports three non-interactive entrypoints:

- `schedule` polls upstream releases on a daily cadence.
- `workflow_dispatch` supports targeted rebuilds with optional Desktop tag, service tag, platform, dry-run, and force-rebuild inputs.
- `repository_dispatch` accepts future-compatible `client_payload` fields (`desktopTag`, `serviceTag`, `platforms`, `forceRebuild`, `dryRun`).

## Workflow inputs

`workflow_dispatch` accepts these inputs:

- `desktop_tag`: optional Desktop GitHub Release tag override.
- `service_tag`: optional service release tag override from `HagiCode-org/releases`.
- `platforms`: comma-separated platforms. Supported values are `linux-x64`, `win-x64`, `osx-x64`, `osx-arm64`, or `all`.
- `force_rebuild`: keep packaging even if the derived Portable Version release already exists.
- `dry_run`: skip GitHub Release publication while still resolving, staging, and packaging.

Repository dispatch payloads must include both `desktopTag` and `serviceTag` so the automation stays non-interactive.

## Required secrets and permissions

The workflow expects a token with enough access to read release metadata from upstream repositories and create releases in `HagiCode-org/portable-version`.

Recommended repository secret:

- `PORTABLE_VERSION_GITHUB_TOKEN`: personal access token or GitHub App token with `contents:read` on upstream repositories and `contents:write` on `portable-version`.

Workflow permissions are set to:

- `contents: write`
- `actions: read`

## Build assumptions

The automation currently assumes:

- automatic scheduled builds default to `linux-x64` to stay safe for unattended CI while still producing a first-class portable package.
- service release assets follow the framework-dependent naming contract used by HagiCode releases, for example `hagicode-0.1.0-beta.33-linux-x64-nort.zip`.
- the selected service asset extracts to a structure that contains `manifest.json`, `config/`, `lib/PCode.Web.dll`, `lib/PCode.Web.runtimeconfig.json`, and `lib/PCode.Web.deps.json`.
- Desktop packaging must stage the payload under `resources/portable-fixed/current/` before the Desktop build command runs.
- cross-platform packaging depends on the selected GitHub-hosted runner being able to execute the matching Desktop packaging script.

## Local verification

Run the helper tests from the repository root for `portable-version`:

```bash
npm test
npm run verify:dry-run
```

The dry-run test uses fixture assets and validates the workspace preparation, service asset extraction, payload staging, and publish-ready inventory generation without creating a GitHub Release.

## Manual recovery steps

Use these recovery paths when a workflow run fails or must be replayed:

1. Re-run the workflow with `workflow_dispatch` and set `dry_run=true` to confirm the build plan and payload staging without publishing.
2. If the derived Portable Version release already exists but the prior upload was partial, re-run with `force_rebuild=true` so packaging and publication update the existing release.
3. If upstream assets changed or were republished, supply explicit `desktop_tag` and `service_tag` inputs so the run uses a known-good version pair.
4. Inspect the uploaded workflow artifacts:
   - `build-plan`
   - `portable-package-<platform>`
   - `release-metadata-<release-tag>`
5. Review the workflow summary for the exact validation failure, missing platform asset, or publication command error.

## Derived release outputs

Each successful build publishes:

- one deterministic Portable Version tag in the `pv-release-<hash>` namespace, so the tag stays Portable Version specific instead of exposing Desktop/Service versions directly
- packaged artifacts copied to deterministic asset names
- the normalized build manifest
- merged artifact inventory metadata
- merged SHA-256 checksums
