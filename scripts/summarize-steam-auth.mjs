#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathExists, readJson } from './lib/fs-utils.mjs';
import { appendSummary } from './lib/summary.mjs';
import {
  buildSteamAuthSummaryLines,
  getSteamcmdConfigPath,
  resolveSteamcmdAuthStateFromRoot
} from './lib/steam-auth.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      'steamcmd-root': { type: 'string' }
    },
    strict: true
  });

  const manifestPath = values.manifest ? path.resolve(values.manifest) : null;
  const steamcmdRoot = values['steamcmd-root'] ? path.resolve(values['steamcmd-root']) : null;
  const summaryLines = ['## SteamCMD persistence'];

  if (manifestPath && (await pathExists(manifestPath))) {
    try {
      const manifest = await readJson(manifestPath);
      if (manifest?.steamAuthentication) {
        summaryLines.push('- Summary source: steam-build-manifest.json');
        summaryLines.push(...buildSteamAuthSummaryLines(manifest.steamAuthentication));
        await appendSummary(summaryLines);
        return;
      }
      summaryLines.push('- Summary source: fallback root probe');
      summaryLines.push(`- Manifest note: ${manifestPath} did not contain steamAuthentication diagnostics.`);
    } catch (error) {
      summaryLines.push('- Summary source: fallback root probe');
      summaryLines.push(`- Manifest note: failed to read ${manifestPath}: ${error.message}`);
    }
  } else if (manifestPath) {
    summaryLines.push('- Summary source: fallback root probe');
    summaryLines.push(`- Manifest note: ${manifestPath} is missing.`);
  }

  if (!steamcmdRoot) {
    summaryLines.push('- SteamCMD root: [unknown]');
    summaryLines.push('- Steam auth detection reason: no SteamCMD root was provided for fallback probing.');
    await appendSummary(summaryLines);
    return;
  }

  const diagnostics = await resolveSteamcmdAuthStateFromRoot(steamcmdRoot);
  summaryLines.push(...buildSteamAuthSummaryLines({
    ...diagnostics,
    canonicalConfigPath: diagnostics.canonicalConfigPath ?? getSteamcmdConfigPath(path.join(steamcmdRoot, 'steamcmd.sh'))
  }));
  await appendSummary(summaryLines);
}

main().catch(async (error) => {
  await appendSummary([
    '## SteamCMD persistence',
    `- Failed to summarize Steam authentication diagnostics: ${error.message}`
  ]);
  process.exitCode = 1;
});
