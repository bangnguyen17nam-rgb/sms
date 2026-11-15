import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Against a local Wrangler dev server; never runs against production.
const base = new URL(process.env.SMS_TEST_URL || 'http://127.0.0.1:8790');
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Smoke tests must target a local HTTP server.');
}
const clients = [{ cookie: '' }, { cookie: '' }, { cookie: '' }];
let count = 0;
function verify(value, message) { assert.ok(value, message); count++; }
async function call(client, path, { method = 'GET', body, form, expected = 200, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (client?.cookie) options.headers.cookie = client.cookie;
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (form) options.body = form;
  const response = await fetch(new URL(path, base), options);
  const cookie = response.headers.get('set-cookie');
  if (client && cookie?.startsWith('veil_session=')) client.cookie = cookie.split(';', 1)[0];
  const json = (response.headers.get('content-type') || '').includes('application/json');
  const data = json ? await response.json() : null;
  assert.equal(response.status, expected, method + ' ' + path + ': ' + JSON.stringify(data));
  count++;
  return { data, response };
}

try {
  console.log('Testing ' + base.origin);
  const home = await call(null, '/');
  verify((await home.response.text()).includes('Veil'), 'Web application is served');
  await call(null, '/app.js');
  await call(null, '/api/auth/me', { expected: 401 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const alice = 'smoke_a_' + suffix;
  const bob = 'smoke_b_' + suffix;
  const stranger = 'smoke_c_' + suffix;
  const password = 'Smoke_' + suffix + '_OK';
  for (const [index, username] of [alice, bob, stranger].entries()) {
    const { data } = await call(clients[index], '/api/auth/register', {
      method: 'POST', body: { username, password, displayName: 'Smoke Tester ' + (index + 1) }, expected: 201
    });
    verify(data.user.username === username, 'Registered username');
    verify(clients[index].cookie.startsWith('veil_session='), 'Session cookie');
  }
  const [a, b, c] = clients;
  await call(null, '/api/auth/login', { method: 'POST', body: { username: alice, password: 'incorrect' }, expected: 401 });
  await call(null, '/api/auth/register', {
    method: 'POST', body: { username: alice, password, displayName: 'Duplicate' }, expected: 409
  });
  const me = await call(a, '/api/auth/me');
  verify(me.data.user.username === alice, 'Session belongs to correct user');
  const people = await call(a, '/api/users/search?q=' + encodeURIComponent(bob));
  verify(people.data.users.some(user => user.username === bob), 'Find another user');
  verify(!people.data.users.some(user => user.username === alice), 'Exclude self from search');

  const created = await call(a, '/api/conversations', { method: 'POST', body: { username: bob }, expected: 201 });
  const id = created.data.conversation.id;
  verify(Boolean(id), 'Conversation created');
  const repeated = await call(b, '/api/conversations', { method: 'POST', body: { username: alice }, expected: 201 });
  verify(repeated.data.conversation.id === id, 'Unique direct conversation');
  await call(c, '/api/conversations/' + id + '/messages', { expected: 404 });
  await call(c, '/api/conversations/' + id + '/read', { method: 'POST', body: {}, expected: 404 });

  const clientMessageId = randomUUID();
  const first = await call(a, '/api/conversations/' + id + '/messages', {
    method: 'POST', body: { body: 'Xin chào từ bài kiểm thử!', clientMessageId }, expected: 201
  });
  verify(first.data.message.body.includes('Xin chào'), 'Message persisted');
  const retry = await call(a, '/api/conversations/' + id + '/messages', {
    method: 'POST', body: { body: 'Xin chào từ bài kiểm thử!', clientMessageId }
  });
  verify(first.data.message.id === retry.data.message.id, 'Idempotent resend');
  const history = await call(b, '/api/conversations/' + id + '/messages');
  verify(history.data.messages.some(msg => msg.id === first.data.message.id), 'Recipient reads message');
  const found = await call(b, '/api/conversations/' + id + '/messages/search?q=ki%E1%BB%83m');
  verify(found.data.messages.some(msg => msg.id === first.data.message.id), 'Server search includes matching message');
  const outsiderSearch = await call(c, '/api/conversations/' + id + '/messages/search?q=ki%E1%BB%83m', { expected: 404 });
  verify(Boolean(outsiderSearch.data.error), 'Search protects private conversation');
  const idempotencyConflict = await call(a, '/api/conversations/' + id + '/messages', {
    method: 'POST', body: { body: 'Different content', clientMessageId }, expected: 409
  });
  verify(Boolean(idempotencyConflict.data.error), 'Same id cannot change message contents');
  const wrongSetting = await call(b, '/api/conversations/' + id + '/mute', {
    method: 'POST', body: { muted: 'true' }, expected: 400
  });
  verify(Boolean(wrongSetting.data.error), 'Boolean settings are validated');
  for (let index = 0; index < 54; index++) {
    await call(a, '/api/conversations/' + id + '/messages', {
      method: 'POST', body: { body: 'Pagination test entry ' + index, clientMessageId: randomUUID() }, expected: 201
    });
  }
  const newestPage = await call(b, '/api/conversations/' + id + '/messages?limit=50');
  verify(newestPage.data.messages.length === 50, 'History page size is enforced');
  verify(newestPage.data.hasMore && Boolean(newestPage.data.nextCursor), 'History offers next cursor');
  const oldestPage = await call(b, '/api/conversations/' + id + '/messages?before=' + newestPage.data.nextCursor + '&limit=50');
  verify(oldestPage.data.messages.some(msg => msg.id === first.data.message.id), 'Earlier history is reachable');
  verify(!oldestPage.data.hasMore, 'Last history page has no more cursor');
  const allHistory = [...oldestPage.data.messages, ...newestPage.data.messages];
  verify(new Set(allHistory.map(msg => msg.id)).size === 55, 'Pagination has no duplicate or lost messages');
  const inbox = await call(b, '/api/conversations');
  verify(Number(inbox.data.conversations.find(item => item.id === id)?.unread_count) >= 1, 'Unread count increases');
  await call(b, '/api/conversations/' + id + '/read', { method: 'POST', body: {} });
  const readInbox = await call(b, '/api/conversations');
  verify(Number(readInbox.data.conversations.find(item => item.id === id)?.unread_count) === 0, 'Mark read clears unread');

  await call(b, '/api/conversations/' + id + '/mute', { method: 'POST', body: { muted: true } });
  const muted = await call(b, '/api/conversations');
  verify(Number(muted.data.conversations.find(item => item.id === id)?.muted) === 1, 'Mute persists');
  await call(b, '/api/conversations/' + id + '/archive', { method: 'POST', body: { archived: true } });
  const archive = await call(b, '/api/conversations?archived=1');
  verify(archive.data.conversations.some(item => item.id === id), 'Archive contains chat');
  const active = await call(b, '/api/conversations');
  verify(!active.data.conversations.some(item => item.id === id), 'Archived chat leaves inbox');

  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'test.png');
  form.append('body', 'Hình kiểm thử');
  form.append('clientMessageId', randomUUID());
  const upload = await call(a, '/api/conversations/' + id + '/attachments', { method: 'POST', form, expected: 201 });
  const fileId = upload.data.message.attachment_id;
  verify(Boolean(fileId), 'R2 attachment linked to message');
  const file = await call(b, '/api/attachments/' + fileId);
  verify((await file.response.arrayBuffer()).byteLength === 8, 'Recipient receives stored bytes');
  await call(c, '/api/attachments/' + fileId, { expected: 404 });
  const unarchived = await call(b, '/api/conversations');
  verify(unarchived.data.conversations.some(item => item.id === id), 'New message unarchives chat');

  const changed = await call(a, '/api/profile', { method: 'PATCH', body: { displayName: 'Smoke Renamed' } });
  verify(changed.data.user.displayName === 'Smoke Renamed', 'Profile update');
  await call(a, '/api/auth/logout', { method: 'POST', body: {} });
  await call(a, '/api/auth/me', { expected: 401 });
  await call(null, '/api/auth/login', { method: 'POST', body: { username: alice, password }, expected: 200 });
  await call(b, '/api/conversations', {
    method: 'POST', body: {}, headers: { origin: 'https://untrusted.example' }, expected: 403
  });
  console.log('PASS: ' + count + ' HTTP/API assertions covering auth, chat, access control, archive, unread, mute, profile and R2 attachments.');
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
}
