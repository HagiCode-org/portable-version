import path from 'node:path';
import { runCommand } from './command.mjs';

export async function extractArchive(archivePath, destinationPath) {
  const lowerPath = archivePath.toLowerCase();

  if (lowerPath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await runCommand('powershell.exe', [
        '-NoLogo',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationPath.replace(/'/g, "''")}' -Force`
      ]);
      return;
    }

    await runCommand('unzip', ['-oq', archivePath, '-d', destinationPath]);
    return;
  }

  await runCommand('tar', ['-xf', archivePath, '-C', destinationPath]);
}
