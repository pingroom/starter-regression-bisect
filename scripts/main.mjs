import { join } from 'node:path';
import { environment, connection, root, directory } from '../src/config.mjs';
import { makeClient } from '../src/client.mjs';
import { step, localStatus } from '../src/engine.mjs';
import { readJson } from '../src/storage.mjs';
import { requireValue, roomSnapshot, selectRoom, LocalError } from '../src/model.mjs';
try {
  const [operation, questionId, ...rest] = process.argv.slice(2);
  requireValue(['run', 'recover', 'find-id', 'status', 'report', 'members'].includes(operation) && rest.length === 0 && (operation === 'recover' ? !!questionId : questionId === undefined), 'Use start, status, report, members, find-id, or recover QUESTION_UUID.');
  let result;
  if (['status', 'report'].includes(operation)) result = await localStatus(directory, operation === 'report');
  else {
    environment(); const config = await connection(), client = makeClient(config.token);
    if (operation === 'members') {
      const room = selectRoom(await client.rooms.list(), config.room); roomSnapshot(room, config.room);
      result = { room: config.room, members: room.members.map(m => ({ id: m.user_id, name: typeof m.user?.name === 'string' ? m.user.name.slice(0, 100) : null })) };
    } else result = await step({ directory, catalog: await readJson(join(root, 'catalog.json')), connection: config, client, operation, questionId });
  }
  console.log(JSON.stringify(result, null, 2));
  if (['creation_unknown', 'inconclusive'].includes(result.status)) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof LocalError ? error.message : 'Bisect failed. Private file and API contents were suppressed; inspect the local journal.');
  process.exitCode = 1;
}
