# portable-version

This repository owns Steam publication for Portable Version and DLC releases. It still provides the build-plan / handoff helpers used by external automation, but packaging plus Azure publication now execute directly in `repos/steam_packer`.

The actual packaging-safe workspace assembly, payload injection, toolchain staging, archive repacking, artifact inventory generation, checksum generation, Azure Blob upload, and root `hagicode-steam/index.json` refresh now execute in `steam_packer`.

## Trigger modes

This repository now keeps only the Steam publication workflows:

- `.github/workflows/portable-version-steam-release.yml` (`portable-version-steam-release`) manually publishes an existing Azure-hosted Portable Version release to Steam.
- `.github/workflows/portable-version-steam-dlc-release.yml` (`portable-version-steam-dlc-release`) manually discovers every DLC from the dedicated DLC Azure container and publishes the latest version of each DLC to Steam.

Packaging and Azure publication are no longer triggered from `portable-version`. If an external caller still wants the normalized selector and handoff contract, call `scripts/resolve-build-plan.mjs` directly and hand the resulting plan to `repos/steam_packer`.

The base Steam workflow is `workflow_dispatch` only and accepts an optional `release` tag. If you leave it blank, the workflow resolves the latest Azure-published Portable Version release from `hagicode-steam/index.json`. The DLC Steam workflow is also `workflow_dispatch`, but it does not accept a `release` input because it always discovers the latest version for every DLC from the DLC root index.

## Workflow inputs

### Steam publication workflow

`portable-version-steam-release` accepts these `workflow_dispatch` inputs:

- `release`: optional Portable Version release tag to hydrate and publish to Steam. Leave it blank to publish the latest version entry from the Portable Version Azure root index.
- `steam_preview`: generate a Steam preview build instead of publishing and setting the beta branch live.
- `steam_branch`: Steam branch to set live for non-preview uploads. This defaults to `beta`.
- `steam_description`: optional Steam build description override.

### Steam DLC publication workflow

`portable-version-steam-dlc-release` accepts these `workflow_dispatch` inputs:

- `steam_preview`: generate a Steam preview build instead of publishing and setting the beta branch live.
- `steam_branch`: Steam branch to set live for non-preview uploads. This defaults to `beta`.
- `steam_description`: optional Steam build description override.

The DLC workflow does not ask for `dlc_name` or `release`. It always downloads the DLC root `index.json`, enumerates every `dlcs[]` entry, resolves the latest version of each DLC, and publishes that latest-per-DLC set as one non-interactive Steam run.

## Release tag convention

Portable Version releases use a readable Web-driven tag:

- canonical format: `<web-tag>`
- current mapping: `web-tag` means the selected `service_tag` / `PCode.Web` payload version
- `desktop_tag` remains available as an optional source-selection override, but it only affects Desktop asset resolution and provenance
- normalization rule: `refs/tags/v0.1.0-beta.35`, `v0.1.0-beta.35`, and `0.1.0-beta.35` all normalize to `v0.1.0-beta.35`
- direct helper example: `node scripts/resolve-build-plan.mjs --event-name workflow_dispatch --event-path <event-json>` still normalizes `service_tag=0.1.0-beta.35` and `desktop_tag=refs/tags/v0.1.34` into release tag `v0.1.0-beta.35`

The same Web-only tag is reused for duplicate detection, Azure version directories, root-index entries, dry-run metadata filenames, and Steam hydration.

## Data sources and publication model

Portable Version uses four Azure-backed data surfaces:

- Desktop index: `https://index.hagicode.com/desktop/index.json`
- Server index: `https://index.hagicode.com/server/index.json`
- Portable Version publication container: `hagicode-steam`
- DLC publication container: a dedicated Azure Blob container addressed by `PORTABLE_VERSION_DLC_AZURE_SAS_URL`

The build-plan helper reads the Desktop and Server manifests, picks the selected version entries, records the matched platform assets, and emits a delegated handoff payload for `steam_packer`. The delegated workflow then downloads the raw archives by combining:

- the asset `path` from the index manifest
- the Desktop Azure Blob SAS container URL from `PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL`
- the Server Azure Blob SAS container URL from `PORTABLE_VERSION_SERVICE_AZURE_SAS_URL`

The delegated publication step in `steam_packer` writes these assets into `hagicode-steam/<releaseTag>/`:

- Portable Version platform archives such as `hagicode-portable-linux-x64.zip`
- `<releaseTag>.build-manifest.json`
- `<releaseTag>.artifact-inventory.json`
- `<releaseTag>.checksums.txt`

After the versioned blobs are visible, `steam_packer` refreshes `hagicode-steam/index.json`. Each version entry in that root index carries:

