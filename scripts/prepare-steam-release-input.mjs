#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractArchive } from './lib/archive.mjs';
import { downloadReleaseAsset, findReleaseAssetByName, getReleaseByTag } from './lib/github.mjs';
import { cleanDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

function normalizeReleaseTag(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error('Steam release hydration requires a non-empty --release value.');
  }
  return normalized;
}

function getMetadataAssetNames(releaseTag) {
  return {
    buildManifest: `${releaseTag}.build-manifest.json`,
    artifactInventory: `${releaseTag}.artifact-inventory.json`
  };
}

function validateManifestReleaseTag(releaseTag, buildManifest) {
  if (buildManifest?.release?.tag !== releaseTag) {
    throw new Error(
      `Release ${releaseTag} downloaded build manifest ${buildManifest?.release?.tag ?? 'without a release tag'} instead of the requested release.`
    );
  }
}

function validateInventoryReleaseTag(releaseTag, inventory) {
  if (inventory?.releaseTag !== releaseTag) {
    throw new Error(
      `Release ${releaseTag} downloaded artifact inventory ${inventory?.releaseTag ?? 'without a release tag'} instead of the requested release.`
    );
  }
}

function collectHydrationAssets(releaseTag, release, inventory) {
  if (!Array.isArray(inventory?.artifacts) || inventory.artifacts.length === 0) {
    throw new Error(`Release ${releaseTag} is missing published platform archives in its artifact inventory.`);
  }

  const selectedAssets = new Map();
  for (const artifact of inventory.artifacts) {
    const platform = String(artifact?.platform ?? '').trim();
    const fileName = String(artifact?.fileName ?? '').trim();
    if (!platform) {
      throw new Error(`Release ${releaseTag} artifact inventory contains an entry without a platform.`);
    }
    if (!fileName) {
      throw new Error(`Release ${releaseTag} artifact inventory is missing a fileName for platform ${platform}.`);
    }
    if (selectedAssets.has(platform)) {
      throw new Error(
        `Release ${releaseTag} contains multiple published archives for ${platform}; standalone Steam hydration expects exactly one archive per platform.`
      );
    }

    const releaseAsset = findReleaseAssetByName(release, fileName);
    if (!releaseAsset) {
      throw new Error(`Release ${releaseTag} is missing published archive ${fileName} for platform ${platform}.`);
    }

    selectedAssets.set(platform, {
      platform,
      fileName,
      releaseAsset
    });
  }

  return [...selectedAssets.values()].sort((left, right) => left.platform.localeCompare(right.platform));
}

export async function prepareSteamReleaseInput({
  releaseTag,
  outputDir,
  repository = 'HagiCode-org/portable-version',
  token,
  resolveRelease = (targetRepository, targetReleaseTag, authToken) =>
    getReleaseByTag(targetRepository, targetReleaseTag, authToken, { allowNotFound: true }),
  downloadAsset = downloadReleaseAsset
} = {}) {
  const normalizedReleaseTag = normalizeReleaseTag(releaseTag);
  const workspaceRoot = path.resolve(outputDir ?? path.join('build', 'steam-release', normalizedReleaseTag));
  const metadataDir = path.join(workspaceRoot, 'metadata');
  const assetsDir = path.join(workspaceRoot, 'release-assets');
  const contentRoot = path.join(workspaceRoot, 'steam-content');

  await cleanDir(metadataDir);
  await cleanDir(assetsDir);
  await cleanDir(contentRoot);

  const release = await resolveRelease(repository, normalizedReleaseTag, token);
  if (!release) {
    throw new Error(`Portable Version release ${normalizedReleaseTag} does not exist in ${repository}.`);
  }

  const metadataAssetNames = getMetadataAssetNames(normalizedReleaseTag);
  const buildManifestAsset = findReleaseAssetByName(release, metadataAssetNames.buildManifest);
  if (!buildManifestAsset) {
    throw new Error(
      `Release ${normalizedReleaseTag} is missing required metadata asset ${metadataAssetNames.buildManifest}.`
    );
  }
  const artifactInventoryAsset = findReleaseAssetByName(release, metadataAssetNames.artifactInventory);
  if (!artifactInventoryAsset) {
    throw new Error(
      `Release ${normalizedReleaseTag} is missing required metadata asset ${metadataAssetNames.artifactInventory}.`
    );
  }

  const buildManifestPath = path.join(metadataDir, metadataAssetNames.buildManifest);
  const artifactInventoryPath = path.join(metadataDir, metadataAssetNames.artifactInventory);
  await downloadAsset(buildManifestAsset, buildManifestPath, token);
  await downloadAsset(artifactInventoryAsset, artifactInventoryPath, token);

  const buildManifest = await readJson(buildManifestPath);
  validateManifestReleaseTag(normalizedReleaseTag, buildManifest);

  const artifactInventory = await readJson(artifactInventoryPath);
  validateInventoryReleaseTag(normalizedReleaseTag, artifactInventory);

  const hydrationAssets = collectHydrationAssets(normalizedReleaseTag, release, artifactInventory);
  for (const asset of hydrationAssets) {
    const downloadedArchivePath = path.join(assetsDir, asset.fileName);
    const platformContentRoot = path.join(contentRoot, asset.platform);
    await downloadAsset(asset.releaseAsset, downloadedArchivePath, token);
    await cleanDir(platformContentRoot);
    await extractArchive(downloadedArchivePath, platformContentRoot);
  }

  const result = {
    releaseTag: normalizedReleaseTag,
    repository,
    releaseUrl: release.html_url ?? null,
    releaseId: release.id ?? null,
    buildManifestPath,
    artifactInventoryPath,
    contentRoot,
    preparedPlatforms: hydrationAssets.map((asset) => asset.platform),
    downloadedAssets: hydrationAssets.map((asset) => ({
      platform: asset.platform,
      fileName: asset.fileName,
      downloadUrl: asset.releaseAsset.downloadUrl ?? null
    }))
  };

  const resultPath = path.join(metadataDir, 'steam-release-input.json');
  await writeJson(resultPath, result);

  await appendSummary([
    '## Portable Version Steam release hydration complete',
    `- Release tag: ${normalizedReleaseTag}`,
    `- Repository: ${repository}`,
    `- Prepared platforms: ${result.preparedPlatforms.join(', ')}`,
    `- Build manifest: ${buildManifestPath}`,
    `- Artifact inventory: ${artifactInventoryPath}`,
    `- Hydration report: ${resultPath}`
  ]);

  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      'output-dir': { type: 'string' },
      repository: { type: 'string' },
      token: { type: 'string' }
    },
    strict: true
  });

  const token =
    values.token ??
    process.env.PORTABLE_VERSION_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN;
  const result = await prepareSteamReleaseInput({
    releaseTag: values.release,
    outputDir: values['output-dir'],
    repository: values.repository,
    token
  });

  console.log(
    JSON.stringify(
      {
        releaseTag: result.releaseTag,
        buildManifestPath: result.buildManifestPath,
        artifactInventoryPath: result.artifactInventoryPath,
        contentRoot: result.contentRoot,
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
