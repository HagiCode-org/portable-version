import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const API_ROOT = 'https://api.github.com';

function getHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'portable-version-automation'
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function requestJson(endpoint, token, { allowNotFound = false } = {}) {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    headers: getHeaders(token)
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) for ${endpoint}: ${body}`);
  }

  return response.json();
}

export async function listReleases(repository, token, perPage = 20) {
  return requestJson(`/repos/${repository}/releases?per_page=${perPage}`, token);
}

export async function getReleaseByTag(repository, tag, token, { allowNotFound = false } = {}) {
  return requestJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, token, { allowNotFound });
}

export async function findReleaseByTag(repository, tag, token) {
  return getReleaseByTag(repository, tag, token, { allowNotFound: true });
}

export async function getLatestEligibleRelease(repository, token) {
  const releases = await listReleases(repository, token, 30);
  const eligibleReleases = releases.filter((release) => !release.draft);
  if (eligibleReleases.length === 0) {
    throw new Error(`No eligible releases found for ${repository}.`);
  }

  return eligibleReleases.sort((left, right) => {
    const leftTime = Date.parse(left.published_at ?? left.created_at ?? 0);
    const rightTime = Date.parse(right.published_at ?? right.created_at ?? 0);
    return rightTime - leftTime;
  })[0];
}

export async function downloadReleaseAsset(asset, destinationPath, token) {
  const downloadUrl = asset.browser_download_url ?? asset.downloadUrl ?? asset.url;
  if (!downloadUrl) {
    throw new Error(`Asset ${asset.name ?? asset.id} does not have a download URL.`);
  }

  if (downloadUrl.startsWith('file://')) {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(new URL(downloadUrl), destinationPath);
    return destinationPath;
  }

  if (/^(?:[A-Za-z]:\\|\/)/.test(downloadUrl)) {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(downloadUrl, destinationPath);
    return destinationPath;
  }

  const response = await fetch(downloadUrl, {
    headers: getHeaders(token),
    redirect: 'follow'
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Failed to download ${downloadUrl}: ${response.status} ${body}`);
  }

  await pipeline(response.body, createWriteStream(destinationPath));
  return destinationPath;
}
