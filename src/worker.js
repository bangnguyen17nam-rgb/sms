const SESSION_COOKIE = "veil_session";
const SESSION_DAYS = 30;
const PASSWORD_ITERATIONS = 100_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_SEARCH_LENGTH = 100;
const MAX_HISTORY_PAGE_SIZE = 100;
const SAFE_INLINE_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: fromBase64Url(salt),
    iterations
  }, key, 256);
  return base64Url(new Uint8Array(bits));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function parseCookies(request) {
  const values = {};
  for (const item of (request.headers.get("cookie") || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    values[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return values;
}

function sessionCookie(token, request, maxAge = SESSION_DAYS * 86400) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name };
}

async function readJson(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Yêu cầu phải gửi dữ liệu JSON.");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_JSON_BYTES) throw new HttpError(413, "Dữ liệu gửi lên quá lớn.");
  if (!request.body) throw new HttpError(400, "Dữ liệu gửi lên không hợp lệ.");

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Dữ liệu gửi lên quá lớn.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const data = JSON.parse(new TextDecoder().decode(buffer));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(400, "Dữ liệu gửi lên phải là một đối tượng JSON.");
    }
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Dữ liệu gửi lên không hợp lệ.");
  }
}

function inputString(value) {
  return typeof value === "string" ? value : "";
}

function validateClientMessageId(value) {
  const id = inputString(value);
  if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(id)) throw new HttpError(400, "Mã tin nhắn không hợp lệ.");
  return id;
}

function parsePageLimit(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  if (!/^[1-9][0-9]{0,2}$/u.test(raw)) throw new HttpError(400, "Giới hạn số tin nhắn không hợp lệ.");
  const limit = Number(raw);
  if (limit > MAX_HISTORY_PAGE_SIZE) throw new HttpError(400, "Tối đa 100 tin nhắn mỗi trang.");
  return limit;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new HttpError(400, `Trường ${field} phải là true hoặc false.`);
  return value;
}

function cleanFileName(value) {
  const name = String(value || "tep-dinh-kem")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/]/gu, "_")
    .trim();
  return (name || "tep-dinh-kem").slice(0, 180);
}

function cleanContentType(value) {
  const type = String(value || "application/octet-stream").toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(type)
    ? type
    : "application/octet-stream";
}

function contentDisposition(fileName, inline = false) {
  const fallback = fileName.replace(/[^a-zA-Z0-9._ -]/gu, "_").replaceAll('"', "_") || "download";
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function assertSameOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Nguồn yêu cầu không hợp lệ.");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    throw new HttpError(403, "Nguồn yêu cầu không hợp lệ.");
  }
  const referer = request.headers.get("referer");
  if (!origin && referer) {
    let refererOrigin;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      throw new HttpError(403, "Nguồn yêu cầu không hợp lệ.");
    }
    if (refererOrigin !== new URL(request.url).origin) throw new HttpError(403, "Nguồn yêu cầu không hợp lệ.");
  }
}

async function createSession(env, userId, request) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt, nowIso()).run();
  return sessionCookie(token, request);
}

async function requireUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !/^[a-zA-Z0-9_-]{43}$/u.test(token)) throw new HttpError(401, "Bạn cần đăng nhập.");
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT u.id, u.username, u.display_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  if (!user) throw new HttpError(401, "Phiên đăng nhập đã hết hạn.");
  return user;
}

async function ensureConversationMember(env, conversationId, userId) {
  const member = await env.DB.prepare(
    "SELECT 1 AS allowed FROM conversation_members WHERE conversation_id = ? AND user_id = ?"
  ).bind(conversationId, userId).first();
  if (!member) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.");
}

const conversationSelect = `
  SELECT
    c.id,
    c.updated_at,
    other.id AS other_user_id,
    other.username AS other_username,
    other.display_name AS other_display_name,
    mine.archived_at,
    mine.muted,
    latest.sender_id AS last_sender_id,
    latest.sent_at AS last_message_at,
    COALESCE(NULLIF(latest.body, ''), CASE WHEN latest_file.id IS NOT NULL THEN '📎 ' || latest_file.file_name ELSE '' END) AS last_message,
    (
      SELECT COUNT(*)
      FROM messages unread
      WHERE unread.conversation_id = c.id
        AND unread.sender_id <> mine.user_id
        AND unread.rowid > mine.last_read_message_rowid
    ) AS unread_count
  FROM conversations c
  JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
  JOIN conversation_members theirs ON theirs.conversation_id = c.id AND theirs.user_id <> mine.user_id
  JOIN users other ON other.id = theirs.user_id
  LEFT JOIN messages latest ON latest.id = (
    SELECT recent.id FROM messages recent WHERE recent.conversation_id = c.id
    ORDER BY recent.sent_at DESC, recent.rowid DESC LIMIT 1
  )
  LEFT JOIN attachments latest_file ON latest_file.id = latest.attachment_id
`;

