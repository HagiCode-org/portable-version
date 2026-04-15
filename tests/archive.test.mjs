import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createArchive, validateZipPaths } from '../scripts/lib/archive.mjs';

async function createArchiveFixture(tempRoot) {
  const sourceRoot = path.join(tempRoot, 'source');
  await mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'nested', 'file.txt'), 'portable version', 'utf8');
  return sourceRoot;
}

async function replaceArchiveEntryPath(archivePath, originalPath, replacementPath) {
  const archiveBuffer = await readFile(archivePath);
  const originalBuffer = Buffer.from(originalPath, 'utf8');
  const replacementBuffer = Buffer.from(replacementPath, 'utf8');

  if (originalBuffer.length !== replacementBuffer.length) {
    throw new Error('Replacement ZIP entry paths must keep the same byte length.');
  }

  let replacements = 0;
  let searchOffset = 0;
  let matchOffset = archiveBuffer.indexOf(originalBuffer, searchOffset);
  while (matchOffset !== -1) {
    replacementBuffer.copy(archiveBuffer, matchOffset);
    replacements += 1;
    searchOffset = matchOffset + originalBuffer.length;
    matchOffset = archiveBuffer.indexOf(originalBuffer, searchOffset);
  }

  if (replacements === 0) {
    throw new Error(`Did not find ${originalPath} inside ${archivePath}.`);
  }

  await writeFile(archivePath, archiveBuffer);
}

test('createArchive creates ZIP entries with forward slashes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-archive-'));
  const sourceRoot = await createArchiveFixture(tempRoot);
  const archivePath = path.join(tempRoot, 'portable.zip');

  await createArchive(sourceRoot, archivePath);

  const entryPaths = await validateZipPaths(archivePath);
  assert.ok(entryPaths.includes('nested/file.txt'));
  assert.ok(entryPaths.every((entryPath) => !entryPath.includes('\\')));
});

test('validateZipPaths rejects ZIP entries that contain backslashes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-archive-invalid-'));
  const sourceRoot = await createArchiveFixture(tempRoot);
  const archivePath = path.join(tempRoot, 'portable.zip');

  await createArchive(sourceRoot, archivePath);
  await replaceArchiveEntryPath(archivePath, 'nested/file.txt', 'nested\\file.txt');

  await assert.rejects(() => validateZipPaths(archivePath), /nested\\file\.txt/);
});
