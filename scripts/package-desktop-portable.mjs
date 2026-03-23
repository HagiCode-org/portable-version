#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createArchive } from './lib/archive.mjs';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { writeChecksumFile } from './lib/checksum.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { buildDeterministicAssetName, getPlatformConfig } from './lib/platforms.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean', default: false }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('package-desktop-portable requires --plan, --platform, and --workspace.');
  }

  const plan = await readJson(path.resolve(values.plan));
  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  getPlatformConfig(values.platform);
  const stagedCurrentPath = path.join(workspaceManifest.portableFixedRoot, 'current');
  if (!(await pathExists(stagedCurrentPath))) {
    throw new Error(`Portable payload is not staged at ${stagedCurrentPath}.`);
  }

  await ensureDir(workspaceManifest.outputDirectory);

  const dryRun = values['force-dry-run'] || Boolean(plan.build.dryRun);
  const packagedFileName = buildDeterministicAssetName(
    plan.release.tag,
    values.platform,
    workspaceManifest.desktopAssetName
  );
  const packagedArchivePath = path.join(workspaceManifest.outputDirectory, packagedFileName);
  await createArchive(workspaceManifest.desktopWorkspace, packagedArchivePath);
  const inventory = [
    await createArtifactRecord({
      archivePath: packagedArchivePath,
      platformId: values.platform
    })
  ];

  const inventoryPath = path.join(workspacePath, `artifact-inventory-${values.platform}.json`);
  const checksumsPath = path.join(workspacePath, `artifact-checksums-${values.platform}.txt`);
  await writeJson(inventoryPath, {
    releaseTag: plan.release.tag,
    platform: values.platform,
    dryRun,
    artifacts: inventory
  });
  await writeChecksumFile(inventory, checksumsPath);

  await appendSummary([
    `### Packaging complete for ${values.platform}`,
    `- Mode: ${dryRun ? 'dry-run' : 'publish-ready'}`,
    `- Inventory: ${inventoryPath}`,
    `- Checksums: ${checksumsPath}`,
    `- Artifacts: ${inventory.map((entry) => entry.fileName).join(', ')}`
  ]);

  console.log(JSON.stringify({ inventoryPath, checksumsPath, artifactCount: inventory.length }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Packaging failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
