import { PingRoom } from '@pingroom/sdk';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { API_ORIGIN, tokenValue, requireValue } from './model.mjs';

async function boundedFetch(transport, input, init, timeoutMs) {
  const deadline = new AbortController();
  const signal = AbortSignal.any([init.signal, deadline.signal].filter(Boolean));
  const expiresAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => deadline.abort(new Error('Request deadline exceeded.')), timeoutMs);
  let reader, response, onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('Request ended before a bounded response was read.'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const read = async () => {
    response = await transport(input, { ...init, signal, redirect: 'error' });
    signal.throwIfAborted();
    const size = response.headers.get('content-length');
    requireValue(size === null || /^\d+$/.test(size) && Number(size) <= 65536,
      'API response exceeds its byte limit.');
    if (!response.body) return response;
    reader = response.body.getReader();
    const chunks = [];
    let length = 0, reads = 0;
    while (true) {
      signal.throwIfAborted();
      requireValue(performance.now() < expiresAt, 'Response read exceeded its deadline.');
      const part = await reader.read();
      requireValue(performance.now() < expiresAt, 'Response read exceeded its deadline.');
      if (part.done) break;
      length += part.value.byteLength;
      requireValue(length <= 65536, 'API response exceeds 64 KiB.');
      if (part.value.byteLength) chunks.push(part.value);
      // Ready empty chunks must neither accumulate nor starve the deadline.
      if (++reads % 64 === 0) await setImmediate();
    }
    return new Response(Buffer.concat(chunks, length), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
  try { return await Promise.race([read(), aborted]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    // Do not let a broken transport's cancellation block the deadline.
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

export function makeClient(token, { fetch: transport = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (token !== undefined) tokenValue(token);
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
    'Request deadline must be 1–30000 milliseconds.');
  return new PingRoom({
    token, baseUrl: API_ORIGIN, timeoutMs,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requireValue(url.origin === API_ORIGIN && url.pathname.startsWith('/api/agent/'),
        'Only the configured PingRoom API origin is permitted.');
      const response = await boundedFetch(transport, input, init, timeoutMs);
      return response;
    },
  });
}
