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
import { buildSteamLoginArgs, generateSteamGuardCode, getSteamcmdConfigPath } from '../scripts/publish-steam.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReleaseTag = 'v0.1.0-beta.33';
const steamSasUrl = 'https://example.blob.core.windows.net/hagicode-steam?sp=rl&sig=test-token';

function createPortableRootIndex({
  releaseTag = defaultReleaseTag,
  steamDepotIds = {
    linux: '7654322',
    windows: '7654323',
    macos: '7654324'
  },
  artifacts = [
    {
      platform: 'linux-x64',
      name: 'hagicode-portable-linux-x64.zip',
      path: `${releaseTag}/hagicode-portable-linux-x64.zip`
    },
    {
      platform: 'osx-universal',
      name: 'hagicode-portable-osx-universal.zip',
      path: `${releaseTag}/hagicode-portable-osx-universal.zip`
    },
    {
      platform: 'win-x64',
      name: 'hagicode-portable-win-x64.zip',
      path: `${releaseTag}/hagicode-portable-win-x64.zip`
    }
  ]
} = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-04-18T12:00:00Z',
    versions: [
      {
        version: releaseTag,
        metadata: {
          buildManifestPath: `${releaseTag}/${releaseTag}.build-manifest.json`,
          artifactInventoryPath: `${releaseTag}/${releaseTag}.artifact-inventory.json`,
          checksumsPath: `${releaseTag}/${releaseTag}.checksums.txt`
        },
        steamDepotIds,
        artifacts
      }
    ]
  };
}

function createAzureFetchFixture(blobs) {
  return async (url) => {
    const parsed = new URL(url);
    const blobPath = parsed.pathname.split('/').slice(2).join('/');
    if (blobPath === 'index.json') {
      return new Response(JSON.stringify(blobs.index, null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }

    const payload = blobs.files.get(blobPath);
    if (!payload) {
      return new Response('not found', { status: 404 });
    }

    return new Response(payload, { status: 200 });
  };
}

async function createHydrationFixture({
  includeWindowsArchive = true,
  includeMacArchive = true,
  steamDepotIds,
  artifacts
} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-steam-release-'));
  const releaseTag = defaultReleaseTag;
  const linuxSource = path.join(tempRoot, 'linux-source');
  const windowsSource = path.join(tempRoot, 'windows-source');
  const macSource = path.join(tempRoot, 'mac-source');
  const files = new Map();

  await mkdir(linuxSource, { recursive: true });
  await mkdir(windowsSource, { recursive: true });
  await mkdir(macSource, { recursive: true });
  await writeFile(path.join(linuxSource, 'hagicode'), 'linux build', 'utf8');
  await writeFile(path.join(windowsSource, 'hagicode.exe'), 'windows build', 'utf8');
  await writeFile(path.join(macSource, 'Hagicode Desktop.app'), 'mac build', 'utf8');

  const buildManifestPath = path.join(tempRoot, `${releaseTag}.build-manifest.json`);
  const artifactInventoryPath = path.join(tempRoot, `${releaseTag}.artifact-inventory.json`);
  const checksumsPath = path.join(tempRoot, `${releaseTag}.checksums.txt`);
  const linuxArchivePath = path.join(tempRoot, 'hagicode-portable-linux-x64.zip');
  const windowsArchivePath = path.join(tempRoot, 'hagicode-portable-win-x64.zip');
  const macArchivePath = path.join(tempRoot, 'hagicode-portable-osx-universal.zip');

  await writeJson(buildManifestPath, {
    upstream: {
      desktop: { version: 'v0.2.0' },
      service: { version: '0.1.0-beta.33' }
    },
    release: {
      tag: releaseTag
    }
  });
  await writeJson(artifactInventoryPath, {
    releaseTag,
    artifacts: [
      {
        platform: 'linux-x64',
        fileName: path.basename(linuxArchivePath)
      },
      {
        platform: 'win-x64',
        fileName: path.basename(windowsArchivePath)
      },
      {
        platform: 'osx-universal',
        fileName: path.basename(macArchivePath)
      }
    ]
  });
  await writeFile(checksumsPath, 'abc123  hagicode-portable-linux-x64.zip\n', 'utf8');

  await createArchive(linuxSource, linuxArchivePath);
  await createArchive(windowsSource, windowsArchivePath);
  await createArchive(macSource, macArchivePath);

  files.set(`${releaseTag}/${releaseTag}.build-manifest.json`, await readFile(buildManifestPath));
  files.set(`${releaseTag}/${releaseTag}.artifact-inventory.json`, await readFile(artifactInventoryPath));
  files.set(`${releaseTag}/${releaseTag}.checksums.txt`, await readFile(checksumsPath));
  files.set(`${releaseTag}/hagicode-portable-linux-x64.zip`, await readFile(linuxArchivePath));
  if (includeWindowsArchive) {
    files.set(`${releaseTag}/hagicode-portable-win-x64.zip`, await readFile(windowsArchivePath));
  }
  if (includeMacArchive) {
    files.set(`${releaseTag}/hagicode-portable-osx-universal.zip`, await readFile(macArchivePath));
  }

  return {
    tempRoot,
    fetchImpl: createAzureFetchFixture({
      index: createPortableRootIndex({
        releaseTag,
        steamDepotIds,
        artifacts
      }),
      files
    })
  };
}

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
      tag: defaultReleaseTag
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
  const fixture = await createHydrationFixture();
  await assert.rejects(
    () =>
      prepareSteamReleaseInput({
        releaseTag: 'v0.1.0-beta.40',
        outputDir: path.join(fixture.tempRoot, 'unknown'),
        steamAzureSasUrl: steamSasUrl,
        fetchImpl: fixture.fetchImpl
      }),
    /does not contain version/
  );
});

