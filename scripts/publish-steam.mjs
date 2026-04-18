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
const PLATFORM_OPTIONS = [
  { id: 'linux-x64', metadataKey: 'linux', cliOption: 'linux-depot-id', contentPlatforms: ['linux-x64'] },
  { id: 'win-x64', metadataKey: 'windows', cliOption: 'windows-depot-id', contentPlatforms: ['win-x64'] },
  {
    id: 'macos',
    metadataKey: 'macos',
    cliOption: 'macos-depot-id',
    contentPlatforms: [UNIFIED_MACOS_CONTENT_PLATFORM, 'osx-x64', 'osx-arm64']
  }
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

function getSteamcmdRoot(steamcmdPath) {
  return path.dirname(path.resolve(steamcmdPath));
}

function getSteamcmdConfigPath(steamcmdPath) {
  return path.join(getSteamcmdRoot(steamcmdPath), 'config', 'config.vdf');
}

function buildSteamLoginArgs({ steamUsername, steamPassword, steamGuardCode, useSavedLogin }) {
  if (!steamUsername) {
    throw new Error('Steam publication requires STEAM_USERNAME.');
  }

  const loginArgs = ['+login', steamUsername];
  if (useSavedLogin) {
    return loginArgs;
  }

  if (!steamPassword) {
    throw new Error('Steam publication requires STEAM_PASSWORD when no saved SteamCMD login token exists.');
  }

  loginArgs.push(steamPassword);
  if (steamGuardCode) {
    loginArgs.push(steamGuardCode);
  }

  return loginArgs;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeSteamDepotIds(steamDepotIds, { sourceLabel, requireAllPlatforms }) {
  const normalized = {};

  for (const platform of PLATFORM_OPTIONS) {
    const rawDepotId = steamDepotIds?.[platform.metadataKey];
    if (!rawDepotId) {
      if (requireAllPlatforms) {
        throw new Error(
          `${sourceLabel} is missing steamDepotIds.${platform.metadataKey}; Steam publication cannot continue.`
        );
      }
      continue;
    }

    normalized[platform.metadataKey] = requireNonEmptyString(
      rawDepotId,
      `${sourceLabel}.steamDepotIds.${platform.metadataKey}`
    );
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error(`${sourceLabel} does not contain any Steam depot ids.`);
  }

  return normalized;
}

function resolveCliSteamDepotIds(values) {
  const depotIds = {};
  for (const platform of PLATFORM_OPTIONS) {
    const value = values[platform.cliOption];
    if (value) {
      depotIds[platform.metadataKey] = value;
    }
  }
  return normalizeSteamDepotIds(depotIds, {
    sourceLabel: 'CLI depot arguments',
    requireAllPlatforms: false
  });
}

async function loadReleaseInput(releaseInputPath) {
  const resolvedPath = path.resolve(releaseInputPath);
  const releaseInput = await readJson(resolvedPath);

  return {
    sourcePath: resolvedPath,
    releaseTag: requireNonEmptyString(releaseInput?.releaseTag, 'release-input.releaseTag'),
    planPath: path.resolve(requireNonEmptyString(releaseInput?.buildManifestPath, 'release-input.buildManifestPath')),
    contentRoot: path.resolve(requireNonEmptyString(releaseInput?.contentRoot, 'release-input.contentRoot')),
    steamDepotIds: normalizeSteamDepotIds(releaseInput?.steamDepotIds, {
      sourceLabel: `release-input ${resolvedPath}`,
      requireAllPlatforms: true
    }),
    azureIndex: releaseInput?.azureIndex ?? null
  };
}

async function resolveDepotDefinitions(steamDepotIds, contentRoot) {
  const depotDefinitions = [];

  for (const platform of PLATFORM_OPTIONS) {
    const depotId = steamDepotIds[platform.metadataKey];
    if (!depotId) {
      continue;
    }

    const contentMatches = [];
    for (const candidatePlatform of platform.contentPlatforms) {
      const candidateRoot = path.join(contentRoot, candidatePlatform);
      if (await pathExists(candidateRoot)) {
        contentMatches.push({
          sourcePlatform: candidatePlatform,
          contentRoot: candidateRoot
        });
      }
    }

    if (contentMatches.length === 0) {
      throw new Error(`Steam content for ${platform.id} is missing under ${contentRoot}.`);
    }

    let selectedMatch = contentMatches[0];
    if (platform.id === 'macos' && contentMatches.length > 1) {
      const universalMatch = contentMatches.find(
        (candidate) => candidate.sourcePlatform === UNIFIED_MACOS_CONTENT_PLATFORM
      );
      if (!universalMatch) {
        throw new Error(
          `Steam content for macos is ambiguous under ${contentRoot}; found ${contentMatches
            .map((candidate) => candidate.sourcePlatform)
            .join(', ')} without ${UNIFIED_MACOS_CONTENT_PLATFORM}.`
        );
      }
      selectedMatch = universalMatch;
    }

    depotDefinitions.push({
      depotId,
      platform: platform.id,
      sourcePlatform: selectedMatch.sourcePlatform,
      contentRoot: selectedMatch.contentRoot,
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
      'release-input': { type: 'string' },
      plan: { type: 'string' },
      'content-root': { type: 'string' },
      'output-dir': { type: 'string' },
      'steamcmd-path': { type: 'string' },
      'app-id': { type: 'string' },
      branch: { type: 'string', default: '' },
      description: { type: 'string' },
      'linux-depot-id': { type: 'string' },
      'windows-depot-id': { type: 'string' },
      'macos-depot-id': { type: 'string' },
      preview: { type: 'boolean', default: false },
      'force-dry-run': { type: 'boolean', default: false }
    },
    strict: true
  });

  if (!values['app-id']) {
    throw new Error('publish-steam requires --app-id.');
  }

  const releaseInput = values['release-input']
    ? await loadReleaseInput(values['release-input'])
    : null;
  const planPath = releaseInput?.planPath ?? values.plan;
  const contentRootValue = releaseInput?.contentRoot ?? values['content-root'];

  if (!planPath || !contentRootValue) {
    throw new Error('publish-steam requires either --release-input or both --plan and --content-root.');
  }

  const plan = await readJson(path.resolve(planPath));
  const contentRoot = path.resolve(contentRootValue);
  const outputDir = path.resolve(values['output-dir'] ?? path.join(contentRoot, '..', 'steam-build'));
  const buildOutputDir = path.join(outputDir, 'build-output');
  const scriptsDir = path.join(outputDir, 'scripts');
  const preview = values.preview;
  const dryRun = values['force-dry-run'];

  if (!(await pathExists(contentRoot))) {
    throw new Error(`Steam content root does not exist at ${contentRoot}.`);
  }

  const steamDepotIds = releaseInput?.steamDepotIds ?? resolveCliSteamDepotIds(values);
  const depotDefinitions = await resolveDepotDefinitions(steamDepotIds, contentRoot);
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
    planPath: path.resolve(planPath),
    releaseInputPath: releaseInput?.sourcePath ?? null,
    appId: values['app-id'],
    description,
    preview,
    branch: values.branch.trim() || null,
    dryRun,
    azureRelease: releaseInput
      ? {
          requestedReleaseTag: releaseInput.releaseTag,
          index: releaseInput.azureIndex,
          steamDepotIds
        }
      : null,
    depots: depotDefinitions.map(({ depotId, platform, sourcePlatform, contentRoot: root, vdfPath }) => ({
      depotId,
      platform,
      sourcePlatform,
      contentRoot: root,
      vdfPath
    })),
    contentRoot,
    appBuildPath
  });

  if (dryRun) {
    await appendSummary([
      '## Portable Version Steam publication dry-run',
      `- Release tag: ${plan.release.tag}`,
      `- App ID: ${values['app-id']}`,
      `- Preview mode: ${preview ? 'enabled' : 'disabled'}`,
      ...(releaseInput
        ? [
            `- Azure release tag: ${releaseInput.releaseTag}`,
            `- Azure root index: ${releaseInput.azureIndex?.sanitizedUrl ?? '[missing-azure-index-context]'}`
          ]
        : []),
      `- Depot count: ${depotDefinitions.length}`,
      `- Depot platforms: ${depotDefinitions.map((depot) => depot.platform).join(', ')}`,
      `- Content root: ${contentRoot}`,
      `- App build script: ${appBuildPath}`
    ]);
    console.log(JSON.stringify({ manifestPath, appBuildPath, depotCount: depotDefinitions.length }, null, 2));
    return;
  }

  const steamcmdPath = values['steamcmd-path'] ?? process.env.STEAMCMD_PATH;
  if (!steamcmdPath) {
    throw new Error('Steam publication requires --steamcmd-path or STEAMCMD_PATH.');
  }

  const steamcmdConfigPath = getSteamcmdConfigPath(steamcmdPath);
  const hasSavedSteamLogin = await pathExists(steamcmdConfigPath);
  const steamUsername = process.env.STEAM_USERNAME;
  const steamPassword = process.env.STEAM_PASSWORD;
  if (!steamUsername) {
    throw new Error('Steam publication requires STEAM_USERNAME.');
  }
  if (!hasSavedSteamLogin && !steamPassword) {
    throw new Error('Steam publication requires STEAM_PASSWORD when no saved SteamCMD login token exists.');
  }

  const steamGuardCode = process.env.STEAM_GUARD_CODE ||
    (process.env.STEAM_SHARED_SECRET ? generateSteamGuardCode(process.env.STEAM_SHARED_SECRET) : '');

  if (!hasSavedSteamLogin) {
    await runCommand(steamcmdPath, [
      ...buildSteamLoginArgs({
        steamUsername,
        steamPassword,
        steamGuardCode,
        useSavedLogin: false
      }),
      '+info',
      '+quit'
    ]);
  }

  await runCommand(steamcmdPath, [
    ...buildSteamLoginArgs({
      steamUsername,
      steamPassword,
      steamGuardCode,
      useSavedLogin: true
    }),
    '+run_app_build',
    appBuildPath,
    '+quit'
  ]);

  await appendSummary([
    '## Portable Version Steam publication complete',
    `- Release tag: ${plan.release.tag}`,
    `- App ID: ${values['app-id']}`,
    `- Preview mode: ${preview ? 'enabled' : 'disabled'}`,
    ...(releaseInput
      ? [
          `- Azure release tag: ${releaseInput.releaseTag}`,
          `- Azure root index: ${releaseInput.azureIndex?.sanitizedUrl ?? '[missing-azure-index-context]'}`
        ]
      : []),
    `- Depot count: ${depotDefinitions.length}`,
    `- Depot platforms: ${depotDefinitions.map((depot) => depot.platform).join(', ')}`,
    `- Steam login mode: ${hasSavedSteamLogin ? 'reused saved SteamCMD token' : 'bootstrapped and saved new SteamCMD token'}`,
    `- SteamCMD config: ${steamcmdConfigPath}`,
    `- Content root: ${contentRoot}`,
    `- App build script: ${appBuildPath}`
  ]);

  console.log(JSON.stringify({ manifestPath, appBuildPath, depotCount: depotDefinitions.length }, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Portable Version Steam publication failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  buildAppVdf,
  buildDepotVdf,
  buildDefaultDescription,
  buildSteamLoginArgs,
  generateSteamGuardCode,
  getSteamcmdConfigPath
};