- `version`
- `metadata.buildManifestPath`
- `metadata.artifactInventoryPath`
- `metadata.checksumsPath`
- `steamDepotIds.linux`
- `steamDepotIds.windows`
- `steamDepotIds.macos`
- `artifacts[]` with per-platform blob-relative paths

Steam publication now treats `hagicode-steam/index.json` as the only source of truth for hydration and depot resolution.

The DLC publication workflow uses its own root-level `index.json` as the only source of truth. The document must expose:

- `updatedAt`
- `dlcs[]`
- `dlcs[].dlcName`
- `dlcs[].versions[]`
- `dlcs[].versions[].version`
- `dlcs[].versions[].steamAppId`
- `dlcs[].versions[].steamDepotIds.linux`
- `dlcs[].versions[].steamDepotIds.windows`
- `dlcs[].versions[].steamDepotIds.macos`
- `dlcs[].versions[].artifacts[]`

Example:

```json
{
  "updatedAt": "2026-04-21T03:09:32.3804912Z",
  "dlcs": [
    {
      "dlcName": "turbo-engine",
      "versions": [
        {
          "version": "0.1.0-beta.50",
          "steamAppId": "4635479",
          "steamDepotIds": {
            "linux": "4635482",
            "windows": "4635480",
            "macos": "4635481"
          },
          "artifacts": [
            {
              "name": "hagicode-dlc-turbo-engine-0.1.0-beta.50-linux-x64-nort.zip",
              "path": "turbo-engine/0.1.0-beta.50/hagicode-dlc-turbo-engine-0.1.0-beta.50-linux-x64-nort.zip"
            },
            {
              "name": "hagicode-dlc-turbo-engine-0.1.0-beta.50-win-x64-nort.zip",
              "path": "turbo-engine/0.1.0-beta.50/hagicode-dlc-turbo-engine-0.1.0-beta.50-win-x64-nort.zip"
            },
            {
              "name": "hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-universal-nort.zip",
              "path": "turbo-engine/0.1.0-beta.50/hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-universal-nort.zip"
            }
          ]
        }
      ]
    }
  ]
}
```

Field semantics:

- `dlcName`: stable Steam/DLC identifier. This becomes the per-DLC staging directory name under `steam-dlc-content/<dlcName>/`.
- `versions[].steamAppId`: version-scoped Steam AppID. The DLC Steam workflow groups builds by this value and emits one `app-build.vdf` per AppID.
- `versions[].steamDepotIds`: version-scoped Steam depot mapping. The DLC Steam workflow refuses to guess depot ids from repository secrets.
- `artifacts[]`: download inventory for that DLC version. The workflow derives `windows`, `linux`, and `macos` staging from artifact names/paths.

Artifact selection rules:

- `windows` requires exactly one `win-x64` artifact.
- `linux` requires exactly one `linux-x64` artifact.
- `macos` prefers exactly one `osx-universal` artifact.
- If `osx-universal` is absent, `macos` requires both `osx-x64` and `osx-arm64`, and both archives are extracted into the same `steam-dlc-content/<dlcName>/macos` content root.

Any missing latest version, missing depot mapping, or missing required artifact causes the DLC workflow to fail before SteamCMD authentication or upload.

## Required secrets and permissions

Recommended repository secrets:

- `PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL`: Desktop Azure Blob container SAS URL with at least `Read` and `List` permissions.
- `PORTABLE_VERSION_SERVICE_AZURE_SAS_URL`: Server Azure Blob container SAS URL with at least `Read` and `List` permissions.
- `PORTABLE_VERSION_STEAM_AZURE_SAS_URL`: Azure Blob SAS URL for the `hagicode-steam` container. `portable-version` Steam workflows only need `Read` and `List`; packaging/publication writes now happen in `steam_packer`.
- `PORTABLE_VERSION_DLC_AZURE_SAS_URL`: Azure Blob SAS URL for the dedicated DLC container. The DLC Steam workflow needs `Read` and `List`.
- `STEAM_USERNAME`: Steam build account name.
- `STEAM_PASSWORD`: Steam build account password.
- `STEAM_SHARED_SECRET`: optional Steam Guard shared secret for fully unattended uploads.
- `STEAM_GUARD_CODE`: optional fallback Steam Guard code when a shared secret is not available.

Optional repository variables:

- `PORTABLE_VERSION_STEAMCMD_ROOT`: absolute path on the self-hosted runner where SteamCMD and its persistent `config/config.vdf` should be stored. Defaults to `$HOME/.local/share/portable-version/steamcmd`.

## SteamCMD persistence contract

`PORTABLE_VERSION_STEAMCMD_ROOT` is the single durable root for SteamCMD authentication state in both Steam workflows. The workflows install `steamcmd.sh` into that directory and expect any reusable authentication files to live under the same root, including:

