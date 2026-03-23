import { createHash } from 'node:crypto';

const PLATFORM_MAP = {
  'linux-x64': {
    id: 'linux-x64',
    runtimeKey: 'linux-x64-nort',
    runner: 'ubuntu-latest',
    npmScript: 'build:linux',
    artifactExtensions: ['.AppImage', '.deb', '.rpm', '.snap', '.zip', '.tar.gz']
  },
  'win-x64': {
    id: 'win-x64',
    runtimeKey: 'win-x64-nort',
    runner: 'windows-latest',
    npmScript: 'build:win',
    artifactExtensions: ['.exe', '.msi', '.appx', '.msix', '.zip']
  },
  'osx-x64': {
    id: 'osx-x64',
    runtimeKey: 'osx-x64-nort',
    runner: 'macos-latest',
    npmScript: 'build:mac:x64',
    artifactExtensions: ['.dmg', '.zip', '.pkg']
  },
  'osx-arm64': {
    id: 'osx-arm64',
    runtimeKey: 'osx-arm64-nort',
    runner: 'macos-latest',
    npmScript: 'build:mac:arm64',
    artifactExtensions: ['.dmg', '.zip', '.pkg']
  }
};

export const DEFAULT_PLATFORMS = ['linux-x64'];

export function getPlatformConfig(platformId) {
  const platform = PLATFORM_MAP[platformId];
  if (!platform) {
    throw new Error(`Unsupported platform: ${platformId}`);
  }
  return platform;
}

export function getSupportedPlatforms() {
  return Object.keys(PLATFORM_MAP);
}

export function normalizePlatforms(value, fallback = DEFAULT_PLATFORMS) {
  if (!value || (typeof value === 'string' && value.trim() === '')) {
    return [...fallback];
  }

  const rawValues = Array.isArray(value)
    ? value
    : String(value)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);

  if (rawValues.length === 1 && rawValues[0].toLowerCase() === 'all') {
    return getSupportedPlatforms();
  }

  const normalized = [];
  for (const rawValue of rawValues) {
    const lowerValue = rawValue.toLowerCase();
    if (!PLATFORM_MAP[lowerValue]) {
      throw new Error(
        `Unsupported platform override \"${rawValue}\". Supported values: ${getSupportedPlatforms().join(', ')}`
      );
    }

    if (!normalized.includes(lowerValue)) {
      normalized.push(lowerValue);
    }
  }

  return normalized;
}

export function derivePortableReleaseTag(desktopTag, serviceTag) {
  const normalizedDesktopTag = stripGitRef(desktopTag);
  const normalizedServiceTag = stripGitRef(serviceTag).replace(/^v/i, '');
  const fingerprint = createHash('sha256')
    .update(`portable-version|desktop:${normalizedDesktopTag}|service:${normalizedServiceTag}`)
    .digest('hex')
    .slice(0, 12);
  return `pv-release-${fingerprint}`;
}

export function stripGitRef(value) {
  return String(value).replace(/^refs\/tags\//, '').trim();
}

export function createPlatformMatrix(platforms) {
  return {
    include: platforms.map((platformId) => {
      const platform = getPlatformConfig(platformId);
      return {
        platform: platform.id,
        runner: platform.runner,
        runtimeKey: platform.runtimeKey,
        npmScript: platform.npmScript
      };
    })
  };
}

export function matchServiceAssetForPlatform(assets, platformId) {
  const platform = getPlatformConfig(platformId);
  const lowerRuntimeKey = platform.runtimeKey.toLowerCase();
  const candidates = assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    return name.includes(lowerRuntimeKey) && (name.endsWith('.zip') || name.endsWith('.tar.gz'));
  });

  if (candidates.length === 0) {
    throw new Error(
      `Missing service release asset for ${platformId}. Expected an asset containing ${platform.runtimeKey}.`
    );
  }

  return candidates.sort((left, right) => left.name.localeCompare(right.name))[0];
}

export function toSafeFileComponent(value) {
  const sanitized = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'artifact';
}

export function buildDeterministicAssetName(releaseTag, platformId, sourceName) {
  return `portable-version-${toSafeFileComponent(releaseTag)}-${platformId}-${toSafeFileComponent(sourceName)}`;
}
