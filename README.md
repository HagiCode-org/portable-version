# portable-version

This repository is the orchestration entrypoint for Portable Version releases. It resolves upstream Desktop and Server versions, derives the normalized release tag, emits a machine-readable handoff payload, and delegates packaging plus Azure publication to `repos/steam_packer`.

The actual packaging-safe workspace assembly, payload injection, toolchain staging, archive repacking, artifact inventory generation, checksum generation, Azure Blob upload, and root `hagicode-steam/index.json` refresh now execute in `steam_packer`.

## Trigger modes

Packaging and Steam publication use separate workflows:

- `.github/workflows/portable-version-build.yml` (`portable-version-release`) handles build-plan resolution and delegated packaging/publication orchestration.
- `.github/workflows/portable-version-steam-release.yml` (`portable-version-steam-release`) manually publishes an existing Azure-hosted Portable Version release to Steam.
- `.github/workflows/portable-version-steam-dlc-release.yml` (`portable-version-steam-dlc-release`) manually discovers every DLC from the dedicated DLC Azure container and publishes the latest version of each DLC to Steam.

The release workflow supports three non-interactive entrypoints:

- `schedule` polls the Desktop and Server index manifests on a daily cadence.
- `workflow_dispatch` supports targeted rebuilds with optional Desktop selector, service selector, platform, dry-run, and force-rebuild inputs.
- `repository_dispatch` accepts `client_payload` fields (`serviceTag`, optional `desktopTag`, `platforms`, `forceRebuild`, `dryRun`). `serviceTag` is required so the automation stays non-interactive, while `desktopTag` falls back to the default Desktop resolution path when omitted.

Packaging-oriented runs stop after producing the handoff artifact plus the delegated reusable-workflow call. Steam publication remains a separate manual workflow and is not triggered by packaging runs.

The base Steam workflow is `workflow_dispatch` only and requires an explicit `release` tag for every run. The DLC Steam workflow is also `workflow_dispatch`, but it does not accept a `release` input because it always discovers the latest version for every DLC from the DLC root index.

## Workflow inputs

### Portable Version release workflow

`portable-version-release` accepts these `workflow_dispatch` inputs:

- `desktop_tag`: optional Desktop version selector. `refs/tags/v0.1.34`, `v0.1.34`, and `0.1.34` are normalized to the same selector.
- `service_tag`: optional Server version selector. `refs/tags/v0.1.0-beta.35`, `v0.1.0-beta.35`, and `0.1.0-beta.35` are normalized to the same selector. In the release-tag convention described below, this current service payload version is treated as the "Web" component.
- `platforms`: comma-separated platforms. Supported values are `linux-x64`, `win-x64`, `osx-universal`, `osx-x64`, `osx-arm64`, or `all`.
- `force_rebuild`: keep packaging even if the derived Portable Version Azure release already exists.
- `dry_run`: skip Azure publication while still resolving and delegating the packaging plan.

When no selector is provided, the build plan resolves the latest indexed Desktop version and the latest indexed Server version.

### Steam publication workflow

`portable-version-steam-release` accepts these `workflow_dispatch` inputs:

- `release`: required Portable Version release tag to hydrate and publish to Steam. The workflow does not infer "latest".
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
- `workflow_dispatch` example: `service_tag=0.1.0-beta.35` plus `desktop_tag=refs/tags/v0.1.34` still produces release tag `v0.1.0-beta.35`
- `repository_dispatch` example: `{"event_type":"portable-version-build","client_payload":{"serviceTag":"0.1.0-beta.35"}}` resolves the latest Desktop release and still produces `v0.1.0-beta.35`

The same Web-only tag is reused for duplicate detection, Azure version directories, root-index entries, dry-run metadata filenames, and Steam hydration.

## Data sources and publication model

Portable Version uses four Azure-backed data surfaces:

- Desktop index: `https://index.hagicode.com/desktop/index.json`
- Server index: `https://index.hagicode.com/server/index.json`
- Portable Version publication container: `hagicode-steam`
- DLC publication container: a dedicated Azure Blob container addressed by `PORTABLE_VERSION_DLC_AZURE_SAS_URL`

The resolve step reads the Desktop and Server manifests, picks the selected version entries, records the matched platform assets, and emits a delegated handoff payload for `steam_packer`. The delegated workflow then downloads the raw archives by combining:

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
- `PORTABLE_VERSION_STEAM_AZURE_SAS_URL`: Azure Blob SAS URL for the `hagicode-steam` container. The release workflow needs `Read`, `List`, `Write`, and `Create`; the Steam workflow only needs `Read` and `List`.
- `PORTABLE_VERSION_DLC_AZURE_SAS_URL`: Azure Blob SAS URL for the dedicated DLC container. The DLC Steam workflow needs `Read` and `List`.
- `STEAM_DEPOT_ID_LINUX`: depot id for Linux builds. The release workflow writes this into the root index and the Steam workflow consumes it from there.
- `STEAM_DEPOT_ID_WINDOWS`: depot id for Windows builds.
- `STEAM_DEPOT_ID_MACOS`: depot id for the unified macOS build.
- `STEAM_APP_ID`: Steam app id for the Desktop product.
- `STEAM_USERNAME`: Steam build account name.
- `STEAM_PASSWORD`: Steam build account password.
- `STEAM_SHARED_SECRET`: optional Steam Guard shared secret for fully unattended uploads.
- `STEAM_GUARD_CODE`: optional fallback Steam Guard code when a shared secret is not available.

