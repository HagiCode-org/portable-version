#!/usr/bin/env node
import path from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { collectPackagedArtifacts } from './lib/artifacts.mjs';
import { sha256File, writeChecksumFile } from './lib/checksum.mjs';
import { runCommand } from './lib/command.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { buildDeterministicAssetName, getPlatformConfig } from './lib/platforms.mjs';

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function createDryRunInventory({ workspaceManifest, plan, platformId }) {
  const fileName = buildDeterministicAssetName(plan.release.tag, platformId, `${platformId}.zip`);
  const outputPath = path.join(workspaceManifest.outputDirectory, fileName);
  await writeFile(
    outputPath,
    [
      'portable-version dry-run artifact',
      `releaseTag=${plan.release.tag}`,
      `platform=${platformId}`,
      `desktopTag=${plan.upstream.desktop.tag}`,
      `serviceTag=${plan.upstream.service.tag}`
    ].join('\n'),
    'utf8'
  );

  return [
    {
      platform: platformId,
      sourcePath: outputPath,
      outputPath,
      fileName,
      sizeBytes: (await stat(outputPath)).size,
      sha256: await sha256File(outputPath)
    }
  ];
}

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
  const platform = getPlatformConfig(values.platform);
  const stagedCurrentPath = path.join(workspaceManifest.desktopWorkspace, 'resources', 'portable-fixed', 'current');
  if (!(await pathExists(stagedCurrentPath))) {
    throw new Error(`Portable payload is not staged at ${stagedCurrentPath}.`);
  }

  await ensureDir(workspaceManifest.outputDirectory);

  const dryRun = values['force-dry-run'] || Boolean(plan.build.dryRun);
  const inventory = dryRun
    ? await createDryRunInventory({ workspaceManifest, plan, platformId: values.platform })
    : await (async () => {
        await runCommand(getNpmCommand(), ['ci'], {
          cwd: workspaceManifest.desktopWorkspace,
          env: { ...process.env, CI: 'true' }
        });
        await runCommand(getNpmCommand(), ['run', platform.npmScript], {
          cwd: workspaceManifest.desktopWorkspace,
          env: { ...process.env, CI: 'true' }
        });
        return collectPackagedArtifacts({
          desktopWorkspace: workspaceManifest.desktopWorkspace,
          platformId: values.platform,
          outputDirectory: workspaceManifest.outputDirectory,
          releaseTag: plan.release.tag
        });
      })();

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
