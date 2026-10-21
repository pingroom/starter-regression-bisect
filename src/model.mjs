import { createHash } from 'node:crypto';
export const API_ORIGIN = 'https://api.pingroom.io';
export class LocalError extends Error {}
export function requireValue(condition, message) { if (!condition) throw new LocalError(message); }
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const exact = (v, fields) => object(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(canonical(v))).digest('hex');
export const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const date = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
const hashValue = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(v);
const trimEdge = /^[\p{White_Space}\u0000\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2065\u206a-\u206f\u2800\u3164\ufeff\uffa0\u{1d159}\u{1d173}-\u{1d17a}\u{e0020}]$/u;
function text(v, limit) {
  requireValue(typeof v === 'string' && v.length > 0 && [...v].length <= limit && !/[\u0000-\u001f\u007f]/u.test(v) && !trimEdge.test([...v][0]) && !trimEdge.test([...v].at(-1)), 'Text is empty, too long, or has unsupported edge/control characters.');
  return v;
}
export function tokenValue(v) {
  requireValue(typeof v === 'string' && /^[\x21-\x7e]{1,8192}$/.test(v), 'Supply a complete nonblank token and room pair.'); return v;
}
export function roomCode(v) {
  requireValue(typeof v === 'string' && /^[A-Z0-9]{12}$/.test(v), 'Room code must contain 12 uppercase letters or digits.'); return v;
}
export function catalogValue(v) {
  requireValue(exact(v, ['id', 'title', 'symptom', 'testerId', 'ttlSeconds', 'knownGood', 'knownBad', 'builds']) && identifier(v.id) && uuid(v.testerId) && Number.isInteger(v.ttlSeconds) && v.ttlSeconds >= 30 && v.ttlSeconds <= 86400 && Array.isArray(v.builds) && v.builds.length >= 2 && v.builds.length <= 64, 'Catalog needs an id, title, symptom, tester UUID, TTL of 30–86400 seconds, boundary revisions, and 2–64 ordered builds.');
  text(v.title, 40); text(v.symptom, 120);
  const builds = v.builds.map(b => {
    requireValue(exact(b, ['revision', 'url']) && identifier(b.revision) && typeof b.url === 'string' && b.url.length <= 180 && /^[\x21-\x7e]+$/.test(b.url), 'Each build needs a unique safe revision and bounded HTTPS URL.');
    let u; try { u = new URL(b.url); } catch { throw new LocalError('Invalid artifact URL.'); }
    requireValue(u.protocol === 'https:' && u.hostname && !u.username && !u.password && !u.search && !u.hash && u.href === b.url, 'Artifact URLs must be canonical HTTPS URLs without credentials, query strings, or fragments.');
    return { revision: b.revision, url: b.url };
  });
  const revisions = builds.map(b => b.revision);
  requireValue(new Set(revisions).size === revisions.length && typeof v.knownGood === 'string' && typeof v.knownBad === 'string' && revisions.indexOf(v.knownGood) >= 0 && revisions.indexOf(v.knownBad) > revisions.indexOf(v.knownGood), 'Supply distinct ordered known-good and known-bad boundary revisions from the catalog.');
  return { id: v.id, title: v.title, symptom: v.symptom, testerId: v.testerId, ttlSeconds: v.ttlSeconds, knownGood: v.knownGood, knownBad: v.knownBad, builds };
}
export function roomSnapshot(room, code, testerId) {
  requireValue(object(room) && room.invite_code === code && room.type === 'standard' && room.is_public === false && uuid(room.id) && Array.isArray(room.members) && room.members.length <= 100, 'Use a granted standard private room with a visible roster of at most 100 humans.');
  const ids = room.members.map(m => {
    requireValue(uuid(m?.user_id) && m.room_id === room.id, 'Invalid room member identity.'); return m.user_id;
  });
  requireValue(new Set(ids).size === ids.length && (!testerId || ids.includes(testerId)), 'The configured tester must be a current human member of the room.');
  return { roomId: room.id, code };
}
export function selectRoom(rooms, code) {
  requireValue(Array.isArray(rooms) && rooms.length <= 1000, 'Invalid or oversized room inventory.');
  const matches = rooms.filter(room => room?.invite_code === code);
  requireValue(matches.length === 1, 'The room must appear exactly once in the granted inventory.');
  return matches[0];
}
export function requestFor(state, attempt) {
  const c = state.catalog, b = c.builds[attempt.index];
  const prompt = `${c.title}\nCheck ${b.revision}: ${b.url}\nRegression: ${c.symptom}\nGood = absent. Bad = present. Cannot test = stop.`;
  requireValue([...prompt].length <= 500, 'The generated question exceeds 500 characters.');
  return { prompt, context: 'Regression bisect', options: [
    { value: 'good', label: 'Good', style: 'default' }, { value: 'bad', label: 'Bad', style: 'default' },
    { value: 'cannot_test', label: 'Cannot test', style: 'default' },
  ], responder_scope: 'direct', target_user_id: c.testerId, ttl: c.ttlSeconds,
  correlation_id: attempt.correlation, idempotencyKey: attempt.correlation,
  data: { starter: 'regression-bisect-v1', case_id: c.id, source_hash: state.sourceHash, revision: b.revision, step: attempt.step } };
}
export function verifyQuestion(q, state, attempt) {
  const r = attempt.request;
  requireValue(object(q) && uuid(q.id) && (!attempt.questionId || q.id === attempt.questionId)
    && q.kind === 'question' && q.is_handoff === false && q.room_code === state.binding.room && q.room?.code === state.binding.room
    && q.prompt === r.prompt && q.context === r.context && q.responder_scope === 'direct' && q.target_user_id === state.catalog.testerId
    && q.resolution_policy === 'first' && q.results === null && q.text_input === null && q.reply_to === null
    && q.correlation_id === r.correlation_id && same(q.data, r.data) && object(q.asker) && q.asker.type === 'agent' && uuid(q.asker.id),
  'Question identity, target, content, or provenance does not match the saved request.');
  requireValue(Array.isArray(q.options) && q.options.length === 3 && q.options.every((o, i) => o.value === r.options[i].value && o.label === r.options[i].label && o.primary === false && o.destructive === false), 'Question options changed.');
  requireValue(date(q.created_at) && date(q.expires_at) && Math.abs(Date.parse(q.expires_at) - Date.parse(q.created_at) - r.ttl * 1000) <= 5000 && (!attempt.createdAt || Date.parse(attempt.createdAt) === Date.parse(q.created_at)) && (!attempt.expiresAt || Date.parse(attempt.expiresAt) === Date.parse(q.expires_at)) && (!attempt.askerId || attempt.askerId === q.asker.id), 'Question timestamps or asking connection changed.');
  requireValue(['pending', 'answered', 'expired', 'cancelled'].includes(q.state) && (q.state === 'pending' ? q.resolved_at === null : date(q.resolved_at) && Date.parse(q.resolved_at) >= Date.parse(q.created_at)), 'Unknown or malformed question state.');
  let value = null, responderId = null, answeredAt = null;
  if (q.state === 'answered') {
    requireValue(object(q.answer) && ['good', 'bad', 'cannot_test'].includes(q.answer.value) && q.answer.text === null && q.answer.label === r.options.find(o => o.value === q.answer.value)?.label && q.answer.responder?.id === state.catalog.testerId && date(q.answer.answered_at) && Date.parse(q.answer.answered_at) >= Date.parse(q.created_at) && Date.parse(q.answer.answered_at) <= Date.parse(q.expires_at) && Date.parse(q.answer.answered_at) === Date.parse(q.resolved_at), 'Answer is not a matching attributed tester observation.');
    value = q.answer.value; responderId = q.answer.responder.id; answeredAt = q.answer.answered_at;
  } else {
    requireValue(q.answer === null, 'An unresolved question carries an unexpected answer.');
    if (q.state === 'expired') requireValue(Date.parse(q.resolved_at) === Date.parse(q.expires_at), 'Expiry does not match the question deadline.');
    if (q.state === 'cancelled') requireValue(Date.parse(q.resolved_at) < Date.parse(q.expires_at), 'Cancellation occurred after the deadline.');
  }
  return { serverState: q.state, value, responderId, answeredAt, createdAt: q.created_at, expiresAt: q.expires_at, askerId: q.asker.id, observedAt: new Date().toISOString() };
}
export function validateState(state) {
  requireValue(object(state) && state.version === 1 && object(state.binding) && hashValue(state.binding.tokenHash) && uuid(state.roomId) && Array.isArray(state.attempts) && state.attempts.length <= 6, 'Invalid bisect journal.');
  roomCode(state.binding.room); const c = catalogValue(state.catalog);
  requireValue(state.sourceHash === hash(c) && ['active', 'complete', 'inconclusive'].includes(state.status), 'Journal source or status changed.');
  let good = c.builds.findIndex(b => b.revision === c.knownGood), bad = c.builds.findIndex(b => b.revision === c.knownBad), reason = null;
  state.attempts.forEach((a, index) => {
    requireValue(bad - good > 1 && reason === null && object(a) && a.step === index && a.index === Math.floor((good + bad) / 2) && /^bisect-[0-9a-f-]{36}$/.test(a.correlation) && uuid(a.correlation.slice(7)) && same(a.request, requestFor(state, a)) && ['creating', 'observing', 'resolved'].includes(a.phase) && (a.questionId === null || uuid(a.questionId)), 'Saved search evidence or request is inconsistent.');
    requireValue(a.phase !== 'creating' || a.questionId === null && a.receipt === null && a.createdAt === null && a.expiresAt === null && a.askerId === null, 'Unknown creation carries a contradictory receipt.');
    requireValue(a.phase === 'creating' || uuid(a.questionId), 'A known question needs an ID.');
    if (a.receipt) {
      const r = a.receipt;
      requireValue(['pending', 'answered', 'expired', 'cancelled'].includes(r.serverState) && date(r.observedAt) && date(r.createdAt) && date(r.expiresAt) && uuid(r.askerId) && a.createdAt === r.createdAt && a.expiresAt === r.expiresAt && a.askerId === r.askerId, 'Saved question receipt is malformed.');
      requireValue(r.serverState === 'pending' ? a.phase === 'observing' : a.phase === 'resolved', 'Saved question phase contradicts the receipt.');
      if (r.serverState === 'answered') {
        requireValue(['good', 'bad', 'cannot_test'].includes(r.value) && r.responderId === c.testerId && date(r.answeredAt), 'Saved answer attribution is invalid.');
        if (r.value === 'good') good = a.index;
        else if (r.value === 'bad') bad = a.index;
        else reason = 'cannot_test';
      } else {
        requireValue(r.value === null && r.responderId === null && r.answeredAt === null, 'Saved non-answer carries a classification.');
        if (r.serverState !== 'pending') reason = r.serverState;
      }
    } else requireValue(a.phase !== 'resolved' && a.createdAt === null && a.expiresAt === null && a.askerId === null, 'Resolved step lacks evidence.');
    if (index < state.attempts.length - 1) requireValue(a.phase === 'resolved', 'An unfinished question was skipped.');
  });
  const expected = reason ? 'inconclusive' : bad - good === 1 ? 'complete' : 'active';
  requireValue(state.good === good && state.bad === bad && state.status === expected && state.reason === reason, 'Saved bracket contradicts the supplied boundaries and tester evidence.');
  return state;
}
export function summary(state) {
  if (!state) return { status: 'not_started' };
  const a = state.attempts.at(-1);
  return { caseId: state.catalog.id, status: state.status === 'active' ? a?.phase === 'creating' ? 'creation_unknown' : a?.phase === 'observing' ? 'pending' : 'ready' : state.status,
    good: state.catalog.builds[state.good].revision, bad: state.catalog.builds[state.bad].revision,
    nextCandidate: state.status === 'active' ? state.catalog.builds[Math.floor((state.good + state.bad) / 2)].revision : null,
    questionId: a?.questionId ?? null, correlation: a?.correlation ?? null, reason: state.reason };
}
export function report(state) {
  return { ...summary(state), assumption: 'The supplied ordered builds have one monotonic good-to-bad transition for this symptom. Catalog endpoints are caller assertions, not observations collected by this starter.',
    symptom: state.catalog.symptom, suppliedGood: state.catalog.knownGood, suppliedBad: state.catalog.knownBad,
    firstBadCandidate: state.status === 'complete' ? state.catalog.builds[state.bad] : null,
    observations: state.attempts.map(a => ({ revision: state.catalog.builds[a.index].revision, questionId: a.questionId, ...a.receipt })) };
}
