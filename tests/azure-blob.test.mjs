import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedBlobUrl,
  resolveAssetDownloadUrl,
  sanitizeUrlForLogs
} from '../scripts/lib/azure-blob.mjs';

test('buildSignedBlobUrl joins asset path onto the SAS container URL', () => {
  const signedUrl = buildSignedBlobUrl(
    'https://example.blob.core.windows.net/releases?sp=rl&sig=test-token',
    'v0.1.34/Hagicode.Desktop.0.1.34-unpacked.zip'
  );

  assert.equal(
    signedUrl,
    'https://example.blob.core.windows.net/releases/v0.1.34/Hagicode.Desktop.0.1.34-unpacked.zip?sp=rl&sig=test-token'
  );
});

test('resolveAssetDownloadUrl fails when the selected asset has no index path', () => {
  assert.throws(
    () =>
      resolveAssetDownloadUrl({
        asset: { name: 'hagicode-0.1.0-beta.35-linux-x64-nort.zip' },
        sasUrl: 'https://example.blob.core.windows.net/releases?sp=rl&sig=test-token'
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
