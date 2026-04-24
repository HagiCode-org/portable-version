import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { validateDesktopToolchainContract } from '../scripts/lib/desktop-toolchain-contract.mjs';

async function createToolchainFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-toolchain-contract-'));
  const toolchainRoot = path.join(root, 'resources', 'extra', 'portable-fixed', 'toolchain');
  await mkdir(path.join(toolchainRoot, 'node', 'bin'), { recursive: true });
  await mkdir(path.join(toolchainRoot, 'bin'), { recursive: true });
  await writeFile(path.join(toolchainRoot, 'node', 'bin', 'node'), 'node');
  await writeFile(path.join(toolchainRoot, 'node', 'bin', 'npm'), 'npm');
  await writeFile(path.join(toolchainRoot, 'bin', 'openspec'), 'openspec');
  await writeFile(path.join(toolchainRoot, 'bin', 'skills'), 'skills');
  await writeFile(path.join(toolchainRoot, 'bin', 'omniroute'), 'omniroute');
  return { root, toolchainRoot };
}

describe('desktop toolchain contract validation', () => {
  it('accepts a Desktop-authored bundled toolchain manifest', async () => {
    const { root, toolchainRoot } = await createToolchainFixture();
    await writeFile(path.join(toolchainRoot, 'toolchain-manifest.json'), `${JSON.stringify({
      owner: 'hagicode-desktop',
      source: 'bundled-desktop',
      platform: 'linux-x64',
      node: { version: '22.22.2' },
      commands: {
        node: 'node/bin/node',
        npm: 'node/bin/npm',
        openspec: 'bin/openspec',
        skills: 'bin/skills',
        omniroute: 'bin/omniroute'
      },
      packages: {
        openspec: { packageName: '@fission-ai/openspec', version: '1.3.1' },
        skills: { packageName: 'skills', version: '1.5.1' },
        omniroute: { packageName: 'omniroute', version: '3.6.9' }
      }
    })}\n`);

    const result = await validateDesktopToolchainContract({ platformContentRoot: root, platformId: 'linux-x64' });
    assert.equal(result.valid, true);
    assert.equal(result.owner, 'hagicode-desktop');
    assert.equal(result.packageVersions.omniroute, '3.6.9');
  });

  it('fails fast and flags legacy incomplete payloads without a Desktop manifest', async () => {
    const { root, toolchainRoot } = await createToolchainFixture();
    await writeFile(path.join(toolchainRoot, 'bin', 'opsx'), 'opsx');

    const result = await validateDesktopToolchainContract({ platformContentRoot: root, platformId: 'linux-x64' });
    assert.equal(result.valid, false);
    assert.equal(result.legacy, true);
    assert.match(result.errors.join('\n'), /toolchain-manifest\.json/);
    assert.match(result.errors.join('\n'), /Legacy toolchain entries detected/);
  });
});
