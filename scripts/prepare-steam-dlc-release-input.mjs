#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractArchive } from './lib/archive.mjs';
import { buildSignedBlobUrl, downloadFromSource } from './lib/azure-blob.mjs';
import { resolveLatestDlcReleaseContext } from './lib/dlc-index.mjs';
import { cleanDir, ensureDir, writeJson } from './lib/fs-utils.mjs';
import { selectSteamArtifactsForPublication, toSafeFileComponent } from './lib/platforms.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

const PLATFORM_FAMILIES = ['linux', 'windows', 'macos'];

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeSelectedArtifacts(selectedArtifacts) {
  return Object.fromEntries(
    Object.entries(selectedArtifacts).map(([platformFamily, artifacts]) => [
      platformFamily,
      artifacts.map((artifact) => ({
        platform: artifact.platform,
        name: artifact.name,
        fileName: artifact.fileName,
        path: artifact.path
      }))
    ])
  );
}

function buildPlatformContentRoots(dlcContentRoot) {
  return {
    linux: path.join(dlcContentRoot, 'linux'),
    windows: path.join(dlcContentRoot, 'windows'),
    macos: path.join(dlcContentRoot, 'macos')
  };
}

async function prepareDlcContent({
  dlc,
  selectedArtifacts,
  assetsRoot,
  dlcContentRoot,
  sasUrl,
  fetchImpl
}) {
  const contentRoots = buildPlatformContentRoots(dlcContentRoot);

  for (const platformFamily of PLATFORM_FAMILIES) {
    await cleanDir(contentRoots[platformFamily]);
  }

  for (const platformFamily of PLATFORM_FAMILIES) {
    for (const artifact of selectedArtifacts[platformFamily]) {
      const downloadPath = path.join(
        assetsRoot,
        platformFamily,
        `${artifact.platform}-${requireNonEmptyString(artifact.fileName, `DLC ${dlc.dlcName} file name`)}`
      );
      await ensureDir(path.dirname(downloadPath));
      await downloadFromSource({
        sourceUrl: buildSignedBlobUrl(sasUrl, artifact.path),
        destinationPath: downloadPath,
        fetchImpl
      });
      await extractArchive(downloadPath, contentRoots[platformFamily]);
    }
  }

  return contentRoots;
}

export async function prepareSteamDlcReleaseInput({
  outputDir,
  dlcAzureSasUrl = process.env.PORTABLE_VERSION_DLC_AZURE_SAS_URL,
  fetchImpl = fetch
} = {}) {
  const normalizedDlcAzureSasUrl = requireNonEmptyString(
    dlcAzureSasUrl,
    'PORTABLE_VERSION_DLC_AZURE_SAS_URL'
  );
  const workspaceRoot = path.resolve(outputDir ?? path.join('build', 'steam-dlc-release', 'latest'));
  const metadataDir = path.join(workspaceRoot, 'metadata');
  const assetsDir = path.join(workspaceRoot, 'release-assets');
  const contentRoot = path.join(workspaceRoot, 'steam-dlc-content');

  await cleanDir(metadataDir);
  await cleanDir(assetsDir);
  await cleanDir(contentRoot);

  const latestReleaseContext = await resolveLatestDlcReleaseContext({
    sasUrl: normalizedDlcAzureSasUrl,
    fetchImpl
  });

  const preparedDlcs = [];
  for (const dlc of latestReleaseContext.dlcs) {
    try {
      const selectedArtifactResult = selectSteamArtifactsForPublication(dlc.artifacts, {
        sourceLabel: `DLC ${dlc.dlcName} version ${dlc.dlcVersion} artifacts`
      });
      const dlcSafeName = toSafeFileComponent(dlc.dlcName);
      const dlcContentRoot = path.join(contentRoot, dlcSafeName);
      const dlcAssetsRoot = path.join(assetsDir, dlcSafeName);
      const contentRoots = await prepareDlcContent({
        dlc,
        selectedArtifacts: selectedArtifactResult.selectedArtifacts,
        assetsRoot: dlcAssetsRoot,
        dlcContentRoot,
        sasUrl: normalizedDlcAzureSasUrl,
        fetchImpl
      });

      preparedDlcs.push({
        dlcName: dlc.dlcName,
        dlcVersion: dlc.dlcVersion,
        contentRoot: dlcContentRoot,
        contentRoots,
        steamDepotIds: dlc.steamDepotIds,
        selectedArtifacts: normalizeSelectedArtifacts(selectedArtifactResult.selectedArtifacts),
        preparedPlatforms: selectedArtifactResult.preparedPlatforms
      });
    } catch (error) {
      throw new Error(`Failed to prepare DLC ${dlc.dlcName} version ${dlc.dlcVersion}: ${error.message}`);
    }
  }

  const result = {
    discoverySource: latestReleaseContext.dlcIndex.sanitizedUrl,
    dlcIndex: latestReleaseContext.dlcIndex,
    dlcs: preparedDlcs
  };
  const resultPath = path.join(metadataDir, 'steam-dlc-release-input.json');
  await writeJson(resultPath, result);

  await appendSummary([
    '## Portable Version Steam DLC release hydration complete',
    `- DLC root index: ${result.discoverySource}`,
    `- DLC count: ${preparedDlcs.length}`,
    `- DLCs: ${preparedDlcs.map((dlc) => `${dlc.dlcName}@${dlc.dlcVersion}`).join(', ')}`,
    `- Hydration report: ${resultPath}`
  ]);

  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'output-dir': { type: 'string' },
      'dlc-azure-sas-url': { type: 'string' }
    },
    strict: true
  });

  const result = await prepareSteamDlcReleaseInput({
    outputDir: values['output-dir'],
    dlcAzureSasUrl: values['dlc-azure-sas-url']
  });

  console.log(
    JSON.stringify(
      {
        discoverySource: result.discoverySource,
        dlcIndex: result.dlcIndex,
        dlcs: result.dlcs.map((dlc) => ({
          dlcName: dlc.dlcName,
          dlcVersion: dlc.dlcVersion,
          contentRoots: dlc.contentRoots,
          steamDepotIds: dlc.steamDepotIds,
          preparedPlatforms: dlc.preparedPlatforms
        }))
      },
      null,
      2
    )
  );
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Portable Version Steam DLC release hydration failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
