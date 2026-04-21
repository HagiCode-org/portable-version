#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { delegateToSteamPackerCli, importSteamPackerModule } from './lib/delegate-to-steam-packer.mjs';

export async function publishRelease(options) {
  const module = await importSteamPackerModule('publish-release.mjs');
  return module.publishRelease(options);
}

async function main() {
  await delegateToSteamPackerCli('publish-release.mjs');
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Portable Version release publication failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
