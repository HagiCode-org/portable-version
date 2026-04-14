import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import {
  createActivationArtifacts,
  createToolchainShimArtifacts,
  readPortableToolchainConfig,
  resolvePortableToolchainPlatform
} from '../scripts/lib/toolchain.mjs';
import { createMockPortableToolchainConfig } from './helpers/portable-toolchain-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test('default toolchain manifest pins supported platforms', async () => {
  const config = await readPortableToolchainConfig();
  assert.equal(config.openspec.packageName, '@fission-ai/openspec');
  assert.equal(config.openspec.version, '1.2.0');
  assert.ok(resolvePortableToolchainPlatform(config, 'linux-x64'));
  assert.ok(resolvePortableToolchainPlatform(config, 'win-x64'));
  assert.ok(resolvePortableToolchainPlatform(config, 'osx-x64'));
  assert.ok(resolvePortableToolchainPlatform(config, 'osx-arm64'));
  assert.ok(resolvePortableToolchainPlatform(config, 'osx-universal'));
});

test('toolchain shims cover unix and windows entrypoints', () => {
  const unixShims = createToolchainShimArtifacts({
    platformId: 'linux-x64',
    cliScriptRelativePath: 'npm-global/lib/node_modules/@fission-ai/openspec/bin/openspec.js',
    commandName: 'openspec'
  });
  const windowsShims = createToolchainShimArtifacts({
    platformId: 'win-x64',
    cliScriptRelativePath: 'npm-global/node_modules/@fission-ai/openspec/bin/openspec.js',
    commandName: 'opsx'
  });

  assert.deepEqual(
    unixShims.map((entry) => entry.fileName),
    ['openspec']
  );
  assert.match(unixShims[0].content, /exec "\$NODE_EXEC" "\$CLI_ENTRY" "\$@"/);
  assert.deepEqual(
    windowsShims.map((entry) => entry.fileName),
    ['opsx.cmd', 'opsx.ps1']
  );
  assert.match(windowsShims[0].content, /"%NODE_EXEC%" "%CLI_ENTRY%" %\*/);
  assert.match(windowsShims[1].content, /& \$nodeExec \$cliEntry @args/);

  const unixActivation = createActivationArtifacts('linux-x64');
  const windowsActivation = createActivationArtifacts('win-x64');
  assert.deepEqual(unixActivation.map((entry) => entry.fileName), ['activate.sh']);
  assert.deepEqual(
    windowsActivation.map((entry) => entry.fileName),
    ['activate.cmd', 'activate.ps1']
  );
});

test('verify-portable-toolchain reports version drift failures', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-toolchain-verify-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await writeJson(planPath, {
    upstream: {
      desktop: {
        tag: 'v0.2.0',
        assetsByPlatform: {
          'linux-x64': {
            name: 'fixture.zip',
            downloadUrl: 'file:///tmp/fixture.zip'
          }
        }
      }
    },
    build: {
      dryRun: true
    }
  });
  await writeJson(path.join(workspacePath, 'workspace-manifest.json'), {
    platform: 'linux-x64',
    portableFixedRoot: path.join(workspacePath, 'portable-fixed'),
    downloadDirectory: path.join(workspacePath, 'downloads'),
    extractDirectory: path.join(workspacePath, 'extracted'),
    outputDirectory: path.join(workspacePath, 'release-assets'),
    toolchainRoot: path.join(workspacePath, 'portable-fixed', 'toolchain'),
    toolchainBinRoot: path.join(workspacePath, 'portable-fixed', 'toolchain', 'bin'),
    toolchainManifestPath: path.join(workspacePath, 'portable-fixed', 'toolchain', 'toolchain-manifest.json')
  });

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-portable-toolchain.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--toolchain-config',
    toolchainFixture.configPath
  ]);

  const manifestPath = path.join(
    workspacePath,
    'portable-fixed',
    'toolchain',
    'toolchain-manifest.json'
  );
  const manifest = await readJson(manifestPath);
  manifest.openspec.version = '0.0.0-broken';
  await writeJson(manifestPath, manifest);

  await assert.rejects(() =>
    runCommand('node', [
      path.join(repoRoot, 'scripts', 'verify-portable-toolchain.mjs'),
      '--platform',
      'linux-x64',
      '--workspace',
      workspacePath,
      '--toolchain-config',
      toolchainFixture.configPath
    ])
  );

  const report = await readJson(path.join(workspacePath, 'toolchain-validation-linux-x64.json'));
  assert.equal(report.validationPassed, false);
  assert.match(report.failureSummary, /OpenSpec version drifted/);
});
