import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createArchive, validateZipPaths } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { createMockPortableToolchainConfig } from './helpers/portable-toolchain-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function createFixtureArchive(sourceDirectory, archivePath) {
  await createArchive(sourceDirectory, archivePath);
}

async function createPortableRuntimeArchive(tempRoot, platformId) {
  const runtimeRoot = path.join(tempRoot, `${platformId}-runtime`);
  await mkdir(path.join(runtimeRoot, 'config'), { recursive: true });
  await mkdir(path.join(runtimeRoot, 'lib'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'manifest.json'), JSON.stringify({
    package: {
      name: `hagicode-${platformId}`,
      version: '0.1.0-beta.33',
      platform: platformId
    }
  }, null, 2), 'utf8');
  await writeFile(path.join(runtimeRoot, 'config', 'appsettings.json'), '{}', 'utf8');
  await writeFile(path.join(runtimeRoot, 'lib', 'PCode.Web.dll'), platformId, 'utf8');
  await writeFile(path.join(runtimeRoot, 'lib', 'PCode.Web.runtimeconfig.json'), '{}', 'utf8');
  await writeFile(path.join(runtimeRoot, 'lib', 'PCode.Web.deps.json'), '{}', 'utf8');

  const archivePath = path.join(tempRoot, `hagicode-0.1.0-beta.33-${platformId}-nort.zip`);
  await createFixtureArchive(runtimeRoot, archivePath);
  return archivePath;
}

async function createMacDesktopArchive(tempRoot) {
  const root = path.join(tempRoot, 'desktop-root');
  const portableFixedRoot = path.join(
    root,
    'Hagicode Desktop.app',
    'Contents',
    'Resources',
    'extra',
    'portable-fixed'
  );
  await mkdir(portableFixedRoot, { recursive: true });
  await writeFile(path.join(portableFixedRoot, '.keep'), 'portable root', 'utf8');

  const archivePath = path.join(tempRoot, 'hagicode.desktop-0.2.0-mac.zip');
  await createFixtureArchive(root, archivePath);
  return archivePath;
}

async function extendToolchainConfigForMac(toolchainConfigPath) {
  const config = await readJson(toolchainConfigPath);
  config.node.platforms['osx-x64'] = { ...config.node.platforms['linux-x64'] };
  config.node.platforms['osx-arm64'] = { ...config.node.platforms['linux-x64'] };
  await writeJson(toolchainConfigPath, config);
}

