import path from 'node:path';
import { chmod, readFile, rm } from 'node:fs/promises';
import { runCommand } from './command.mjs';
import { ensureDir } from './fs-utils.mjs';

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_MIN_LENGTH = 22;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LENGTH = 20;
const MAX_ZIP_COMMENT_LENGTH = 0xffff;
const MAX_END_OF_CENTRAL_DIRECTORY_SEARCH =
  END_OF_CENTRAL_DIRECTORY_MIN_LENGTH + ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_LENGTH + MAX_ZIP_COMMENT_LENGTH;

function findEndOfCentralDirectoryOffset(archiveBuffer, archivePath) {
  const minimumOffset = Math.max(0, archiveBuffer.length - MAX_END_OF_CENTRAL_DIRECTORY_SEARCH);
  for (let offset = archiveBuffer.length - END_OF_CENTRAL_DIRECTORY_MIN_LENGTH; offset >= minimumOffset; offset -= 1) {
    if (archiveBuffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }

  throw new Error(`ZIP archive ${archivePath} is missing an end-of-central-directory record.`);
}

function listZipEntryPaths(archiveBuffer, archivePath) {
  const endOfCentralDirectoryOffset = findEndOfCentralDirectoryOffset(archiveBuffer, archivePath);
  const entryCount = archiveBuffer.readUInt16LE(endOfCentralDirectoryOffset + 10);
  const centralDirectoryOffset = archiveBuffer.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const entryPaths = [];
  let entryOffset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (archiveBuffer.readUInt32LE(entryOffset) !== CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
      throw new Error(
        `ZIP archive ${archivePath} has an invalid central directory entry at offset ${entryOffset}.`
      );
    }

    const fileNameLength = archiveBuffer.readUInt16LE(entryOffset + 28);
    const extraFieldLength = archiveBuffer.readUInt16LE(entryOffset + 30);
    const fileCommentLength = archiveBuffer.readUInt16LE(entryOffset + 32);
    const fileNameStart = entryOffset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    entryPaths.push(archiveBuffer.toString('utf8', fileNameStart, fileNameEnd));
    entryOffset = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return entryPaths;
}

export async function validateZipPaths(archivePath) {
  const archiveBuffer = await readFile(archivePath);
  const entryPaths = listZipEntryPaths(archiveBuffer, archivePath);
  const invalidPaths = entryPaths.filter((entryPath) => entryPath.includes('\\'));

  if (invalidPaths.length > 0) {
    throw new Error(
      `ZIP archive ${archivePath} contains non-compliant backslash-separated paths: ${invalidPaths.join(', ')}`
    );
  }

  return entryPaths;
}

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
    await runCommand('zip', ['-qr', destinationPath, '.'], { cwd: sourceDirectory });
    await validateZipPaths(destinationPath);
    return destinationPath;
  }

  if (lowerPath.endsWith('.tar.gz')) {
    await runCommand('tar', ['-czf', destinationPath, '.'], { cwd: sourceDirectory });
    return destinationPath;
  }

  throw new Error(`Unsupported archive output format for ${destinationPath}.`);
}