Optional repository variables:

- `PORTABLE_VERSION_STEAMCMD_ROOT`: absolute path on the self-hosted runner where SteamCMD and its persistent `config/config.vdf` should be stored. Defaults to `$HOME/.local/share/portable-version/steamcmd`.

Workflow permissions are set to:

- `portable-version-release`: `contents: write`, `actions: read`
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
- the portable toolchain manifest is defined in `config/portable-toolchain.json`, which pins the Node.js distribution per platform and the bundled OpenSpec CLI package version.
- the repacked archive stages the portable toolchain under `portable-fixed/toolchain/`, including `node/`, `npm-global/`, `bin/openspec`, `bin/opsx`, `env/activate.*`, and `toolchain-manifest.json`.

## Steam publication flow

Steam publication hydrates its input from an existing Azure-hosted Portable Version release instead of package-job artifacts or GitHub Release assets. `portable-version-steam-release` now:

1. validates the required `release` input against `hagicode-steam/index.json`
2. downloads the Azure-hosted build manifest, artifact inventory, and checksums referenced by the matched version entry
3. downloads each published Portable Version archive referenced by the root index and artifact inventory
4. reconstructs `steam-content/<platform>` from those archives, using `steam-content/osx-universal` for the unified macOS depot when available
5. installs `steamcmd` on the dedicated self-hosted runner
6. generates app and depot VDF scripts under `steam-build/scripts/`
7. saves the initial SteamCMD login token under the persistent SteamCMD root and reuses that token on future runs
8. derives a Steam Guard code from `STEAM_SHARED_SECRET` when available, otherwise uses `STEAM_GUARD_CODE` if provided
9. runs `steamcmd +run_app_build` in preview or publish mode

`steam_preview=false` uploads the build while setting `beta` live unless you override `steam_branch`. `steam_preview=true` keeps the Steam upload in preview mode so you can validate depot mappings and authentication without pushing a live update; preview runs do not pass `setlive` even if `steam_branch` is populated.

If the selected release is missing the build manifest, merged artifact inventory, depot mapping, or one of the required platform archives, the workflow fails before any Steam login happens. That usually means the Azure root index entry is incomplete or the Azure version directory is only partially published and should be republished first.

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

Use `repos/steam_packer` for delegated packaging verification:

```bash
cd ../steam_packer
npm test
npm run verify:dry-run
```

The thin compatibility wrappers in this repository still forward the old packaging script names into `steam_packer`, but new packaging changes should be made in `repos/steam_packer` only.

For manual delegated diagnostics you can still override the network download step with fixture files:

- `scripts/prepare-packaging-workspace.mjs --desktop-asset-source <file-or-url>`
- `scripts/stage-portable-payload.mjs --service-asset-source <file-or-url>`

Those wrappers are intended for tests and diagnostics only. Production packaging now executes through the delegated `steam_packer` reusable workflow.

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

1. Re-run `portable-version-release` with `dry_run=true` to confirm index resolution, payload staging, repacking, and Azure publication planning without writing blobs.
2. If the derived Portable Version Azure version directory already exists but the prior upload was partial, re-run with `force_rebuild=true`.
3. If a specific upstream build must be replayed, provide `service_tag` and optionally `desktop_tag` when you need to pin a non-default Desktop asset.
4. Inspect the uploaded workflow artifacts:
   - `portable-release-build-plan`
   - `portable-release-metadata-<release-tag>`
   - `portable-steam-release-preparation-<release-tag>`
   - `portable-steam-build-metadata-<release-tag>`
5. For delegated packaging failures, inspect the `steam_packer` reusable workflow jobs and the delegated summary output before changing anything in `portable-version`.
6. Review the workflow summary for the exact selector mismatch, delegated packaging failure, Azure upload failure, root-index refresh failure, archive hydration failure, Steam authentication issue, or SteamCMD publication error.

## Derived release outputs

Each successful build publishes:

- one deterministic Portable Version version directory in the `<web-tag>` namespace under `hagicode-steam/`
- repacked Desktop artifacts copied to deterministic asset names such as `hagicode-portable-linux-x64.zip`
- the normalized build manifest
- merged artifact inventory metadata
- merged SHA-256 checksums
- one root-index entry containing `metadata.*`, `steamDepotIds.*`, and `artifacts[]`
- one toolchain validation report per platform, proving the bundled `node`, `openspec`, and `opsx` commands executed successfully before publication
For DLC publication, `STEAM_APP_ID` is not used. Each DLC latest version must provide its own `steamAppId` in the DLC root `index.json`.