async function getConversation(env, conversationId, userId) {
  return env.DB.prepare(`${conversationSelect} WHERE c.id = ?`).bind(userId, conversationId).first();
}

async function getMessage(env, messageId) {
  return env.DB.prepare(`
    SELECT
      m.id, m.conversation_id, m.sender_id, m.body, m.client_message_id, m.sent_at,
      u.username, u.display_name,
      a.id AS attachment_id, a.file_name AS attachment_name,
      a.content_type AS attachment_type, a.byte_size AS attachment_bytes
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.id = ?
  `).bind(messageId).first();
}

async function findRepeatedMessage(env, conversationId, senderId, clientMessageId, body, attachment = null) {
  const previous = await env.DB.prepare(`
    SELECT m.id, m.conversation_id, m.body, m.attachment_id,
      a.file_name, a.content_type, a.byte_size
    FROM messages m
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.sender_id = ? AND m.client_message_id = ?
  `).bind(senderId, clientMessageId).first();
  if (!previous) return null;
  if (
    previous.conversation_id !== conversationId ||
    previous.body !== (body || null) ||
    Boolean(previous.attachment_id) !== Boolean(attachment) ||
    (attachment && (
      previous.file_name !== attachment.name ||
      previous.content_type !== attachment.type ||
      Number(previous.byte_size) !== attachment.size
    ))
  ) {
    throw new HttpError(409, "Mã tin nhắn đã được dùng cho một nội dung khác.");
  }
  return getMessage(env, previous.id);
}

async function loadConversationMessages(url, env, conversationId, user, search = false) {
  await ensureConversationMember(env, conversationId, user.id);
  const limit = parsePageLimit(url);
  const query = inputString(url.searchParams.get("q")).trim().toLowerCase();
  if (search && query.length < 2) return json({ messages: [], hasMore: false, nextCursor: null });
  if (query.length > MAX_SEARCH_LENGTH) throw new HttpError(400, "Từ khóa tìm kiếm quá dài.");

  const before = url.searchParams.get("before");
  let cursor = null;
  if (before !== null) {
    if (!/^[a-z0-9-]{36}$/iu.test(before)) throw new HttpError(400, "Con trỏ phân trang không hợp lệ.");
    cursor = await env.DB.prepare("SELECT sent_at, rowid AS sequence FROM messages WHERE id = ? AND conversation_id = ?")
      .bind(before, conversationId).first();
    if (!cursor) throw new HttpError(400, "Con trỏ phân trang không hợp lệ.");
  }

  const parameters = [conversationId];
  let where = "WHERE m.conversation_id = ?";
  if (search) {
    where += " AND (instr(lower(COALESCE(m.body, '')), ?) > 0 OR instr(lower(COALESCE(a.file_name, '')), ?) > 0)";
    parameters.push(query, query);
  }
  if (cursor) {
    where += " AND (m.sent_at < ? OR (m.sent_at = ? AND m.rowid < ?))";
    parameters.push(cursor.sent_at, cursor.sent_at, cursor.sequence);
  }
  parameters.push(limit + 1);
  const { results } = await env.DB.prepare(`
    SELECT
      m.id, m.conversation_id, m.sender_id, m.body, m.client_message_id, m.sent_at,
      u.username, u.display_name,
      a.id AS attachment_id, a.file_name AS attachment_name,
      a.content_type AS attachment_type, a.byte_size AS attachment_bytes
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    ${where}
    ORDER BY m.sent_at DESC, m.rowid DESC
    LIMIT ?
  `).bind(...parameters).all();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const nextCursor = hasMore ? page.at(-1).id : null;
  return json({ messages: search ? page : page.reverse(), hasMore, nextCursor });
}

