import { readFile } from 'node:fs/promises';
export const TOKEN = 'offline-bisect-token';
export const CODE = 'BISCTROOM001';
export const ROOM_ID = '22222222-2222-4222-8222-222222222222';
export const ASKER_ID = '33333333-3333-4333-8333-333333333333';
export async function sampleCatalog() { return JSON.parse(await readFile(new URL('../examples/catalog.json', import.meta.url), 'utf8')); }
export function mockTransport(catalog) {
  const room = { id: ROOM_ID, invite_code: CODE, type: 'standard', is_public: false, members: [
    { room_id: ROOM_ID, user_id: catalog.testerId, user: { name: 'Offline tester' } },
  ] };
  const requests = [], questions = new Map();
  const mock = {
    room, rooms: [room], requests, questions, loseCreate: false, malformedCreate: false, failRead: false, beforeCreate: null, afterCreate: null,
    get last() { return [...questions.values()].at(-1); },
    answer(value, id = mock.last.id) {
      const q = questions.get(id);
      q.state = 'answered'; q.resolved_at = q.created_at;
      q.answer = { value, label: q.options.find(o => o.value === value)?.label, text: null, responder: { id: catalog.testerId }, answered_at: q.created_at };
    },
    close(state) {
      mock.last.state = state;
      mock.last.resolved_at = state === 'expired' ? mock.last.expires_at : mock.last.created_at;
    },
    async fetch(input, init) {
      const url = new URL(input), body = init.body ? JSON.parse(init.body) : null;
      requests.push({ method: init.method, path: url.pathname, body, headers: new Headers(init.headers) });
      if (url.pathname === '/api/agent/rooms' && init.method === 'GET') return Response.json(mock.rooms);
      if (url.pathname === `/api/agent/rooms/${CODE}/questions` && init.method === 'POST') {
        await mock.beforeCreate?.(body);
        const id = `00000000-0000-4000-8000-${String(questions.size + 1).padStart(12, '0')}`;
        const created = new Date();
        const q = { id, kind: 'question', is_handoff: false, room_code: CODE, room: { code: CODE },
          prompt: body.prompt, context: body.context,
          options: body.options.map(o => ({ value: o.value, label: o.label, primary: false, destructive: false })),
          text_input: null, responder_scope: body.responder_scope, target_user_id: body.target_user_id,
          resolution_policy: 'first', results: null, reply_to: null, state: 'pending', answer: null,
          correlation_id: body.correlation_id, data: body.data, created_at: created.toISOString(),
          expires_at: new Date(+created + body.ttl * 1000).toISOString(), resolved_at: null,
          asker: { type: 'agent', id: ASKER_ID } };
        questions.set(id, q);
        await mock.afterCreate?.(q);
        if (mock.loseCreate) throw new Error('Lost response with private details');
        return Response.json(mock.malformedCreate ? {} : q, { status: 201 });
      }
      if (url.pathname === '/api/agent/questions' && init.method === 'GET') return Response.json({ questions: [...questions.values()] });
      if (url.pathname.startsWith('/api/agent/questions/') && init.method === 'GET') {
        if (mock.failRead) return Response.json({ message: 'Private API error' }, { status: 503 });
        const q = questions.get(url.pathname.split('/').at(-1));
        return q ? Response.json(q) : Response.json({}, { status: 404 });
      }
      throw new Error('Unexpected mock route');
    },
  };
  return mock;
}
