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

function buildDefaultDlcDescription(releaseInput, depots, branch) {
  const branchLabel = branch ? ` branch ${branch}` : ' default branch';
  const dlcLabel = releaseInput.dlcs.map((dlc) => `${dlc.dlcName}@${dlc.dlcVersion}`).join(', ');
  return [
    `Portable Version DLC publication`,
    `DLC count ${releaseInput.dlcs.length}`,
    `DLCs ${dlcLabel}`,
    `Depots ${depots.map((depot) => `${depot.dlcName}:${depot.platform}`).join(', ')}`,
    `Target${branchLabel}`
  ].join(' | ');
}

function buildDefaultDlcAppDescription(releaseInput, depots, branch, appId) {
  const branchLabel = branch ? ` branch ${branch}` : ' default branch';
  const dlcLabel = releaseInput.dlcs
    .filter((dlc) => dlc.steamAppId === appId)
    .map((dlc) => `${dlc.dlcName}@${dlc.dlcVersion}`)
    .join(', ');

  return [
    `Portable Version DLC publication`,
    `Steam App ${appId}`,
    `DLCs ${dlcLabel}`,
    `Depots ${depots.map((depot) => `${depot.dlcName}:${depot.platform}`).join(', ')}`,
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

  if (Array.isArray(releaseInput?.dlcs)) {
    if (releaseInput.dlcs.length === 0) {
      throw new Error(`release-input ${resolvedPath} does not contain any DLC entries.`);
    }

    return {
      mode: 'dlc',
      sourcePath: resolvedPath,
      discoverySource: releaseInput.discoverySource
        ? requireNonEmptyString(releaseInput.discoverySource, `release-input ${resolvedPath}.discoverySource`)
        : '[missing-dlc-discovery-source]',
      dlcIndex: releaseInput.dlcIndex ?? null,
      dlcs: releaseInput.dlcs.map((entry, index) => normalizeDlcReleaseEntry(entry, resolvedPath, index))
    };
  }

  return {
    mode: 'base',
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

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }

  return value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
}

function normalizeDlcSelectedArtifacts(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const platform of PLATFORM_OPTIONS) {
    const records = value[platform.metadataKey];
    if (!records) {
      continue;
    }

    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`${label}.${platform.metadataKey} must be a non-empty array when provided.`);
    }

    normalized[platform.metadataKey] = records.map((record, index) => ({
      platform: requireNonEmptyString(record?.platform, `${label}.${platform.metadataKey}[${index}].platform`),
      name: requireNonEmptyString(
        record?.name ?? record?.fileName,
        `${label}.${platform.metadataKey}[${index}].name`
      ),
      path: requireNonEmptyString(record?.path, `${label}.${platform.metadataKey}[${index}].path`)
    }));
  }

  return normalized;
}

function normalizeDlcReleaseEntry(entry, resolvedPath, index) {
  const label = `release-input ${resolvedPath}.dlcs[${index}]`;
  const contentRoots = entry?.contentRoots;
  if (!contentRoots || typeof contentRoots !== 'object' || Array.isArray(contentRoots)) {
    throw new Error(`${label}.contentRoots must be an object.`);
  }

  return {
    dlcName: requireNonEmptyString(entry?.dlcName, `${label}.dlcName`),
    dlcVersion: requireNonEmptyString(entry?.dlcVersion, `${label}.dlcVersion`),
    steamAppId: requireNonEmptyString(entry?.steamAppId, `${label}.steamAppId`),
    contentRoot: path.resolve(requireNonEmptyString(entry?.contentRoot, `${label}.contentRoot`)),
    contentRoots: {
      linux: path.resolve(requireNonEmptyString(contentRoots.linux, `${label}.contentRoots.linux`)),
      windows: path.resolve(requireNonEmptyString(contentRoots.windows, `${label}.contentRoots.windows`)),
      macos: path.resolve(requireNonEmptyString(contentRoots.macos, `${label}.contentRoots.macos`))
    },
    steamDepotIds: normalizeSteamDepotIds(entry?.steamDepotIds, {
      sourceLabel: label,
      requireAllPlatforms: true
    }),
    preparedPlatforms: normalizeStringArray(entry?.preparedPlatforms, `${label}.preparedPlatforms`),
    selectedArtifacts: normalizeDlcSelectedArtifacts(entry?.selectedArtifacts, `${label}.selectedArtifacts`)
  };
}

