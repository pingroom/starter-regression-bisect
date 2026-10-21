import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeClient } from '../src/client.mjs';
import { step, localStatus } from '../src/engine.mjs';
import { sampleCatalog, mockTransport, TOKEN, CODE } from './mock.mjs';
const directory = await mkdtemp(join(tmpdir(), 'pingroom-bisect-demo-'));
try {
  const catalog = await sampleCatalog(), mock = mockTransport(catalog);
  const args = { directory, catalog, connection: { token: TOKEN, room: CODE }, client: makeClient(TOKEN, { fetch: mock.fetch }) };
  console.log(`First question: ${(await step(args)).nextCandidate}.`);
  mock.answer('bad'); await step(args);
  console.log(`After tester reports Bad, next question: ${(await step(args)).nextCandidate}.`);
  mock.answer('good'); const result = await step(args);
  console.log(`Candidate boundary: ${result.good} -> ${result.bad}; ${result.status}.`);
  const evidence = await localStatus(directory, true);
  console.log(`Saved ${evidence.observations.length} attributed observations; supplied endpoints and monotonicity remain assumptions.`);
  await step(args);
  console.log(`Replay made no new questions. Total mock questions: ${mock.questions.size}. No artifact fetches or live PingRoom calls.`);
} finally { await rm(directory, { recursive: true, force: true }); }
