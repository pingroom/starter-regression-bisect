import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readJson } from './storage.mjs';
import { tokenValue, roomCode, requireValue } from './model.mjs';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const directory = join(root, '.bisect');
export const credentialDirectory = join(root, '.pingroom');
export function environment() {
  try { process.loadEnvFile(join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load project .env.'); }
}
export async function connection(env = process.env, path = join(credentialDirectory, 'credentials.json')) {
  let value;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined || env.CI) value = { token: env.PINGROOM_TOKEN, room: env.PINGROOM_ROOM };
  else {
    try { value = await readJson(path); }
    catch { requireValue(false, 'Run npm run connect, or supply both PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  }
  return { token: tokenValue(value?.token), room: roomCode(value?.room) };
}
