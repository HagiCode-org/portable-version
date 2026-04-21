import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLatestDlcVersions } from '../scripts/lib/dlc-index.mjs';
import { selectSteamArtifactsForPublication } from '../scripts/lib/platforms.mjs';

test('resolveLatestDlcVersions selects the newest version for every DLC in the root index', () => {
  const resolved = resolveLatestDlcVersions({
    sanitizedIndexUrl: 'https://example.invalid/dlc/index.json',
    dlcIndex: {
      updatedAt: '2026-04-21T03:09:32.3804912Z',
      dlcs: [
        {
          dlcName: 'turbo-engine',
          versions: [
            {
              version: '0.1.0-beta.9',
              steamAppId: '101',
              steamDepotIds: {
                linux: '1',
                windows: '2',
                macos: '3'
              },
              artifacts: [
                {
                  name: 'hagicode-dlc-turbo-engine-0.1.0-beta.9-linux-x64-nort.zip',
                  path: 'turbo-engine/0.1.0-beta.9/linux.zip'
                }
              ]
            },
            {
              version: '0.1.0-beta.10',
              steamAppId: '102',
              steamDepotIds: {
                linux: '4',
                windows: '5',
                macos: '6'
              },
              artifacts: [
                {
                  name: 'hagicode-dlc-turbo-engine-0.1.0-beta.10-linux-x64-nort.zip',
                  path: 'turbo-engine/0.1.0-beta.10/linux.zip'
                }
              ]
            }
          ]
        },
        {
          dlcName: 'nitro-boost',
          versions: [
            {
              version: '1.2.0',
              steamAppId: '201',
              steamDepotIds: {
                linux: '7',
                windows: '8',
                macos: '9'
              },
              artifacts: [
                {
                  name: 'hagicode-dlc-nitro-boost-1.2.0-linux-x64-nort.zip',
                  path: 'nitro-boost/1.2.0/linux.zip'
                }
              ]
            },
            {
              version: '1.1.9',
              steamAppId: '200',
              steamDepotIds: {
                linux: '10',
                windows: '11',
                macos: '12'
              },
              artifacts: [
                {
                  name: 'hagicode-dlc-nitro-boost-1.1.9-linux-x64-nort.zip',
                  path: 'nitro-boost/1.1.9/linux.zip'
                }
              ]
            }
          ]
        }
      ]
    }
  });

  assert.deepEqual(
    resolved.map((entry) => [entry.dlcName, entry.dlcVersion, entry.steamAppId]),
    [
      ['turbo-engine', '0.1.0-beta.10', '102'],
      ['nitro-boost', '1.2.0', '201']
    ]
  );
});

test('selectSteamArtifactsForPublication chooses linux-x64 and prefers osx-universal when it exists', () => {
  const selected = selectSteamArtifactsForPublication([
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-linux-x64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/linux.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-win-x64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/windows.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-x64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/osx-x64.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-arm64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/osx-arm64.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-universal-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/osx-universal.zip'
    }
  ]);

  assert.deepEqual(selected.preparedPlatforms, ['linux-x64', 'win-x64', 'osx-universal']);
  assert.deepEqual(
    selected.selectedArtifacts.macos.map((artifact) => artifact.platform),
    ['osx-universal']
  );
});

test('selectSteamArtifactsForPublication falls back to osx-x64 and osx-arm64 when osx-universal is absent', () => {
  const selected = selectSteamArtifactsForPublication([
    {
      name: 'hagicode-dlc-nitro-boost-0.2.0-beta.7-linux-x64-nort.zip',
      path: 'nitro-boost/0.2.0-beta.7/linux.zip'
    },
    {
      name: 'hagicode-dlc-nitro-boost-0.2.0-beta.7-win-x64-nort.zip',
      path: 'nitro-boost/0.2.0-beta.7/windows.zip'
    },
    {
      name: 'hagicode-dlc-nitro-boost-0.2.0-beta.7-osx-x64-nort.zip',
      path: 'nitro-boost/0.2.0-beta.7/osx-x64.zip'
    },
    {
      name: 'hagicode-dlc-nitro-boost-0.2.0-beta.7-osx-arm64-nort.zip',
      path: 'nitro-boost/0.2.0-beta.7/osx-arm64.zip'
    }
  ]);

  assert.deepEqual(selected.preparedPlatforms, ['linux-x64', 'win-x64', 'osx-x64', 'osx-arm64']);
  assert.deepEqual(
    selected.selectedArtifacts.macos.map((artifact) => artifact.platform),
    ['osx-x64', 'osx-arm64']
  );
});

test('selectSteamArtifactsForPublication ignores additional linux-arm64 artifacts when linux-x64 is present', () => {
  const selected = selectSteamArtifactsForPublication([
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-linux-arm64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/linux-arm64.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-linux-x64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/linux-x64.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-win-x64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/windows.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-x64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/osx-x64.zip'
    },
    {
      name: 'hagicode-dlc-turbo-engine-0.1.0-beta.50-osx-arm64-nort.zip',
      path: 'turbo-engine/0.1.0-beta.50/osx-arm64.zip'
    }
  ]);

  assert.equal(selected.selectedArtifacts.linux.length, 1);
  assert.equal(selected.selectedArtifacts.linux[0].platform, 'linux-x64');
  assert.deepEqual(selected.preparedPlatforms, ['linux-x64', 'win-x64', 'osx-x64', 'osx-arm64']);
});
