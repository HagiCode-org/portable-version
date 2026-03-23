import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function fixturePath(...segments) {
  return path.join(repoRoot, 'tests', 'fixtures', ...segments);
}

async function createFixtureArchive(sourceDirectory, archivePath) {
  await runCommand('zip', ['-qr', archivePath, '.'], { cwd: sourceDirectory });
}

test('dry-run packaging stages payload and emits inventory metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-dry-run-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.zip');

  await createFixtureArchive(fixturePath('desktop-fixture'), desktopArchivePath);

  await writeJson(planPath, {
    repositories: {
      desktop: 'HagiCode-org/desktop',
      service: 'HagiCode-org/releases',
      portable: 'HagiCode-org/portable-version'
    },
    platforms: ['linux-x64'],
    upstream: {
      desktop: {
        tag: 'v0.2.0',
        assetsByPlatform: {
          'linux-x64': {
            name: 'hagicode-desktop-0.2.0.zip',
            downloadUrl: `file://${desktopArchivePath}`
          }
        }
      },
      service: {
        tag: 'v0.1.0-beta.33',
        assetsByPlatform: {
          'linux-x64': {
            name: 'hagicode-0.1.0-beta.33-linux-x64-nort.zip',
            downloadUrl: `file://${fixturePath('hagicode-0.1.0-beta.33-linux-x64-nort.zip')}`
          }
        }
      }
    },
    release: {
      tag: 'pv-release-d680cc63b74a'
    },
    build: {
      dryRun: true
    }
  });

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'prepare-packaging-workspace.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--desktop-asset-source',
    desktopArchivePath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-portable-payload.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'package-desktop-portable.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--force-dry-run'
  ]);

  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-linux-x64.json'));
  assert.equal(inventory.artifacts.length, 1);
  assert.equal(inventory.platform, 'linux-x64');
  assert.equal(inventory.artifacts[0].fileName, 'hagicode-portable-linux-x64.zip');
});
