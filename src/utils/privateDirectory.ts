import fs from 'node:fs/promises';

export const PRIVATE_DIRECTORY_MODE = 0o700;

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await makeDirectoryPrivate(directoryPath);
}

export async function makeDirectoryPrivate(directoryPath: string): Promise<void> {
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory()) throw new Error(`Expected a directory: ${directoryPath}`);
  await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export async function assertPrivateDirectory(directoryPath: string): Promise<void> {
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory()) throw new Error(`Expected a directory: ${directoryPath}`);
  const mode = stats.mode & 0o777;
  if (mode !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`expected mode 0700 but found ${mode.toString(8).padStart(4, '0')}: ${directoryPath}`);
  }
}
