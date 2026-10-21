import { join } from 'node:path';
import { makeClient } from '../src/client.mjs';
import { credentialDirectory } from '../src/config.mjs';
import { atomicJson, privateDirectory } from '../src/storage.mjs';
import { roomSnapshot, selectRoom } from '../src/model.mjs';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
try {
  if (process.argv.length !== 2) throw new Error('No arguments expected.');
  console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
  console.log('Choose a standard private home room containing the tester and grant this robot access to it.');
  const client = makeClient();
  const pairing = await client.auth.startPairing({ agent_label: 'Regression bisect' });
  console.log(`Claim this robot: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: controller.signal });
  const room = active.home_room ?? active.room;
  await privateDirectory(credentialDirectory);
  await atomicJson(credentialDirectory, { token: active.credential, room: room?.invite_code ?? null }, 'credentials.json');
  if (!room) throw new Error('No delivery room.');
  roomSnapshot(selectRoom(await client.rooms.list(), room.invite_code), room.invite_code);
  console.log('Connected. Run npm run members to find the tester UUID, then configure catalog.json.');
} catch {
  console.error('Connection or room preflight failed. If credentials were saved, fix the grant or room in Connected Agents; do not create another robot for a grant error.');
  process.exitCode = 1;
}
