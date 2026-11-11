import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createGenerateHandler } from '../api/generate.js';
import { createFeedbackHandler } from '../api/feedback.js';
import { createStatusHandler } from '../api/status.js';
import { AppError, unavailable } from '../server/errors.js';
import { readConfig } from '../server/env.js';
import { decodeCursor, encodeCursor, validateFeedback, MiB } from '../server/validation.js';
import { createFeedbackStore } from '../server/supabase.js';
import { clientSubject, consumeQuota } from '../server/rate-limit.js';
import { generateImage } from '../server/openai.js';

const origin = 'http://localhost:3000';
const config = {
  origin, openaiKey: 'test-server-key', imageModel: 'gpt-image-2.5-flare',
  supabaseUrl: 'https://example.supabase.co', supabaseKey: 'server-test-secret',
  rateSalt: 'test-only-salt-with-at-least-32-bytes', generationEnabled: true,
  generationDailyLimit: 50, localDev: true,
};
const id = '0cd3032a-9ee8-4c47-9b43-b695f7384fe9';
const input = { clientRequestId: id, nickname: '', content: '좋아요!', consent: true, website: '' };
const request = (path, body, headers = {}) => new Request(`${origin}${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const baseDependencies = { readConfig: () => config, createDatabase: () => ({}), consumeQuota: async () => {} };
const item = { id: 'e4fef9f1-4a50-4404-a52d-bfd0f470752d', nickname: '익명', content: '좋아요!', createdAt: '2026-11-11T03:00:00.123456+00:00' };
const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ad80d9' } }).png().toBuffer();
const formRequest = (fields = { mode: 'prompt', prompt: '보라 고양이' }) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(`${origin}/api/generate`, { method: 'POST', headers: { origin }, body: form });
};

test('status returns only configuration flags, never environment values', async () => {
  const handler = createStatusHandler({ readConfig: () => config });
  const response = await handler(new Request(`${origin}/api/status`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { aiConfigured: true, feedbackConfigured: true, localPreview: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('missing AI key keeps independent feedback capability available', async () => {
  const handler = createStatusHandler({ readConfig: () => ({ ...config, openaiKey: '' }) });
  assert.deepEqual(await (await handler(new Request(`${origin}/api/status`))).json(), { aiConfigured: false, feedbackConfigured: true, localPreview: true });
});

test('unsupported methods advertise Allow and cross-site writes are forbidden', async () => {
  const handler = createFeedbackHandler(baseDependencies);
  const method = await handler(new Request(`${origin}/api/feedback`, { method: 'DELETE' }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, POST');
  assert.equal((await handler(request('/api/feedback', input, { origin: 'https://elsewhere.test' }))).status, 403);
  const without = request('/api/feedback', input);
  without.headers.delete('origin');
  assert.equal((await handler(without)).status, 403);
});

test('invalid prompt is rejected before key/config dependencies or provider', async () => {
  let dependencyCalls = 0;
  const handler = createGenerateHandler({ ...baseDependencies, requireAiConfig: () => { dependencyCalls++; throw unavailable(); } });
  assert.equal((await handler(formRequest({ mode: 'prompt', prompt: '  ' }))).status, 400);
  assert.equal(dependencyCalls, 0);
  assert.equal((await handler(formRequest())).status, 503);
  assert.equal(dependencyCalls, 1);
});

test('multipart rejects duplicates, unknown fields, wrong modes and oversized streaming bodies', async () => {
  const handler = createGenerateHandler(baseDependencies);
  const form = new FormData();
  form.append('mode', 'prompt'); form.append('prompt', 'cat'); form.append('prompt', 'dog');
  assert.equal((await handler(new Request(`${origin}/api/generate`, { method: 'POST', headers: { origin }, body: form }))).status, 400);
  assert.equal((await handler(formRequest({ mode: 'other', prompt: 'cat' }))).status, 400);
  assert.equal((await handler(formRequest({ mode: 'prompt', prompt: 'cat', unexpected: 'value' }))).status, 400);
  const huge = new Request(`${origin}/api/generate`, { method: 'POST', headers: { origin, 'content-type': 'multipart/form-data; boundary=test' }, body: Buffer.alloc(3 * MiB + 1) });
  assert.equal((await handler(huge)).status, 413);
});

test('image validation rejects forged PNG and unexpected dimensions before provider', async () => {
  let calls = 0;
  const handler = createGenerateHandler({ ...baseDependencies, generateImage: async () => { calls++; } });
  const fake = new File(['<html>not an image</html>'], 'image.png', { type: 'image/png' });
  assert.equal((await handler(formRequest({ mode: 'image', image: fake }))).status, 400);
  const tiny = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal((await handler(formRequest({ mode: 'image', image: new File([tiny], 'image.png', { type: 'image/png' }) }))).status, 400);
  const animationChunk = Buffer.alloc(20);
  animationChunk.writeUInt32BE(8);
  animationChunk.write('acTL', 4);
  const animated = Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)]);
  assert.equal((await handler(formRequest({ mode: 'image', image: new File([animated], 'image.png', { type: 'image/png' }) }))).status, 400);
  assert.equal(calls, 0);
});

test('quota failure and quota denial prevent provider invocation', async () => {
  let calls = 0;
  const handler = createGenerateHandler({
    ...baseDependencies, consumeQuota: async () => { throw unavailable(); },
    createImageClient: () => { calls++; },
  });
  assert.equal((await handler(formRequest())).status, 503);
  assert.equal(calls, 0);
  const denied = createGenerateHandler({ ...baseDependencies, consumeQuota: async () => {
    throw new AppError(429, 'DAILY_LIMIT', '한도 초과', { retryAfterSeconds: 120 });
  }, createImageClient: () => { calls++; } });
  const response = await denied(formRequest());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '120');
  assert.equal((await response.json()).error.retryAfterSeconds, 120);
  assert.equal(calls, 0);
});

test('prompt and image route call the correct provider once and return normalized 512 PNG', async () => {
  const calls = [];
  const fakeClient = { images: {
    generate: async (options) => { calls.push(['generate', options]); return { data: [{ b64_json: png.toString('base64') }] }; },
    edit: async (options) => { calls.push(['edit', options]); return { data: [{ b64_json: png.toString('base64') }] }; },
  } };
  const handler = createGenerateHandler({ ...baseDependencies, createImageClient: () => fakeClient });
  const generated = await handler(formRequest());
  assert.equal(generated.status, 200);
  const data = await generated.json();
  assert.equal(data.mimeType, 'image/png');
  assert.equal(data.width, 512);
  assert.equal((await sharp(Buffer.from(data.imageBase64, 'base64')).metadata()).width, 512);
  const edited = await handler(formRequest({ mode: 'image', image: new File([png], 'safe.png', { type: 'image/png' }), prompt: '' }));
  assert.equal(edited.status, 200);
  assert.deepEqual(calls.map(([kind]) => kind), ['generate', 'edit']);
  assert.equal(calls[0][1].n, 1);
  assert.equal(calls[1][1].image.type, 'image/png');
  assert.equal(calls[0][1].model, config.imageModel);
});

test('provider rejection, timeout, authentication and malformed output map to safe errors', async () => {
  for (const [failure, expected] of [
    [{ code: 'content_policy_violation', message: 'secret internal detail' }, 422],
    [{ name: 'APIConnectionTimeoutError' }, 504],
    [{ status: 401 }, 503], [{ status: 429 }, 503], [{ status: 500 }, 502],
  ]) {
    const client = { images: { generate: async () => { throw failure; } } };
    await assert.rejects(generateImage(client, { mode: 'prompt', prompt: 'cat' }, config), (error) => error.status === expected && !error.message.includes('secret'));
  }
  await assert.rejects(generateImage({ images: { generate: async () => ({ data: [{ url: 'https://untrusted.example/image' }] }) } }, { mode: 'prompt', prompt: 'cat' }, config), (error) => error.status === 502);
});

test('feedback validates codepoints, consent, spam trap and unknown properties', () => {
  assert.equal(validateFeedback({ ...input, content: '😀'.repeat(500) }).content.length, 1000);
  assert.equal(validateFeedback(input).nickname, '익명');
  assert.throws(() => validateFeedback({ ...input, content: '😀'.repeat(501) }));
  assert.throws(() => validateFeedback({ ...input, content: '   ' }));
  assert.throws(() => validateFeedback({ ...input, consent: false }), (error) => error.status === 403);
  assert.throws(() => validateFeedback({ ...input, consent: 'true' }), (error) => error.status === 400);
  assert.throws(() => validateFeedback({ ...input, website: 'spam' }));
  assert.throws(() => validateFeedback({ ...input, nickname: 'a'.repeat(21) }));
  assert.throws(() => validateFeedback({ ...input, nickname: '\ud800' }));
  assert.throws(() => validateFeedback({ ...input, admin: true }));
});

test('invalid feedback JSON and UTF8 fail before configuration, not fake success', async () => {
  let configCalls = 0;
  const handler = createFeedbackHandler({ ...baseDependencies, requireFeedbackConfig: () => { configCalls++; throw unavailable(); } });
  assert.equal((await handler(request('/api/feedback', { ...input, content: '' }))).status, 400);
  const utf8 = new Request(`${origin}/api/feedback`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: new Uint8Array([0xc3, 0x28]) });
  assert.equal((await handler(utf8)).status, 400);
  assert.equal(configCalls, 0);
  assert.equal((await handler(request('/api/feedback', input))).status, 503);
  assert.equal(configCalls, 1);
});

test('feedback response status distinguishes first write and replay', async () => {
  for (const replay of [false, true]) {
    const handler = createFeedbackHandler({ ...baseDependencies, createFeedbackStore: () => ({ insert: async (normalized) => {
      assert.equal(normalized.nickname, '익명'); return { item, replay };
    } }) });
    const response = await handler(request('/api/feedback', input));
    assert.equal(response.status, replay ? 200 : 201);
    assert.deepEqual(await response.json(), { item });
  }
});

test('cursor preserves microseconds and rejects injection and invalid dates', () => {
  const row = { id: item.id, created_at: item.createdAt };
  const cursor = encodeCursor(row);
  assert.deepEqual(decodeCursor(cursor), { id: item.id, createdAt: item.createdAt });
  for (const createdAt of ['2026-02-30T03:00:00+00:00', '2026-11-11T03:00:00Z),id.gt.0', 'invalid']) {
    const value = Buffer.from(JSON.stringify({ id: item.id, createdAt })).toString('base64url');
    assert.throws(() => decodeCursor(value), (error) => error.code === 'INVALID_CURSOR');
  }
  assert.throws(() => decodeCursor('x'.repeat(513)));
});

test('feedback list rejects duplicate cursors and unknown query parameters', async () => {
  const handler = createFeedbackHandler(baseDependencies);
  for (const query of ['?limit=100000', '?cursor=a&cursor=b', '?cursor=']) {
    assert.equal((await handler(new Request(`${origin}/api/feedback${query}`))).status, 400);
  }
});

test('DB store reads 21, returns 20, and uses exact timestamp for next cursor', async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(1000 - index).padStart(12, '0')}`, nickname: '익명', content: String(index), created_at: item.createdAt }));
  const operations = [];
  const query = {
    select: (columns) => { assert.ok(!columns.includes('*')); return query; },
    order: (column, direction) => { operations.push([column, direction]); return query; },
    limit: (n) => { assert.equal(n, 21); return query; },
    or: (condition) => { operations.push(condition); return query; },
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  const store = createFeedbackStore({ from: () => query });
  const list = await store.list({ createdAt: item.createdAt, id: item.id });
  assert.equal(list.items.length, 20);
  assert.equal(decodeCursor(list.nextCursor).createdAt, item.createdAt);
  assert.equal(decodeCursor(list.nextCursor).id, rows[19].id);
  assert.match(operations[2], /\.123456\+00:00/);
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['content', 'createdAt', 'id', 'nickname']);
});