test('prepare-steam-release-input hydrates published Azure archives for standalone Steam publication', async () => {
  const fixture = await createHydrationFixture();
  const hydrationRoot = path.join(fixture.tempRoot, 'hydrated-release');
  const steamBuildOutput = path.join(fixture.tempRoot, 'steam-build');

  const hydration = await prepareSteamReleaseInput({
    releaseTag: defaultReleaseTag,
    outputDir: hydrationRoot,
    steamAzureSasUrl: steamSasUrl,
    fetchImpl: fixture.fetchImpl
  });

  assert.deepEqual(hydration.preparedPlatforms, ['linux-x64', 'osx-universal', 'win-x64']);
  assert.deepEqual(hydration.steamDepotIds, {
    linux: '7654322',
    windows: '7654323',
    macos: '7654324'
  });
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
    '--release-input',
    path.join(hydrationRoot, 'metadata', 'steam-release-input.json'),
    '--output-dir',
    steamBuildOutput,
    '--app-id',
    '7654321',
    '--branch',
    'candidate',
    '--preview',
    '--force-dry-run'
  ]);

  const manifest = await readJson(path.join(steamBuildOutput, 'steam-build-manifest.json'));
  assert.equal(manifest.preview, true);
  assert.equal(manifest.branch, 'candidate');
  assert.equal(manifest.depots.length, 3);
  assert.equal(manifest.planPath, hydration.buildManifestPath);
  assert.equal(manifest.contentRoot, hydration.contentRoot);
  assert.equal(manifest.releaseInputPath, path.join(hydrationRoot, 'metadata', 'steam-release-input.json'));
  assert.deepEqual(manifest.azureRelease, {
    requestedReleaseTag: defaultReleaseTag,
    index: hydration.azureIndex,
    steamDepotIds: hydration.steamDepotIds
  });
  assert.equal(manifest.depots[2].platform, 'macos');
  assert.equal(manifest.depots[2].sourcePlatform, 'osx-universal');
});

test('prepare-steam-release-input fails when the Azure release entry omits a depot mapping', async () => {
  const fixture = await createHydrationFixture({
    steamDepotIds: {
      linux: '7654322',
      windows: '7654323'
    }
  });

  await assert.rejects(
    () =>
      prepareSteamReleaseInput({
        releaseTag: defaultReleaseTag,
        outputDir: path.join(fixture.tempRoot, 'missing-depot'),
        steamAzureSasUrl: steamSasUrl,
        fetchImpl: fixture.fetchImpl
      }),
    /steamDepotIds\.macos/
  );
});

test('prepare-steam-release-input fails when a required archive is missing from Azure', async () => {
  const fixture = await createHydrationFixture({ includeWindowsArchive: false });

  await assert.rejects(
    () =>
      prepareSteamReleaseInput({
        releaseTag: defaultReleaseTag,
        outputDir: path.join(fixture.tempRoot, 'missing-windows'),
        steamAzureSasUrl: steamSasUrl,
        fetchImpl: fixture.fetchImpl
      }),
    /Failed to download/
  );
});

test('publish-steam uses one unified macOS depot backed by universal content', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-steam-macos-'));
  const contentRoot = path.join(tempRoot, 'steam-content');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const outputDir = path.join(tempRoot, 'steam-build');

  await mkdir(path.join(contentRoot, 'osx-universal'), { recursive: true });
  await writeFile(path.join(contentRoot, 'osx-universal', 'Hagicode Desktop.app'), 'mac bundle', 'utf8');

  await writeJson(planPath, {
    upstream: {
      desktop: { version: 'v0.2.0' },
      service: { version: '0.1.0-beta.33' }
    },
    release: {
      tag: defaultReleaseTag
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
    '7654323',
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

test('buildSteamLoginArgs reuses a saved SteamCMD session without resending credentials', () => {
  assert.deepEqual(
    buildSteamLoginArgs({
      steamUsername: 'builder-account',
      steamPassword: 'secret',
      steamGuardCode: 'ABCDE',
      useSavedLogin: true
    }),
    ['+login', 'builder-account']
  );
});

test('buildSteamLoginArgs includes password and guard code when bootstrapping a new SteamCMD session', () => {
  assert.deepEqual(
    buildSteamLoginArgs({
      steamUsername: 'builder-account',
      steamPassword: 'secret',
      steamGuardCode: 'ABCDE',
      useSavedLogin: false
    }),
    ['+login', 'builder-account', 'secret', 'ABCDE']
  );
  assert.equal(
    getSteamcmdConfigPath('/tmp/portable-version-steamcmd/steamcmd.sh'),
    path.resolve('/tmp/portable-version-steamcmd/config/config.vdf')
  );
});
