import { createWriteStream } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { compareNormalizedVersions } from './index-source.mjs';

function assertNonEmpty(value, message) {
  if (!value || String(value).trim() === '') {
    throw new Error(message);
  }
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function normalizeString(value, message) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function xmlEntityDecode(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function extractXmlValue(block, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = pattern.exec(block);
  return match ? xmlEntityDecode(match[1]) : null;
}

function contentTypeFromPath(blobPath) {
  if (blobPath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (blobPath.endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }
  if (blobPath.endsWith('.zip')) {
    return 'application/zip';
  }
  return 'application/octet-stream';
}

function mapArtifactRecord(artifact, releaseTag) {
  const normalized = assertArtifactRecord(artifact, releaseTag);
  return {
    platform: normalized.platform,
    name: normalized.name,
    fileName: normalized.fileName,
    path: normalized.path,
    sizeBytes: normalized.sizeBytes,
    sha256: normalized.sha256,
    sourcePath: normalized.sourcePath,
    outputPath: normalized.outputPath
  };
}

function sortVersionEntries(entries) {
  return [...entries].sort((left, right) => compareNormalizedVersions(right.version, left.version));
}

function assertSteamDepotIds(steamDepotIds, label) {
  assertObject(steamDepotIds, `${label} must be an object.`);
  return {
    linux: normalizeString(steamDepotIds.linux, `${label}.linux must be a non-empty string.`),
    windows: normalizeString(steamDepotIds.windows, `${label}.windows must be a non-empty string.`),
    macos: normalizeString(steamDepotIds.macos, `${label}.macos must be a non-empty string.`)
  };
}

function normalizeMetadataPath(releaseTag, value, fieldName) {
  const normalized = normalizeString(value, `${fieldName} must be a non-empty string.`);
  return normalized.includes('/') ? normalized.replace(/^\/+/, '') : `${releaseTag}/${normalized}`;
}

function assertArtifactRecord(artifact, releaseTag) {
  assertObject(artifact, `Portable Version artifact for ${releaseTag} must be an object.`);
  const platform = normalizeString(
    artifact.platform,
    `Portable Version artifact for ${releaseTag} is missing a platform.`
  );
  const fileName = normalizeString(
    artifact.fileName ?? artifact.name,
    `Portable Version artifact for ${releaseTag} (${platform}) is missing a file name.`
  );
  const blobPath = String(artifact.path ?? '').trim() || `${releaseTag}/${fileName}`;

  return {
    platform,
    name: fileName,
    fileName,
    path: blobPath.replace(/^\/+/, ''),
    sizeBytes: artifact.sizeBytes ?? artifact.size ?? null,
    sha256: artifact.sha256 ?? null,
    sourcePath: artifact.sourcePath ?? null,
    outputPath: artifact.outputPath ?? null
  };
}

function assertPortableVersionVersionEntry(versionEntry, label) {
  assertObject(versionEntry, `${label} must be an object.`);
  assertObject(versionEntry.metadata, `${label}.metadata must be an object.`);

  const artifacts = Array.isArray(versionEntry.artifacts)
    ? versionEntry.artifacts.map((artifact) =>
        assertArtifactRecord(artifact, normalizeString(versionEntry.version, `${label}.version must be a non-empty string.`))
      )
    : (() => {
        throw new Error(`${label}.artifacts must be an array.`);
      })();

  return {
    version: normalizeString(versionEntry.version, `${label}.version must be a non-empty string.`),
    metadata: {
      buildManifestPath: normalizeString(
        versionEntry.metadata.buildManifestPath,
        `${label}.metadata.buildManifestPath must be a non-empty string.`
      ),
      artifactInventoryPath: normalizeString(
        versionEntry.metadata.artifactInventoryPath,
        `${label}.metadata.artifactInventoryPath must be a non-empty string.`
      ),
      checksumsPath: normalizeString(
        versionEntry.metadata.checksumsPath,
        `${label}.metadata.checksumsPath must be a non-empty string.`
      )
    },
    steamDepotIds: assertSteamDepotIds(versionEntry.steamDepotIds, `${label}.steamDepotIds`),
    artifacts: artifacts
      .sort((left, right) => left.platform.localeCompare(right.platform))
      .map((artifact) => ({
        platform: artifact.platform,
        name: artifact.name,
        fileName: artifact.fileName,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256
      })),
    upstream: versionEntry.upstream ?? null,
    publishedAt: versionEntry.publishedAt ?? null,
    updatedAt: versionEntry.updatedAt ?? null
  };
}

export function sanitizeUrlForLogs(url) {
  if (!url) {
    return '[empty-url]';
  }

  try {
    const parsed = new URL(url);
    return parsed.search
      ? `${parsed.origin}${parsed.pathname}?<sas-token-redacted>`
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    const normalized = String(url);
    const queryIndex = normalized.indexOf('?');
    return queryIndex >= 0 ? `${normalized.slice(0, queryIndex)}?<sas-token-redacted>` : normalized;
  }
}

export function parseAzureSasUrl(sasUrl) {
  assertNonEmpty(sasUrl, 'Azure SAS URL is required.');

  let parsed;
  try {
    parsed = new URL(sasUrl);
  } catch {
    throw new Error('Azure SAS URL is invalid.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Azure SAS URL must use HTTPS, received ${parsed.protocol}.`);
  }

  if (!parsed.search || !parsed.searchParams.has('sig')) {
    throw new Error('Azure SAS URL must include a SAS token with a sig parameter.');
  }

  return parsed;
}

export function getAzureBlobContainerUrl(sasUrl) {
  const parsed = parseAzureSasUrl(sasUrl);
  return `${parsed.origin}${parsed.pathname.replace(/\/?$/, '/')}`;
}

export function buildSignedBlobUrl(sasUrl, assetPath) {
  assertNonEmpty(assetPath, 'Azure blob asset path is required.');

  const parsed = parseAzureSasUrl(sasUrl);
  const containerUrl = new URL(getAzureBlobContainerUrl(parsed.toString()));
  const signedUrl = new URL(String(assetPath).replace(/^\/+/, ''), containerUrl);
  signedUrl.search = parsed.search;
  return signedUrl.toString();
}

export function resolveAssetDownloadUrl({ asset, sasUrl, overrideSource }) {
  if (overrideSource) {
    return overrideSource;
  }

  if (!asset?.path || String(asset.path).trim() === '') {
    throw new Error(`Asset ${asset?.name ?? '<unknown>'} is missing index path metadata.`);
  }

  return buildSignedBlobUrl(sasUrl, asset.path);
}

export function buildPortableVersionRootIndexUrl(sasUrl) {
  return buildSignedBlobUrl(sasUrl, 'index.json');
}

export function createPortableVersionRootIndexDocument({ generatedAt = new Date().toISOString(), versions = [] } = {}) {
  return {
    schemaVersion: 1,
    generatedAt,
    versions: sortVersionEntries(versions)
  };
}

export function validatePortableVersionRootIndexDocument(
  document,
  { sanitizedIndexUrl = '[unknown-portable-version-index]' } = {}
) {
  assertObject(document, `Portable Version root index ${sanitizedIndexUrl} must be a JSON object.`);

  if (!Array.isArray(document.versions)) {
    throw new Error(`Portable Version root index ${sanitizedIndexUrl} is missing a versions array.`);
  }

  return {
    schemaVersion: document.schemaVersion ?? 1,
    generatedAt: document.generatedAt ?? null,
    versions: sortVersionEntries(
      document.versions.map((versionEntry, index) =>
        assertPortableVersionVersionEntry(
          versionEntry,
          `Portable Version root index ${sanitizedIndexUrl}.versions[${index}]`
        )
      )
    )
  };
}

export function normalizePortableVersionVersionEntry({
  releaseTag,
  metadata,
  steamDepotIds,
  artifacts,
  upstream = null,
  publishedAt = new Date().toISOString(),
  updatedAt = publishedAt
} = {}) {
  const normalizedReleaseTag = normalizeString(releaseTag, 'Portable Version releaseTag is required.');
  assertObject(metadata, `Portable Version ${normalizedReleaseTag}.metadata must be an object.`);

  const normalizedArtifacts = Array.isArray(artifacts)
    ? artifacts.map((artifact) => mapArtifactRecord(artifact, normalizedReleaseTag))
    : (() => {
        throw new Error(`Portable Version ${normalizedReleaseTag}.artifacts must be an array.`);
      })();

  return assertPortableVersionVersionEntry(
    {
      version: normalizedReleaseTag,
      metadata: {
        buildManifestPath: normalizeMetadataPath(
          normalizedReleaseTag,
          metadata.buildManifestPath,
          `Portable Version ${normalizedReleaseTag}.metadata.buildManifestPath`
        ),
        artifactInventoryPath: normalizeMetadataPath(
          normalizedReleaseTag,
          metadata.artifactInventoryPath,
          `Portable Version ${normalizedReleaseTag}.metadata.artifactInventoryPath`
        ),
        checksumsPath: normalizeMetadataPath(
          normalizedReleaseTag,
          metadata.checksumsPath,
          `Portable Version ${normalizedReleaseTag}.metadata.checksumsPath`
        )
      },
      steamDepotIds: assertSteamDepotIds(
        steamDepotIds,
        `Portable Version ${normalizedReleaseTag}.steamDepotIds`
      ),
      artifacts: normalizedArtifacts,
      upstream,
      publishedAt,
      updatedAt
    },
    `Portable Version ${normalizedReleaseTag}`
  );
}

export function upsertPortableVersionRootIndexEntry(document, versionEntry, { generatedAt = new Date().toISOString() } = {}) {
  const normalizedDocument = validatePortableVersionRootIndexDocument(document);
  const normalizedVersionEntry = assertPortableVersionVersionEntry(
    versionEntry,
    `Portable Version ${versionEntry?.version ?? '[unknown-release]'}`
  );
  const remainingEntries = normalizedDocument.versions.filter(
    (entry) => entry.version !== normalizedVersionEntry.version
  );

  return {
    schemaVersion: normalizedDocument.schemaVersion ?? 1,
    generatedAt,
    versions: sortVersionEntries([...remainingEntries, normalizedVersionEntry])
  };
}

export function resolvePortableVersionIndexEntryByReleaseTag({
  document,
  releaseTag,
  sanitizedIndexUrl = '[unknown-portable-version-index]'
} = {}) {
  const normalizedReleaseTag = normalizeString(releaseTag, 'Portable Version release tag is required.');
  const normalizedDocument = validatePortableVersionRootIndexDocument(document, { sanitizedIndexUrl });
  const matchedEntry = normalizedDocument.versions.find((entry) => entry.version === normalizedReleaseTag);

  if (!matchedEntry) {
    throw new Error(
      `Portable Version root index ${sanitizedIndexUrl} does not contain version "${normalizedReleaseTag}".`
    );
  }

  return matchedEntry;
}

export async function fetchPortableVersionRootIndex({ sasUrl, fetchImpl = fetch } = {}) {
  const indexUrl = buildPortableVersionRootIndexUrl(sasUrl);
  const sanitizedIndexUrl = sanitizeUrlForLogs(indexUrl);
  const response = await fetchImpl(indexUrl, {
    headers: {
      Accept: 'application/json'
    },
    redirect: 'follow'
  });

  if (response.status === 404) {
    return {
      exists: false,
      indexUrl,
      sanitizedIndexUrl,
      document: createPortableVersionRootIndexDocument()
    };
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to download Portable Version root index ${sanitizedIndexUrl}: ${response.status} ${body}`
    );
  }

  const body = await response.text();
  let document;
  try {
    document = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `Failed to parse Portable Version root index ${sanitizedIndexUrl}: ${error.message}`
    );
  }

  return {
    exists: true,
    indexUrl,
    sanitizedIndexUrl,
    document: validatePortableVersionRootIndexDocument(document, { sanitizedIndexUrl })
  };
}

export async function findPortableVersionReleaseByTag({ sasUrl, releaseTag, fetchImpl = fetch } = {}) {
  const { document, sanitizedIndexUrl } = await fetchPortableVersionRootIndex({
    sasUrl,
    fetchImpl
  });
  const normalizedReleaseTag = normalizeString(releaseTag, 'Portable Version release tag is required.');
  return (
    document.versions.find((entry) => entry.version === normalizedReleaseTag)
      ? {
          version: normalizedReleaseTag,
          sanitizedIndexUrl
        }
      : null
  );
}

export async function uploadAzureBlob({
  sasUrl,
  blobPath,
  filePath,
  content,
  contentType,
  fetchImpl = fetch
} = {}) {
  const normalizedBlobPath = normalizeString(blobPath, 'Azure blob path is required.').replace(/^\/+/, '');
  const targetUrl = buildSignedBlobUrl(sasUrl, normalizedBlobPath);
  const body = filePath ? await readFile(filePath) : content;

  if (body === undefined || body === null) {
    throw new Error(`Azure blob upload ${normalizedBlobPath} requires either filePath or content.`);
  }

  const response = await fetchImpl(targetUrl, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2023-11-03',
      'content-type': contentType ?? contentTypeFromPath(normalizedBlobPath)
    },
    body
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to upload Azure blob ${sanitizeUrlForLogs(targetUrl)}: ${response.status} ${responseBody}`
    );
  }

  return {
    blobPath: normalizedBlobPath,
    uploadUrl: targetUrl,
    sanitizedUploadUrl: sanitizeUrlForLogs(targetUrl)
  };
}

export async function listAzureBlobs({ sasUrl, prefix = '', fetchImpl = fetch } = {}) {
  const parsed = parseAzureSasUrl(sasUrl);
  const listUrl = new URL(getAzureBlobContainerUrl(parsed.toString()));
  listUrl.search = parsed.search;
  listUrl.searchParams.set('restype', 'container');
  listUrl.searchParams.set('comp', 'list');
  if (prefix) {
    listUrl.searchParams.set('prefix', prefix);
  }

  const response = await fetchImpl(listUrl.toString(), {
    headers: {
      Accept: 'application/xml'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to list Azure blobs under ${sanitizeUrlForLogs(listUrl.toString())}: ${response.status} ${body}`
    );
  }

  const body = await response.text();
  const blobMatches = [...body.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)];
  return blobMatches.map((match) => {
    const block = match[1];
    const name = extractXmlValue(block, 'Name');
    return {
      name,
      sizeBytes: Number.parseInt(extractXmlValue(block, 'Content-Length') ?? '', 10) || null,
      lastModified: extractXmlValue(block, 'Last-Modified')
    };
  });
}

export async function writePortableVersionRootIndex({
  sasUrl,
  document,
  fetchImpl = fetch,
  generatedAt = new Date().toISOString()
} = {}) {
  const normalizedDocument = validatePortableVersionRootIndexDocument(
    {
      ...document,
      generatedAt
    },
    {
      sanitizedIndexUrl: sanitizeUrlForLogs(buildPortableVersionRootIndexUrl(sasUrl))
    }
  );

  return uploadAzureBlob({
    sasUrl,
    blobPath: 'index.json',
    content: `${JSON.stringify(normalizedDocument, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8',
    fetchImpl
  });
}

export async function downloadFromSource({ sourceUrl, destinationPath, headers, fetchImpl = fetch }) {
  assertNonEmpty(sourceUrl, 'A download source URL is required.');

  if (String(sourceUrl).startsWith('file://')) {
    await copyFile(new URL(sourceUrl), destinationPath);
    return destinationPath;
  }

  if (/^(?:[A-Za-z]:\\|\/)/.test(String(sourceUrl))) {
    await copyFile(sourceUrl, destinationPath);
    return destinationPath;
  }

  const response = await fetchImpl(sourceUrl, {
    headers,
    redirect: 'follow'
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Failed to download ${sanitizeUrlForLogs(sourceUrl)}: ${response.status} ${body}`);
  }

  await pipeline(response.body, createWriteStream(destinationPath));
  return destinationPath;
}
