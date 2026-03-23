#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cleanDir, copyDir, ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { getPlatformConfig } from './lib/platforms.mjs';
import { runCommand } from './lib/command.mjs';

async function cloneDesktopRepository(targetPath, tag, repositoryUrl) {
  await runCommand('git', ['clone', '--depth', '1', '--branch', tag, repositoryUrl, targetPath]);
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'desktop-source': { type: 'string' },
      'desktop-clone-url': { type: 'string' }
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
  const desktopSource = values['desktop-source'] ? path.resolve(values['desktop-source']) : null;
  const desktopCloneUrl = values['desktop-clone-url'] ?? `https://github.com/${plan.repositories.desktop}.git`;
  const desktopWorkspace = path.join(workspacePath, 'desktop');
  const downloadDirectory = path.join(workspacePath, 'downloads');
  const extractDirectory = path.join(workspacePath, 'extracted');
  const outputDirectory = path.join(workspacePath, 'release-assets');

  await cleanDir(workspacePath);
  await ensureDir(downloadDirectory);
  await ensureDir(extractDirectory);
  await ensureDir(outputDirectory);

  if (desktopSource) {
    await copyDir(desktopSource, desktopWorkspace);
  } else {
    await cloneDesktopRepository(desktopWorkspace, plan.upstream.desktop.tag, desktopCloneUrl);
  }

  const workspaceManifest = {
    planPath,
    platform: platform.id,
    runtimeKey: platform.runtimeKey,
    desktopWorkspace,
    downloadDirectory,
    extractDirectory,
    outputDirectory,
    desktopCloneUrl,
    desktopTag: plan.upstream.desktop.tag,
    dryRun: plan.build.dryRun
  };
  const workspaceManifestPath = path.join(workspacePath, 'workspace-manifest.json');
  await writeJson(workspaceManifestPath, workspaceManifest);

  await appendSummary([
    `### Workspace prepared for ${platform.id}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Workspace: ${workspacePath}`,
    `- Source: ${desktopSource ?? desktopCloneUrl}`
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
