import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, privateDirectory, readJson } from './storage.mjs';
import { LocalError, exact, requireValue, tokenValue, roomCode, roomSnapshot, selectRoom } from './model.mjs';

async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function pairingUrl(value) {
  requireValue(typeof value === 'string' && value.length <= 8192, 'Invalid saved pairing link. Keep .pingroom/pairing.json for investigation.');
  let url;
  try { url = new URL(value); } catch { throw new LocalError('Invalid pairing link. Keep .pingroom/pairing.json for investigation.'); }
  requireValue(['https://pingroom.io', 'https://api.pingroom.io'].includes(url.origin) && !url.username && !url.password,
    'Unexpected pairing link. Keep .pingroom/pairing.json for investigation.');
  return url.href;
}

const expired = 'Saved pairing expired. Do not start another robot automatically. Resolve or revoke the old robot in Connected Agents, confirm it is no longer usable, then archive only .pingroom/pairing.json before an intentional new setup.';
function pendingValue(value) {
  requireValue(exact(value, ['version', 'phase', 'createdAt', 'token', 'url', 'expiresInSeconds', 'pollIntervalMs'])
    && value.version === 1 && value.phase === 'pending' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isInteger(value.expiresInSeconds) && value.expiresInSeconds >= 1 && value.expiresInSeconds <= 3600
    && Number.isInteger(value.pollIntervalMs) && value.pollIntervalMs >= 1000 && value.pollIntervalMs <= 10000,
  'Invalid saved pairing. Keep .pingroom/pairing.json for investigation; no new robot was created.');
  tokenValue(value.token); pairingUrl(value.url);
  return value;
}

export async function connect({ directory, client, signal, log = console.log }) {
  await privateDirectory(directory);
  const lock = join(directory, '.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new LocalError('Connection setup is locked. Confirm the previous setup process stopped before removing only .pingroom/.lock.');
    throw error;
  }
  try {
    const credentialsPath = join(directory, 'credentials.json'), pendingPath = join(directory, 'pairing.json');
    requireValue(await optionalJson(credentialsPath) === undefined,
      'Saved connection already exists. Keep .pingroom/credentials.json and the bisect journal; use npm run members to inspect the connection instead of replacing it.');
    let pending = await optionalJson(pendingPath);
    if (pending === undefined) {
      signal?.throwIfAborted();
      const createdAt = Date.now();
      // An interrupted POST cannot be assumed absent. Save intent before the
      // SDK registers a robot and starts pairing, and never replay that intent.
      await atomicJson(directory, { version: 1, phase: 'creating', createdAt }, 'pairing.json');
      signal?.throwIfAborted();
      const pairing = await client.auth.startPairing({ agent_label: 'Regression bisect' });
      pending = pendingValue({ version: 1, phase: 'pending', createdAt,
        token: client.getToken(), url: pairingUrl(pairing.pair_browser_url ?? pairing.pair_url),
        expiresInSeconds: pairing.expires_in,
        pollIntervalMs: Math.min(10000, Math.max(1000, Number(pairing.poll_interval_ms) || 1500)) });
      await atomicJson(directory, pending, 'pairing.json');
    } else {
      requireValue(pending?.phase !== 'creating',
        'Pairing creation is uncertain. Keep .pingroom/pairing.json and inspect Connected Agents. Resolve or revoke any created robot before archiving this file for an intentional new setup.');
      pendingValue(pending);
    }
    const remaining = Math.min(pending.expiresInSeconds, Math.floor((pending.createdAt + pending.expiresInSeconds * 1000 - Date.now()) / 1000));
    requireValue(remaining > 0, expired);
    client.setToken(pending.token);
    log(`Claim this robot: ${pending.url}`);
    let active;
    try {
      active = await client.auth.waitForPairing({ expires_in: remaining, poll_interval_ms: pending.pollIntervalMs }, { signal });
    } catch (error) {
      if (error.code === 'pairing_expired') throw new LocalError(expired);
      throw error;
    }
    const room = active.home_room ?? active.room;
    // Keep the approved credential even if room preflight subsequently fails.
    await atomicJson(directory, { token: tokenValue(active.credential), room: room?.invite_code ?? null }, 'credentials.json');
    await rm(pendingPath);
    roomCode(room?.invite_code);
    roomSnapshot(selectRoom(await client.rooms.list(), room.invite_code), room.invite_code);
    log('Connected. Run npm run members to find the tester UUID, then configure catalog.json.');
  } finally { await rm(lock, { recursive: true }); }
}
