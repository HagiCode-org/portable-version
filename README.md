# portable-version

This repository automates Portable Version builds for HagiCode Desktop by resolving upstream Desktop and Server packages from the official index manifests, downloading the indexed raw assets through Azure Blob SAS URLs, injecting the fixed portable payload, repacking the archive, and publishing a deterministic GitHub Release.

Portable builds also bundle a pinned Node.js runtime and a preinstalled OpenSpec CLI so the unpacked archive can run `node`, `openspec`, and `opsx` without depending on machine-wide installations.

## Trigger modes

Packaging and Steam publication now use separate workflows:

- `.github/workflows/portable-version-build.yml` (`portable-version-release`) handles build-plan resolution, packaging, and GitHub Release publication.
- `.github/workflows/portable-version-steam-release.yml` (`portable-version-steam-release`) manually publishes an existing Portable Version release to Steam.

The release workflow supports three non-interactive entrypoints:

- `schedule` polls the Desktop and Server index manifests on a daily cadence.
- `workflow_dispatch` supports targeted rebuilds with optional Desktop selector, service selector, platform, dry-run, and force-rebuild inputs.
- `repository_dispatch` accepts `client_payload` fields (`desktopTag`, `serviceTag`, `platforms`, `forceRebuild`, `dryRun`) and still requires both selectors so the automation stays non-interactive.

The Steam workflow is `workflow_dispatch` only and requires an explicit `release` tag for every run.

## Workflow inputs

### Portable Version release workflow

`portable-version-release` accepts these `workflow_dispatch` inputs:

- `desktop_tag`: optional Desktop version selector. `refs/tags/v0.1.34`, `v0.1.34`, and `0.1.34` are normalized to the same selector.
- `service_tag`: optional Server version selector. `refs/tags/v0.1.0-beta.35`, `v0.1.0-beta.35`, and `0.1.0-beta.35` are normalized to the same selector. In the release-tag convention described below, this current service payload version is treated as the "Web" component.
- `platforms`: comma-separated platforms. Supported values are `linux-x64`, `win-x64`, `osx-universal`, `osx-x64`, `osx-arm64`, or `all`.
- `force_rebuild`: keep packaging even if the derived Portable Version release already exists.
- `dry_run`: skip GitHub Release publication while still resolving, staging, and packaging.

When no selector is provided, the build plan resolves the latest indexed Desktop version and the latest indexed Server version.

### Steam publication workflow

`portable-version-steam-release` accepts these `workflow_dispatch` inputs:

- `release`: required Portable Version release tag to hydrate and publish to Steam. The workflow does not infer "latest".
- `steam_preview`: generate a Steam preview build instead of publishing a live Steam update. This defaults to `true` for safer first runs.
- `steam_branch`: optional Steam branch to set live. Leave empty to upload without changing the live branch.
- `steam_description`: optional Steam build description override.

## Release tag convention

Portable Version releases now use a readable concatenated tag instead of the old hashed `pv-release-*` namespace:

- canonical format: `<web-tag>-<desktop-tag>`
- current mapping: `web-tag` means the selected `service_tag` / `PCode.Web` payload version
- normalization rule: `refs/tags/v0.1.0-beta.35`, `v0.1.0-beta.35`, and `0.1.0-beta.35` all normalize to `v0.1.0-beta.35`
- example: `service_tag=0.1.0-beta.35` plus `desktop_tag=refs/tags/v0.1.34` produces `v0.1.0-beta.35-v0.1.34`

The same concatenated tag is reused for duplicate detection, workflow outputs, GitHub Release titles, release notes, and dry-run metadata filenames.

## Data sources and download model

Portable Version now uses a single upstream discovery model:

- Desktop index: `https://index.hagicode.com/desktop/index.json`
- Server index: `https://index.hagicode.com/server/index.json`

The resolve step reads those manifests, picks the selected version entries, and records the matched platform assets. Packaging then downloads the raw archives by combining:

- the asset `path` from the index manifest
- the Desktop Azure Blob SAS container URL from `PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL`
- the Server Azure Blob SAS container URL from `PORTABLE_VERSION_SERVICE_AZURE_SAS_URL`

The build plan artifact stores index metadata and the redacted Desktop/Server SAS container info, but it does not persist the live SAS token.

## Required secrets and permissions

Recommended repository secrets:

- `PORTABLE_VERSION_GITHUB_TOKEN`: token with `contents:write` on `HagiCode-org/portable-version`. It is only used for the final GitHub Release publication and release existence checks.
- `PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL`: Desktop Azure Blob container SAS URL with at least `Read` and `List` permissions. Example shape: `https://<account>.blob.core.windows.net/<desktop-container>?<sas-token>`.
- `PORTABLE_VERSION_SERVICE_AZURE_SAS_URL`: Server Azure Blob container SAS URL with at least `Read` and `List` permissions. Example shape: `https://<account>.blob.core.windows.net/<service-container>?<sas-token>`.

Steam publication uses these additional repository secrets in `portable-version-steam-release`:

- `STEAM_APP_ID`: Steam app id for the Desktop product.
- `STEAM_DEPOT_ID_LINUX`: depot id for Linux builds.
- `STEAM_DEPOT_ID_WINDOWS`: depot id for Windows builds.
- `STEAM_DEPOT_ID_MACOS`: depot id for the unified macOS build.
- `STEAM_USERNAME`: Steam build account name.
- `STEAM_PASSWORD`: Steam build account password.
- `STEAM_SHARED_SECRET`: optional Steam Guard shared secret for fully unattended uploads.
- `STEAM_GUARD_CODE`: optional fallback Steam Guard code when a shared secret is not available.

Optional repository variables:

- `PORTABLE_VERSION_STEAMCMD_ROOT`: absolute path on the self-hosted runner where SteamCMD and its persistent `config/config.vdf` should be stored. Defaults to `$HOME/.local/share/portable-version/steamcmd`.

Workflow permissions are set to:

- `portable-version-release`: `contents: write`, `actions: read`
- `portable-version-steam-release`: `contents: read`

The Steam workflow is pinned to a dedicated self-hosted runner with labels `self-hosted`, `Linux`, `X64`, and `steam` (for example a Red Hat host prepared for SteamCMD uploads).

## Build assumptions

The automation currently assumes:

- scheduled builds default to the full platform matrix: `linux-x64`, `win-x64`, `osx-x64`, and `osx-arm64`.
- Desktop assets are selected from index `assets[]` by platform-specific naming rules. Linux prefers zip fixtures when present and otherwise falls back to the indexed AppImage; Windows uses the published `*-unpacked.zip`; macOS uses the published zip archives.
- Server assets follow the framework-dependent naming contract used by HagiCode releases, for example `hagicode-0.1.0-beta.35-linux-x64-nort.zip`.
- the selected Server asset extracts to a structure that contains `manifest.json`, `config/`, `lib/PCode.Web.dll`, `lib/PCode.Web.runtimeconfig.json`, and `lib/PCode.Web.deps.json`.
- the downloaded Desktop asset already contains `resources/extra/portable-fixed/` or `Contents/Resources/extra/portable-fixed/`, and the workflow injects the runtime into `current/` inside that directory.
- the portable toolchain manifest is defined in `config/portable-toolchain.json`, which pins the Node.js distribution per platform and the bundled OpenSpec CLI package version.
- the repacked archive stages the portable toolchain under `portable-fixed/toolchain/`, including `node/`, `npm-global/`, `bin/openspec`, `bin/opsx`, `env/activate.*`, and `toolchain-manifest.json`.

## Steam publication flow

Steam publication now hydrates its input from an existing Portable Version GitHub Release instead of depending on package-job artifacts from the release workflow. `portable-version-steam-release` now:

1. validates the required `release` input against `HagiCode-org/portable-version`
2. downloads `<release>.build-manifest.json` and `<release>.artifact-inventory.json`
3. downloads each published Portable Version archive referenced by the merged inventory
4. reconstructs `steam-content/<platform>` from those archives, using `steam-content/osx-universal` for the unified macOS depot when available
5. installs `steamcmd` on the dedicated self-hosted `self-hosted`/`Linux`/`X64`/`steam` runner
6. generates app and depot VDF scripts under `steam-build/scripts/`
7. saves the initial SteamCMD login token under the persistent SteamCMD root and reuses that token on future runs
8. derives a Steam Guard code from `STEAM_SHARED_SECRET` when available, otherwise uses `STEAM_GUARD_CODE` if provided
9. runs `steamcmd +run_app_build` in preview or publish mode

`steam_preview=true` keeps the Steam upload in preview mode so you can validate depot mappings and authentication without pushing a live update. Once the preview run succeeds, re-run `portable-version-steam-release` with `steam_preview=false` and optionally set `steam_branch` if you want the build to go live on a specific branch.

If the selected release is missing the build manifest, merged artifact inventory, or one of the published platform archives, the workflow fails before any Steam login happens. That usually means the release predates the current Portable Version publication metadata contract and should be rebuilt first.

On the first successful non-dry-run Steam publication run, the workflow performs a full SteamCMD login, runs `info`, and preserves the updated `config/config.vdf` on the self-hosted runner. Later runs reuse `+login <username>` without resending the password, which matches the SteamPipe CI/CD guidance for saved login tokens.

## Local verification

Run the helper tests from the repository root for `portable-version`:

```bash
npm test
npm run verify:dry-run
```

The dry-run test uses fixture assets and validates Desktop archive preparation, Server payload extraction, toolchain staging, and archive repacking without publishing a GitHub Release.

For manual local staging you can override the network download step with fixture files:

- `scripts/prepare-packaging-workspace.mjs --desktop-asset-source <file-or-url>`
- `scripts/stage-portable-payload.mjs --service-asset-source <file-or-url>`

Those overrides are intended for tests and diagnostics only. Production packaging must use index `asset.path + PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL` or `asset.path + PORTABLE_VERSION_SERVICE_AZURE_SAS_URL`, depending on the asset source.

## Migration notes

This repository no longer supports the old GitHub Release-driven build-plan structure.

Removed assumptions:

- upstream Desktop and Server discovery from GitHub Release metadata
- old `releaseId`, release asset API URLs, and compatibility field mappings in `build-plan.json`
- fallback downloads through release asset URLs during packaging

If you have external tooling that consumes `build-plan.json`, migrate it to the new structure:

- `upstream.desktop.version` / `upstream.service.version`
- `upstream.*.manifestUrl`
- `upstream.*.assetsByPlatform[platform].path`
- `downloads.strategy === "azure-blob-sas"`

## Manual recovery steps

Use these recovery paths when a workflow run fails or must be replayed:

1. Re-run the workflow with `workflow_dispatch` and set `dry_run=true` to confirm index resolution, payload staging, and repacking without publishing.
2. If the derived Portable Version release already exists but the prior upload was partial, re-run with `force_rebuild=true`.
3. If a specific upstream pair must be replayed, supply explicit `desktop_tag` and `service_tag` selectors.
4. Inspect the uploaded workflow artifacts:
   - `portable-release-build-plan`
   - `portable-release-package-<platform>`
   - `portable-release-metadata-<release-tag>`
   - `portable-steam-release-preparation-<release-tag>`
   - `portable-steam-build-metadata-<release-tag>`
5. Review the workflow summary for the exact selector mismatch, missing indexed asset, release hydration failure, Steam authentication issue, or publication error.

## Derived release outputs

Each successful build publishes:

- one deterministic Portable Version tag in the `<web-tag>-<desktop-tag>` namespace
- repacked Desktop artifacts copied to deterministic asset names such as `hagicode-portable-linux-x64.zip`
- the normalized build manifest
- merged artifact inventory metadata
- merged SHA-256 checksums
- one toolchain validation report per platform, proving the bundled `node`, `openspec`, and `opsx` commands executed successfully before publication
