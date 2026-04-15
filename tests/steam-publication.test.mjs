import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createArchive } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { prepareSteamReleaseInput } from '../scripts/prepare-steam-release-input.mjs';
import { generateSteamGuardCode } from '../scripts/publish-steam.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test('publish-steam emits build scripts in dry-run mode', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-steam-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const contentRoot = path.join(tempRoot, 'steam-content');
  const outputDir = path.join(tempRoot, 'steam-build');

  await mkdir(path.join(contentRoot, 'linux-x64'), { recursive: true });
  await mkdir(path.join(contentRoot, 'win-x64'), { recursive: true });
  await writeFile(path.join(contentRoot, 'linux-x64', 'hagicode'), 'linux build', 'utf8');
  await writeFile(path.join(contentRoot, 'win-x64', 'hagicode.exe'), 'windows build', 'utf8');

  await writeJson(planPath, {
    upstream: {
      desktop: { version: 'v0.2.0' },
      service: { version: '0.1.0-beta.33' }
    },
    release: {
      tag: 'v0.1.0-beta.33-v0.2.0'
    }
  });

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'publish-steam.mjs'),
    '--plan',
    planPath,
    '--content-root',
    contentRoot,
    '--output-dir',
    outputDir,
    '--app-id',
    '1234560',
    '--linux-depot-id',
    '1234561',
    '--windows-depot-id',
    '1234562',
    '--branch',
    'candidate',
    '--preview',
    '--force-dry-run'
  ]);

  const manifest = await readJson(path.join(outputDir, 'steam-build-manifest.json'));
  const appBuild = await readFile(path.join(outputDir, 'scripts', 'app-build.vdf'), 'utf8');
  const linuxDepot = await readFile(path.join(outputDir, 'scripts', 'depot-build-linux-x64.vdf'), 'utf8');

  assert.equal(manifest.appId, '1234560');
  assert.equal(manifest.preview, true);
  assert.equal(manifest.branch, 'candidate');
  assert.equal(manifest.depots.length, 2);
  assert.match(appBuild, /"setlive" "candidate"/);
  assert.match(appBuild, /"preview" "1"/);
  assert.match(linuxDepot, /"DepotID" "1234561"/);
});

test('prepare-steam-release-input rejects unknown release tags', async () => {
  await assert.rejects(
    () =>
      prepareSteamReleaseInput({
        releaseTag: 'v0.1.0-beta.33-v0.2.0',
        resolveRelease: async () => null
      }),
    /does not exist/
  );
});

