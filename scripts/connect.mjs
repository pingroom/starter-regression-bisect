import { makeClient } from '../src/client.mjs';
import { credentialDirectory } from '../src/config.mjs';
import { connect } from '../src/connect.mjs';
import { LocalError } from '../src/model.mjs';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
try {
  if (process.argv.length !== 2) throw new Error('No arguments expected.');
  console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
  console.log('Choose a standard private home room containing the tester and grant this robot access to it.');
  await connect({ directory: credentialDirectory, client: makeClient(), signal: controller.signal });
} catch (error) {
  console.error(error instanceof LocalError ? error.message : controller.signal.aborted
    ? 'Connection interrupted. Saved setup was retained; run npm run connect again to resume or see recovery instructions.'
    : 'Connection or room preflight failed. Saved setup was retained. If credentials were saved, fix the grant or room in Connected Agents; do not create another robot for a grant error.');
  process.exitCode = 1;
}
