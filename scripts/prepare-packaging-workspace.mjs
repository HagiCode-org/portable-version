#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { extractArchive } from './lib/archive.mjs';
import { downloadReleaseAsset } from './lib/github.mjs';
import {
  cleanDir,
  ensureDir,
  findFirstMatchingDirectory,
  pathExists,
  readJson,
  writeJson
} from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { getPlatformConfig } from './lib/platforms.mjs';

async function resolveDesktopAppRoot(extractionRoot, platform) {
  if (!platform.appBundleName) {
    return extractionRoot;
  }

  const directAppRoot = path.join(extractionRoot, platform.appBundleName);
  if (await pathExists(directAppRoot)) {
    return directAppRoot;
  }

  const discoveredRoot = await findFirstMatchingDirectory(
    extractionRoot,
    async (candidate) => path.basename(candidate) === platform.appBundleName
  );
  if (discoveredRoot) {
    return discoveredRoot;
  }

  throw new Error(`Unable to find Desktop app bundle ${platform.appBundleName} under ${extractionRoot}.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      token: { type: 'string' },
      'desktop-asset-source': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('prepare-packaging-workspace requires --plan, --platform, and --workspace.');
  }

  const planPath = path.resolve(values.plan);
  const workspacePath = path.resolve(values.workspace);
  const platformId = values.platform;
  const plan = await readJson(planPath);
  const platform = getPlatformConfig(platformId);
  const desktopAsset = plan.upstream.desktop.assetsByPlatform?.[platformId];
  if (!desktopAsset) {
    throw new Error(`No Desktop asset mapped for platform ${platformId}.`);
  }

  const token = values.token ?? process.env.PORTABLE_VERSION_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const downloadDirectory = path.join(workspacePath, 'downloads');
  const extractDirectory = path.join(workspacePath, 'extracted');
  const outputDirectory = path.join(workspacePath, 'release-assets');
  const desktopArchivePath = path.join(downloadDirectory, desktopAsset.name);
  const desktopWorkspace = path.join(extractDirectory, 'desktop');

  await cleanDir(workspacePath);
  await ensureDir(downloadDirectory);
  await ensureDir(outputDirectory);
  await ensureDir(desktopWorkspace);

  const assetSource = values['desktop-asset-source'] ?? desktopAsset.downloadUrl;
  await downloadReleaseAsset({ ...desktopAsset, downloadUrl: assetSource }, desktopArchivePath, token);
  await extractArchive(desktopArchivePath, desktopWorkspace);

  const desktopAppRoot = await resolveDesktopAppRoot(desktopWorkspace, platform);
  const portableFixedRoot = path.join(desktopAppRoot, ...platform.portableFixedSegments);
  if (!(await pathExists(portableFixedRoot))) {
    throw new Error(`Desktop asset ${desktopAsset.name} does not contain ${portableFixedRoot}.`);
  }

  const workspaceManifest = {
    planPath,
    platform: platform.id,
    runtimeKey: platform.runtimeKey,
    desktopWorkspace,
    desktopAppRoot,
    portableFixedRoot,
    downloadDirectory,
    extractDirectory,
    outputDirectory,
    desktopTag: plan.upstream.desktop.tag,
    desktopAssetName: desktopAsset.name,
    desktopArchivePath,
    dryRun: plan.build.dryRun
  };
  const workspaceManifestPath = path.join(workspacePath, 'workspace-manifest.json');
  await writeJson(workspaceManifestPath, workspaceManifest);

  await appendSummary([
    `### Workspace prepared for ${platform.id}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Desktop asset: ${desktopAsset.name}`,
    `- Workspace: ${workspacePath}`,
    `- Portable root: ${portableFixedRoot}`
  ]);

  console.log(JSON.stringify({ workspaceManifestPath, desktopWorkspace }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Workspace preparation failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
