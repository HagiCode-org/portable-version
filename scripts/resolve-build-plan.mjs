#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseAzureSasUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { buildPlan } from './lib/build-plan.mjs';
import { ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { DEFAULT_INDEX_SOURCES } from './lib/index-source.mjs';
import { DEFAULT_PLATFORMS } from './lib/platforms.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';
import { writeGithubOutputs } from './lib/workflow-output.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      'event-name': { type: 'string' },
      'event-path': { type: 'string' },
      output: { type: 'string' },
      token: { type: 'string' },
      'default-platforms': { type: 'string' },
      'desktop-index-url': { type: 'string' },
      'service-index-url': { type: 'string' },
      'desktop-azure-sas-url': { type: 'string' },
      'service-azure-sas-url': { type: 'string' },
      'steam-azure-sas-url': { type: 'string' }
    }
  });

  const eventName = values['event-name'] ?? process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const eventPath = values['event-path'] ?? process.env.GITHUB_EVENT_PATH;
  const outputPath = path.resolve(values.output ?? 'build/build-plan.json');
  const token = values.token ?? process.env.PORTABLE_VERSION_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const desktopAzureSasUrl =
    values['desktop-azure-sas-url'] ??
    process.env.PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL ??
    process.env.DESKTOP_AZURE_BLOB_SAS_URL ??
    process.env.PORTABLE_VERSION_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const serviceAzureSasUrl =
    values['service-azure-sas-url'] ??
    process.env.PORTABLE_VERSION_SERVICE_AZURE_SAS_URL ??
    process.env.SERVICE_AZURE_BLOB_SAS_URL ??
    process.env.PORTABLE_VERSION_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const steamAzureSasUrl =
    values['steam-azure-sas-url'] ??
    process.env.PORTABLE_VERSION_STEAM_AZURE_SAS_URL ??
    process.env.PORTABLE_VERSION_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const defaultPlatforms = values['default-platforms']
    ? values['default-platforms'].split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_PLATFORMS;

  if (!desktopAzureSasUrl || !serviceAzureSasUrl) {
    throw new Error(
      'resolve-build-plan requires both Desktop and Service Azure SAS URLs via --desktop-azure-sas-url/--service-azure-sas-url or PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL/PORTABLE_VERSION_SERVICE_AZURE_SAS_URL.'
    );
  }

  parseAzureSasUrl(desktopAzureSasUrl);
  parseAzureSasUrl(serviceAzureSasUrl);

  const repositories = {
    desktop: values['desktop-index-url'] ?? process.env.PORTABLE_VERSION_DESKTOP_INDEX_URL ?? DEFAULT_INDEX_SOURCES.desktop,
    service: values['service-index-url'] ?? process.env.PORTABLE_VERSION_SERVICE_INDEX_URL ?? DEFAULT_INDEX_SOURCES.service,
    portable: 'HagiCode-org/portable-version'
  };

  const eventPayload = eventPath ? await readJson(eventPath) : {};
  await ensureDir(path.dirname(outputPath));

  const plan = await buildPlan({
    eventName,
    eventPayload,
    token,
    repositories,
    defaultPlatforms,
    azureSasUrls: {
      desktop: desktopAzureSasUrl,
      service: serviceAzureSasUrl
    },
    portableAzureSasUrl: steamAzureSasUrl
  });

  await writeJson(outputPath, plan);

  await writeGithubOutputs({
    plan_path: outputPath,
    release_tag: plan.release.tag,
    release_identity: 'web-only',
    should_build: plan.build.shouldBuild,
    dry_run: plan.build.dryRun,
    platform_matrix: JSON.stringify(plan.platformMatrix)
  });

  const selectedPlatforms = plan.platforms.join(', ');
  await appendSummary([
    '## Portable Version release plan',
    `- Trigger: ${plan.trigger.type}`,
    `- Desktop index: ${plan.upstream.desktop.manifestUrl}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Service index: ${plan.upstream.service.manifestUrl}`,
    `- Service version: ${plan.upstream.service.version}`,
    `- Platforms: ${selectedPlatforms}`,
    `- Derived release tag (Web-driven): ${plan.release.tag}`,
    `- Desktop Azure SAS: ${sanitizeUrlForLogs(desktopAzureSasUrl)}`,
    `- Service Azure SAS: ${sanitizeUrlForLogs(serviceAzureSasUrl)}`,
    `- Steam Azure SAS: ${steamAzureSasUrl ? sanitizeUrlForLogs(steamAzureSasUrl) : '[not-configured]'}`,
    `- Release exists in Azure index: ${plan.release.exists ? 'yes' : 'no'}`,
    `- Build mode: ${plan.build.dryRun ? 'dry-run' : 'publish'}`,
    plan.build.shouldBuild ? '- Packaging will continue.' : `- Packaging skipped: ${plan.build.skipReason}`
  ]);

  console.log(
    JSON.stringify(
      {
        outputPath,
        releaseTag: plan.release.tag,
        releaseIdentity: 'web-only',
        shouldBuild: plan.build.shouldBuild
      },
      null,
      2
    )
  );
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable Version release plan failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
