import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson, withLock } from './storage.mjs';
import { catalogValue, hash, roomCode, tokenValue, roomSnapshot, selectRoom, requestFor, verifyQuestion, validateState, summary, report, requireValue, same, uuid } from './model.mjs';

async function load(directory) {
  try { return validateState(await readJson(join(directory, 'journal.json'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(directory, state) { validateState(state); await atomicJson(directory, state); }
function bind(state, catalog, connection) {
  requireValue(state.sourceHash === hash(catalog) && same(state.catalog, catalog) && state.binding.tokenHash === hash(connection.token) && state.binding.room === connection.room, 'The catalog, room, or credential changed. Preserve the existing journal for investigation.');
}
function apply(state, attempt, receipt) {
  attempt.receipt = receipt; attempt.createdAt = receipt.createdAt; attempt.expiresAt = receipt.expiresAt; attempt.askerId = receipt.askerId;
  attempt.phase = receipt.serverState === 'pending' ? 'observing' : 'resolved';
  if (receipt.serverState === 'answered') {
    if (receipt.value === 'good') state.good = attempt.index;
    else if (receipt.value === 'bad') state.bad = attempt.index;
    else { state.status = 'inconclusive'; state.reason = 'cannot_test'; }
  } else if (receipt.serverState !== 'pending') {
    state.status = 'inconclusive'; state.reason = receipt.serverState;
  }
  if (state.status === 'active' && state.bad - state.good === 1) state.status = 'complete';
}
export async function step({ directory, catalog: input, connection, client, operation = 'run', questionId }) {
  const catalog = catalogValue(input); tokenValue(connection.token); roomCode(connection.room);
  requireValue(['run', 'recover', 'find-id'].includes(operation), 'Unknown operation.');
  if (operation === 'recover') requireValue(uuid(questionId), 'Recovery requires an exact question UUID.');
  return withLock(directory, async () => {
    let state = await load(directory);
    if (state) bind(state, catalog, connection);
    if (state?.status !== 'active' && state !== null) return summary(state);
    if (!state) requireValue(operation === 'run', 'Start this search before recovery.');
    const room = roomSnapshot(selectRoom(await client.rooms.list(), connection.room), connection.room, catalog.testerId);
    if (state) requireValue(room.roomId === state.roomId, 'The room identity changed.');
    else {
      state = { version: 1, catalog, sourceHash: hash(catalog), binding: { tokenHash: hash(connection.token), room: connection.room }, roomId: room.roomId,
        good: catalog.builds.findIndex(b => b.revision === catalog.knownGood), bad: catalog.builds.findIndex(b => b.revision === catalog.knownBad), status: 'active', reason: null, attempts: [] };
      if (state.bad - state.good === 1) state.status = 'complete';
      await save(directory, state);
      if (state.status === 'complete') return summary(state);
    }
    let a = state.attempts.at(-1);
    if (operation === 'find-id') {
      requireValue(a && a.phase !== 'resolved', 'No unresolved creation to inspect.');
      const rows = await client.questions.list({});
      requireValue(Array.isArray(rows) && rows.length <= 200, 'Question inventory exceeds the recovery limit.');
      return { ...summary(state), candidates: rows.filter(q => q?.correlation_id === a.correlation && uuid(q.id)).map(q => q.id), note: 'Candidate IDs only. Absence from this bounded recent list does not prove creation failed.' };
    }
    if (operation === 'recover') {
      requireValue(a && a.phase !== 'resolved' && a.receipt === null, 'Recovery attaches only a creation without a verified receipt.');
      const q = await client.questions.get(questionId);
      const receipt = verifyQuestion(q, state, { ...a, questionId: null });
      requireValue(q.id === questionId, 'Recovery returned a different question ID.');
      a.questionId = questionId; apply(state, a, receipt); await save(directory, state);
      return summary(state);
    }
    if (a?.phase === 'creating') return summary(state); // Never resend an uncertain POST.
    if (a?.phase === 'observing') {
      const receipt = verifyQuestion(await client.questions.get(a.questionId), state, a);
      apply(state, a, receipt); await save(directory, state);
      return summary(state); // A following invocation asks the next midpoint.
    }
    a = { step: state.attempts.length, index: Math.floor((state.good + state.bad) / 2), correlation: `bisect-${randomUUID()}`,
      phase: 'creating', questionId: null, createdAt: null, expiresAt: null, askerId: null, receipt: null };
    a.request = requestFor(state, a); state.attempts.push(a);
    await save(directory, state); // Fixed payload, TTL and idempotency key precede POST.
    let q;
    try { q = await client.questions.ask(connection.room, a.request); }
    catch { return summary(state); }
    if (!uuid(q?.id)) return summary(state);
    a.questionId = q.id; a.phase = 'observing'; await save(directory, state);
    const receipt = verifyQuestion(q, state, a);
    apply(state, a, receipt); await save(directory, state);
    return summary(state);
  });
}
export async function localStatus(directory, exportReport = false) {
  return withLock(directory, async () => {
    const state = await load(directory);
    if (!state) return summary(null);
    if (!exportReport) return summary(state);
    const result = report(state);
    await atomicJson(directory, result, 'report.json');
    return result;
  });
}
