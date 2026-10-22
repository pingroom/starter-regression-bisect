import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { step } from '../src/engine.mjs';
import { makeClient } from '../src/client.mjs';
import { sampleCatalog, mockTransport, TOKEN, CODE } from '../scripts/mock.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
// Run the real entrypoint and pinned SDK in an isolated checkout. Every fetch
// is intercepted; an unrecognized route fails instead of reaching the network.
const preload = `
import { appendFileSync, writeFileSync } from 'node:fs';
const room = { id: '22222222-2222-4222-8222-222222222222', invite_code: 'BISCTROOM001', type: 'standard', is_public: false, members: [] };
globalThis.fetch = async (input, init) => {
  const url = new URL(input), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ run: process.env.PROBE_RUN, method: init.method, path }) + '\\n');
  if (path === '/api/agent/auth' && init.method === 'POST') {
    if (process.env.PROBE_MODE === 'lost-register') throw new Error('Lost registration response');
    return Response.json({ credential: 'offline-pending-token', credential_type: 'pre_claim', expires_in: 900 });
  }
  if (path === '/api/agent/auth/pair/start' && init.method === 'POST') {
    if (process.env.PROBE_MODE === 'lost-pair') throw new Error('Lost pairing response');
    return Response.json({ pair_token: 'offline-token', pair_url: 'https://pingroom.io/claim/offline', pair_browser_url: 'https://pingroom.io/claim/offline', expires_in: 900, poll_interval_ms: 1000 });
  }
  if (path === '/api/agent/auth/pair/status' && init.method === 'GET') {
    if (new Headers(init.headers).get('authorization') !== 'Bearer offline-pending-token') throw new Error('Wrong pending credential');
    if (['interrupt', 'hold'].includes(process.env.PROBE_MODE)) {
      writeFileSync(process.env.PROBE_READY, 'ready');
      if (process.env.PROBE_MODE === 'interrupt') setTimeout(() => process.kill(process.pid, 'SIGINT'), 1);
      return Response.json({ status: 'pending' });
    }
    return Response.json({ status: 'active', credential: 'offline-approved-token', credential_type: 'active', expires_in: null, home_room: room, room });
  }
  if (path === '/api/agent/rooms' && init.method === 'GET') return process.env.PROBE_MODE === 'preflight-fail' ? Response.json({}, { status: 403 }) : Response.json([room]);
  throw new Error('Unexpected mock route');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bisect-connect-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of ['src', 'scripts']) await cp(join(source, folder), join(directory, folder), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  return directory;
}
function launch(t, directory, mode = 'active', run = mode) {
  const env = { ...process.env, PROBE_MODE: mode, PROBE_RUN: run, PROBE_LOG: join(directory, 'requests.jsonl'), PROBE_READY: join(directory, 'ready') };
  for (const key of ['NODE_OPTIONS', 'PINGROOM_TOKEN', 'PINGROOM_ROOM', 'CI']) delete env[key];
  const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'scripts/connect.mjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  return { child, done };
}
async function requests(directory) {
  try { return (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function ready(directory) {
  for (let i = 0; i < 100; i++) {
    try { await stat(join(directory, 'ready')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('Mock setup did not reach the pending wait.');
}
const credentialPath = directory => join(directory, '.pingroom', 'credentials.json');
const pairingPath = directory => join(directory, '.pingroom', 'pairing.json');

test('connect preserves an existing credential and resumable journal without API calls', async t => {
  const directory = await fixture(t), catalog = await sampleCatalog(), mock = mockTransport(catalog);
  const args = { directory: join(directory, '.bisect'), catalog, connection: { token: TOKEN, room: CODE }, client: makeClient(TOKEN, { fetch: mock.fetch }) };
  await step(args);
  await mkdir(join(directory, '.pingroom'));
  const credential = JSON.stringify(args.connection), before = await readFile(join(args.directory, 'journal.json'), 'utf8');
  await writeFile(credentialPath(directory), credential);
  const result = await launch(t, directory).done;
  assert.equal(result.code, 1); assert.match(result.stderr, /already exists/);
  assert.deepEqual(await requests(directory), []);
  assert.equal(await readFile(credentialPath(directory), 'utf8'), credential);
  assert.equal(await readFile(join(args.directory, 'journal.json'), 'utf8'), before);
  assert.equal((await step(args)).status, 'pending');
});

test('interrupted entrypoint resumes one private pending pairing with the same credential', async t => {
  const directory = await fixture(t);
  const first = await launch(t, directory, 'interrupt').done;
  assert.equal(first.code, 1);
  const pending = JSON.parse(await readFile(pairingPath(directory), 'utf8'));
  assert.equal(pending.phase, 'pending');
  assert.equal((await stat(pairingPath(directory))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, '.pingroom'))).mode & 0o777, 0o700);
  const second = await launch(t, directory, 'active', 'retry').done;
  assert.equal(second.code, 0, second.stderr);
  const calls = await requests(directory);
  assert.equal(calls.filter(r => r.path === '/api/agent/auth').length, 1);
  assert.equal(calls.filter(r => r.path === '/api/agent/auth/pair/start').length, 1);
  assert.ok(calls.filter(r => r.run === 'retry').every(r => r.method === 'GET'));
  assert.match(first.stdout, /https:\/\/pingroom.io\/claim\/offline/);
  assert.match(second.stdout, /https:\/\/pingroom.io\/claim\/offline/);
  assert.equal(JSON.parse(await readFile(credentialPath(directory), 'utf8')).token, 'offline-approved-token');
  await assert.rejects(readFile(pairingPath(directory)), { code: 'ENOENT' });
});

test('concurrent connect entrypoints cannot create a second robot', async t => {
  const directory = await fixture(t), first = launch(t, directory, 'hold', 'first');
  await ready(directory);
  try {
    const second = await launch(t, directory, 'active', 'second').done;
    assert.equal(second.code, 1); assert.match(second.stderr, /locked/);
    assert.equal((await requests(directory)).filter(r => r.run === 'second').length, 0);
  } finally { first.child.kill('SIGINT'); await first.done; }
});

test('lost registration or pairing responses retain uncertain intent and never retry POST', async t => {
  for (const mode of ['lost-register', 'lost-pair']) {
    const directory = await fixture(t);
    assert.equal((await launch(t, directory, mode).done).code, 1);
    const saved = await readFile(pairingPath(directory), 'utf8');
    assert.equal(JSON.parse(saved).phase, 'creating');
    const retry = await launch(t, directory, 'active', 'retry').done;
    assert.equal(retry.code, 1); assert.match(retry.stderr, /uncertain/);
    assert.equal((await requests(directory)).filter(r => r.run === 'retry').length, 0);
    assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
  }
});

test('expired pending setup refuses a new registration and retains recovery evidence', async t => {
  const directory = await fixture(t);
  await launch(t, directory, 'interrupt').done;
  const pending = JSON.parse(await readFile(pairingPath(directory), 'utf8'));
  pending.createdAt = Date.now() - 3600000;
  const saved = JSON.stringify(pending); await writeFile(pairingPath(directory), saved);
  const result = await launch(t, directory, 'active', 'retry').done;
  assert.equal(result.code, 1); assert.match(result.stderr, /expired/);
  assert.equal((await requests(directory)).filter(r => r.run === 'retry').length, 0);
  assert.equal(await readFile(pairingPath(directory), 'utf8'), saved);
});

test('approved credentials survive room preflight failure and are not replaced on retry', async t => {
  const directory = await fixture(t);
  assert.equal((await launch(t, directory, 'preflight-fail').done).code, 1);
  const saved = await readFile(credentialPath(directory), 'utf8');
  assert.equal(JSON.parse(saved).token, 'offline-approved-token');
  const retry = await launch(t, directory, 'active', 'retry').done;
  assert.equal(retry.code, 1); assert.match(retry.stderr, /already exists/);
  assert.equal((await requests(directory)).filter(r => r.run === 'retry').length, 0);
  assert.equal(await readFile(credentialPath(directory), 'utf8'), saved);
});
