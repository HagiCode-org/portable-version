import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createArchive } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { prepareSteamDlcReleaseInput } from '../scripts/prepare-steam-dlc-release-input.mjs';
import { prepareSteamReleaseInput } from '../scripts/prepare-steam-release-input.mjs';
import { buildSteamLoginArgs, generateSteamGuardCode, getSteamcmdConfigPath } from '../scripts/publish-steam.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReleaseTag = 'v0.1.0-beta.33';
const steamSasUrl = 'https://example.blob.core.windows.net/hagicode-steam?sp=rl&sig=test-token';
const dlcSteamSasUrl = 'https://example.blob.core.windows.net/hagicode-steam-dlc?sp=rl&sig=test-token';

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

function createDlcRootIndex(dlcs) {
  return {
    updatedAt: '2026-04-21T03:09:32.3804912Z',
    dlcs
  };
}

function buildDlcArtifactRecord(dlcName, version, platform) {
  const fileName = `hagicode-dlc-${dlcName}-${version}-${platform}-nort.zip`;
  return {
    name: fileName,
    path: `${dlcName}/${version}/${fileName}`
  };
}

async function createArchiveBlob(tempRoot, files, blobPath, entries) {
  const sourceRoot = path.join(tempRoot, 'dlc-sources', blobPath.replace(/[^A-Za-z0-9._/-]+/g, '-'));
  const archivePath = path.join(tempRoot, 'dlc-archives', path.basename(blobPath));

  await mkdir(sourceRoot, { recursive: true });
  for (const [entryPath, content] of Object.entries(entries)) {
    const targetPath = path.join(sourceRoot, entryPath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  }

  await createArchive(sourceRoot, archivePath);
  files.set(blobPath, await readFile(archivePath));
}

async function createDlcHydrationFixture({
  emptyVersionsFor = [],
  omitDepotMapping = null,
  omitArtifactPlatform = null
} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-steam-dlc-'));
  const files = new Map();

  const turboLatestVersion = '0.1.0-beta.50';
  const nitroLatestVersion = '0.2.0-beta.7';

  const turboLatestArtifacts = ['linux-x64', 'win-x64', 'osx-universal'].map((platform) =>
    buildDlcArtifactRecord('turbo-engine', turboLatestVersion, platform)
  );
  const nitroLatestArtifacts = ['linux-x64', 'win-x64', 'osx-x64', 'osx-arm64'].map((platform) =>
    buildDlcArtifactRecord('nitro-boost', nitroLatestVersion, platform)
  );

  const turboLatestDepotIds = {
    linux: '4635482',
    windows: '4635480',
    macos: '4635481'
  };
  const nitroLatestDepotIds = {
    linux: '5735482',
    windows: '5735480',
    macos: '5735481'
  };

  if (!(emptyVersionsFor.includes('turbo-engine'))) {
    for (const artifact of turboLatestArtifacts) {
      if (omitArtifactPlatform?.dlcName === 'turbo-engine' && omitArtifactPlatform.platform === artifact.name.match(/-(linux-x64|win-x64|osx-universal)-nort\.zip$/)?.[1]) {
        continue;
      }
      await createArchiveBlob(tempRoot, files, artifact.path, {
        'README.txt': `turbo-engine ${artifact.name}`,
        ...(artifact.name.includes('linux-x64') ? { 'bin/turbo-linux.txt': 'turbo linux latest' } : {}),
        ...(artifact.name.includes('win-x64') ? { 'bin/turbo-windows.txt': 'turbo windows latest' } : {}),
        ...(artifact.name.includes('osx-universal') ? { 'mac/turbo-universal.txt': 'turbo mac universal latest' } : {})
      });
    }
  }

  if (!(emptyVersionsFor.includes('nitro-boost'))) {
    for (const artifact of nitroLatestArtifacts) {
      const platform = artifact.name.match(/-(linux-x64|win-x64|osx-x64|osx-arm64)-nort\.zip$/)?.[1];
      if (omitArtifactPlatform?.dlcName === 'nitro-boost' && omitArtifactPlatform.platform === platform) {
        continue;
      }
      await createArchiveBlob(tempRoot, files, artifact.path, {
        'README.txt': `nitro-boost ${artifact.name}`,
        ...(platform === 'linux-x64' ? { 'linux/nitro-linux.txt': 'nitro linux latest' } : {}),
        ...(platform === 'win-x64' ? { 'windows/nitro-windows.txt': 'nitro windows latest' } : {}),
        ...(platform === 'osx-x64' ? { 'macos/x64-only.txt': 'nitro mac x64 latest' } : {}),
        ...(platform === 'osx-arm64' ? { 'macos/arm64-only.txt': 'nitro mac arm64 latest' } : {})
      });
    }
  }

  const dlcs = [
    {
      dlcName: 'turbo-engine',
      versions: emptyVersionsFor.includes('turbo-engine')
        ? []
        : [
            {
              version: '0.1.0-beta.49',
              steamDepotIds: turboLatestDepotIds,
              artifacts: ['linux-x64', 'win-x64', 'osx-universal'].map((platform) =>
                buildDlcArtifactRecord('turbo-engine', '0.1.0-beta.49', platform)
              )
            },
            {
              version: turboLatestVersion,
              steamDepotIds:
                omitDepotMapping?.dlcName === 'turbo-engine'
                  ? Object.fromEntries(
                      Object.entries(turboLatestDepotIds).filter(([platform]) => platform !== omitDepotMapping.platform)
                    )
                  : turboLatestDepotIds,
              artifacts: turboLatestArtifacts.filter((artifact) => {
                const platform = artifact.name.match(/-(linux-x64|win-x64|osx-universal)-nort\.zip$/)?.[1];
                return !(
                  omitArtifactPlatform?.dlcName === 'turbo-engine' && omitArtifactPlatform.platform === platform
                );
              })
            }
          ]
    },
    {
      dlcName: 'nitro-boost',
      versions: emptyVersionsFor.includes('nitro-boost')
        ? []
        : [
            {
              version: '0.2.0-beta.6',
              steamDepotIds: nitroLatestDepotIds,
              artifacts: ['linux-x64', 'win-x64', 'osx-universal'].map((platform) =>
                buildDlcArtifactRecord('nitro-boost', '0.2.0-beta.6', platform)
              )
            },
            {
              version: nitroLatestVersion,
              steamDepotIds:
                omitDepotMapping?.dlcName === 'nitro-boost'
                  ? Object.fromEntries(
                      Object.entries(nitroLatestDepotIds).filter(([platform]) => platform !== omitDepotMapping.platform)
                    )
                  : nitroLatestDepotIds,
              artifacts: nitroLatestArtifacts.filter((artifact) => {
                const platform = artifact.name.match(/-(linux-x64|win-x64|osx-x64|osx-arm64)-nort\.zip$/)?.[1];
                return !(
                  omitArtifactPlatform?.dlcName === 'nitro-boost' && omitArtifactPlatform.platform === platform
                );
              })
            }
          ]
    }
  ];

  return {
    tempRoot,
    fetchImpl: createAzureFetchFixture({
      index: createDlcRootIndex(dlcs),
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

test('prepare-steam-dlc-release-input hydrates the latest version for every discovered DLC and publishes all depots', async () => {
  const fixture = await createDlcHydrationFixture();
  const hydrationRoot = path.join(fixture.tempRoot, 'hydrated-dlc-release');
  const steamBuildOutput = path.join(fixture.tempRoot, 'steam-dlc-build');

  const hydration = await prepareSteamDlcReleaseInput({
    outputDir: hydrationRoot,
    dlcAzureSasUrl: dlcSteamSasUrl,
    fetchImpl: fixture.fetchImpl
  });

  assert.equal(hydration.discoverySource.includes('index.json'), true);
  assert.equal(hydration.dlcs.length, 2);
  assert.deepEqual(
    hydration.dlcs.map((entry) => [entry.dlcName, entry.dlcVersion]),
    [
      ['turbo-engine', '0.1.0-beta.50'],
      ['nitro-boost', '0.2.0-beta.7']
    ]
  );
  assert.deepEqual(hydration.dlcs[0].preparedPlatforms, ['linux-x64', 'win-x64', 'osx-universal']);
  assert.deepEqual(hydration.dlcs[1].preparedPlatforms, ['linux-x64', 'win-x64', 'osx-x64', 'osx-arm64']);
  assert.equal(await readFile(path.join(hydration.dlcs[0].contentRoots.linux, 'bin', 'turbo-linux.txt'), 'utf8'), 'turbo linux latest');
  assert.equal(await readFile(path.join(hydration.dlcs[1].contentRoots.macos, 'macos', 'x64-only.txt'), 'utf8'), 'nitro mac x64 latest');
  assert.equal(await readFile(path.join(hydration.dlcs[1].contentRoots.macos, 'macos', 'arm64-only.txt'), 'utf8'), 'nitro mac arm64 latest');

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'publish-steam.mjs'),
    '--release-input',
    path.join(hydrationRoot, 'metadata', 'steam-dlc-release-input.json'),
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
  const appBuild = await readFile(path.join(steamBuildOutput, 'scripts', 'app-build.vdf'), 'utf8');

  assert.equal(manifest.planPath, null);
  assert.equal(manifest.contentRoot, null);
  assert.equal(manifest.preview, true);
  assert.equal(manifest.branch, 'candidate');
  assert.equal(manifest.dlcRelease.dlcCount, 2);
  assert.equal(manifest.dlcs.length, 2);
  assert.equal(manifest.depots.length, 6);
  assert.equal(manifest.depots[0].dlcName, 'turbo-engine');
  assert.equal(manifest.depots[0].platform, 'linux');
  assert.equal(manifest.depots[2].sourcePlatform, 'osx-universal');
  assert.equal(manifest.depots[5].dlcName, 'nitro-boost');
  assert.equal(manifest.depots[5].sourcePlatform, 'osx-x64+osx-arm64');
  assert.match(appBuild, /"4635482"/);
  assert.match(appBuild, /"5735481"/);
});

test('prepare-steam-dlc-release-input fails when a discovered DLC does not expose any versions', async () => {
  const fixture = await createDlcHydrationFixture({
    emptyVersionsFor: ['nitro-boost']
  });

  await assert.rejects(
    () =>
      prepareSteamDlcReleaseInput({
        outputDir: path.join(fixture.tempRoot, 'missing-latest-version'),
        dlcAzureSasUrl: dlcSteamSasUrl,
        fetchImpl: fixture.fetchImpl
      }),
    /nitro-boost".*does not contain any versions/
  );
});

test('prepare-steam-dlc-release-input fails when the latest DLC version omits a depot mapping', async () => {
  const fixture = await createDlcHydrationFixture({
    omitDepotMapping: {
      dlcName: 'turbo-engine',
      platform: 'macos'
    }
  });

  await assert.rejects(
    () =>
      prepareSteamDlcReleaseInput({
        outputDir: path.join(fixture.tempRoot, 'missing-dlc-depot'),
        dlcAzureSasUrl: dlcSteamSasUrl,
        fetchImpl: fixture.fetchImpl
      }),
    /turbo-engine".*steamDepotIds\.macos/
  );
});

test('prepare-steam-dlc-release-input fails when the latest DLC version omits a required artifact', async () => {
  const fixture = await createDlcHydrationFixture({
    omitArtifactPlatform: {
      dlcName: 'turbo-engine',
      platform: 'win-x64'
    }
  });

  await assert.rejects(
    () =>
      prepareSteamDlcReleaseInput({
        outputDir: path.join(fixture.tempRoot, 'missing-dlc-artifact'),
        dlcAzureSasUrl: dlcSteamSasUrl,
        fetchImpl: fixture.fetchImpl
      }),
    /Failed to prepare DLC turbo-engine version 0.1.0-beta.50: .*win-x64 artifact/
  );
});

test('prepare-steam-dlc-release-input preserves macOS fallback staging for a split DLC archive set', async () => {
  const fixture = await createDlcHydrationFixture();
  const hydration = await prepareSteamDlcReleaseInput({
    outputDir: path.join(fixture.tempRoot, 'macos-fallback'),
    dlcAzureSasUrl: dlcSteamSasUrl,
    fetchImpl: fixture.fetchImpl
  });
  const nitroBoost = hydration.dlcs.find((entry) => entry.dlcName === 'nitro-boost');

  assert.ok(nitroBoost);
  assert.deepEqual(
    nitroBoost.selectedArtifacts.macos.map((artifact) => artifact.platform),
    ['osx-x64', 'osx-arm64']
  );
  assert.equal(await readFile(path.join(nitroBoost.contentRoots.macos, 'macos', 'x64-only.txt'), 'utf8'), 'nitro mac x64 latest');
  assert.equal(await readFile(path.join(nitroBoost.contentRoots.macos, 'macos', 'arm64-only.txt'), 'utf8'), 'nitro mac arm64 latest');
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
