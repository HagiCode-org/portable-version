#!/usr/bin/env node
import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runCommand } from './lib/command.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

function getGhCommand() {
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

function buildReleaseNotes(plan, inventories) {
  const platformList = inventories.map((inventory) => inventory.platform).join(', ');
  return [
    `# ${plan.release.name}`,
    '',
    'Automated Portable Version release.',
    '',
    `- Portable release tag: ${plan.release.tag}`,
    `- Desktop release: ${plan.upstream.desktop.repository}@${plan.upstream.desktop.tag}`,
    `- Service source: ${plan.upstream.service.repository}@${plan.upstream.service.tag}`,
    `- Trigger: ${plan.trigger.type}`,
    `- Platforms: ${platformList}`,
    `- Mode: ${plan.build.dryRun ? 'dry-run' : 'publish'}`
  ].join('\n');
}

async function ensureReleaseExists(plan, notesPath) {
  const gh = getGhCommand();
  const baseArgs = ['release', 'view', plan.release.tag, '--repo', plan.release.repository];
  try {
    await runCommand(gh, baseArgs, { stdio: 'pipe' });
    await runCommand(gh, ['release', 'edit', plan.release.tag, '--repo', plan.release.repository, '--title', plan.release.name, '--notes-file', notesPath]);
  } catch {
    await runCommand(gh, [
      'release',
      'create',
      plan.release.tag,
      '--repo',
      plan.release.repository,
      '--title',
      plan.release.name,
      '--notes-file',
      notesPath,
      '--target',
      process.env.GITHUB_SHA ?? 'HEAD'
    ]);
  }
}

async function uploadAssets(plan, filePaths) {
  const gh = getGhCommand();
  await runCommand(gh, ['release', 'upload', plan.release.tag, ...filePaths, '--repo', plan.release.repository, '--clobber']);
}

async function resolveArtifactUploadPath(artifactsDir, artifact) {
  const candidates = [
    artifact.outputPath,
    path.join(artifactsDir, artifact.fileName),
    path.join(artifactsDir, 'release-assets', artifact.fileName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to find uploaded artifact ${artifact.fileName}. Checked: ${candidates.join(', ')}`
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'artifacts-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      'force-dry-run': { type: 'boolean', default: false }
    }
  });

  if (!values.plan || !values['artifacts-dir']) {
    throw new Error('publish-release requires --plan and --artifacts-dir.');
  }

  const plan = await readJson(path.resolve(values.plan));
  const artifactsDir = path.resolve(values['artifacts-dir']);
  const outputDir = path.resolve(values['output-dir'] ?? path.join(artifactsDir, 'release-metadata'));
  const dryRun = values['force-dry-run'] || Boolean(plan.build.dryRun);
  await ensureDir(outputDir);

  const entries = await readdir(artifactsDir);
  const inventoryFiles = entries.filter((entry) => entry.startsWith('artifact-inventory-') && entry.endsWith('.json'));
  const checksumFiles = entries.filter((entry) => entry.startsWith('artifact-checksums-') && entry.endsWith('.txt'));
  const inventories = await Promise.all(
    inventoryFiles.sort().map((entry) => readJson(path.join(artifactsDir, entry)))
  );
  const mergedInventory = {
    releaseTag: plan.release.tag,
    dryRun,
    platforms: inventories.map((inventory) => inventory.platform),
    artifacts: inventories.flatMap((inventory) => inventory.artifacts)
  };
  const mergedInventoryPath = path.join(outputDir, `${plan.release.tag}.artifact-inventory.json`);
  const buildManifestPath = path.join(outputDir, `${plan.release.tag}.build-manifest.json`);
  const notesPath = path.join(outputDir, `${plan.release.tag}.release-notes.md`);
  const mergedChecksumsPath = path.join(outputDir, `${plan.release.tag}.checksums.txt`);

  await writeJson(mergedInventoryPath, mergedInventory);
  await writeJson(buildManifestPath, plan);
  await writeFile(notesPath, `${buildReleaseNotes(plan, inventories)}\n`, 'utf8');

  const checksumContents = [];
  for (const checksumFile of checksumFiles.sort()) {
    checksumContents.push((await readFile(path.join(artifactsDir, checksumFile), 'utf8')).trim());
  }
  await writeFile(mergedChecksumsPath, `${checksumContents.filter(Boolean).join('\n')}\n`, 'utf8');

  const releaseAssetFiles = await Promise.all(
    mergedInventory.artifacts.map((artifact) => resolveArtifactUploadPath(artifactsDir, artifact))
  );
  const assetFiles = [
    ...releaseAssetFiles,
    buildManifestPath,
    mergedInventoryPath,
    mergedChecksumsPath
  ];

  if (dryRun) {
    const dryRunReportPath = path.join(outputDir, `${plan.release.tag}.publish-dry-run.json`);
    await writeJson(dryRunReportPath, {
      releaseTag: plan.release.tag,
      repository: plan.release.repository,
      notesPath,
      assetFiles
    });
    await appendSummary([
      '## Release publication dry-run',
      `- Release tag: ${plan.release.tag}`,
      `- Assets prepared: ${assetFiles.length}`,
      `- Report: ${dryRunReportPath}`
    ]);
    console.log(JSON.stringify({ dryRunReportPath, assetCount: assetFiles.length }, null, 2));
    return;
  }

  await ensureReleaseExists(plan, notesPath);
  await uploadAssets(plan, assetFiles);

  await appendSummary([
    '## Release publication complete',
    `- Repository: ${plan.release.repository}`,
    `- Release tag: ${plan.release.tag}`,
    `- Assets uploaded: ${assetFiles.length}`
  ]);

  console.log(JSON.stringify({ releaseTag: plan.release.tag, assetCount: assetFiles.length }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Release publication failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
