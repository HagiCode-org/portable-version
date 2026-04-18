import { buildSignedBlobUrl, sanitizeUrlForLogs } from './azure-blob.mjs';

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

function validateVersionEntry(versionEntry, label) {
  const normalized = requireObject(versionEntry, label);
  const artifacts = normalized.artifacts;

  if (!Array.isArray(artifacts)) {
    fail(`${label}.artifacts must be an array.`);
  }

  return {
    version: requireNonEmptyString(normalized.version, `${label}.version`),
    steamDepotIds: validateSteamDepotIds(normalized.steamDepotIds, `${label}.steamDepotIds`),
    artifacts
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

  return {
    updatedAt: requireNonEmptyString(normalized.updatedAt, `DLC root index ${sanitizedIndexUrl}.updatedAt`),
    dlcs: dlcs.map((dlcEntry, index) => validateDlcEntry(dlcEntry, `DLC root index ${sanitizedIndexUrl}.dlcs[${index}]`))
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
    steamDepotIds: validateSteamDepotIds(
      matchedVersion.steamDepotIds,
      `DLC root index ${sanitizedIndexUrl} version ${matchedVersion.version}.steamDepotIds`
    )
  };
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
