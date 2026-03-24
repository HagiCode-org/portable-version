import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicAssetName,
  createPlatformMatrix,
  getPlatformConfig,
  normalizePlatforms
} from '../scripts/lib/platforms.mjs';
import {
  getNodeExecutableRelativePath,
  getNpmExecutableRelativePath
} from '../scripts/lib/toolchain.mjs';

test('normalizePlatforms supports all shortcut and rejects unsupported values', () => {
  assert.deepEqual(normalizePlatforms('all'), ['linux-x64', 'win-x64', 'osx-x64', 'osx-arm64']);
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
    buildDeterministicAssetName('pv-release-380d772cc976', 'linux-x64', 'HagiCode Desktop 0.1.0.AppImage'),
    'hagicode-portable-linux-x64.zip'
  );
});

test('platform metadata exposes portable toolchain layout', () => {
  assert.equal(getPlatformConfig('linux-x64').toolchain.primaryShimExtension, '');
  assert.equal(getPlatformConfig('win-x64').toolchain.primaryShimExtension, '.cmd');
  assert.equal(getNodeExecutableRelativePath('linux-x64'), 'node/bin/node');
  assert.equal(getNpmExecutableRelativePath('linux-x64'), 'node/bin/npm');
  assert.equal(getNodeExecutableRelativePath('win-x64'), 'node/node.exe');
  assert.equal(getNpmExecutableRelativePath('win-x64'), 'node/npm.cmd');
});
