import fs from 'node:fs/promises';
import path from 'node:path';

export async function assertMinFreeDisk(targetPath: string, minFreeMb: number): Promise<void> {
  if (minFreeMb <= 0) return;
  const existingPath = await nearestExistingPath(targetPath);
  const stats = await fs.statfs(existingPath);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const requiredBytes = minFreeMb * 1024 * 1024;
  if (freeBytes < requiredBytes) {
    throw new Error(
      `Insufficient free disk space at ${existingPath}: ${formatBytes(freeBytes)} available, ${formatBytes(requiredBytes)} required`
    );
  }
}

async function nearestExistingPath(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Cannot find an existing parent directory for ${targetPath}`);
      current = parent;
    }
  }
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024 / 1024)} MB`;
}
