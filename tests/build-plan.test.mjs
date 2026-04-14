import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, normalizeTriggerInputs } from '../scripts/lib/build-plan.mjs';
import { derivePortableReleaseTag, normalizeReleaseTagComponent } from '../scripts/lib/platforms.mjs';

const defaultPlatforms = ['linux-x64'];
const desktopIndexUrl = 'https://index.example.test/desktop/index.json';
const serviceIndexUrl = 'https://index.example.test/server/index.json';

const desktopIndexManifest = {
  updatedAt: '2026-03-28T08:25:02.3306932Z',
  versions: [
    {
      version: 'v0.1.9',
      assets: [
        { name: 'Hagicode.Desktop-0.1.9.AppImage', path: 'v0.1.9/Hagicode.Desktop-0.1.9.AppImage', size: 11 },
        { name: 'Hagicode.Desktop.0.1.9-unpacked.zip', path: 'v0.1.9/Hagicode.Desktop.0.1.9-unpacked.zip', size: 12 },
        { name: 'Hagicode.Desktop-0.1.9-mac.zip', path: 'v0.1.9/Hagicode.Desktop-0.1.9-mac.zip', size: 13 },
        { name: 'Hagicode.Desktop-0.1.9-arm64-mac.zip', path: 'v0.1.9/Hagicode.Desktop-0.1.9-arm64-mac.zip', size: 14 }
      ]
    },
    {
      version: 'v0.1.34',
      assets: [
        { name: 'Hagicode.Desktop-0.1.34.AppImage', path: 'v0.1.34/Hagicode.Desktop-0.1.34.AppImage', size: 21 },
        { name: 'Hagicode.Desktop.0.1.34-unpacked.zip', path: 'v0.1.34/Hagicode.Desktop.0.1.34-unpacked.zip', size: 22 },
        { name: 'Hagicode.Desktop-0.1.34-mac.zip', path: 'v0.1.34/Hagicode.Desktop-0.1.34-mac.zip', size: 23 },
        { name: 'Hagicode.Desktop-0.1.34-arm64-mac.zip', path: 'v0.1.34/Hagicode.Desktop-0.1.34-arm64-mac.zip', size: 24 }
      ]
    },
    {
      version: 'v0.0.1-dev.3',
      assets: [
        { name: 'Hagicode.Desktop-0.0.1-dev.3.AppImage', path: 'v0.0.1-dev.3/Hagicode.Desktop-0.0.1-dev.3.AppImage', size: 31 },
        { name: 'Hagicode.Desktop.0.0.1-dev.3-unpacked.zip', path: 'v0.0.1-dev.3/Hagicode.Desktop.0.0.1-dev.3-unpacked.zip', size: 32 },
        { name: 'Hagicode.Desktop-0.0.1-dev.3-mac.zip', path: 'v0.0.1-dev.3/Hagicode.Desktop-0.0.1-dev.3-mac.zip', size: 33 },
        { name: 'Hagicode.Desktop-0.0.1-dev.3-arm64-mac.zip', path: 'v0.0.1-dev.3/Hagicode.Desktop-0.0.1-dev.3-arm64-mac.zip', size: 34 }
      ]
    }
  ]
};

const serviceIndexManifest = {
  updatedAt: '2026-03-28T08:25:02.3306932Z',
  versions: [
    {
      version: '0.1.0-beta.22',
      assets: [
        { name: 'hagicode-0.1.0-beta.22-linux-x64-nort.zip', path: '0.1.0-beta.22/hagicode-0.1.0-beta.22-linux-x64-nort.zip', size: 41 },
        { name: 'hagicode-0.1.0-beta.22-win-x64-nort.zip', path: '0.1.0-beta.22/hagicode-0.1.0-beta.22-win-x64-nort.zip', size: 42 }
      ]
    },
    {
      version: '0.1.0-beta.35',
      assets: [
        { name: 'hagicode-0.1.0-beta.35-linux-x64-nort.zip', path: '0.1.0-beta.35/hagicode-0.1.0-beta.35-linux-x64-nort.zip', size: 51 },
        { name: 'hagicode-0.1.0-beta.35-win-x64-nort.zip', path: '0.1.0-beta.35/hagicode-0.1.0-beta.35-win-x64-nort.zip', size: 52 }
      ]
    },
    {
      version: '0.1.0-beta.33',
      assets: [
        { name: 'hagicode-0.1.0-beta.33-linux-x64-nort.zip', path: '0.1.0-beta.33/hagicode-0.1.0-beta.33-linux-x64-nort.zip', size: 61 },
        { name: 'hagicode-0.1.0-beta.33-win-x64-nort.zip', path: '0.1.0-beta.33/hagicode-0.1.0-beta.33-win-x64-nort.zip', size: 62 }
      ]
    }
  ]
};

