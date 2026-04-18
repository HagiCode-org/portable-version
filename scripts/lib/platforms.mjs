const POSIX_TOOLCHAIN = {
  shell: 'posix',
  nodeBinSegments: ['bin'],
  nodeExecutableName: 'node',
  npmExecutableName: 'npm',
  npmGlobalBinSegments: ['bin'],
  npmGlobalModulesSegments: ['lib', 'node_modules'],
  primaryShimExtension: ''
};

const WINDOWS_TOOLCHAIN = {
  shell: 'windows',
  nodeBinSegments: [],
  nodeExecutableName: 'node.exe',
  npmExecutableName: 'npm.cmd',
  npmGlobalBinSegments: [],
  npmGlobalModulesSegments: ['node_modules'],
  primaryShimExtension: '.cmd'
};

export const UNIVERSAL_MACOS_PLATFORM = 'osx-universal';
export const UNIVERSAL_MACOS_MEMBER_PLATFORMS = ['osx-x64', 'osx-arm64'];
export const DEFAULT_BUILD_PLATFORMS = ['linux-x64', 'win-x64', UNIVERSAL_MACOS_PLATFORM];

const PLATFORM_MAP = {
  'linux-x64': {
    id: 'linux-x64',
    runtimeKey: 'linux-x64-nort',
    runner: 'ubuntu-latest',
    desktopAssetPatterns: [/^hagicode-desktop-[^-]+\.[^.]+\.zip$/i, /^hagicode-desktop-.*\.zip$/i, /\.appimage$/i],
    portableFixedSegments: ['resources', 'extra', 'portable-fixed'],
    toolchain: POSIX_TOOLCHAIN
  },
  'win-x64': {
    id: 'win-x64',
    runtimeKey: 'win-x64-nort',
    runner: 'windows-latest',
    desktopAssetPatterns: [/^hagicode\.desktop\..*-unpacked\.zip$/i],
    portableFixedSegments: ['resources', 'extra', 'portable-fixed'],
    toolchain: WINDOWS_TOOLCHAIN
  },
  'osx-x64': {
    id: 'osx-x64',
    runtimeKey: 'osx-x64-nort',
    runner: 'macos-latest',
    desktopAssetPatterns: [/^hagicode\.desktop-(?!.*-arm64-mac\.zip$).*-mac\.zip$/i],
    appBundleName: 'Hagicode Desktop.app',
    portableFixedSegments: ['Contents', 'Resources', 'extra', 'portable-fixed'],
    toolchain: POSIX_TOOLCHAIN
  },
  'osx-arm64': {
    id: 'osx-arm64',
    runtimeKey: 'osx-arm64-nort',
    runner: 'macos-latest',
    desktopAssetPatterns: [/^hagicode\.desktop-.*-arm64-mac\.zip$/i],
    appBundleName: 'Hagicode Desktop.app',
    portableFixedSegments: ['Contents', 'Resources', 'extra', 'portable-fixed'],
    toolchain: POSIX_TOOLCHAIN
  },
  [UNIVERSAL_MACOS_PLATFORM]: {
    id: UNIVERSAL_MACOS_PLATFORM,
    runtimeKey: 'osx-universal-nort',
    runner: 'macos-latest',
    desktopAssetSourcePlatform: 'osx-x64',
    serviceAssetSourcePlatforms: [...UNIVERSAL_MACOS_MEMBER_PLATFORMS],
    desktopAssetPatterns: [/^hagicode\.desktop-(?!.*-arm64-mac\.zip$).*-mac\.zip$/i],
    appBundleName: 'Hagicode Desktop.app',
    portableFixedSegments: ['Contents', 'Resources', 'extra', 'portable-fixed'],
    toolchain: POSIX_TOOLCHAIN,
    bundle: {
      kind: 'macos-universal',
      manifestFileName: 'bundle-manifest.json',
      memberPlatforms: [...UNIVERSAL_MACOS_MEMBER_PLATFORMS],
      publicationPlatform: UNIVERSAL_MACOS_PLATFORM
    }
  }
};

export const DEFAULT_PLATFORMS = [...DEFAULT_BUILD_PLATFORMS];

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

export function getDefaultBuildPlatforms() {
  return [...DEFAULT_BUILD_PLATFORMS];
}

export function getRequestedAssetPlatforms(platformId, sourceType) {
  const platform = getPlatformConfig(platformId);
  if (sourceType === 'desktop') {
    return [platform.desktopAssetSourcePlatform ?? platform.id];
  }

  if (sourceType === 'service') {
    return [...(platform.serviceAssetSourcePlatforms ?? [platform.id])];
  }

  throw new Error(`Unsupported asset source type: ${sourceType}`);
}

export function expandRequestedPlatformsForAssets(platforms, sourceType) {
  return platforms
    .flatMap((platformId) => getRequestedAssetPlatforms(platformId, sourceType))
    .filter((platformId, index, values) => values.indexOf(platformId) === index);
}

export function getBundleConfig(platformId) {
  return getPlatformConfig(platformId).bundle ?? null;
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
    return getDefaultBuildPlatforms();
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

export function stripGitRef(value) {
  return String(value).replace(/^refs\/tags\//, '').trim();
}

export function normalizeReleaseTagComponent(value) {
  const normalized = stripGitRef(value);
  if (!normalized) {
    throw new Error('Release tag components must be non-empty.');
  }

  return `v${normalized.replace(/^v/i, '')}`;
}

export function derivePortableReleaseTag(serviceTag) {
  return normalizeReleaseTagComponent(serviceTag);
}

export function createPlatformMatrix(platforms) {
  return {
    include: platforms.map((platformId) => {
      const platform = getPlatformConfig(platformId);
      return {
        platform: platform.id,
        runner: platform.runner,
        runtimeKey: platform.runtimeKey
      };
    })
  };
}

export function matchDesktopAssetForPlatform(assets, platformId) {
  const platform = getPlatformConfig(platformId);
  const assetPlatform = platform.desktopAssetSourcePlatform
    ? getPlatformConfig(platform.desktopAssetSourcePlatform)
    : platform;
  for (const pattern of assetPlatform.desktopAssetPatterns) {
    const candidates = assets.filter((asset) => pattern.test(asset.name));
    if (candidates.length > 0) {
      return candidates.sort((left, right) => left.name.localeCompare(right.name))[0];
    }
  }

  throw new Error(
    `Missing Desktop release asset for ${platformId}. Expected one of: ${platform.desktopAssetPatterns.map((pattern) => pattern.source).join(', ')}`
  );
}

export function matchServiceAssetForPlatform(assets, platformId) {
  const platform = getPlatformConfig(platformId);
  if (Array.isArray(platform.serviceAssetSourcePlatforms) && platform.serviceAssetSourcePlatforms.length > 1) {
    throw new Error(`Platform ${platformId} requires multiple service assets and cannot be matched as a single asset.`);
  }
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

export function buildDeterministicAssetName(_releaseTag, platformId, _sourceName) {
  return `hagicode-portable-${platformId}.zip`;
}
