import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { generateSteamGuardCode } from '../scripts/publish-steam.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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
      tag: 'pv-release-d680cc63b74a'
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

test('generateSteamGuardCode returns the expected length', () => {
  const code = generateSteamGuardCode('aGVsbG8gd29ybGQ=');
  assert.equal(code.length, 5);
  assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
});