async function handleRegister(request, env) {
  const body = await readJson(request);
  const username = inputString(body.username).trim().toLowerCase();
  const password = inputString(body.password);
  const displayName = inputString(body.displayName).trim();
  const fields = {};
  if (!/^[a-z0-9_]{5,30}$/u.test(username)) fields.username = "Dùng 5–30 ký tự: chữ thường, số hoặc dấu gạch dưới.";
  if (password.length < 5 || password.length > 128) fields.password = "Mật khẩu cần từ 5 đến 128 ký tự.";
  if (!displayName || displayName.length > 50) fields.displayName = "Tên hiển thị cần từ 1 đến 50 ký tự.";
  if (Object.keys(fields).length) throw new HttpError(400, "Vui lòng kiểm tra thông tin đăng ký.", { fields });

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
  if (exists) throw new HttpError(409, "Tên tài khoản đã được sử dụng.", { fields: { username: "Hãy chọn tên tài khoản khác." } });

  const salt = randomToken(16);
  const passwordHash = await derivePassword(password, salt);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`
      INSERT INTO users (id, username, display_name, password_salt, password_hash, password_iterations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, username, displayName, salt, passwordHash, PASSWORD_ITERATIONS, nowIso()).run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "Tên tài khoản đã được sử dụng.");
    throw error;
  }
  const cookie = await createSession(env, id, request);
  return json({ user: { id, username, displayName } }, 201, { "set-cookie": cookie });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const username = inputString(body.username).trim().toLowerCase();
  const password = inputString(body.password);
  if (!/^[a-z0-9_]{5,30}$/u.test(username) || password.length < 1 || password.length > 128) {
    throw new HttpError(401, "Tên tài khoản hoặc mật khẩu không đúng.");
  }
  const user = await env.DB.prepare(`
    SELECT id, username, display_name, password_salt, password_hash, password_iterations
    FROM users WHERE username = ?
  `).bind(username).first();
  if (!user) throw new HttpError(401, "Tên tài khoản hoặc mật khẩu không đúng.");
  const candidate = await derivePassword(password, user.password_salt, Number(user.password_iterations));
  if (!constantTimeEqual(candidate, user.password_hash)) throw new HttpError(401, "Tên tài khoản hoặc mật khẩu không đúng.");
  const cookie = await createSession(env, user.id, request);
  return json({ user: publicUser(user) }, 200, { "set-cookie": cookie });
}

async function handleLogout(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

async function handleProfile(request, env, user) {
  const body = await readJson(request);
  const displayName = inputString(body.displayName).trim();
  if (!displayName || displayName.length > 50) throw new HttpError(400, "Tên hiển thị cần từ 1 đến 50 ký tự.");
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, user.id).run();
  return json({ user: { id: user.id, username: user.username, displayName } });
}

async function handleUserSearch(url, env, user) {
  const query = inputString(url.searchParams.get("q")).trim().toLowerCase().replace(/^@/u, "");
  if (query.length < 2) return json({ users: [] });
  if (query.length > MAX_SEARCH_LENGTH) throw new HttpError(400, "Từ khóa tìm kiếm quá dài.");
  const { results } = await env.DB.prepare(`
    SELECT id, username, display_name
    FROM users
    WHERE id <> ? AND (instr(username, ?) > 0 OR instr(lower(display_name), ?) > 0)
    ORDER BY username
    LIMIT 12
  `).bind(user.id, query, query).all();
  return json({ users: results.map((item) => publicUser(item)) });
}

async function handleConversationList(url, env, user) {
  const archived = url.searchParams.get("archived") === "1";
  const { results } = await env.DB.prepare(`
    ${conversationSelect}
    WHERE ${archived ? "mine.archived_at IS NOT NULL" : "mine.archived_at IS NULL"}
    ORDER BY COALESCE(latest.sent_at, c.updated_at) DESC
  `).bind(user.id).all();
  const count = await env.DB.prepare(`
    SELECT COUNT(*) AS total FROM conversation_members WHERE user_id = ? AND archived_at IS NOT NULL
  `).bind(user.id).first();
  return json({ conversations: results, archiveCount: Number(count?.total || 0) });
}

async function handleConversationCreate(request, env, user) {
  const body = await readJson(request);
  const username = inputString(body.username).trim().toLowerCase().replace(/^@/u, "");
  const other = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (!other) throw new HttpError(404, "Không tìm thấy tài khoản này.");
  if (other.id === user.id) throw new HttpError(400, "Bạn không thể tự nhắn cho chính mình.");
  const directKey = [user.id, other.id].sort().join(":");
  let conversation = await env.DB.prepare("SELECT id FROM conversations WHERE direct_key = ?").bind(directKey).first();
  if (!conversation) {
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO conversations (id, direct_key, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(id, directKey, timestamp, timestamp),
        env.DB.prepare("INSERT INTO conversation_members (conversation_id, user_id, last_read_at, muted) VALUES (?, ?, ?, 0)").bind(id, user.id, timestamp),
        env.DB.prepare("INSERT INTO conversation_members (conversation_id, user_id, last_read_at, muted) VALUES (?, ?, ?, 0)").bind(id, other.id, timestamp)
      ]);
      conversation = { id };
    } catch (error) {
      conversation = await env.DB.prepare("SELECT id FROM conversations WHERE direct_key = ?").bind(directKey).first();
      if (!conversation) throw error;
    }
  }
  await env.DB.prepare("UPDATE conversation_members SET archived_at = NULL WHERE conversation_id = ? AND user_id = ?")
    .bind(conversation.id, user.id).run();
  const item = await getConversation(env, conversation.id, user.id);
  return json({ conversation: item }, 201);
}

async function handleMessageCreate(request, env, conversationId, user) {
  await ensureConversationMember(env, conversationId, user.id);
  const input = await readJson(request);
  const body = inputString(input.body).trim();
  if (!body) throw new HttpError(400, "Tin nhắn không được để trống.");
  if (body.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, `Tin nhắn tối đa ${MAX_MESSAGE_LENGTH} ký tự.`);
  const clientMessageId = validateClientMessageId(input.clientMessageId);
  const repeated = await findRepeatedMessage(env, conversationId, user.id, clientMessageId, body);
  if (repeated) return json({ message: repeated });

  const id = crypto.randomUUID();
  const timestamp = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, body, client_message_id, sent_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, conversationId, user.id, body, clientMessageId, timestamp),
      env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(timestamp, conversationId),
      env.DB.prepare("UPDATE conversation_members SET archived_at = NULL WHERE conversation_id = ?").bind(conversationId)
    ]);
  } catch (error) {
    // A retry can race with the original request; the unique index decides the winner.
    const winner = await findRepeatedMessage(env, conversationId, user.id, clientMessageId, body);
    if (winner) return json({ message: winner });
    throw error;
  }
  return json({ message: await getMessage(env, id) }, 201);
}

async function handleAttachmentCreate(request, env, conversationId, user) {
  await ensureConversationMember(env, conversationId, user.id);
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Dữ liệu tệp không hợp lệ.");
  }
  const file = form.get("file") || form.get("image");
  if (!file || typeof file.stream !== "function") throw new HttpError(400, "Chưa chọn tệp cần gửi.");
  if (!file.size) throw new HttpError(400, "Không thể gửi tệp rỗng.");
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "Tệp tối đa 10 MB.");
  const body = inputString(form.get("body")).trim();
  if (body.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, `Chú thích tối đa ${MAX_MESSAGE_LENGTH} ký tự.`);
  const clientMessageId = validateClientMessageId(form.get("clientMessageId"));
  const attachmentId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const timestamp = nowIso();
  const fileName = cleanFileName(file.name);
  const contentType = cleanContentType(file.type);
  const repeated = await findRepeatedMessage(env, conversationId, user.id, clientMessageId, body, {
    name: fileName, type: contentType, size: file.size
  });
  if (repeated) return json({ message: repeated });
  const objectKey = `${conversationId}/${timestamp.slice(0, 10)}/${attachmentId}`;
  await env.ATTACHMENTS.put(objectKey, file.stream(), {
    httpMetadata: { contentType },
    customMetadata: { fileName, uploaderId: user.id, conversationId }
  });
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO attachments (id, conversation_id, uploader_id, r2_key, file_name, content_type, byte_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(attachmentId, conversationId, user.id, objectKey, fileName, contentType, file.size, timestamp),
      env.DB.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, body, client_message_id, attachment_id, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(messageId, conversationId, user.id, body || null, clientMessageId, attachmentId, timestamp),
      env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(timestamp, conversationId),
      env.DB.prepare("UPDATE conversation_members SET archived_at = NULL WHERE conversation_id = ?").bind(conversationId)
    ]);
  } catch (error) {
    await env.ATTACHMENTS.delete(objectKey);
    const winner = await findRepeatedMessage(env, conversationId, user.id, clientMessageId, body, {
      name: fileName, type: contentType, size: file.size
    });
    if (winner) return json({ message: winner });
    throw error;
  }
  return json({ message: await getMessage(env, messageId) }, 201);
}

async function handleAttachmentGet(request, env, attachmentId, user) {
  const attachment = await env.DB.prepare(`
    SELECT a.id, a.r2_key, a.file_name, a.content_type, a.byte_size
    FROM attachments a
    JOIN conversation_members member ON member.conversation_id = a.conversation_id AND member.user_id = ?
    WHERE a.id = ?
  `).bind(user.id, attachmentId).first();
  if (!attachment) throw new HttpError(404, "Không tìm thấy tệp.");
  const object = await env.ATTACHMENTS.get(attachment.r2_key);
  if (!object) throw new HttpError(404, "Tệp không còn tồn tại trên kho lưu trữ.");
  if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304 });
  const inline = SAFE_INLINE_IMAGES.has(attachment.content_type);
  return new Response(object.body, {
    headers: {
      "content-type": attachment.content_type || "application/octet-stream",
      "content-length": String(attachment.byte_size),
      "content-disposition": contentDisposition(attachment.file_name, inline),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      etag: object.httpEtag
    }
  });
}

async function handleMemberSetting(request, env, conversationId, user, setting) {
  await ensureConversationMember(env, conversationId, user.id);
  const body = await readJson(request);
  if (setting === "archive") {
    const archivedAt = requireBoolean(body.archived, "archived") ? nowIso() : null;
    await env.DB.prepare("UPDATE conversation_members SET archived_at = ? WHERE conversation_id = ? AND user_id = ?")
      .bind(archivedAt, conversationId, user.id).run();
  } else {
    await env.DB.prepare("UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?")
      .bind(requireBoolean(body.muted, "muted") ? 1 : 0, conversationId, user.id).run();
  }
  return json({ ok: true });
}

async function handleRead(env, conversationId, user) {
  await ensureConversationMember(env, conversationId, user.id);
  await env.DB.prepare(`
    UPDATE conversation_members
    SET last_read_at = ?,
        last_read_message_rowid = MAX(last_read_message_rowid, COALESCE((
          SELECT MAX(rowid) FROM messages WHERE conversation_id = ?
        ), 0))
    WHERE conversation_id = ? AND user_id = ?
  `).bind(nowIso(), conversationId, conversationId, user.id).run();
  return json({ ok: true });
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  assertSameOrigin(request);

  if (path === "/api/auth/register" && request.method === "POST") return handleRegister(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return handleLogin(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return handleLogout(request, env);

  const user = await requireUser(request, env);
  if (path === "/api/auth/me" && request.method === "GET") return json({ user: publicUser(user) });
  if (path === "/api/profile" && request.method === "PATCH") return handleProfile(request, env, user);
  if (path === "/api/users/search" && request.method === "GET") return handleUserSearch(url, env, user);
  if (path === "/api/conversations" && request.method === "GET") return handleConversationList(url, env, user);
  if (path === "/api/conversations" && request.method === "POST") return handleConversationCreate(request, env, user);

  const attachmentMatch = path.match(/^\/api\/attachments\/([^/]+)$/u);
  if (attachmentMatch && request.method === "GET") return handleAttachmentGet(request, env, decodeURIComponent(attachmentMatch[1]), user);

  const searchMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages\/search$/u);
  if (searchMatch && request.method === "GET") {
    return loadConversationMessages(url, env, decodeURIComponent(searchMatch[1]), user, true);
  }

  const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)\/(messages|attachments|read|archive|mute)$/u);
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const action = conversationMatch[2];
    if (action === "messages" && request.method === "GET") return loadConversationMessages(url, env, conversationId, user);
    if (action === "messages" && request.method === "POST") return handleMessageCreate(request, env, conversationId, user);
    if (action === "attachments" && request.method === "POST") return handleAttachmentCreate(request, env, conversationId, user);
    if (action === "read" && request.method === "POST") return handleRead(env, conversationId, user);
    if (action === "archive" && request.method === "POST") return handleMemberSetting(request, env, conversationId, user, "archive");
    if (action === "mute" && request.method === "POST") return handleMemberSetting(request, env, conversationId, user, "mute");
  }
  throw new HttpError(404, "Không tìm thấy API.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await routeApi(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, ...error.details }, error.status);
      console.error(error);
      return json({ error: "Máy chủ gặp lỗi. Vui lòng thử lại." }, 500);
    }
  }
};