- `config/config.vdf`
- `config/loginusers.vdf` when SteamCMD writes account metadata
- root-level `ssfn*` files when Steam Guard persistence is available

The publication script now probes that root as a set instead of hard-coding only `config/config.vdf`. Successful runs write the probe result, initial/final authentication mode, fallback usage, and any failure stage into `steam-build-manifest.json`, and the workflow summary prefers that manifest output before falling back to a direct root probe.

Directory relocation is supported as long as the entire SteamCMD root moves together. If a self-hosted runner is replaced or the storage mount changes, copy the full `PORTABLE_VERSION_STEAMCMD_ROOT` directory, then update `STEAMCMD_PATH` or the repository variable to point to the new absolute location. The script resolves the root from the current `steamcmd.sh` path, so it does not depend on the old absolute path.

If Steam authentication starts prompting unexpectedly, check these items first:

- The workflow summary or uploaded `steam-build-manifest.json` for `steamAuthentication.detectedStatePaths`, `detectionReason`, `initialMode`, `finalMode`, and `failureStage`.
- Whether `PORTABLE_VERSION_STEAMCMD_ROOT` still points at the intended persistent directory on the self-hosted runner.
- Whether the root still contains `config/config.vdf` or `ssfn*` after any runner cleanup, home-directory reset, or storage migration.
- Whether `STEAM_PASSWORD` is still configured, because the script only performs one credentialed refresh attempt when saved-login reuse fails.

Workflow permissions are set to:

- `portable-version-steam-release`: `contents: read`
- `portable-version-steam-dlc-release`: `contents: read`

The Steam workflow is pinned to a dedicated self-hosted runner with labels `self-hosted`, `Linux`, `X64`, and `steam`.

## Build assumptions

The automation currently assumes:

- scheduled builds default to the full platform matrix: `linux-x64`, `win-x64`, and `osx-universal`
- Desktop assets are selected from index `assets[]` by platform-specific naming rules. Linux prefers zip fixtures when present and otherwise falls back to the indexed AppImage; Windows uses the published `*-unpacked.zip`; macOS uses the published zip archives.
- Server assets follow the framework-dependent naming contract used by HagiCode releases, for example `hagicode-0.1.0-beta.35-linux-x64-nort.zip`.
- the selected Server asset extracts to a structure that contains `manifest.json`, `config/`, `lib/PCode.Web.dll`, `lib/PCode.Web.runtimeconfig.json`, and `lib/PCode.Web.deps.json`.
- the downloaded Desktop asset already contains `resources/extra/portable-fixed/` or `Contents/Resources/extra/portable-fixed/`, and the workflow injects the runtime into `current/` inside that directory.
- Node/toolchain ownership belongs to `hagicode-desktop`. New Desktop assets must already contain the canonical `portable-fixed/toolchain/` contract with `node/`, `npm-global/`, `bin/openspec`, `bin/skills`, `bin/omniroute`, `env/activate.*`, and a Desktop-authored `toolchain-manifest.json` marked `owner=hagicode-desktop` and `source=bundled-desktop`.
- `repos/steam_packer` performs the authoritative pre-publication validation for that Desktop-authored contract, including bundled managed CLI entries such as `openspec`, `skills`, and `omniroute`.
- `portable-version` trusts the Azure-published archives that already passed that upstream gate and limits Steam hydration checks to release metadata, required archives, and extraction compatibility.

## Steam publication flow

Steam publication hydrates its input from an existing Azure-hosted Portable Version release instead of package-job artifacts or GitHub Release assets. `portable-version-steam-release` now:

1. resolves the requested `release` input against `hagicode-steam/index.json`, or picks the latest available version entry when `release` is omitted
2. downloads the Azure-hosted build manifest, artifact inventory, and checksums referenced by the matched version entry
3. downloads each published Portable Version archive referenced by the root index and artifact inventory
4. reconstructs `steam-content/<platform>` from those archives, using `steam-content/osx-universal` for the unified macOS depot when available
5. installs `steamcmd` on the dedicated self-hosted runner
6. generates app and depot VDF scripts under `steam-build/scripts/`
7. saves the initial SteamCMD login token under the persistent SteamCMD root and reuses that token on future runs
8. probes the configured SteamCMD root, records which authentication files were detected, and prefers saved-login reuse before any password-based bootstrap
9. derives a Steam Guard code from `STEAM_SHARED_SECRET` when available, otherwise uses `STEAM_GUARD_CODE` if provided
10. writes `metadata/steam-release-input.json` with both the requested selector and the resolved effective release
11. runs `steamcmd +run_app_build` in preview or publish mode, retrying once with a credentialed refresh if saved-login reuse fails and `STEAM_PASSWORD` is available

