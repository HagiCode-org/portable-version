#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCommand } from './lib/command.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

const STEAM_GUARD_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const UNIFIED_MACOS_CONTENT_PLATFORM = 'osx-universal';
const MACOS_PLATFORM_IDS = new Set(['osx-x64', 'osx-arm64']);
const PLATFORM_OPTIONS = [
  { id: 'linux-x64', cliOption: 'linux-depot-id' },
  { id: 'win-x64', cliOption: 'windows-depot-id' },
  { id: 'osx-x64', cliOption: 'macos-x64-depot-id' },
  { id: 'osx-arm64', cliOption: 'macos-arm64-depot-id' }
];

function escapeVdf(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function buildDefaultDescription(plan, depots, branch) {
  const branchLabel = branch ? ` branch ${branch}` : ' default branch';
  return [
    `Portable Version ${plan.release.tag}`,
    `Desktop ${plan.upstream.desktop.version}`,
    `Service ${plan.upstream.service.version}`,
    `Platforms ${depots.map((depot) => depot.platform).join(', ')}`,
    `Target${branchLabel}`
  ].join(' | ');
}

function decodeSharedSecret(sharedSecret) {
  return Buffer.from(sharedSecret, 'base64');
}

function generateSteamGuardCode(sharedSecret, timestamp = Date.now()) {
  const secret = decodeSharedSecret(sharedSecret);
  const time = Math.floor(timestamp / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
  timeBuffer.writeUInt32BE(time >>> 0, 4);

  const hash = crypto.createHmac('sha1', secret).update(timeBuffer).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  let codePoint = hash.readUInt32BE(offset) & 0x7fffffff;
  let code = '';
  for (let index = 0; index < 5; index += 1) {
    code += STEAM_GUARD_ALPHABET[codePoint % STEAM_GUARD_ALPHABET.length];
    codePoint = Math.floor(codePoint / STEAM_GUARD_ALPHABET.length);
  }
  return code;
}

function buildDepotVdf(depotId, contentRoot) {
  return [
    '"DepotBuildConfig"',
    '{',
    `  "DepotID" "${escapeVdf(depotId)}"`,
    `  "ContentRoot" "${escapeVdf(contentRoot)}"`,
    '  "FileMapping"',
    '  {',
    '    "LocalPath" "*"',
    '    "DepotPath" "."',
    '    "recursive" "1"',
    '  }',
    '}'
  ].join('\n');
}

function buildAppVdf({ appId, description, buildOutput, depotDefinitions, preview, branch }) {
  const lines = [
    '"appbuild"',
    '{',
    `  "appid" "${escapeVdf(appId)}"`,
    `  "desc" "${escapeVdf(description)}"`,
    `  "buildoutput" "${escapeVdf(buildOutput)}"`,
    '  "contentroot" "."',
    `  "preview" "${preview ? '1' : '0'}"`
  ];

  if (branch) {
    lines.push(`  "setlive" "${escapeVdf(branch)}"`);
  }

  lines.push('  "depots"');
  lines.push('  {');
  for (const depot of depotDefinitions) {
    lines.push(`    "${escapeVdf(depot.depotId)}" "${escapeVdf(depot.vdfPath)}"`);
  }
  lines.push('  }');
  lines.push('}');
  return lines.join('\n');
}

async function resolveDepotDefinitions(options, contentRoot) {
  const depotDefinitions = [];

  for (const platform of PLATFORM_OPTIONS) {
    const depotId = options[platform.cliOption];
    if (!depotId) {
      continue;
    }

    let platformContentRoot = path.join(contentRoot, platform.id);
    let sourcePlatform = platform.id;
    if (!(await pathExists(platformContentRoot)) && MACOS_PLATFORM_IDS.has(platform.id)) {
      const universalRoot = path.join(contentRoot, UNIFIED_MACOS_CONTENT_PLATFORM);
      if (await pathExists(universalRoot)) {
        platformContentRoot = universalRoot;
        sourcePlatform = UNIFIED_MACOS_CONTENT_PLATFORM;
      }
    }
    if (!(await pathExists(platformContentRoot))) {
      throw new Error(`Steam content for ${platform.id} is missing at ${platformContentRoot}.`);
    }

    depotDefinitions.push({
      depotId,
      platform: platform.id,
      sourcePlatform,
      contentRoot: platformContentRoot,
      fileName: `depot-build-${platform.id}.vdf`
    });
  }

  if (depotDefinitions.length === 0) {
    throw new Error('At least one Steam depot id must be configured.');
  }

  return depotDefinitions;
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'content-root': { type: 'string' },
      'output-dir': { type: 'string' },
      'steamcmd-path': { type: 'string' },
      'app-id': { type: 'string' },
      branch: { type: 'string', default: '' },
      description: { type: 'string' },
      'linux-depot-id': { type: 'string' },
      'windows-depot-id': { type: 'string' },
      'macos-x64-depot-id': { type: 'string' },
      'macos-arm64-depot-id': { type: 'string' },
      preview: { type: 'boolean', default: false },
      'force-dry-run': { type: 'boolean', default: false }
    },
    strict: true
  });

  if (!values.plan || !values['content-root'] || !values['app-id']) {
    throw new Error('publish-steam requires --plan, --content-root, and --app-id.');
  }

  const plan = await readJson(path.resolve(values.plan));
  const contentRoot = path.resolve(values['content-root']);
  const outputDir = path.resolve(values['output-dir'] ?? path.join(contentRoot, '..', 'steam-build'));
  const buildOutputDir = path.join(outputDir, 'build-output');
  const scriptsDir = path.join(outputDir, 'scripts');
  const preview = values.preview;
  const dryRun = values['force-dry-run'];

  if (!(await pathExists(contentRoot))) {
    throw new Error(`Steam content root does not exist at ${contentRoot}.`);
  }

  const depotDefinitions = await resolveDepotDefinitions(values, contentRoot);
  const description =
    values.description?.trim() || buildDefaultDescription(plan, depotDefinitions, values.branch);

  await ensureDir(buildOutputDir);
  await ensureDir(scriptsDir);

  for (const depot of depotDefinitions) {
    depot.vdfPath = path.join(scriptsDir, depot.fileName);
    await writeFile(depot.vdfPath, `${buildDepotVdf(depot.depotId, depot.contentRoot)}\n`, 'utf8');
  }

  const appBuildPath = path.join(scriptsDir, 'app-build.vdf');
  await writeFile(
    appBuildPath,
    `${buildAppVdf({
      appId: values['app-id'],
      description,
      buildOutput: buildOutputDir,
      depotDefinitions,
      preview,
      branch: values.branch.trim()
    })}\n`,
    'utf8'
  );

  const manifestPath = path.join(outputDir, 'steam-build-manifest.json');
  await writeJson(manifestPath, {
    releaseTag: plan.release.tag,
    appId: values['app-id'],
    description,
    preview,
    branch: values.branch.trim() || null,
    dryRun,
    depots: depotDefinitions.map(({ depotId, platform, sourcePlatform, contentRoot: root, vdfPath }) => ({
      depotId,
      platform,
      sourcePlatform,
      contentRoot: root,
      vdfPath
    })),
    appBuildPath
  });

  if (dryRun) {
    await appendSummary([
      '## Steam publication dry-run',
      `- App ID: ${values['app-id']}`,
      `- Preview mode: ${preview ? 'enabled' : 'disabled'}`,
      `- Depot count: ${depotDefinitions.length}`,
      `- App build script: ${appBuildPath}`
    ]);
    console.log(JSON.stringify({ manifestPath, appBuildPath, depotCount: depotDefinitions.length }, null, 2));
    return;
  }

  const steamcmdPath = values['steamcmd-path'] ?? process.env.STEAMCMD_PATH;
  if (!steamcmdPath) {
    throw new Error('Steam publication requires --steamcmd-path or STEAMCMD_PATH.');
  }

  const steamUsername = process.env.STEAM_USERNAME;
  const steamPassword = process.env.STEAM_PASSWORD;
  if (!steamUsername || !steamPassword) {
    throw new Error('Steam publication requires STEAM_USERNAME and STEAM_PASSWORD.');
  }

  const steamGuardCode = process.env.STEAM_GUARD_CODE ||
    (process.env.STEAM_SHARED_SECRET ? generateSteamGuardCode(process.env.STEAM_SHARED_SECRET) : '');

  const loginArgs = ['+login', steamUsername, steamPassword];
  if (steamGuardCode) {
    loginArgs.push(steamGuardCode);
  }

  await runCommand(steamcmdPath, [
    ...loginArgs,
    '+run_app_build',
    appBuildPath,
    '+quit'
  ]);

  await appendSummary([
    '## Steam publication complete',
    `- App ID: ${values['app-id']}`,
    `- Preview mode: ${preview ? 'enabled' : 'disabled'}`,
    `- Depot count: ${depotDefinitions.length}`,
    `- App build script: ${appBuildPath}`
  ]);

  console.log(JSON.stringify({ manifestPath, appBuildPath, depotCount: depotDefinitions.length }, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Steam publication failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}

export { buildAppVdf, buildDepotVdf, buildDefaultDescription, generateSteamGuardCode };