test('universal macOS packaging writes bundle metadata and preserves both payload roots', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-macos-universal-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopArchivePath = await createMacDesktopArchive(tempRoot);
  const x64ServiceArchivePath = await createPortableRuntimeArchive(tempRoot, 'osx-x64');
  const arm64ServiceArchivePath = await createPortableRuntimeArchive(tempRoot, 'osx-arm64');
  const serviceSourceMapPath = path.join(tempRoot, 'service-source-map.json');
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await extendToolchainConfigForMac(toolchainFixture.configPath);
  await writeJson(serviceSourceMapPath, {
    'osx-x64': x64ServiceArchivePath,
    'osx-arm64': arm64ServiceArchivePath
  });

  await writeJson(planPath, {
    repositories: {
      desktop: 'https://index.hagicode.com/desktop/index.json',
      service: 'https://index.hagicode.com/server/index.json',
      portable: 'HagiCode-org/portable-version'
    },
    downloads: {
      strategy: 'azure-blob-sas',
      desktop: { containerUrl: 'https://example.blob.core.windows.net/desktop/' },
      service: { containerUrl: 'https://example.blob.core.windows.net/server/' }
    },
    platforms: ['osx-universal'],
    upstream: {
      desktop: {
        sourceType: 'index',
        manifestUrl: 'https://index.hagicode.com/desktop/index.json',
        version: 'v0.2.0',
        assetsByPlatform: {
          'osx-x64': {
            name: 'hagicode.desktop-0.2.0-mac.zip',
            path: 'v0.2.0/hagicode.desktop-0.2.0-mac.zip'
          }
        }
      },
      service: {
        sourceType: 'index',
        manifestUrl: 'https://index.hagicode.com/server/index.json',
        version: '0.1.0-beta.33',
        assetsByPlatform: {
          'osx-x64': {
            name: 'hagicode-0.1.0-beta.33-osx-x64-nort.zip',
            path: '0.1.0-beta.33/hagicode-0.1.0-beta.33-osx-x64-nort.zip'
          },
          'osx-arm64': {
            name: 'hagicode-0.1.0-beta.33-osx-arm64-nort.zip',
            path: '0.1.0-beta.33/hagicode-0.1.0-beta.33-osx-arm64-nort.zip'
          }
        }
      }
    },
    release: {
      tag: 'v0.1.0-beta.33-v0.2.0'
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
    'osx-universal',
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
    'osx-universal',
    '--workspace',
    workspacePath,
    '--service-asset-source-map',
    serviceSourceMapPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-portable-toolchain.mjs'),
    '--plan',
    planPath,
    '--platform',
    'osx-universal',
    '--workspace',
    workspacePath,
    '--toolchain-config',
    toolchainFixture.configPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'verify-portable-toolchain.mjs'),
    '--platform',
    'osx-universal',
    '--workspace',
    workspacePath,
    '--toolchain-config',
    toolchainFixture.configPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'package-desktop-portable.mjs'),
    '--plan',
    planPath,
    '--platform',
    'osx-universal',
    '--workspace',
    workspacePath,
    '--force-dry-run'
  ]);

  const payloadReport = await readJson(path.join(workspacePath, 'payload-validation-osx-universal.json'));
  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-osx-universal.json'));

  assert.equal(payloadReport.bundle.kind, 'macos-universal');
  assert.deepEqual(payloadReport.bundle.includedPlatforms, ['osx-x64', 'osx-arm64']);
  assert.equal(inventory.bundle.publicationPlatform, 'osx-universal');
  assert.deepEqual(inventory.artifacts[0].bundledPlatforms, ['osx-x64', 'osx-arm64']);
  assert.equal(inventory.artifacts[0].fileName, 'hagicode-portable-osx-universal.zip');

  const archiveListing = (await validateZipPaths(inventory.artifacts[0].outputPath)).join('\n');
  assert.match(
    archiveListing,
    /Hagicode Desktop\.app\/Contents\/Resources\/extra\/portable-fixed\/current\/bundle-manifest\.json/
  );
  assert.match(
    archiveListing,
    /Hagicode Desktop\.app\/Contents\/Resources\/extra\/portable-fixed\/current\/osx-x64\/manifest\.json/
  );
  assert.match(
    archiveListing,
    /Hagicode Desktop\.app\/Contents\/Resources\/extra\/portable-fixed\/current\/osx-arm64\/manifest\.json/
  );
});

test('universal macOS staging fails before packaging when a required payload member is missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-macos-universal-missing-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopArchivePath = await createMacDesktopArchive(tempRoot);
  const x64ServiceArchivePath = await createPortableRuntimeArchive(tempRoot, 'osx-x64');
  const serviceSourceMapPath = path.join(tempRoot, 'service-source-map.json');

  await writeJson(serviceSourceMapPath, {
    'osx-x64': x64ServiceArchivePath
  });

  await writeJson(planPath, {
    upstream: {
      desktop: {
        version: 'v0.2.0',
        assetsByPlatform: {
          'osx-x64': {
            name: 'hagicode.desktop-0.2.0-mac.zip',
            path: 'v0.2.0/hagicode.desktop-0.2.0-mac.zip'
          }
        }
      },
      service: {
        version: '0.1.0-beta.33',
        assetsByPlatform: {
          'osx-x64': {
            name: 'hagicode-0.1.0-beta.33-osx-x64-nort.zip',
            path: '0.1.0-beta.33/hagicode-0.1.0-beta.33-osx-x64-nort.zip'
          }
        }
      }
    },
    release: {
      tag: 'v0.1.0-beta.33-v0.2.0-missing'
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
    'osx-universal',
    '--workspace',
    workspacePath,
    '--desktop-asset-source',
    desktopArchivePath
  ]);

  await assert.rejects(
    () =>
      runCommand('node', [
        path.join(repoRoot, 'scripts', 'stage-portable-payload.mjs'),
        '--plan',
        planPath,
        '--platform',
        'osx-universal',
        '--workspace',
        workspacePath,
        '--service-asset-source-map',
        serviceSourceMapPath
      ], { stdio: 'pipe' }),
    /No service asset mapped for platform osx-arm64/
  );
});
