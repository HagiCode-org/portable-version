import path from 'node:path';
import { chmod, rm } from 'node:fs/promises';
import { runCommand } from './command.mjs';
import { ensureDir } from './fs-utils.mjs';

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

  if (lowerPath.endsWith('.appimage')) {
    if (process.platform === 'win32') {
      throw new Error(`AppImage extraction is not supported on ${process.platform}.`);
    }

    await chmod(archivePath, 0o755);
    await runCommand(archivePath, ['--appimage-extract'], {
      cwd: destinationPath,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1'
      }
    });
    return;
  }

  await runCommand('tar', ['-xf', archivePath, '-C', destinationPath]);
}

export async function createArchive(sourceDirectory, destinationPath) {
  const lowerPath = destinationPath.toLowerCase();

  await ensureDir(path.dirname(destinationPath));
  await rm(destinationPath, { force: true });

  if (lowerPath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const escapedSource = sourceDirectory.replace(/'/g, "''");
      const escapedDestination = destinationPath.replace(/'/g, "''");
      await runCommand('powershell.exe', [
        '-NoLogo',
        '-NonInteractive',
        '-Command',
        [
          'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
          `[System.IO.Compression.ZipFile]::CreateFromDirectory('${escapedSource}', '${escapedDestination}', [System.IO.Compression.CompressionLevel]::Optimal, $false);`
        ].join(' ')
      ]);
      return destinationPath;
    }

    await runCommand('zip', ['-qr', destinationPath, '.'], { cwd: sourceDirectory });
    return destinationPath;
  }

  if (lowerPath.endsWith('.tar.gz')) {
    await runCommand('tar', ['-czf', destinationPath, '.'], { cwd: sourceDirectory });
    return destinationPath;
  }

  throw new Error(`Unsupported archive output format for ${destinationPath}.`);
}
