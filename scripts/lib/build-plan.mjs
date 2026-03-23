import { findReleaseByTag, getLatestEligibleRelease, getReleaseByTag } from './github.mjs';
import {
  createPlatformMatrix,
  derivePortableReleaseTag,
  matchServiceAssetForPlatform,
  normalizePlatforms,
  stripGitRef
} from './platforms.mjs';

const DEFAULT_REPOSITORIES = {
  desktop: 'HagiCode-org/desktop',
  service: 'HagiCode-org/releases',
  portable: 'HagiCode-org/portable-version'
};

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function coalesce(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

export function normalizeTriggerInputs({ eventName, eventPayload, defaultPlatforms }) {
  const inputs = eventPayload?.inputs ?? {};
  const dispatchPayload = eventPayload?.client_payload ?? {};

  const triggerType = eventName;
  const desktopTag = coalesce(inputs.desktop_tag, dispatchPayload.desktopTag, dispatchPayload.desktop_tag);
  const serviceTag = coalesce(inputs.service_tag, dispatchPayload.serviceTag, dispatchPayload.service_tag);
  const platforms = coalesce(inputs.platforms, dispatchPayload.platforms);
  const forceRebuild = normalizeBoolean(
    coalesce(inputs.force_rebuild, dispatchPayload.forceRebuild, dispatchPayload.force_rebuild),
    false
  );
  const dryRun = normalizeBoolean(coalesce(inputs.dry_run, dispatchPayload.dryRun, dispatchPayload.dry_run), false);

  if (eventName === 'repository_dispatch' && (!desktopTag || !serviceTag)) {
    throw new Error(
      'repository_dispatch payload must include both desktopTag and serviceTag so the build plan stays non-interactive.'
    );
  }

  return {
    triggerType,
    desktopTag,
    serviceTag,
    selectedPlatforms: normalizePlatforms(platforms, defaultPlatforms),
    forceRebuild,
    dryRun,
    rawInputs: {
      desktopTag,
      serviceTag,
      platforms,
      forceRebuild,
      dryRun
    }
  };
}

export async function resolveReleaseContext({ repository, tag, token }) {
  return tag
    ? getReleaseByTag(repository, stripGitRef(tag), token)
    : getLatestEligibleRelease(repository, token);
}

export function mapServiceAssetsByPlatform(serviceRelease, platforms) {
  const assetsByPlatform = {};
  for (const platformId of platforms) {
    const asset = matchServiceAssetForPlatform(serviceRelease.assets ?? [], platformId);
    assetsByPlatform[platformId] = {
      id: asset.id,
      name: asset.name,
      size: asset.size,
      contentType: asset.content_type,
      downloadUrl: asset.browser_download_url,
      apiUrl: asset.url
    };
  }
  return assetsByPlatform;
}

export async function buildPlan({
  eventName,
  eventPayload,
  token,
  repositories = DEFAULT_REPOSITORIES,
  defaultPlatforms,
  now = new Date().toISOString()
}) {
  const trigger = normalizeTriggerInputs({
    eventName,
    eventPayload,
    defaultPlatforms
  });

  const desktopRelease = await resolveReleaseContext({
    repository: repositories.desktop,
    tag: trigger.desktopTag,
    token
  });
  const serviceRelease = await resolveReleaseContext({
    repository: repositories.service,
    tag: trigger.serviceTag,
    token
  });

  const resolvedDesktopTag = stripGitRef(desktopRelease.tag_name);
  const resolvedServiceTag = stripGitRef(serviceRelease.tag_name);
  const releaseTag = derivePortableReleaseTag(resolvedDesktopTag, resolvedServiceTag);
  const assetsByPlatform = mapServiceAssetsByPlatform(serviceRelease, trigger.selectedPlatforms);
  const existingPortableRelease = await findReleaseByTag(repositories.portable, releaseTag, token);
  const releaseExists = Boolean(existingPortableRelease);
  const shouldBuild = !releaseExists || trigger.forceRebuild;
  const skipReason = !shouldBuild
    ? `Portable Version release ${releaseTag} already exists and force_rebuild was not enabled.`
    : null;

  return {
    schemaVersion: 1,
    generatedAt: now,
    repositories,
    trigger: {
      type: trigger.triggerType,
      rawInputs: trigger.rawInputs
    },
    platforms: trigger.selectedPlatforms,
    platformMatrix: createPlatformMatrix(trigger.selectedPlatforms),
    upstream: {
      desktop: {
        repository: repositories.desktop,
        tag: resolvedDesktopTag,
        name: desktopRelease.name,
        publishedAt: desktopRelease.published_at,
        url: desktopRelease.html_url,
        releaseId: desktopRelease.id
      },
      service: {
        repository: repositories.service,
        tag: resolvedServiceTag,
        name: serviceRelease.name,
        publishedAt: serviceRelease.published_at,
        url: serviceRelease.html_url,
        releaseId: serviceRelease.id,
        assetsByPlatform
      }
    },
    release: {
      repository: repositories.portable,
      tag: releaseTag,
      name: `Portable Version ${resolvedDesktopTag} + ${resolvedServiceTag}`,
      exists: releaseExists,
      url: existingPortableRelease?.html_url ?? null,
      notesTitle: `Portable Version ${releaseTag}`
    },
    build: {
      shouldBuild,
      forceRebuild: trigger.forceRebuild,
      dryRun: trigger.dryRun,
      skipReason
    }
  };
}