test('prepare-steam-release-input hydrates published archives for standalone Steam publication', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-steam-release-'));
  const releaseTag = 'v0.1.0-beta.33-v0.2.0';
  const releaseAssetRoot = path.join(tempRoot, 'release-assets-fixture');
  const hydrationRoot = path.join(tempRoot, 'hydrated-release');
  const steamBuildOutput = path.join(tempRoot, 'steam-build');
  const linuxSource = path.join(tempRoot, 'linux-source');
  const macSource = path.join(tempRoot, 'mac-source');

  await mkdir(releaseAssetRoot, { recursive: true });
  await mkdir(linuxSource, { recursive: true });
  await mkdir(macSource, { recursive: true });
  await writeFile(path.join(linuxSource, 'hagicode'), 'linux build', 'utf8');
  await writeFile(path.join(macSource, 'Hagicode Desktop.app'), 'mac build', 'utf8');

  const buildManifestAssetPath = path.join(releaseAssetRoot, `${releaseTag}.build-manifest.json`);
  const artifactInventoryAssetPath = path.join(releaseAssetRoot, `${releaseTag}.artifact-inventory.json`);
  const linuxArchivePath = path.join(releaseAssetRoot, 'hagicode-portable-linux-x64.zip');
  const macArchivePath = path.join(releaseAssetRoot, 'hagicode-portable-osx-universal.zip');

  await writeJson(buildManifestAssetPath, {
    upstream: {
      desktop: { version: 'v0.2.0' },
      service: { version: '0.1.0-beta.33' }
    },
    release: {
      tag: releaseTag
    }
  });
  await writeJson(artifactInventoryAssetPath, {
    releaseTag,
    artifacts: [
      {
        platform: 'linux-x64',
        fileName: path.basename(linuxArchivePath)
      },
      {
        platform: 'osx-universal',
        fileName: path.basename(macArchivePath)
      }
    ]
  });

  await createArchive(linuxSource, linuxArchivePath);
  await createArchive(macSource, macArchivePath);

  const release = {
    id: 42,
    html_url: `https://github.com/HagiCode-org/portable-version/releases/tag/${releaseTag}`,
    assets: [
      {
        name: path.basename(buildManifestAssetPath),
        downloadUrl: buildManifestAssetPath
      },
      {
        name: path.basename(artifactInventoryAssetPath),
        downloadUrl: artifactInventoryAssetPath
      },
      {
        name: path.basename(linuxArchivePath),
        downloadUrl: linuxArchivePath
      },
      {
        name: path.basename(macArchivePath),
        downloadUrl: macArchivePath
      }
    ]
  };

  const hydration = await prepareSteamReleaseInput({
    releaseTag,
    outputDir: hydrationRoot,
    resolveRelease: async () => release
  });

  assert.deepEqual(hydration.preparedPlatforms, ['linux-x64', 'osx-universal']);
  assert.equal(
    await readFile(path.join(hydration.contentRoot, 'linux-x64', 'hagicode'), 'utf8'),
    'linux build'
  );
  assert.equal(
    await readFile(path.join(hydration.contentRoot, 'osx-universal', 'Hagicode Desktop.app'), 'utf8'),
    'mac build'
  );

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'publish-steam.mjs'),
    '--plan',
    hydration.buildManifestPath,
    '--content-root',
    hydration.contentRoot,
    '--output-dir',
    steamBuildOutput,
    '--app-id',
    '7654321',
    '--linux-depot-id',
    '7654322',
    '--macos-depot-id',
    '7654323',
    '--branch',
    'candidate',
    '--preview',
    '--force-dry-run'
  ]);

  const manifest = await readJson(path.join(steamBuildOutput, 'steam-build-manifest.json'));
  assert.equal(manifest.preview, true);
  assert.equal(manifest.branch, 'candidate');
  assert.equal(manifest.depots.length, 2);
  assert.equal(manifest.planPath, hydration.buildManifestPath);
  assert.equal(manifest.contentRoot, hydration.contentRoot);
  assert.equal(manifest.depots[1].platform, 'macos');
  assert.equal(manifest.depots[1].sourcePlatform, 'osx-universal');
});

test('publish-steam uses one unified macOS depot backed by universal content', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-steam-macos-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const contentRoot = path.join(tempRoot, 'steam-content');
  const outputDir = path.join(tempRoot, 'steam-build');

  await mkdir(path.join(contentRoot, 'osx-universal'), { recursive: true });
  await writeFile(path.join(contentRoot, 'osx-universal', 'Hagicode Desktop.app'), 'mac bundle', 'utf8');

  await writeJson(planPath, {
    upstream: {
      desktop: { version: 'v0.2.0' },
      service: { version: '0.1.0-beta.33' }
    },
    release: {
      tag: 'v0.1.0-beta.33-v0.2.0'
    }
  });

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'publish-steam.mjs'),
    '--plan',
    planPath,
    '--content-root',
    contentRoot,
    '--output-dir',
    outputDir,
    '--app-id',
    '7654321',
    '--macos-depot-id',
    '7654322',
    '--force-dry-run'
  ]);

  const manifest = await readJson(path.join(outputDir, 'steam-build-manifest.json'));
  const macosDepot = await readFile(path.join(outputDir, 'scripts', 'depot-build-macos.vdf'), 'utf8');

  assert.equal(manifest.depots.length, 1);
  assert.equal(manifest.depots[0].platform, 'macos');
  assert.equal(manifest.depots[0].sourcePlatform, 'osx-universal');
  assert.match(macosDepot, /osx-universal/);
});

test('generateSteamGuardCode returns the expected length', () => {
  const code = generateSteamGuardCode('aGVsbG8gd29ybGQ=');
  assert.equal(code.length, 5);
  assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
});