function createFetchStub(fixtures) {
  return async (url) => {
    if (!(url in fixtures)) {
      throw new Error(`Unexpected URL ${url}`);
    }

    return {
      ok: true,
      async json() {
        return fixtures[url];
      }
    };
  };
}

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

  assert.equal(normalized.desktopSelector, 'v0.2.0');
  assert.equal(normalized.serviceSelector, 'v0.1.0-beta.33');
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

test('buildPlan resolves latest index versions and platform assets', async () => {
  const plan = await buildPlan({
    eventName: 'schedule',
    eventPayload: {},
    repositories: {
      desktop: desktopIndexUrl,
      service: serviceIndexUrl,
      portable: 'HagiCode-org/portable-version'
    },
    defaultPlatforms: ['linux-x64', 'win-x64'],
    azureSasUrls: {
      desktop: 'https://example.blob.core.windows.net/desktop?sp=rl&sig=desktop-token',
      service: 'https://example.blob.core.windows.net/server?sp=rl&sig=service-token'
    },
    fetchImpl: createFetchStub({
      [desktopIndexUrl]: desktopIndexManifest,
      [serviceIndexUrl]: serviceIndexManifest
    }),
    findPortableRelease: async () => null,
    now: '2026-03-29T00:00:00.000Z'
  });

  assert.equal(plan.upstream.desktop.version, 'v0.1.34');
  assert.equal(plan.upstream.service.version, '0.1.0-beta.35');
  assert.equal(plan.upstream.desktop.assetsByPlatform['linux-x64'].path, 'v0.1.34/Hagicode.Desktop-0.1.34.AppImage');
  assert.equal(plan.upstream.desktop.assetsByPlatform['win-x64'].name, 'Hagicode.Desktop.0.1.34-unpacked.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['linux-x64'].path, '0.1.0-beta.35/hagicode-0.1.0-beta.35-linux-x64-nort.zip');
  assert.equal(plan.downloads.desktop.containerUrl, 'https://example.blob.core.windows.net/desktop/');
  assert.equal(plan.downloads.service.containerUrl, 'https://example.blob.core.windows.net/server/');
  assert.equal(plan.release.tag, 'v0.1.0-beta.35-v0.1.34');
  assert.equal(plan.release.name, 'Portable Version v0.1.0-beta.35-v0.1.34');
  assert.equal(plan.release.notesTitle, 'Portable Version v0.1.0-beta.35-v0.1.34');
  assert.equal(plan.build.shouldBuild, true);
});

test('buildPlan normalizes explicit selectors and reuses existing release state', async () => {
  const existingRelease = {
    html_url: 'https://github.com/HagiCode-org/portable-version/releases/tag/v0.1.0-beta.33-v0.1.34'
  };
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: {
      inputs: {
        desktop_tag: 'refs/tags/v0.1.34',
        service_tag: 'refs/tags/v0.1.0-beta.33',
        platforms: 'linux-x64',
        dry_run: 'true'
      }
    },
    repositories: {
      desktop: desktopIndexUrl,
      service: serviceIndexUrl,
      portable: 'HagiCode-org/portable-version'
    },
    defaultPlatforms,
    fetchImpl: createFetchStub({
      [desktopIndexUrl]: desktopIndexManifest,
      [serviceIndexUrl]: serviceIndexManifest
    }),
    findPortableRelease: async (_repository, tag) => ({ ...existingRelease, tag_name: tag })
  });

  assert.equal(plan.upstream.desktop.selector, 'v0.1.34');
  assert.equal(plan.upstream.desktop.version, 'v0.1.34');
  assert.equal(plan.upstream.service.selector, 'v0.1.0-beta.33');
  assert.equal(plan.upstream.service.version, '0.1.0-beta.33');
  assert.equal(plan.release.tag, derivePortableReleaseTag('0.1.0-beta.33', 'v0.1.34'));
  assert.equal(plan.release.exists, true);
  assert.equal(plan.build.shouldBuild, false);
});

test('derivePortableReleaseTag canonicalizes service and desktop tags before concatenation', () => {
  assert.equal(
    derivePortableReleaseTag('refs/tags/v0.1.0-beta.33', '0.1.31'),
    'v0.1.0-beta.33-v0.1.31'
  );
});

test('normalizeReleaseTagComponent collapses equivalent selector forms into canonical v-prefixed tags', () => {
  assert.equal(normalizeReleaseTagComponent('refs/tags/v0.1.34'), 'v0.1.34');
  assert.equal(normalizeReleaseTagComponent('v0.1.34'), 'v0.1.34');
  assert.equal(normalizeReleaseTagComponent('0.1.34'), 'v0.1.34');
});
