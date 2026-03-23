import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test('publish-release emits a dry-run publication report', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-publish-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const artifactsDir = path.join(tempRoot, 'artifacts');
  const outputDir = path.join(tempRoot, 'release-metadata');
  const assetPath = path.join(artifactsDir, 'portable-version-example-linux-x64.zip');

  await mkdir(artifactsDir, { recursive: true });

  await writeJson(planPath, {
    trigger: { type: 'workflow_dispatch' },
    upstream: {
      desktop: { repository: 'HagiCode-org/desktop', tag: 'v0.2.0' },
      service: { repository: 'HagiCode-org/releases', tag: 'v0.1.0-beta.33' }
    },
    release: {
      repository: 'HagiCode-org/portable-version',
      tag: 'pv-release-d680cc63b74a',
      name: 'Portable Version pv-release-d680cc63b74a'
    },
    build: { dryRun: true }
  });

  await writeFile(assetPath, 'fixture asset', 'utf8');
  await writeJson(path.join(artifactsDir, 'artifact-inventory-linux-x64.json'), {
    platform: 'linux-x64',
    artifacts: [
      {
        fileName: 'portable-version-example-linux-x64.zip',
        outputPath: '/tmp/non-existent-runner-path/portable-version-example-linux-x64.zip',
        sha256: 'abc123',
        sizeBytes: 12
      }
    ]
  });
  await writeFile(path.join(artifactsDir, 'artifact-checksums-linux-x64.txt'), 'abc123  portable-version-example-linux-x64.zip\n', 'utf8');

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'publish-release.mjs'),
    '--plan',
    planPath,
    '--artifacts-dir',
    artifactsDir,
    '--output-dir',
    outputDir,
    '--force-dry-run'
  ]);

  const report = await readJson(path.join(outputDir, 'pv-release-d680cc63b74a.publish-dry-run.json'));
  assert.equal(report.releaseTag, 'pv-release-d680cc63b74a');
  assert.ok(report.assetFiles.some((filePath) => filePath.endsWith('.build-manifest.json')));
});
