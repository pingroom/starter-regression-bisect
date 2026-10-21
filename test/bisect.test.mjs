import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localStatus } from '../src/engine.mjs';
import { makeClient } from '../src/client.mjs';
import { catalogValue, validateState, date, hash } from '../src/model.mjs';
import { readJson, atomicJson } from '../src/storage.mjs';
import { connection } from '../src/config.mjs';
import { sampleCatalog, mockTransport, TOKEN, CODE } from '../scripts/mock.mjs';

const clone = value => structuredClone(value);
const posts = mock => mock.requests.filter(r => r.method === 'POST');
async function setup(t, change = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bisect-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = await sampleCatalog(); change(catalog);
  const mock = mockTransport(catalog);
  const args = { directory, catalog, connection: { token: TOKEN, room: CODE }, client: makeClient(TOKEN, { fetch: mock.fetch }) };
  return { directory, catalog, mock, args };
}
const journal = directory => readJson(join(directory, 'journal.json'));

test('binary search narrows only on attributed observations and saves evidence', async t => {
  const { directory, args, mock } = await setup(t);
  assert.equal((await step(args)).nextCandidate, 'build-003');
  mock.answer('bad'); assert.equal((await step(args)).bad, 'build-003');
  assert.equal(mock.questions.size, 1);
  assert.equal((await step(args)).nextCandidate, 'build-002');
  mock.answer('good'); const result = await step(args);
  assert.equal(result.status, 'complete'); assert.equal(result.good, 'build-002'); assert.equal(result.bad, 'build-003');
  const report = await localStatus(directory, true);
  assert.equal(report.firstBadCandidate.revision, 'build-003');
  assert.equal(report.observations.length, 2);
  assert.equal(report.observations[0].responderId, args.catalog.testerId);
  assert.equal(report.suppliedGood, 'build-001');
  assert.match(report.assumption, /caller assertions/);
  assert.deepEqual(await readJson(join(directory, 'report.json')), report);
});
test('complete replay and local report perform no API requests', async t => {
  const { directory, args, mock } = await setup(t, c => { c.knownBad = 'build-002'; });
  assert.equal((await step(args)).status, 'complete');
  assert.equal(mock.questions.size, 0);
  mock.requests.length = 0;
  await step(args); const report = await localStatus(directory, true);
  assert.equal(report.observations.length, 0); assert.equal(mock.requests.length, 0);
});
test('pending question leaves the bracket unchanged and is never resent', async t => {
  const { args, mock } = await setup(t);
  const first = await step(args), second = await step(args);
  assert.equal(second.status, 'pending'); assert.equal(second.good, first.good); assert.equal(second.bad, first.bad);
  assert.equal(posts(mock).length, 1);
});
test('local clock does not turn a server-pending response into expiry', async t => {
  const { args, mock } = await setup(t);
  mock.afterCreate = q => {
    q.created_at = '2020-01-01T00:00:00Z'; q.expires_at = '2020-01-01T01:00:00Z';
  };
  assert.equal((await step(args)).status, 'pending');
  assert.equal((await step(args)).status, 'pending');
  assert.equal(posts(mock).length, 1);
});
test('Cannot test closes inconclusive rather than skipping or guessing', async t => {
  const { directory, args, mock } = await setup(t);
  await step(args); mock.answer('cannot_test');
  const result = await step(args); assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, 'cannot_test');
  assert.equal(result.good, 'build-001'); assert.equal(result.bad, 'build-005');
  assert.equal((await localStatus(directory, true)).firstBadCandidate, null);
  await step(args); assert.equal(posts(mock).length, 1);
});
test('server expiry and cancellation are distinct inconclusive receipts', async t => {
  for (const state of ['expired', 'cancelled']) {
    const { args, mock } = await setup(t); await step(args); mock.close(state);
    const result = await step(args);
    assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, state);
    assert.equal(result.good, 'build-001'); assert.equal(result.bad, 'build-005');
  }
});
test('fixed request and idempotency key are durable before the real SDK POST', async t => {
  const { directory, args, mock } = await setup(t);
  mock.beforeCreate = async body => {
    const state = await journal(directory), a = state.attempts[0];
    assert.equal(a.phase, 'creating'); assert.equal(a.questionId, null);
    assert.equal(a.request.ttl, args.catalog.ttlSeconds);
    assert.equal(a.request.target_user_id, args.catalog.testerId);
    assert.equal(a.request.prompt, body.prompt);
    assert.equal(posts(mock)[0].headers.get('idempotency-key'), a.correlation);
    assert.equal(Object.hasOwn(body, 'idempotencyKey'), false);
  };
  await step(args);
});
test('lost creation blocks POST replay; candidate search and exact recovery only read', async t => {
  const { args, mock } = await setup(t); mock.loseCreate = true;
  assert.equal((await step(args)).status, 'creation_unknown');
  assert.equal((await step(args)).status, 'creation_unknown');
  const found = await step({ ...args, operation: 'find-id' });
  assert.deepEqual(found.candidates, [mock.last.id]);
  const recovered = await step({ ...args, operation: 'recover', questionId: mock.last.id });
  assert.equal(recovered.status, 'pending'); assert.equal(posts(mock).length, 1);
});
test('malformed creation without ID is uncertain, and recovery can observe a resolved answer', async t => {
  const { args, mock } = await setup(t); mock.malformedCreate = true;
  assert.equal((await step(args)).status, 'creation_unknown');
  mock.answer('bad');
  const result = await step({ ...args, operation: 'recover', questionId: mock.last.id });
  assert.equal(result.status, 'ready'); assert.equal(result.bad, 'build-003'); assert.equal(posts(mock).length, 1);
});
test('wrong recovery identity, payload, correlation, or target never attaches', async t => {
  for (const mutate of [q => { q.prompt += ' changed'; }, q => { q.correlation_id = 'foreign'; }, q => { q.target_user_id = '44444444-4444-4444-8444-444444444444'; }]) {
    const { args, mock } = await setup(t); mock.loseCreate = true; await step(args); mutate(mock.last);
    await assert.rejects(step({ ...args, operation: 'recover', questionId: mock.last.id }), /does not match/);
    assert.equal(posts(mock).length, 1);
  }
});
test('a verified receipt cannot be replaced by explicit recovery', async t => {
  const { args, mock } = await setup(t); await step(args);
  await assert.rejects(step({ ...args, operation: 'recover', questionId: mock.last.id }), /without a verified receipt/);
});
test('known ID survives transient read failures without duplicate questions', async t => {
  const { args, mock } = await setup(t); await step(args); mock.failRead = true;
  await assert.rejects(step(args)); mock.failRead = false; mock.answer('good');
  assert.equal((await step(args)).good, 'build-003'); assert.equal(posts(mock).length, 1);
});
test('a known ID with an invalid initial response is saved for later verification', async t => {
  const { directory, args, mock } = await setup(t);
  mock.afterCreate = q => { q.prompt += ' changed'; };
  await assert.rejects(step(args), /does not match/);
  const saved = await journal(directory);
  assert.equal(saved.attempts[0].questionId, mock.last.id); assert.equal(saved.attempts[0].receipt, null);
  mock.last.prompt = saved.attempts[0].request.prompt;
  assert.equal((await step(args)).status, 'pending'); assert.equal(posts(mock).length, 1);
});
test('foreign or redacted answer actors cannot narrow the bracket', async t => {
  for (const id of [null, '44444444-4444-4444-8444-444444444444']) {
    const { directory, args, mock } = await setup(t); await step(args); mock.answer('bad'); mock.last.answer.responder.id = id;
    await assert.rejects(step(args), /attributed tester/);
    assert.equal((await journal(directory)).bad, 4);
  }
});
test('changed options, room, policy, asker, or reserved response data fail closed', async t => {
  for (const mutate of [
    q => { q.options[0].primary = true; }, q => { q.options[1].label = 'Other'; },
    q => { q.room.code = 'OTHERROOM001'; }, q => { q.resolution_policy = 'all'; },
    q => { q.asker.id = '44444444-4444-4444-8444-444444444444'; }, q => { q.data.source_hash = 'changed'; },
  ]) {
    const { args, mock } = await setup(t); await step(args); mutate(mock.last);
    await assert.rejects(step(args)); assert.equal(posts(mock).length, 1);
  }
});
test('answer after expiry or inconsistent resolved_at cannot narrow the bracket', async t => {
  for (const mutate of [q => { q.answer.answered_at = new Date(Date.parse(q.expires_at) + 1).toISOString(); q.resolved_at = q.answer.answered_at; }, q => { q.resolved_at = q.expires_at; }]) {
    const { args, mock } = await setup(t); await step(args); mock.answer('bad'); mutate(mock.last);
    await assert.rejects(step(args), /attributed tester/);
  }
});
test('equivalent ISO representations remain valid, but changed deadlines fail', async t => {
  const { args, mock } = await setup(t); await step(args);
  mock.last.created_at = mock.last.created_at.replace('Z', '+00:00'); mock.last.expires_at = mock.last.expires_at.replace('Z', '+00:00');
  assert.equal((await step(args)).status, 'pending');
  mock.last.expires_at = new Date(Date.parse(mock.last.expires_at) + 1000).toISOString();
  await assert.rejects(step(args), /timestamps/);
});
test('room-list preflight does not call the room-detail read-state endpoint', async t => {
  const { args, mock } = await setup(t); await step(args); await step(args);
  assert.ok(mock.requests.some(r => r.path === '/api/agent/rooms'));
  assert.ok(mock.requests.every(r => r.path !== `/api/agent/rooms/${CODE}`));
});
test('room inventory rejects malformed, missing, and duplicate entries before send', async t => {
  for (const change of [m => { m.rooms = { rooms: [m.room] }; }, m => { m.rooms = []; }, m => { m.rooms.push(clone(m.room)); }]) {
    const { args, mock } = await setup(t); change(mock);
    await assert.rejects(step(args)); assert.equal(posts(mock).length, 0);
  }
});
test('personal/public rooms, duplicate humans, and missing tester are refused', async t => {
  for (const change of [r => { r.type = 'personal'; }, r => { r.is_public = true; }, r => { r.members.push(clone(r.members[0])); }, r => { r.members = []; }]) {
    const { args, mock } = await setup(t); change(mock.room);
    await assert.rejects(step(args)); assert.equal(posts(mock).length, 0);
  }
});
test('tester leaving or room identity replacement stops before observing a result', async t => {
  const { args, mock } = await setup(t); await step(args); mock.answer('bad');
  const roster = mock.room.members; mock.room.members = [];
  await assert.rejects(step(args), /tester/); mock.room.members = roster;
  mock.room.id = '44444444-4444-4444-8444-444444444444'; mock.room.members[0].room_id = mock.room.id;
  await assert.rejects(step(args), /identity changed/);
  assert.equal(posts(mock).length, 1);
});
test('catalog edits, reordered builds, credential and room changes cannot resume', async t => {
  const { args } = await setup(t); await step(args);
  for (const changed of [
    { ...args, catalog: { ...args.catalog, symptom: 'Other symptom' } },
    { ...args, catalog: { ...args.catalog, builds: [args.catalog.builds[0], args.catalog.builds[2], args.catalog.builds[1], ...args.catalog.builds.slice(3)] } },
    { ...args, connection: { ...args.connection, token: 'different-token' } },
    { ...args, connection: { ...args.connection, room: 'OTHERROOM001' } },
  ]) await assert.rejects(step(changed), /changed/);
});
test('maximum catalog and full search fit bounded durable storage', async t => {
  const { directory, args, mock } = await setup(t, c => {
    c.builds = Array.from({ length: 64 }, (_, i) => ({ revision: `build-${i}`, url: `https://example.com/${'a'.repeat(140)}${i}` }));
    c.knownGood = 'build-0'; c.knownBad = 'build-63';
  });
  let result;
  for (let i = 0; i < 6; i++) {
    await step(args); mock.answer('good'); result = await step(args); if (result.status === 'complete') break;
  }
  assert.equal(result.status, 'complete');
  assert.ok((await stat(join(directory, 'journal.json'))).size < 48000);
  assert.equal((await localStatus(directory, true)).firstBadCandidate.revision, 'build-63');
});
test('journal validates replayed bracket rather than trusting saved result fields', async t => {
  const { directory, args } = await setup(t); await step(args);
  const state = await journal(directory); state.good = 2;
  assert.throws(() => validateState(state), /contradicts/);
  await atomicJson(directory, state); await assert.rejects(localStatus(directory));
});
test('private journal and exported report never contain the credential', async t => {
  const { directory, args } = await setup(t); await step(args); await localStatus(directory, true);
  for (const file of ['journal.json', 'report.json']) {
    assert.ok(!(await readFile(join(directory, file), 'utf8')).includes(TOKEN));
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});
test('invalid local JSON is bounded and parse errors never reveal input', async t => {
  const { directory } = await setup(t); const path = join(directory, 'invalid.json');
  for (const bytes of [Buffer.from([0xc3, 0x28]), '{"secret-token":', 'x'.repeat(65537)]) {
    await writeFile(path, bytes); await assert.rejects(readJson(path), e => !e.message.includes('secret-token'));
  }
  await atomicJson(directory, { saved: true });
  await assert.rejects(atomicJson(directory, { text: 'x'.repeat(65537) }));
  assert.deepEqual(await readJson(join(directory, 'journal.json')), { saved: true });
});
test('symlinked journals and concurrent locks block before any API call', async t => {
  const { directory, args, mock } = await setup(t);
  await mkdir(join(directory, '.lock'));
  await assert.rejects(step(args), /locked/); await rm(join(directory, '.lock'), { recursive: true });
  await writeFile(join(directory, 'outside.json'), '{}'); await symlink(join(directory, 'outside.json'), join(directory, 'journal.json'));
  await assert.rejects(step(args)); assert.equal(mock.requests.length, 0);
});
test('partial environment credentials are rejected instead of falling back', async t => {
  const { directory } = await setup(t); const path = join(directory, 'saved.json');
  await atomicJson(directory, { token: TOKEN, room: CODE }, 'saved.json');
  assert.deepEqual(await connection({}, path), { token: TOKEN, room: CODE });
  for (const env of [{ PINGROOM_TOKEN: TOKEN }, { PINGROOM_ROOM: CODE }, { PINGROOM_TOKEN: '', PINGROOM_ROOM: CODE }, { CI: 'true' }]) await assert.rejects(connection(env, path));
});
test('input rejects ambiguous boundaries, unsafe URLs, invisible edges, and invalid dates', async () => {
  const c = await sampleCatalog();
  for (const value of [
    { ...c, knownBad: c.knownGood }, { ...c, testerId: 'name-only' }, { ...c, ttlSeconds: 29 },
    { ...c, title: '\u115fInvisible' }, { ...c, extra: true },
    { ...c, builds: c.builds.map((b, i) => i ? b : { ...b, url: 'https://example.com/x?token=secret' }) },
    { ...c, builds: c.builds.map((b, i) => i ? b : { ...b, url: 'file:///tmp/example' }) },
  ]) assert.throws(() => catalogValue(value));
  assert.equal(date('2026-02-30T00:00:00Z'), false);
  assert.equal(hash(catalogValue(c)), hash(clone(c)));
});
test('complete-body deadline catches stalled and endlessly ready empty streams', async () => {
  for (const mode of ['stall', 'empty']) {
    let cancelled = false;
    const client = makeClient(TOKEN, { timeoutMs: 30, fetch: async () => new Response(new ReadableStream({
      pull(controller) { if (mode === 'empty') controller.enqueue(new Uint8Array()); },
      cancel() { cancelled = true; },
    })) });
    const start = performance.now(); await assert.rejects(client.rooms.list());
    assert.ok(performance.now() - start < 2000); assert.equal(cancelled, true);
  }
});
test('response size and never-resolving fetch are bounded', async () => {
  for (const fetch of [async () => new Response('x'.repeat(65537)), async () => new Promise(() => {})]) {
    const client = makeClient(TOKEN, { timeoutMs: 30, fetch });
    await assert.rejects(client.rooms.list());
  }
});
