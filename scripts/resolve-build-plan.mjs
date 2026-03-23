#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildPlan } from './lib/build-plan.mjs';
import { ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
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
      'default-platforms': { type: 'string' }
    }
  });

  const eventName = values['event-name'] ?? process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const eventPath = values['event-path'] ?? process.env.GITHUB_EVENT_PATH;
  const outputPath = path.resolve(values.output ?? 'build/build-plan.json');
  const token = values.token ?? process.env.PORTABLE_VERSION_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const defaultPlatforms = values['default-platforms']
    ? values['default-platforms'].split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_PLATFORMS;

  const eventPayload = eventPath ? await readJson(eventPath) : {};
  await ensureDir(path.dirname(outputPath));

  const plan = await buildPlan({
    eventName,
    eventPayload,
    token,
    defaultPlatforms
  });

  await writeJson(outputPath, plan);

  await writeGithubOutputs({
    plan_path: outputPath,
    release_tag: plan.release.tag,
    should_build: plan.build.shouldBuild,
    dry_run: plan.build.dryRun,
    platform_matrix: JSON.stringify(plan.platformMatrix)
  });

  const remainingPlatforms = plan.platforms.join(', ');
  await appendSummary([
    '## Portable Version build plan',
    `- Trigger: ${plan.trigger.type}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Service tag: ${plan.upstream.service.tag}`,
    `- Platforms: ${remainingPlatforms}`,
    `- Derived release tag: ${plan.release.tag}`,
    `- Release exists: ${plan.release.exists ? 'yes' : 'no'}`,
    `- Build mode: ${plan.build.dryRun ? 'dry-run' : 'publish'}`,
    plan.build.shouldBuild ? '- Packaging will continue.' : `- Packaging skipped: ${plan.build.skipReason}`
  ]);

  console.log(JSON.stringify({ outputPath, releaseTag: plan.release.tag, shouldBuild: plan.build.shouldBuild }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable Version build plan failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
