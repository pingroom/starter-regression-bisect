import { constants } from 'node:fs';
import { open, mkdir, chmod, lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private storage must be a real directory.');
  await chmod(path, 0o700);
}
export async function readJson(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid bounded private file.');
    // Bound the read itself: the file may grow after the metadata check.
    const data = Buffer.alloc(65537);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 65536) throw new Error('Private file exceeds 64 KiB.');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length));
      return JSON.parse(text);
    } catch { throw new Error('Private file is not valid UTF-8 JSON; its contents are suppressed.'); }
  } finally { await file?.close(); }
}
export async function atomicJson(directory, value, filename = 'journal.json') {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 65536) throw new Error('Private journal exceeds 64 KiB; no write was attempted.');
  const temporary = join(directory, `${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, join(directory, filename));
    const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}
export async function withLock(directory, run) {
  await privateDirectory(directory);
  const lock = join(directory, '.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error('Bisect is locked. Confirm the previous process stopped before removing .bisect/.lock.'); }
  try { return await run(); } finally { await rm(lock, { recursive: true }); }
}
