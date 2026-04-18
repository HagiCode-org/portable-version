#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractArchive } from './lib/archive.mjs';
import {
  buildSignedBlobUrl,
  downloadFromSource,
  fetchPortableVersionRootIndex,
  resolvePortableVersionIndexEntryByReleaseTag
} from './lib/azure-blob.mjs';
import { cleanDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

const REQUIRED_ARCHIVE_PLATFORMS = [
  { platform: 'linux-x64', metadataKey: 'linux' },
  { platform: 'win-x64', metadataKey: 'windows' },
  { platform: 'osx-universal', metadataKey: 'macos', optionalAlternatives: ['osx-x64', 'osx-arm64'] }
];

function normalizeReleaseTag(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error('Steam release hydration requires a non-empty --release value.');
  }
  return normalized;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function ensureReleaseTagMatches(releaseTag, buildManifest, artifactInventory) {
  if (buildManifest?.release?.tag !== releaseTag) {
    throw new Error(
      `Release ${releaseTag} downloaded build manifest ${buildManifest?.release?.tag ?? 'without a release tag'} instead of the requested release.`
    );
  }

  if (artifactInventory?.releaseTag !== releaseTag) {
    throw new Error(
      `Release ${releaseTag} downloaded artifact inventory ${artifactInventory?.releaseTag ?? 'without a release tag'} instead of the requested release.`
    );
  }
}

function collectInventoryArtifactsByPlatform(releaseTag, artifactInventory) {
  if (!Array.isArray(artifactInventory?.artifacts) || artifactInventory.artifacts.length === 0) {
    throw new Error(`Release ${releaseTag} is missing published platform archives in its artifact inventory.`);
  }

  const artifactsByPlatform = new Map();
  for (const artifact of artifactInventory.artifacts) {
    const platform = requireNonEmptyString(
      artifact?.platform,
      `Release ${releaseTag} artifact inventory contains an entry without a platform`
    );
    if (artifactsByPlatform.has(platform)) {
      throw new Error(
        `Release ${releaseTag} contains multiple published archives for ${platform}; standalone Steam hydration expects exactly one archive per platform.`
      );
    }
    artifactsByPlatform.set(platform, artifact);
  }

  return artifactsByPlatform;
}

function resolveHydrationAssets(releaseTag, releaseEntry, artifactInventory) {
  const rootIndexArtifacts = new Map(
    releaseEntry.artifacts.map((artifact) => [artifact.platform, artifact])
  );
  const inventoryArtifacts = collectInventoryArtifactsByPlatform(releaseTag, artifactInventory);
  const resolvedAssets = [];

  for (const requirement of REQUIRED_ARCHIVE_PLATFORMS) {
    const candidatePlatforms = [requirement.platform, ...(requirement.optionalAlternatives ?? [])];
    const selectedPlatform = candidatePlatforms.find(
      (platform) => rootIndexArtifacts.has(platform) && inventoryArtifacts.has(platform)
    );

    if (!selectedPlatform) {
      throw new Error(
        `Release ${releaseTag} is missing a published archive for ${requirement.metadataKey}; expected one of ${candidatePlatforms.join(', ')}.`
      );
    }

    const rootIndexArtifact = rootIndexArtifacts.get(selectedPlatform);
    const inventoryArtifact = inventoryArtifacts.get(selectedPlatform);
    const inventoryFileName = requireNonEmptyString(
      inventoryArtifact?.fileName ?? inventoryArtifact?.name,
      `Release ${releaseTag} artifact inventory entry for ${selectedPlatform}.fileName`
    );

    if (rootIndexArtifact.name !== inventoryFileName && rootIndexArtifact.fileName !== inventoryFileName) {
      throw new Error(
        `Release ${releaseTag} root index/archive metadata mismatch for ${selectedPlatform}; expected ${inventoryFileName} but index points to ${rootIndexArtifact.name}.`
      );
    }

    resolvedAssets.push({
      depotPlatform: requirement.metadataKey,
      platform: selectedPlatform,
      fileName: inventoryFileName,
      blobPath: rootIndexArtifact.path
    });
  }

  return resolvedAssets.sort((left, right) => left.platform.localeCompare(right.platform));
}

export async function prepareSteamReleaseInput({
  releaseTag,
  outputDir,
  steamAzureSasUrl = process.env.PORTABLE_VERSION_STEAM_AZURE_SAS_URL,
  fetchImpl = fetch
} = {}) {
  const normalizedReleaseTag = normalizeReleaseTag(releaseTag);
  const normalizedSteamAzureSasUrl = requireNonEmptyString(
    steamAzureSasUrl,
    'PORTABLE_VERSION_STEAM_AZURE_SAS_URL'
  );
  const workspaceRoot = path.resolve(outputDir ?? path.join('build', 'steam-release', normalizedReleaseTag));
  const metadataDir = path.join(workspaceRoot, 'metadata');
  const assetsDir = path.join(workspaceRoot, 'release-assets');
  const contentRoot = path.join(workspaceRoot, 'steam-content');

  await cleanDir(metadataDir);
  await cleanDir(assetsDir);
  await cleanDir(contentRoot);

  const rootIndex = await fetchPortableVersionRootIndex({
    sasUrl: normalizedSteamAzureSasUrl,
    fetchImpl
  });
  const releaseEntry = resolvePortableVersionIndexEntryByReleaseTag({
    document: rootIndex.document,
    releaseTag: normalizedReleaseTag,
    sanitizedIndexUrl: rootIndex.sanitizedIndexUrl
  });

  const buildManifestPath = path.join(metadataDir, path.basename(releaseEntry.metadata.buildManifestPath));
  const artifactInventoryPath = path.join(metadataDir, path.basename(releaseEntry.metadata.artifactInventoryPath));
  const checksumsPath = path.join(metadataDir, path.basename(releaseEntry.metadata.checksumsPath));

  await downloadFromSource({
    sourceUrl: buildSignedBlobUrl(normalizedSteamAzureSasUrl, releaseEntry.metadata.buildManifestPath),
    destinationPath: buildManifestPath,
    fetchImpl
  });
  await downloadFromSource({
    sourceUrl: buildSignedBlobUrl(normalizedSteamAzureSasUrl, releaseEntry.metadata.artifactInventoryPath),
    destinationPath: artifactInventoryPath,
    fetchImpl
  });
  await downloadFromSource({
    sourceUrl: buildSignedBlobUrl(normalizedSteamAzureSasUrl, releaseEntry.metadata.checksumsPath),
    destinationPath: checksumsPath,
    fetchImpl
  });

  const buildManifest = await readJson(buildManifestPath);
  const artifactInventory = await readJson(artifactInventoryPath);
  ensureReleaseTagMatches(normalizedReleaseTag, buildManifest, artifactInventory);

  const hydrationAssets = resolveHydrationAssets(normalizedReleaseTag, releaseEntry, artifactInventory);
  for (const asset of hydrationAssets) {
    const downloadedArchivePath = path.join(assetsDir, asset.fileName);
    const platformContentRoot = path.join(contentRoot, asset.platform);
    await downloadFromSource({
      sourceUrl: buildSignedBlobUrl(normalizedSteamAzureSasUrl, asset.blobPath),
      destinationPath: downloadedArchivePath,
      fetchImpl
    });
    await cleanDir(platformContentRoot);
    await extractArchive(downloadedArchivePath, platformContentRoot);
  }

  const result = {
    releaseTag: normalizedReleaseTag,
    buildManifestPath,
    artifactInventoryPath,
    checksumsPath,
    contentRoot,
    steamDepotIds: releaseEntry.steamDepotIds,
    azureIndex: {
      sanitizedUrl: rootIndex.sanitizedIndexUrl,
      version: releaseEntry.version
    },
    metadata: releaseEntry.metadata,
    preparedPlatforms: hydrationAssets.map((asset) => asset.platform),
    downloadedAssets: hydrationAssets.map((asset) => ({
      platform: asset.platform,
      fileName: asset.fileName,
      blobPath: asset.blobPath
    }))
  };

  const resultPath = path.join(metadataDir, 'steam-release-input.json');
  await writeJson(resultPath, result);

  await appendSummary([
    '## Portable Version Steam release hydration complete',
    `- Release tag: ${normalizedReleaseTag}`,
    `- Azure root index: ${result.azureIndex.sanitizedUrl}`,
    `- Azure version entry: ${result.azureIndex.version}`,
    `- Depot platforms: ${Object.keys(result.steamDepotIds).join(', ')}`,
    `- Prepared platforms: ${result.preparedPlatforms.join(', ')}`,
    `- Build manifest: ${buildManifestPath}`,
    `- Artifact inventory: ${artifactInventoryPath}`,
    `- Checksums: ${checksumsPath}`,
    `- Hydration report: ${resultPath}`
  ]);

  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      'output-dir': { type: 'string' },
      'steam-azure-sas-url': { type: 'string' }
    },
    strict: true
  });

  const result = await prepareSteamReleaseInput({
    releaseTag: values.release,
    outputDir: values['output-dir'],
    steamAzureSasUrl: values['steam-azure-sas-url']
  });

  console.log(
    JSON.stringify(
      {
        releaseTag: result.releaseTag,
        buildManifestPath: result.buildManifestPath,
        artifactInventoryPath: result.artifactInventoryPath,
        checksumsPath: result.checksumsPath,
        contentRoot: result.contentRoot,
        steamDepotIds: result.steamDepotIds,
        azureIndex: result.azureIndex,
        preparedPlatforms: result.preparedPlatforms
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
      '## Portable Version Steam release hydration failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
