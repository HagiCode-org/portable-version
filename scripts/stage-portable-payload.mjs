#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { extractArchive } from './lib/archive.mjs';
import { downloadReleaseAsset } from './lib/github.mjs';
import {
  cleanDir,
  copyDir,
  ensureDir,
  findFirstMatchingDirectory,
  pathExists,
  readJson,
  writeJson
} from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

async function resolveRuntimeRoot(extractedRoot) {
  const directManifest = path.join(extractedRoot, 'manifest.json');
  const directLibDll = path.join(extractedRoot, 'lib', 'PCode.Web.dll');
  if ((await pathExists(directManifest)) || (await pathExists(directLibDll))) {
    return extractedRoot;
  }

  const nested = await findFirstMatchingDirectory(extractedRoot, async (candidate) => {
    const manifestPath = path.join(candidate, 'manifest.json');
    const dllPath = path.join(candidate, 'lib', 'PCode.Web.dll');
    return (await pathExists(manifestPath)) || (await pathExists(dllPath));
  });

  return nested;
}

async function validatePayloadRoot(runtimeRoot) {
  const requiredPaths = [
    'manifest.json',
    path.join('config'),
    path.join('lib', 'PCode.Web.dll'),
    path.join('lib', 'PCode.Web.runtimeconfig.json'),
    path.join('lib', 'PCode.Web.deps.json')
  ];

  const missing = [];
  for (const relativePath of requiredPaths) {
    const absolutePath = path.join(runtimeRoot, relativePath);
    if (!(await pathExists(absolutePath))) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Portable payload is incomplete under ${runtimeRoot}. Missing: ${missing.join(', ')}`
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      token: { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('stage-portable-payload requires --plan, --platform, and --workspace.');
  }

  const plan = await readJson(path.resolve(values.plan));
  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const asset = plan.upstream.service.assetsByPlatform[values.platform];
  if (!asset) {
    throw new Error(`No service asset mapped for platform ${values.platform}.`);
  }

  const token = values.token ?? process.env.PORTABLE_VERSION_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const downloadPath = path.join(workspaceManifest.downloadDirectory, asset.name);
  const extractionPath = path.join(workspaceManifest.extractDirectory, values.platform);
  const stagedCurrentPath = path.join(workspaceManifest.portableFixedRoot, 'current');

  await ensureDir(workspaceManifest.downloadDirectory);
  await ensureDir(extractionPath);
  await downloadReleaseAsset(asset, downloadPath, token);
  await extractArchive(downloadPath, extractionPath);

  const runtimeRoot = await resolveRuntimeRoot(extractionPath);
  if (!runtimeRoot) {
    throw new Error(`Unable to find an extracted portable runtime under ${extractionPath}.`);
  }

  await validatePayloadRoot(runtimeRoot);
  await ensureDir(workspaceManifest.portableFixedRoot);
  await cleanDir(stagedCurrentPath);
  await copyDir(runtimeRoot, stagedCurrentPath);

  const validationReportPath = path.join(workspacePath, `payload-validation-${values.platform}.json`);
  await writeJson(validationReportPath, {
    platform: values.platform,
    assetName: asset.name,
    downloadPath,
    extractionPath,
    runtimeRoot,
    portableFixedRoot: workspaceManifest.portableFixedRoot,
    stagedCurrentPath,
    requiredPaths: [
      'manifest.json',
      'config/',
      'lib/PCode.Web.dll',
      'lib/PCode.Web.runtimeconfig.json',
      'lib/PCode.Web.deps.json'
    ]
  });

  await appendSummary([
    `### Portable payload staged for ${values.platform}`,
    `- Asset: ${asset.name}`,
    `- Extracted root: ${runtimeRoot}`,
    `- Staged path: ${stagedCurrentPath}`
  ]);

  console.log(JSON.stringify({ validationReportPath, stagedCurrentPath }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable payload staging failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
