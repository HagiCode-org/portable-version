import path from 'node:path';
import { stat } from 'node:fs/promises';
import { copySingleFile, ensureDir, listFilesRecursively } from './fs-utils.mjs';
import { buildDeterministicAssetName, getPlatformConfig } from './platforms.mjs';
import { sha256File } from './checksum.mjs';

export async function collectPackagedArtifacts({ desktopWorkspace, platformId, outputDirectory, releaseTag }) {
  const platform = getPlatformConfig(platformId);
  const pkgRoot = path.join(desktopWorkspace, 'pkg');
  const files = await listFilesRecursively(pkgRoot);
  const matchedFiles = files.filter((filePath) => {
    const lowerPath = filePath.toLowerCase();
    return platform.artifactExtensions.some((extension) => lowerPath.endsWith(extension.toLowerCase()));
  });

  if (matchedFiles.length === 0) {
    throw new Error(`No packaged artifacts found for ${platformId} under ${pkgRoot}.`);
  }

  await ensureDir(outputDirectory);

  const inventory = [];
  for (const filePath of matchedFiles.sort()) {
    const sourceName = path.basename(filePath);
    const targetName = buildDeterministicAssetName(releaseTag, platformId, sourceName);
    const targetPath = path.join(outputDirectory, targetName);
    await copySingleFile(filePath, targetPath);
    const fileStat = await stat(targetPath);
    inventory.push({
      platform: platformId,
      sourcePath: filePath,
      outputPath: targetPath,
      fileName: targetName,
      sizeBytes: fileStat.size,
      sha256: await sha256File(targetPath)
    });
  }

  return inventory;
}