`steam_preview=false` uploads the build while setting `beta` live unless you override `steam_branch`. `steam_preview=true` keeps the Steam upload in preview mode so you can validate depot mappings and authentication without pushing a live update; preview runs do not pass `setlive` even if `steam_branch` is populated.

If the selected release is missing the build manifest, merged artifact inventory, depot mapping, or one of the required platform archives, the workflow fails before any Steam login happens. The same fail-fast rule applies when `release` is omitted but the Azure root index is empty or malformed. That usually means the Azure root index entry is incomplete or the Azure version directory is only partially published and should be republished first.

The DLC Steam publication flow is separate and latest-driven. `portable-version-steam-dlc-release` now:

1. downloads the dedicated DLC root `index.json`
2. enumerates every `dlcs[]` entry and resolves the latest version per DLC
3. validates that each latest version contains `steamAppId`, complete `steamDepotIds`, and required `artifacts[]`
4. downloads and extracts the selected DLC archives into `steam-dlc-content/<dlcName>/linux`, `steam-dlc-content/<dlcName>/windows`, and `steam-dlc-content/<dlcName>/macos`
5. writes `metadata/steam-dlc-release-input.json` with `dlcName`, `dlcVersion`, `steamAppId`, `steamDepotIds`, `selectedArtifacts`, `preparedPlatforms`, and content roots for every DLC
6. groups discovered DLCs by `steamAppId`, generates one `app-build.vdf` per AppID, and publishes those builds sequentially
7. fails before SteamCMD login whenever any discovered DLC is incomplete

The generated DLC release-input metadata is intentionally explicit so operators can inspect exactly which DLC versions were discovered and which archives were selected for each platform family.

## Local verification

Run the helper tests from the repository root for `portable-version`:

```bash
npm test
```

These tests cover version resolution, Azure index hydration, Steam/DLC preparation, and publication helpers that still live in `portable-version`.

Use `repos/steam_packer` for delegated packaging and Azure publication verification:

```bash
cd ../steam_packer
npm test
npm run verify:dry-run
```

## Migration notes

Portable Version publication no longer treats GitHub Release as a source of truth.

Portable Version also no longer owns the packaging or Azure publication implementation. Those responsibilities moved to `steam_packer`, while this repository keeps version resolution, handoff generation, trigger orchestration, and Steam publication entrypoints.

Removed assumptions:

- Portable Version release hydration from GitHub Release assets
- GitHub Release duplicate detection for the primary build workflow
- DLC root-index lookup for the main application's Steam depot mappings
- repository-level `STEAM_DEPOT_ID_*` secrets at Steam publication time
- manual `dlc_name` selection for DLC Steam publication

If you have external tooling that consumed GitHub Release assets, migrate it to:

- `hagicode-steam/index.json`
- `hagicode-steam/<releaseTag>/<releaseTag>.build-manifest.json`
- `hagicode-steam/<releaseTag>/<releaseTag>.artifact-inventory.json`
- `hagicode-steam/<releaseTag>/<releaseTag>.checksums.txt`
- `hagicode-steam/<releaseTag>/<portable-archive>.zip`

## Manual recovery steps

Use these recovery paths when a workflow run fails or must be replayed:

1. For packaging or Azure publication replay, run the corresponding workflow or script in `repos/steam_packer`.
2. If a specific upstream build must be replayed with normalized selectors, regenerate the handoff plan via `node scripts/resolve-build-plan.mjs` and pass that plan into `steam_packer`.
3. Inspect the uploaded workflow artifacts:
   - `portable-release-metadata-<release-tag>`
   - `portable-steam-release-preparation-<release-tag>`
   - `portable-steam-build-metadata-<release-tag>`
4. For delegated packaging failures, inspect the `steam_packer` workflow jobs and delegated summary output before changing anything in `portable-version`.
5. Review the workflow summary for the exact selector mismatch, delegated packaging failure, Azure upload failure, root-index refresh failure, archive hydration failure, Steam authentication issue, or SteamCMD publication error.

## Derived release outputs

Each successful build publishes:

- one deterministic Portable Version version directory in the `<web-tag>` namespace under `hagicode-steam/`
- repacked Desktop artifacts copied to deterministic asset names such as `hagicode-portable-linux-x64.zip`
- the normalized build manifest
- merged artifact inventory metadata
- merged SHA-256 checksums
- one root-index entry containing `metadata.*`, `steamDepotIds.*`, and `artifacts[]`
- one upstream toolchain validation report per platform, emitted by `steam_packer` before publication
For DLC publication, no repository-level app id secret is used. Each DLC latest version must provide its own `steamAppId` in the DLC root `index.json`.
