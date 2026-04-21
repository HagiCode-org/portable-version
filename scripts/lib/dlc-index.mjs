import { buildSignedBlobUrl, sanitizeUrlForLogs } from './azure-blob.mjs';
import { compareNormalizedVersions } from './index-source.mjs';

function fail(message) {
  throw new Error(message);
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    fail(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function validateSteamDepotIds(steamDepotIds, label) {
  const normalized = requireObject(steamDepotIds, label);
  return {
    linux: requireNonEmptyString(normalized.linux, `${label}.linux`),
    windows: requireNonEmptyString(normalized.windows, `${label}.windows`),
    macos: requireNonEmptyString(normalized.macos, `${label}.macos`)
  };
}

function validateSteamAppId(steamAppId, label) {
  return requireNonEmptyString(steamAppId, label);
}

function validateArtifactEntry(artifact, label) {
  const normalized = requireObject(artifact, label);
  const name = requireNonEmptyString(normalized.name ?? normalized.fileName, `${label}.name`);
  const fileName = normalized.fileName ? requireNonEmptyString(normalized.fileName, `${label}.fileName`) : name;
  const artifactPath = requireNonEmptyString(normalized.path ?? fileName, `${label}.path`);

  return {
    ...normalized,
    name,
    fileName,
    path: artifactPath,
    platform: normalized.platform ? requireNonEmptyString(normalized.platform, `${label}.platform`) : null
  };
}

function validateVersionEntry(versionEntry, label) {
  const normalized = requireObject(versionEntry, label);
  const artifacts = normalized.artifacts;

  if (!Array.isArray(artifacts)) {
    fail(`${label}.artifacts must be an array.`);
  }

  return {
    version: requireNonEmptyString(normalized.version, `${label}.version`),
    steamAppId: validateSteamAppId(normalized.steamAppId, `${label}.steamAppId`),
    steamDepotIds: requireObject(normalized.steamDepotIds, `${label}.steamDepotIds`),
    artifacts: artifacts.map((artifact, index) => validateArtifactEntry(artifact, `${label}.artifacts[${index}]`))
  };
}

function validateDlcEntry(dlcEntry, label) {
  const normalized = requireObject(dlcEntry, label);
  const versions = normalized.versions;

  if (!Array.isArray(versions)) {
    fail(`${label}.versions must be an array.`);
  }

  return {
    dlcName: requireNonEmptyString(normalized.dlcName, `${label}.dlcName`),
    versions: versions.map((versionEntry, index) => validateVersionEntry(versionEntry, `${label}.versions[${index}]`))
  };
}

export function buildDlcRootIndexUrl(sasUrl) {
  return buildSignedBlobUrl(sasUrl, 'index.json');
}

export function validateDlcRootIndexDocument(document, { sanitizedIndexUrl = '[unknown-dlc-index]' } = {}) {
  const normalized = requireObject(document, 'DLC root index');

  if (Object.hasOwn(normalized, 'versions') || Object.hasOwn(normalized, 'channels')) {
    fail(`DLC root index ${sanitizedIndexUrl} must not contain top-level host fields versions/channels.`);
  }

  const dlcs = normalized.dlcs;
  if (!Array.isArray(dlcs)) {
    fail(`DLC root index ${sanitizedIndexUrl} is missing a dlcs array.`);
  }

  const normalizedDlcs = dlcs.map((dlcEntry, index) =>
    validateDlcEntry(dlcEntry, `DLC root index ${sanitizedIndexUrl}.dlcs[${index}]`)
  );
  const seenDlcNames = new Set();
  for (const dlcEntry of normalizedDlcs) {
    if (seenDlcNames.has(dlcEntry.dlcName)) {
      fail(`DLC root index ${sanitizedIndexUrl} contains duplicate dlcName "${dlcEntry.dlcName}".`);
    }
    seenDlcNames.add(dlcEntry.dlcName);
  }

  return {
    updatedAt: requireNonEmptyString(normalized.updatedAt, `DLC root index ${sanitizedIndexUrl}.updatedAt`),
    dlcs: normalizedDlcs
  };
}

export async function fetchDlcRootIndex({ sasUrl, fetchImpl = fetch } = {}) {
  const indexUrl = buildDlcRootIndexUrl(sasUrl);
  const sanitizedIndexUrl = sanitizeUrlForLogs(indexUrl);

  const response = await fetchImpl(indexUrl, {
    redirect: 'follow'
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Failed to download DLC root index ${sanitizedIndexUrl}: ${response.status} ${body}`);
  }

  const body = await response.text();
  let document;
  try {
    document = JSON.parse(body);
  } catch (error) {
    fail(`Failed to parse DLC root index ${sanitizedIndexUrl}: ${error.message}`);
  }

  return {
    indexUrl,
    sanitizedIndexUrl,
    document: validateDlcRootIndexDocument(document, { sanitizedIndexUrl })
  };
}

export function resolveDlcVersionByReleaseTag({
  dlcIndex,
  dlcName,
  releaseTag,
  sanitizedIndexUrl = '[unknown-dlc-index]'
} = {}) {
  const normalizedDlcName = requireNonEmptyString(dlcName, 'Configured DLC name');
  const normalizedReleaseTag = requireNonEmptyString(releaseTag, 'Requested release tag');
  const normalizedIndex = validateDlcRootIndexDocument(dlcIndex, { sanitizedIndexUrl });
  const matchedDlc = normalizedIndex.dlcs.find((entry) => entry.dlcName === normalizedDlcName);

  if (!matchedDlc) {
    fail(
      `DLC root index ${sanitizedIndexUrl} does not contain dlcName "${normalizedDlcName}" for release "${normalizedReleaseTag}".`
    );
  }

  const matchedVersion = matchedDlc.versions.find((entry) => entry.version === normalizedReleaseTag);
  if (!matchedVersion) {
    fail(
      `DLC root index ${sanitizedIndexUrl} does not contain version "${normalizedReleaseTag}" under dlcName "${normalizedDlcName}".`
    );
  }

  return {
    updatedAt: normalizedIndex.updatedAt,
    dlcName: matchedDlc.dlcName,
    dlcVersion: matchedVersion.version,
    steamAppId: validateSteamAppId(
      matchedVersion.steamAppId,
      `DLC root index ${sanitizedIndexUrl} version ${matchedVersion.version}.steamAppId`
    ),
    steamDepotIds: validateSteamDepotIds(
      matchedVersion.steamDepotIds,
      `DLC root index ${sanitizedIndexUrl} version ${matchedVersion.version}.steamDepotIds`
    )
  };
}

function resolveLatestVersionEntry(versions, label) {
  if (!Array.isArray(versions) || versions.length === 0) {
    fail(`${label} does not contain any versions.`);
  }

  return [...versions].sort((left, right) => compareNormalizedVersions(right.version, left.version))[0];
}

export function resolveLatestDlcVersions({
  dlcIndex,
  sanitizedIndexUrl = '[unknown-dlc-index]'
} = {}) {
  const normalizedIndex = validateDlcRootIndexDocument(dlcIndex, { sanitizedIndexUrl });

  if (normalizedIndex.dlcs.length === 0) {
    fail(`DLC root index ${sanitizedIndexUrl} does not contain any DLC entries.`);
  }

  return normalizedIndex.dlcs.map((dlcEntry) => {
    const latestVersion = resolveLatestVersionEntry(
      dlcEntry.versions,
      `DLC root index ${sanitizedIndexUrl} dlcName "${dlcEntry.dlcName}"`
    );

    return {
      dlcName: dlcEntry.dlcName,
      dlcVersion: latestVersion.version,
      steamAppId: validateSteamAppId(
        latestVersion.steamAppId,
        `DLC root index ${sanitizedIndexUrl} dlcName "${dlcEntry.dlcName}" version ${latestVersion.version}.steamAppId`
      ),
      steamDepotIds: validateSteamDepotIds(
        latestVersion.steamDepotIds,
        `DLC root index ${sanitizedIndexUrl} dlcName "${dlcEntry.dlcName}" version ${latestVersion.version}.steamDepotIds`
      ),
      artifacts: latestVersion.artifacts,
      availableVersions: dlcEntry.versions.map((entry) => entry.version)
    };
  });
}

export async function resolveDlcReleaseContext({ sasUrl, dlcName, releaseTag, fetchImpl = fetch } = {}) {
  const normalizedDlcName = requireNonEmptyString(dlcName, 'Configured DLC name');
  const normalizedReleaseTag = requireNonEmptyString(releaseTag, 'Requested release tag');

  try {
    const { document, sanitizedIndexUrl } = await fetchDlcRootIndex({
      sasUrl,
      fetchImpl
    });
    const resolved = resolveDlcVersionByReleaseTag({
      dlcIndex: document,
      dlcName: normalizedDlcName,
      releaseTag: normalizedReleaseTag,
      sanitizedIndexUrl
    });

    return {
      dlcName: resolved.dlcName,
      dlcVersion: resolved.dlcVersion,
      steamAppId: resolved.steamAppId,
      steamDepotIds: resolved.steamDepotIds,
      dlcIndex: {
        sanitizedUrl: sanitizedIndexUrl,
        updatedAt: resolved.updatedAt,
        dlcCount: document.dlcs.length
      }
    };
  } catch (error) {
    fail(
      `DLC index resolution failed for dlc "${normalizedDlcName}" and release "${normalizedReleaseTag}": ${error.message}`
    );
  }
}

export async function resolveLatestDlcReleaseContext({ sasUrl, fetchImpl = fetch } = {}) {
  try {
    const { document, sanitizedIndexUrl } = await fetchDlcRootIndex({
      sasUrl,
      fetchImpl
    });
    const resolvedDlcs = resolveLatestDlcVersions({
      dlcIndex: document,
      sanitizedIndexUrl
    });

    return {
      dlcs: resolvedDlcs,
      dlcIndex: {
        sanitizedUrl: sanitizedIndexUrl,
        updatedAt: document.updatedAt,
        dlcCount: document.dlcs.length
      }
    };
  } catch (error) {
    fail(`DLC index latest-version resolution failed: ${error.message}`);
  }
}
