import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from './command.mjs';
import { pathExists } from './fs-utils.mjs';

function resolveSteamPackerRoot() {
  return path.resolve(fileURLToPath(new URL('../../../steam_packer/', import.meta.url)));
}

export function getSteamPackerScriptPath(scriptName) {
  return path.join(resolveSteamPackerRoot(), 'scripts', scriptName);
}

async function assertSteamPackerScriptExists(scriptName) {
  const scriptPath = getSteamPackerScriptPath(scriptName);
  if (!(await pathExists(scriptPath))) {
    throw new Error(
      `Portable Version packaging entry scripts/${scriptName} moved to steam_packer, but ${scriptPath} is unavailable. Use the reusable workflow or clone the sibling steam_packer repo.`
    );
  }

  return scriptPath;
}

export async function importSteamPackerModule(moduleName) {
  const scriptPath = await assertSteamPackerScriptExists(moduleName);
  return import(pathToFileURL(scriptPath).href);
}

export async function delegateToSteamPackerCli(scriptName, args = process.argv.slice(2)) {
  const scriptPath = await assertSteamPackerScriptExists(scriptName);
  console.warn(
    `[portable-version] scripts/${scriptName} is now a compatibility wrapper. Delegating execution to ${scriptPath}.`
  );
  await runCommand(process.execPath, [scriptPath, ...args]);
}
