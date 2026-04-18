import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPortableVersionRootIndexUrl,
  buildSignedBlobUrl,
  fetchPortableVersionRootIndex,
  normalizePortableVersionVersionEntry,
  resolveAssetDownloadUrl,
  resolvePortableVersionIndexEntryByReleaseTag,
  sanitizeUrlForLogs,
  upsertPortableVersionRootIndexEntry,
  validatePortableVersionRootIndexDocument
} from '../scripts/lib/azure-blob.mjs';

const sasUrl = 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token';

function createVersionEntry(overrides = {}) {
  return {
    version: 'v0.1.0-beta.33',
    metadata: {
      buildManifestPath: 'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json',
      artifactInventoryPath: 'v0.1.0-beta.33/v0.1.0-beta.33.artifact-inventory.json',
      checksumsPath: 'v0.1.0-beta.33/v0.1.0-beta.33.checksums.txt'
    },
    steamDepotIds: {
      linux: '123',
      windows: '456',
      macos: '789'
    },
    artifacts: [
      {
        platform: 'linux-x64',
        name: 'hagicode-portable-linux-x64.zip',
        path: 'v0.1.0-beta.33/hagicode-portable-linux-x64.zip'
      }
    ],
    ...overrides
  };
}

test('buildSignedBlobUrl joins asset path onto the SAS container URL', () => {
  const signedUrl = buildSignedBlobUrl(
    sasUrl,
    'v0.1.34/Hagicode.Desktop.0.1.34-unpacked.zip'
  );

  assert.equal(
    signedUrl,
    'https://example.blob.core.windows.net/hagicode-steam/v0.1.34/Hagicode.Desktop.0.1.34-unpacked.zip?sp=racwl&sig=test-token'
  );
});

test('buildPortableVersionRootIndexUrl points at the container root index.json', () => {
  assert.equal(
    buildPortableVersionRootIndexUrl(sasUrl),
    'https://example.blob.core.windows.net/hagicode-steam/index.json?sp=racwl&sig=test-token'
  );
});

test('resolveAssetDownloadUrl fails when the selected asset has no index path', () => {
  assert.throws(
    () =>
      resolveAssetDownloadUrl({
        asset: { name: 'hagicode-0.1.0-beta.35-linux-x64-nort.zip' },
        sasUrl
      }),
    /missing index path metadata/
  );
});

test('sanitizeUrlForLogs redacts the SAS query string', () => {
  assert.equal(
    sanitizeUrlForLogs('https://example.blob.core.windows.net/releases/v0.1.34/file.zip?sp=rl&sig=test-token'),
    'https://example.blob.core.windows.net/releases/v0.1.34/file.zip?<sas-token-redacted>'
  );
});

test('normalizePortableVersionVersionEntry derives stable metadata and artifact paths', () => {
  const entry = normalizePortableVersionVersionEntry({
    releaseTag: 'v0.1.0-beta.33',
    metadata: {
      buildManifestPath: 'v0.1.0-beta.33.build-manifest.json',
      artifactInventoryPath: 'v0.1.0-beta.33.artifact-inventory.json',
      checksumsPath: 'v0.1.0-beta.33.checksums.txt'
    },
    steamDepotIds: {
      linux: '123',
      windows: '456',
      macos: '789'
    },
    artifacts: [
      {
        platform: 'linux-x64',
        fileName: 'hagicode-portable-linux-x64.zip'
      }
    ]
  });

  assert.equal(entry.metadata.buildManifestPath, 'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json');
  assert.equal(entry.artifacts[0].path, 'v0.1.0-beta.33/hagicode-portable-linux-x64.zip');
});

test('upsertPortableVersionRootIndexEntry replaces the matching releaseTag entry instead of duplicating it', () => {
  const document = {
    schemaVersion: 1,
    generatedAt: '2026-04-18T00:00:00.000Z',
    versions: [
      createVersionEntry({
        metadata: {
          buildManifestPath: 'v0.1.0-beta.33/old.build-manifest.json',
          artifactInventoryPath: 'v0.1.0-beta.33/old.artifact-inventory.json',
          checksumsPath: 'v0.1.0-beta.33/old.checksums.txt'
        }
      })
    ]
  };

  const updated = upsertPortableVersionRootIndexEntry(document, createVersionEntry(), {
    generatedAt: '2026-04-18T01:00:00.000Z'
  });

  assert.equal(updated.versions.length, 1);
  assert.equal(updated.versions[0].metadata.buildManifestPath, 'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json');
});

test('validatePortableVersionRootIndexDocument rejects missing depot mappings', () => {
  assert.throws(
    () =>
      validatePortableVersionRootIndexDocument({
        schemaVersion: 1,
        generatedAt: '2026-04-18T00:00:00.000Z',
        versions: [
          createVersionEntry({
            steamDepotIds: {
              linux: '123',
              macos: '789'
            }
          })
        ]
      }),
    /steamDepotIds\.windows/
  );
});

test('validatePortableVersionRootIndexDocument rejects missing metadata paths', () => {
  assert.throws(
    () =>
      validatePortableVersionRootIndexDocument({
        schemaVersion: 1,
        generatedAt: '2026-04-18T00:00:00.000Z',
        versions: [
          createVersionEntry({
            metadata: {
              buildManifestPath: 'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json',
              checksumsPath: 'v0.1.0-beta.33/v0.1.0-beta.33.checksums.txt'
            }
          })
        ]
      }),
    /metadata\.artifactInventoryPath/
  );
});

test('fetchPortableVersionRootIndex returns an empty document on 404', async () => {
  const result = await fetchPortableVersionRootIndex({
    sasUrl,
    fetchImpl: async () => new Response('not found', { status: 404 })
  });

  assert.equal(result.exists, false);
  assert.deepEqual(result.document.versions, []);
});

test('resolvePortableVersionIndexEntryByReleaseTag reports the sanitized index url for unknown releases', () => {
  assert.throws(
    () =>
      resolvePortableVersionIndexEntryByReleaseTag({
        document: {
          schemaVersion: 1,
          generatedAt: '2026-04-18T00:00:00.000Z',
          versions: [createVersionEntry()]
        },
        releaseTag: 'v0.1.0-beta.40',
        sanitizedIndexUrl: 'https://example.blob.core.windows.net/hagicode-steam/index.json?<sas-token-redacted>'
      }),
    /does not contain version "v0.1.0-beta.40"/
  );
});
