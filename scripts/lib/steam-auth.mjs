import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathExists } from './fs-utils.mjs';

const KNOWN_STATE_FILES = [
  path.join('config', 'config.vdf'),
  path.join('config', 'loginusers.vdf')
];

export function getSteamcmdRoot(steamcmdPath) {
  return path.dirname(path.resolve(steamcmdPath));
}

export function getSteamcmdConfigPath(steamcmdPath) {
  return path.join(getSteamcmdRoot(steamcmdPath), 'config', 'config.vdf');
}

export async function resolveSteamcmdAuthStateFromRoot(steamcmdRoot) {
  const normalizedRoot = path.resolve(steamcmdRoot);
  const canonicalConfigPath = path.join(normalizedRoot, 'config', 'config.vdf');
  const detectedStatePaths = [];

  for (const relativePath of KNOWN_STATE_FILES) {
    const absolutePath = path.join(normalizedRoot, relativePath);
    if (await pathExists(absolutePath)) {
      detectedStatePaths.push(absolutePath);
    }
  }

  const ssfnPaths = [];
  try {
    const rootEntries = await readdir(normalizedRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && /^ssfn/i.test(entry.name)) {
        ssfnPaths.push(path.join(normalizedRoot, entry.name));
      }
    }
  } catch {
    // Missing roots are treated as "no reusable state" below.
  }

  detectedStatePaths.push(...ssfnPaths);
  detectedStatePaths.sort((left, right) => left.localeCompare(right));

  const hasCanonicalConfig = detectedStatePaths.includes(canonicalConfigPath);
  const hasLoginUsers = detectedStatePaths.includes(path.join(normalizedRoot, 'config', 'loginusers.vdf'));
  const hasSsfn = ssfnPaths.length > 0;
  const hasReusableLogin = hasCanonicalConfig || hasSsfn;

  let detectionReason = 'No known SteamCMD authentication state files were detected under the configured SteamCMD root.';
  if (!(await pathExists(normalizedRoot))) {
    detectionReason = 'The configured SteamCMD root does not exist yet, so no reusable authentication state is available.';
  } else if (hasCanonicalConfig && hasSsfn) {
    detectionReason =
      'Detected config/config.vdf and Steam Guard state files under the configured SteamCMD root.';
  } else if (hasCanonicalConfig) {
    detectionReason = 'Detected config/config.vdf under the configured SteamCMD root.';
  } else if (hasSsfn) {
    detectionReason = 'Detected Steam Guard state files under the configured SteamCMD root.';
  } else if (hasLoginUsers) {
    detectionReason =
      'Detected Steam account metadata, but no reusable login token files were found under the configured SteamCMD root.';
  }

  return {
    steamcmdRoot: normalizedRoot,
    canonicalConfigPath,
    detectedStatePaths,
    hasReusableLogin,
    detectionReason
  };
}

export async function resolveSteamcmdAuthState(steamcmdPath) {
  return resolveSteamcmdAuthStateFromRoot(getSteamcmdRoot(steamcmdPath));
}

export function formatDetectedStatePaths(detectedStatePaths) {
  return Array.isArray(detectedStatePaths) && detectedStatePaths.length > 0
    ? detectedStatePaths.join(', ')
    : '[none]';
}

export function buildSteamAuthSummaryLines(diagnostics = {}) {
  return [
    `- SteamCMD root: ${diagnostics.steamcmdRoot ?? '[unknown]'}`,
    `- SteamCMD canonical config: ${diagnostics.canonicalConfigPath ?? '[unknown]'}`,
    `- Steam auth reusable state: ${diagnostics.hasReusableLogin ? 'yes' : 'no'}`,
    `- Steam auth detection reason: ${diagnostics.detectionReason ?? '[unknown]'}`,
    `- Steam auth state files: ${formatDetectedStatePaths(diagnostics.detectedStatePaths)}`,
    ...(diagnostics.initialMode ? [`- Steam auth initial mode: ${diagnostics.initialMode}`] : []),
    ...(diagnostics.finalMode ? [`- Steam auth final mode: ${diagnostics.finalMode}`] : []),
    ...(typeof diagnostics.fallbackTriggered === 'boolean'
      ? [`- Steam auth fallback triggered: ${diagnostics.fallbackTriggered ? 'yes' : 'no'}`]
      : []),
    ...(diagnostics.failureStage ? [`- Steam auth failure stage: ${diagnostics.failureStage}`] : [])
  ];
}
