import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapDesktopAssetsByPlatform,
  mapServiceAssetsByPlatform,
  normalizeTriggerInputs
} from '../scripts/lib/build-plan.mjs';
import { derivePortableReleaseTag } from '../scripts/lib/platforms.mjs';

const defaultPlatforms = ['linux-x64'];

test('normalizeTriggerInputs uses workflow_dispatch overrides and booleans', () => {
  const normalized = normalizeTriggerInputs({
    eventName: 'workflow_dispatch',
    eventPayload: {
      inputs: {
        desktop_tag: 'v0.2.0',
        service_tag: 'v0.1.0-beta.33',
        platforms: 'linux-x64,win-x64',
        force_rebuild: 'true',
        dry_run: '1'
      }
    },
    defaultPlatforms
  });

  assert.equal(normalized.desktopTag, 'v0.2.0');
  assert.equal(normalized.serviceTag, 'v0.1.0-beta.33');
  assert.deepEqual(normalized.selectedPlatforms, ['linux-x64', 'win-x64']);
  assert.equal(normalized.forceRebuild, true);
  assert.equal(normalized.dryRun, true);
});

test('normalizeTriggerInputs requires repository_dispatch versions', () => {
  assert.throws(
    () =>
      normalizeTriggerInputs({
        eventName: 'repository_dispatch',
        eventPayload: { client_payload: { platforms: 'linux-x64' } },
        defaultPlatforms
      }),
    /must include both desktopTag and serviceTag/
  );
});

test('mapServiceAssetsByPlatform matches framework-dependent runtime assets', () => {
  const mapped = mapServiceAssetsByPlatform(
    {
      assets: [
        { id: 1, name: 'hagicode-0.1.0-beta.33-linux-x64-nort.zip', browser_download_url: 'https://example.test/linux.zip' },
        { id: 2, name: 'hagicode-0.1.0-beta.33-win-x64-nort.zip', browser_download_url: 'https://example.test/win.zip' }
      ]
    },
    ['linux-x64', 'win-x64']
  );

  assert.equal(mapped['linux-x64'].name, 'hagicode-0.1.0-beta.33-linux-x64-nort.zip');
  assert.equal(mapped['win-x64'].name, 'hagicode-0.1.0-beta.33-win-x64-nort.zip');
});

test('mapDesktopAssetsByPlatform matches published Desktop archives', () => {
  const mapped = mapDesktopAssetsByPlatform(
    {
      assets: [
        { id: 1, name: 'hagicode-desktop-0.1.32.zip', browser_download_url: 'https://example.test/linux.zip' },
        { id: 2, name: 'Hagicode.Desktop.0.1.32-unpacked.zip', browser_download_url: 'https://example.test/win.zip' }
      ]
    },
    ['linux-x64', 'win-x64']
  );

  assert.equal(mapped['linux-x64'].name, 'hagicode-desktop-0.1.32.zip');
  assert.equal(mapped['win-x64'].name, 'Hagicode.Desktop.0.1.32-unpacked.zip');
});

test('derivePortableReleaseTag creates an independent Portable Version tag namespace', () => {
  assert.equal(
    derivePortableReleaseTag('v0.1.31', 'v0.1.0-beta.33'),
    'pv-release-380d772cc976'
  );
});