test('DB unique conflict only replays identical normalized public payload', async () => {
  const saved = { ...item, created_at: item.createdAt, public_consent: true };
  const db = {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ error: { code: '23505', message: 'duplicate key violates feedback_request_unique' } }) }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: saved, error: null }) }) }),
    }),
  };
  const store = createFeedbackStore(db);
  assert.equal((await store.insert(validateFeedback(input))).replay, true);
  await assert.rejects(store.insert(validateFeedback({ ...input, content: '바뀐 내용' })), (error) => error.status === 409);
});

test('quota RPC is fail-closed and exposes safe retry metadata', async () => {
  const req = new Request(`${origin}/api/feedback`);
  await assert.rejects(consumeQuota({ rpc: async () => ({ error: { message: 'secret' }, data: null }) }, req, config, 'feedback_read'), (error) => error.status === 503);
  await assert.rejects(consumeQuota({ rpc: async () => ({ data: [{ allowed: false, reason: 'global', retry_at: new Date(Date.now() + 60000).toISOString() }] }) }, req, config, 'generation'), (error) => error.code === 'DAILY_LIMIT' && error.retryAfterSeconds >= 59);
  let args;
  await consumeQuota({ rpc: async (name, inputArgs) => { args = inputArgs; assert.equal(name, 'consume_quota'); return { data: [{ allowed: true }] }; } }, req, config, 'feedback_write');
  assert.equal(args.p_scope, 'feedback_write');
  assert.match(args.p_subject, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(args).includes('127.0.0.1'));
});

test('subject hashes normalize IPv6, vary by UTC date, and reject missing trusted production IP', () => {
  const prod = { ...config, localDev: false };
  const now = new Date('2026-11-11T01:00:00Z');
  const make = (ip) => new Request(`${origin}/api/feedback`, { headers: { 'x-vercel-forwarded-for': ip } });
  assert.equal(clientSubject(make('2001:0db8:0:0:0:0:0:1'), prod, now), clientSubject(make('2001:db8::1'), prod, now));
  assert.equal(clientSubject(make('::ffff:127.0.0.1'), prod, now), clientSubject(make('127.0.0.1'), prod, now));
  assert.notEqual(clientSubject(make('127.0.0.1'), prod, now), clientSubject(make('127.0.0.1'), prod, new Date('2026-11-12T01:00:00Z')));
  assert.throws(() => clientSubject(new Request(`${origin}/api/feedback`), prod, now), (error) => error.status === 503);
  assert.equal(readConfig({ LOCAL_DEV: 'true', VERCEL: '1' }).localDev, false);
});