async function resolveBaseDepotDefinitions(steamDepotIds, contentRoot) {
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

function deriveDlcSourcePlatform(dlcEntry, metadataKey) {
  const selectedArtifacts = dlcEntry.selectedArtifacts?.[metadataKey];
  if (Array.isArray(selectedArtifacts) && selectedArtifacts.length > 0) {
    return selectedArtifacts.map((artifact) => artifact.platform).join('+');
  }

  return metadataKey;
}

async function resolveDlcDepotDefinitions(dlcEntries) {
  const depotDefinitions = [];

  for (const dlcEntry of dlcEntries) {
    for (const platform of PLATFORM_OPTIONS) {
      const depotId = dlcEntry.steamDepotIds[platform.metadataKey];
      const contentRoot = dlcEntry.contentRoots[platform.metadataKey];

      if (!depotId) {
        throw new Error(
          `DLC ${dlcEntry.dlcName} version ${dlcEntry.dlcVersion} is missing steamDepotIds.${platform.metadataKey}; Steam publication cannot continue.`
        );
      }

      if (!(await pathExists(contentRoot))) {
        throw new Error(
          `DLC ${dlcEntry.dlcName} version ${dlcEntry.dlcVersion} is missing prepared ${platform.metadataKey} content under ${contentRoot}.`
        );
      }

      depotDefinitions.push({
        steamAppId: dlcEntry.steamAppId,
        depotId,
        platform: platform.metadataKey,
        sourcePlatform: deriveDlcSourcePlatform(dlcEntry, platform.metadataKey),
        contentRoot,
        fileName: `depot-build-${dlcEntry.dlcName}-${platform.metadataKey}.vdf`,
        dlcName: dlcEntry.dlcName,
        dlcVersion: dlcEntry.dlcVersion
      });
    }
  }

  return depotDefinitions;
}

function buildAppBuildDefinitions({
  releaseInput,
  plan,
  depotDefinitions,
  buildOutputDir,
  scriptsDir,
  preview,
  branch,
  explicitAppId,
  descriptionOverride
}) {
  if (releaseInput?.mode === 'dlc') {
    const groupedDefinitions = new Map();
    for (const depot of depotDefinitions) {
      const appId = requireNonEmptyString(depot.steamAppId, `DLC ${depot.dlcName} app id`);
      const existingGroup = groupedDefinitions.get(appId) ?? [];
      existingGroup.push(depot);
      groupedDefinitions.set(appId, existingGroup);
    }

    return [...groupedDefinitions.entries()].map(([appId, depots]) => ({
      appId,
      description: descriptionOverride || buildDefaultDlcAppDescription(releaseInput, depots, branch, appId),
      buildOutput: path.join(buildOutputDir, `app-${appId}`),
      depotDefinitions: depots,
      appBuildPath: path.join(scriptsDir, `app-build-${appId}.vdf`)
    }));
  }

  return [
    {
      appId: explicitAppId,
      description: descriptionOverride || buildDefaultDescription(plan, depotDefinitions, branch),
      buildOutput: buildOutputDir,
      depotDefinitions,
      appBuildPath: path.join(scriptsDir, 'app-build.vdf')
    }
  ];
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

  const releaseInput = values['release-input']
    ? await loadReleaseInput(values['release-input'])
    : null;

  if (!values['app-id'] && releaseInput?.mode !== 'dlc') {
    throw new Error('publish-steam requires --app-id.');
  }
  const planPath =
    releaseInput?.mode === 'base' ? releaseInput.planPath : releaseInput ? null : values.plan;
  const contentRootValue =
    releaseInput?.mode === 'base' ? releaseInput.contentRoot : releaseInput ? null : values['content-root'];

  if (!releaseInput && (!planPath || !contentRootValue)) {
    throw new Error('publish-steam requires either --release-input or both --plan and --content-root.');
  }

  const plan = planPath ? await readJson(path.resolve(planPath)) : null;
  const contentRoot = contentRootValue ? path.resolve(contentRootValue) : null;
  const defaultOutputRoot = contentRoot ?? releaseInput?.dlcs?.[0]?.contentRoot ?? process.cwd();
  const outputDir = path.resolve(values['output-dir'] ?? path.join(defaultOutputRoot, '..', 'steam-build'));
  const buildOutputDir = path.join(outputDir, 'build-output');
  const scriptsDir = path.join(outputDir, 'scripts');
  const preview = values.preview;
  const dryRun = values['force-dry-run'];

  if (contentRoot && !(await pathExists(contentRoot))) {
    throw new Error(`Steam content root does not exist at ${contentRoot}.`);
  }

  const steamDepotIds =
    releaseInput?.mode === 'base' ? releaseInput.steamDepotIds : releaseInput ? null : resolveCliSteamDepotIds(values);
  const depotDefinitions =
    releaseInput?.mode === 'dlc'
      ? await resolveDlcDepotDefinitions(releaseInput.dlcs)
      : await resolveBaseDepotDefinitions(steamDepotIds, contentRoot);
  const descriptionOverride = values.description?.trim() || '';

  await ensureDir(buildOutputDir);
  await ensureDir(scriptsDir);

  for (const depot of depotDefinitions) {
    depot.vdfPath = path.join(scriptsDir, depot.fileName);
    await writeFile(depot.vdfPath, `${buildDepotVdf(depot.depotId, depot.contentRoot)}\n`, 'utf8');
  }

  const appBuildDefinitions = buildAppBuildDefinitions({
    releaseInput,
    plan,
    depotDefinitions,
    buildOutputDir,
    scriptsDir,
    preview,
    branch: values.branch.trim(),
    explicitAppId: values['app-id'],
    descriptionOverride
  });

  for (const appBuild of appBuildDefinitions) {
    await ensureDir(appBuild.buildOutput);
    await writeFile(
      appBuild.appBuildPath,
      `${buildAppVdf({
        appId: appBuild.appId,
        description: appBuild.description,
        buildOutput: appBuild.buildOutput,
        depotDefinitions: appBuild.depotDefinitions,
        preview,
        branch: values.branch.trim()
      })}\n`,
      'utf8'
    );
  }

  const manifestPath = path.join(outputDir, 'steam-build-manifest.json');
  await writeJson(manifestPath, {
    releaseTag: plan?.release?.tag ?? null,
    planPath: planPath ? path.resolve(planPath) : null,
    releaseInputPath: releaseInput?.sourcePath ?? null,
    appId: appBuildDefinitions.length === 1 ? appBuildDefinitions[0].appId : null,
    description: appBuildDefinitions.length === 1 ? appBuildDefinitions[0].description : null,
    preview,
    branch: values.branch.trim() || null,
    dryRun,
    azureRelease: releaseInput?.mode === 'base'
      ? {
          requestedReleaseTag: releaseInput.releaseTag,
          index: releaseInput.azureIndex,
          steamDepotIds
        }
      : null,
    dlcRelease:
      releaseInput?.mode === 'dlc'
        ? {
            discoverySource: releaseInput.discoverySource,
            dlcCount: releaseInput.dlcs.length,
            appIds: [...new Set(releaseInput.dlcs.map((dlc) => dlc.steamAppId))]
          }
        : null,
    dlcs:
      releaseInput?.mode === 'dlc'
        ? releaseInput.dlcs.map((dlc) => ({
            dlcName: dlc.dlcName,
            dlcVersion: dlc.dlcVersion,
            steamAppId: dlc.steamAppId,
            contentRoot: dlc.contentRoot,
            contentRoots: dlc.contentRoots,
            preparedPlatforms: dlc.preparedPlatforms,
            steamDepotIds: dlc.steamDepotIds,
            selectedArtifacts: dlc.selectedArtifacts
          }))
        : [],
    depots: depotDefinitions.map(
      ({
        depotId,
        platform,
        sourcePlatform,
        contentRoot: root,
        vdfPath,
        steamAppId = null,
        dlcName = null,
        dlcVersion = null
      }) => ({
        depotId,
        platform,
        sourcePlatform,
        contentRoot: root,
        vdfPath,
        steamAppId,
        dlcName,
        dlcVersion
      })
    ),
    contentRoot,
    appBuildPath: appBuildDefinitions.length === 1 ? appBuildDefinitions[0].appBuildPath : null,
    appBuilds: appBuildDefinitions.map((build) => ({
      appId: build.appId,
      description: build.description,
      buildOutput: build.buildOutput,
      appBuildPath: build.appBuildPath,
      depotCount: build.depotDefinitions.length,
      depotIds: build.depotDefinitions.map((depot) => depot.depotId)
    }))
  });

  if (dryRun) {
    await appendSummary([
      '## Portable Version Steam publication dry-run',
      ...(plan ? [`- Release tag: ${plan.release.tag}`] : []),
      `- App IDs: ${appBuildDefinitions.map((build) => build.appId).join(', ')}`,
      `- Preview mode: ${preview ? 'enabled' : 'disabled'}`,
      ...(releaseInput
        ? [
            ...(releaseInput.mode === 'base'
              ? [
                  `- Azure release tag: ${releaseInput.releaseTag}`,
                  `- Azure root index: ${releaseInput.azureIndex?.sanitizedUrl ?? '[missing-azure-index-context]'}`
                ]
              : [
                  `- DLC discovery source: ${releaseInput.discoverySource}`,
                  `- DLC count: ${releaseInput.dlcs.length}`,
                  `- DLCs: ${releaseInput.dlcs.map((dlc) => `${dlc.dlcName}@${dlc.dlcVersion} (app ${dlc.steamAppId})`).join(', ')}`
                ])
          ]
        : []),
      `- Depot count: ${depotDefinitions.length}`,
      `- Depot platforms: ${depotDefinitions.map((depot) => depot.platform).join(', ')}`,
      ...(contentRoot ? [`- Content root: ${contentRoot}`] : []),
      `- App build scripts: ${appBuildDefinitions.map((build) => build.appBuildPath).join(', ')}`
    ]);
    console.log(
      JSON.stringify(
        {
          manifestPath,
          appBuildCount: appBuildDefinitions.length,
          appBuildPaths: appBuildDefinitions.map((build) => build.appBuildPath),
          depotCount: depotDefinitions.length
        },
        null,
        2
      )
    );
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

  for (const appBuild of appBuildDefinitions) {
    await runCommand(steamcmdPath, [
      ...buildSteamLoginArgs({
        steamUsername,
        steamPassword,
        steamGuardCode,
        useSavedLogin: true
      }),
      '+run_app_build',
      appBuild.appBuildPath,
      '+quit'
    ]);
  }

  await appendSummary([
    '## Portable Version Steam publication complete',
    ...(plan ? [`- Release tag: ${plan.release.tag}`] : []),
    `- App IDs: ${appBuildDefinitions.map((build) => build.appId).join(', ')}`,
    `- Preview mode: ${preview ? 'enabled' : 'disabled'}`,
    ...(releaseInput
      ? [
          ...(releaseInput.mode === 'base'
            ? [
                `- Azure release tag: ${releaseInput.releaseTag}`,
                `- Azure root index: ${releaseInput.azureIndex?.sanitizedUrl ?? '[missing-azure-index-context]'}`
              ]
            : [
                `- DLC discovery source: ${releaseInput.discoverySource}`,
                `- DLC count: ${releaseInput.dlcs.length}`,
                `- DLCs: ${releaseInput.dlcs.map((dlc) => `${dlc.dlcName}@${dlc.dlcVersion} (app ${dlc.steamAppId})`).join(', ')}`
              ])
        ]
      : []),
    `- Depot count: ${depotDefinitions.length}`,
    `- Depot platforms: ${depotDefinitions.map((depot) => depot.platform).join(', ')}`,
    `- Steam login mode: ${hasSavedSteamLogin ? 'reused saved SteamCMD token' : 'bootstrapped and saved new SteamCMD token'}`,
    `- SteamCMD config: ${steamcmdConfigPath}`,
    ...(contentRoot ? [`- Content root: ${contentRoot}`] : []),
    `- App build scripts: ${appBuildDefinitions.map((build) => build.appBuildPath).join(', ')}`
  ]);

  console.log(
    JSON.stringify(
      {
        manifestPath,
        appBuildCount: appBuildDefinitions.length,
        appBuildPaths: appBuildDefinitions.map((build) => build.appBuildPath),
        depotCount: depotDefinitions.length
      },
      null,
      2
    )
  );
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
