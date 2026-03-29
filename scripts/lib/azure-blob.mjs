import { createWriteStream } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

function assertNonEmpty(value, message) {
  if (!value || String(value).trim() === '') {
    throw new Error(message);
  }
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

export async function downloadFromSource({ sourceUrl, destinationPath, headers }) {
  assertNonEmpty(sourceUrl, 'A download source URL is required.');

  if (String(sourceUrl).startsWith('file://')) {
    await copyFile(new URL(sourceUrl), destinationPath);
    return destinationPath;
  }

  if (/^(?:[A-Za-z]:\\|\/)/.test(String(sourceUrl))) {
    await copyFile(sourceUrl, destinationPath);
    return destinationPath;
  }

  const response = await fetch(sourceUrl, {
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
