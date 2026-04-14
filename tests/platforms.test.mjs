import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicAssetName,
  createPlatformMatrix,
  expandRequestedPlatformsForAssets,
  getPlatformConfig,
  normalizePlatforms
} from '../scripts/lib/platforms.mjs';
import {
  getNodeExecutableRelativePath,
  getNpmExecutableRelativePath
} from '../scripts/lib/toolchain.mjs';

test('normalizePlatforms supports all shortcut and rejects unsupported values', () => {
  assert.deepEqual(normalizePlatforms('all'), ['linux-x64', 'win-x64', 'osx-universal']);
  assert.throws(() => normalizePlatforms('linux-x64,plan9'), /Unsupported platform override/);
});

test('createPlatformMatrix returns runner metadata', () => {
  const matrix = createPlatformMatrix(['linux-x64', 'win-x64']);
  assert.deepEqual(matrix, {
    include: [
      {
        platform: 'linux-x64',
        runner: 'ubuntu-latest',
        runtimeKey: 'linux-x64-nort'
      },
      {
        platform: 'win-x64',
        runner: 'windows-latest',
        runtimeKey: 'win-x64-nort'
      }
    ]
  });
});

test('buildDeterministicAssetName produces stable publish-friendly names', () => {
  assert.equal(
    buildDeterministicAssetName('v0.1.0-beta.33-v0.1.31', 'linux-x64', 'HagiCode Desktop 0.1.0.AppImage'),
    'hagicode-portable-linux-x64.zip'
  );
  assert.equal(
    buildDeterministicAssetName('v0.1.0-beta.33-v0.1.31', 'osx-universal', 'HagiCode Desktop 0.1.0-mac.zip'),
    'hagicode-portable-osx-universal.zip'
  );
});

test('expandRequestedPlatformsForAssets resolves universal macOS inputs to explicit source assets', () => {
  assert.deepEqual(expandRequestedPlatformsForAssets(['osx-universal'], 'desktop'), ['osx-x64']);
  assert.deepEqual(expandRequestedPlatformsForAssets(['osx-universal'], 'service'), ['osx-x64', 'osx-arm64']);
});

test('platform metadata exposes portable toolchain layout', () => {
  assert.equal(getPlatformConfig('linux-x64').toolchain.primaryShimExtension, '');
  assert.equal(getPlatformConfig('win-x64').toolchain.primaryShimExtension, '.cmd');
  assert.deepEqual(getPlatformConfig('osx-universal').bundle.memberPlatforms, ['osx-x64', 'osx-arm64']);
  assert.equal(getNodeExecutableRelativePath('linux-x64'), 'node/bin/node');
  assert.equal(getNpmExecutableRelativePath('linux-x64'), 'node/bin/npm');
  assert.equal(getNodeExecutableRelativePath('win-x64'), 'node/node.exe');
  assert.equal(getNpmExecutableRelativePath('win-x64'), 'node/npm.cmd');
});
