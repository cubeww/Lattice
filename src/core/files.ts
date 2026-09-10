import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('File is not a regular file or exceeds the size limit.');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function atomicWrite(path: string, data: Buffer | string) {
  const temporary = join(dirname(path), `.lattice-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function exists(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export { readFile };
