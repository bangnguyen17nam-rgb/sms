const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  conversations: [],
  activeConversation: null,
  messages: [],
  activeFilter: 'all',
  showArchived: false,
  archiveCount: 0,
  pollTimer: null,
  searchTimer: null,
  offline: !navigator.onLine,
  pendingAttachment: null,
  pendingAttachmentUrl: null,
  uploadingAttachment: false
};

const appShell = $('#appShell');
const authScreen = $('#authScreen');
const conversationList = $('#conversationList');
const messages = $('#messages');
const chatSearch = $('#chatSearch');
const messageInput = $('#messageInput');
const composer = $('#composer');
const sendButton = $('#sendButton');
const fileInput = $('#fileInput');
const imageInput = $('#imageInput');

function icon(name, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : parts[0]?.slice(0, 2) || '?').toUpperCase();
}

function avatarClass(seed) {
  const choices = ['avatar-linh', 'avatar-minh', 'avatar-tuan', 'avatar-nhien', 'avatar-work'];
  const score = [...String(seed || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return choices[score % choices.length];
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(date);
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(date);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
  if (options.formData) {
    init.body = options.formData;
  } else if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  let data = {};
  try { data = await response.json(); } catch { data = { error: 'Phản hồi máy chủ không hợp lệ.' }; }
  if (!response.ok) {
    const error = new Error(data.error || 'Yêu cầu không thành công.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setAuthMode(mode) {
  const login = mode === 'login';
  $('#loginForm').hidden = !login;
  $('#registerForm').hidden = login;
  $('#loginTab').classList.toggle('active', login);
  $('#registerTab').classList.toggle('active', !login);
  $('#loginTab').setAttribute('aria-selected', String(login));
  $('#registerTab').setAttribute('aria-selected', String(!login));
  $('#authTitle').textContent = login ? 'Đăng nhập' : 'Tạo tài khoản';
  $('#authSubtitle').textContent = login ? 'Tiếp tục những cuộc trò chuyện của bạn.' : 'Bắt đầu với username — không cần email.';
  $('.auth-heading .eyebrow').textContent = login ? 'Chào mừng trở lại' : 'Tham gia Veil';
  clearAuthErrors();
  setTimeout(() => $(login ? '#loginUsername' : '#registerDisplayName').focus(), 0);
}

function clearAuthErrors() {
  $('#authErrorSummary').hidden = true;
  $('#authErrorSummary').textContent = '';
  $$('.field-error').forEach((element) => element.textContent = '');
  $$('.field').forEach((element) => element.classList.remove('has-error'));
}

function setFieldError(id, message) {
  const input = $(`#${id}`);
  const error = $(`#${id}Error`);
  if (!input || !error) return;
  error.textContent = message || '';
  input.closest('.field').classList.toggle('has-error', Boolean(message));
  input.setAttribute('aria-invalid', String(Boolean(message)));
  if (message) input.setAttribute('aria-describedby', `${id}Error`); else input.removeAttribute('aria-describedby');
}

function showAuthError(message, fields = {}, prefix = '') {
  const summary = $('#authErrorSummary');
  summary.textContent = message;
  summary.hidden = false;
  const map = { username: `${prefix}Username`, password: `${prefix}Password`, displayName: `${prefix}DisplayName` };
  Object.entries(fields).forEach(([name, value]) => setFieldError(map[name], value));
  summary.focus();
}

function validateAuth(mode) {
  clearAuthErrors();
  const prefix = mode === 'login' ? 'login' : 'register';
  const username = $(`#${prefix}Username`).value.trim().toLowerCase();
  const password = $(`#${prefix}Password`).value;
  const errors = {};
  if (!username) errors.username = 'Nhập tên tài khoản.';
  if (mode === 'register' && username && !/^[a-z0-9_]{5,30}$/.test(username)) errors.username = 'Dùng 5–30 ký tự: chữ thường, số hoặc dấu gạch dưới.';
  if (!password) errors.password = 'Nhập mật khẩu.';
  if (mode === 'register' && password && password.length < 5) errors.password = 'Mật khẩu cần ít nhất 5 ký tự.';
  if (mode === 'register') {
    const displayName = $('#registerDisplayName').value.trim();
    if (!displayName) errors.displayName = 'Nhập tên hiển thị.';
  }
  Object.entries(errors).forEach(([name, message]) => setFieldError({ username: `${prefix}Username`, password: `${prefix}Password`, displayName: 'registerDisplayName' }[name], message));
  if (Object.keys(errors).length) {
    showAuthError('Vui lòng kiểm tra các trường được đánh dấu.', {}, prefix);
    return null;
  }
  return mode === 'login'
    ? { username, password }
    : { username, password, displayName: $('#registerDisplayName').value.trim() };
}

async function submitAuth(event, mode) {
  event.preventDefault();
  const payload = validateAuth(mode);
  if (!payload) return;
  const form = event.currentTarget;
  const button = $('.auth-submit', form);
  button.disabled = true;
  button.classList.add('loading');
  try {
    const data = await api(`/api/auth/${mode}`, { method: 'POST', body: payload });
    state.user = data.user;
    form.reset();
    await enterApp();
  } catch (error) {
    showAuthError(error.message, error.data?.fields || {}, mode);
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
}

async function enterApp() {
  authScreen.hidden = true;
  appShell.hidden = false;
  const name = state.user.displayName;
  const userInitials = initials(name);
  $('#profileName').textContent = name;
  $('#profileUsername').textContent = `@${state.user.username}`;
  $('#profileAvatar').childNodes[0].nodeValue = userInitials;
  $('#profileButton').childNodes[0].nodeValue = userInitials;
  clearActiveConversation();
  await loadConversations();
  startPolling();
}

function leaveApp() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  state.user = null;
  state.conversations = [];
  state.activeConversation = null;
  state.messages = [];
  state.showArchived = false;
  state.archiveCount = 0;
  appShell.hidden = true;
  authScreen.hidden = false;
  closeAllModals();
  setAuthMode('login');
}

async function init() {
  setTheme(localStorage.getItem('veil-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    await enterApp();
  } catch (error) {
    authScreen.hidden = false;
    appShell.hidden = true;
    if (error.status !== 401) showAuthError('Không thể kết nối máy chủ. Hãy tải lại trang.');
  }
}

async function loadConversations({ quiet = false } = {}) {
  try {
    const data = await api(`/api/conversations${state.showArchived ? '?archived=1' : ''}`);
    state.conversations = data.conversations || [];
    state.archiveCount = Number(data.archiveCount || 0);
    if (state.activeConversation) state.activeConversation = state.conversations.find((item) => item.id === state.activeConversation.id) || state.activeConversation;
    renderConversations();
  } catch (error) {
    if (error.status === 401) return leaveApp();
    if (!quiet) toast(error.message, 'info');
  }
}

function renderConversations() {
  const query = chatSearch.value.trim().toLocaleLowerCase('vi');
  const filtered = state.conversations.filter((item) => {
    const haystack = `${item.other_display_name || ''} ${item.other_username || ''} ${item.last_message || ''}`.toLocaleLowerCase('vi');
    const matchesFilter = state.activeFilter === 'all' || (state.activeFilter === 'unread' && Number(item.unread_count) > 0);
    return haystack.includes(query) && matchesFilter;
  });
  const unreadTotal = state.conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
  const unreadCount = $('#unreadFilterCount');
  unreadCount.textContent = String(unreadTotal);
  ['#unreadNavBadge', '#mobileUnreadBadge'].forEach((selector) => {
    const badge = $(selector);
    badge.textContent = String(unreadTotal);
    badge.hidden = unreadTotal === 0 || state.showArchived;
  });
  $('#archiveCount').textContent = String(state.archiveCount);
  $('#archiveChipCount').textContent = String(state.archiveCount);
  $('#archiveChip').classList.toggle('active', state.showArchived);
  $('#archiveButtonLabel').textContent = state.showArchived ? 'Quay lại hộp thư' : 'Đã lưu trữ';
  $('#inboxTitle').textContent = state.showArchived ? 'Đã lưu trữ' : 'Tin nhắn';
  if (!filtered.length) {
    conversationList.innerHTML = state.conversations.length
      ? `<div class="conversation-empty">${icon('search')}<strong>Không tìm thấy</strong><p>Thử từ khóa hoặc bộ lọc khác.</p></div>`
      : state.showArchived
        ? `<div class="conversation-empty">${icon('archive')}<strong>Chưa có hội thoại lưu trữ</strong><p>Hội thoại bạn lưu trữ sẽ xuất hiện tại đây.</p></div>`
        : `<div class="conversation-empty">${icon('message')}<strong>Chưa có cuộc trò chuyện</strong><p>Tìm một username để bắt đầu.</p><button id="emptyNewChat">Tin nhắn mới</button></div>`;
    $('#emptyNewChat')?.addEventListener('click', () => openModal('#newChatModal'));
    return;
  }
  conversationList.innerHTML = filtered.map((item) => {
    const name = item.other_display_name || item.other_username || 'Cuộc trò chuyện';
    const selected = state.activeConversation?.id === item.id;
    const mine = item.last_sender_id === state.user.id;
    return `<button class="conversation-item ${selected ? 'selected' : ''} ${Number(item.unread_count) > 0 ? 'unread' : ''}" role="option" aria-selected="${selected}" data-id="${escapeHTML(item.id)}">
      <span class="avatar ${avatarClass(item.other_username)}">${escapeHTML(initials(name))}</span>
      <span class="conversation-copy"><span class="conversation-name"><strong>${escapeHTML(name)}</strong></span><span class="conversation-preview">${item.last_message ? `${mine ? 'Bạn: ' : ''}${escapeHTML(item.last_message)}` : `@${escapeHTML(item.other_username)}`}</span></span>
      <span class="conversation-meta"><time>${escapeHTML(formatTime(item.last_message_at || item.updated_at))}</time>${Number(item.unread_count) > 0 ? `<span class="unread-count">${Math.min(99, Number(item.unread_count))}</span>` : mine && item.last_message ? icon('check', 'delivery-mini') : ''}</span>
    </button>`;
  }).join('');
}

async function selectConversation(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  if (state.activeConversation?.id !== id) clearPendingAttachment();
  state.activeConversation = conversation;
  state.messages = [];
  $('#chatPanel').classList.remove('no-active-chat');
  renderConversations();
  updateConversationHeader();
  appShell.classList.add('mobile-chat-open');
  messageInput.disabled = false;
  messageInput.placeholder = `Nhắn cho ${(conversation.other_display_name || conversation.other_username).split(' ')[0]}...`;
  autoSizeInput();
  await loadMessages({ quiet: false, force: true });
  if (Number(conversation.unread_count) > 0) await markConversationRead(conversation);
  setTimeout(() => messageInput.focus(), 50);
}

function updateConversationHeader() {
  const conversation = state.activeConversation;
  if (!conversation) return;
  const name = conversation.other_display_name || conversation.other_username;
  $('#activeName').textContent = name;
  $('#activeStatus').textContent = `@${conversation.other_username}`;
  $$('.chat-person .avatar, .details-profile .avatar').forEach((avatar) => {
    const large = avatar.classList.contains('large');
    avatar.className = `avatar ${large ? 'large ' : ''}${avatarClass(conversation.other_username)}`;
    avatar.textContent = initials(name);
  });
  $('.details-profile h3').textContent = name;
  $('.details-profile p').textContent = `@${conversation.other_username}`;
  $('#muteLabel').textContent = Number(conversation.muted) ? 'Đang tắt' : 'Đang bật';
  $('#archiveConversationButton span').textContent = conversation.archived_at ? 'Bỏ lưu trữ' : 'Lưu trữ';
}

async function markConversationRead(conversation) {
  try {
    await api(`/api/conversations/${encodeURIComponent(conversation.id)}/read`, { method: 'POST', body: {} });
    conversation.unread_count = 0;
    renderConversations();
  } catch {}
}

async function loadMessages({ quiet = true, force = false } = {}) {
  if (!state.activeConversation) return;
  try {
    const activeId = state.activeConversation.id;
    const data = await api(`/api/conversations/${encodeURIComponent(activeId)}/messages`);
    if (state.activeConversation?.id !== activeId) return;
    const incoming = data.messages || [];
    const changed = force || incoming.length !== state.messages.length || incoming.at(-1)?.id !== state.messages.at(-1)?.id;
    if (changed) {
      const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
      state.messages = incoming;
      renderMessages();
      if (nearBottom || force) messages.scrollTop = messages.scrollHeight;
    }
  } catch (error) {
    if (error.status === 401) return leaveApp();
    if (!quiet) toast(error.message, 'info');
  }
}

function renderMessages() {
  if (!state.messages.length) {
    messages.innerHTML = `<div class="chat-empty">${icon('message')}<h2>Bắt đầu cuộc trò chuyện</h2><p>Hãy gửi lời chào. Tin nhắn sẽ được lưu thật trên D1.</p></div>`;
    return;
  }
  messages.innerHTML = `<div class="day-divider"><span>Gần đây</span></div>${state.messages.map((message) => {
    const outgoing = message.sender_id === state.user.id;
    const attachmentUrl = message.local_url || (message.attachment_id ? `/api/attachments/${encodeURIComponent(message.attachment_id)}` : '');
    const attachmentName = message.attachment_name || 'Tệp đính kèm';
    const attachmentType = message.attachment_type || '';
    const isImage = Boolean(attachmentUrl) && (message.local_is_image || attachmentType.startsWith('image/'));
    const attachment = isImage
      ? `<button class="message-image-button" type="button" data-image-src="${escapeHTML(attachmentUrl)}" aria-label="Xem ảnh đính kèm"><img src="${escapeHTML(attachmentUrl)}" alt="${escapeHTML(attachmentName)}" loading="lazy" />${message.uploading ? '<span class="image-uploading">Đang gửi tệp…</span>' : ''}</button>`
      : attachmentUrl
        ? `<a class="message-file-card" href="${escapeHTML(attachmentUrl)}" download="${escapeHTML(attachmentName)}">${icon('file')}<span><strong>${escapeHTML(attachmentName)}</strong><small>${escapeHTML(formatBytes(message.attachment_bytes))}${message.uploading ? ' · Đang gửi…' : ' · Nhấn để tải xuống'}</small></span>${icon('download')}</a>`
        : '';
    const caption = message.body ? `<div class="message-bubble">${escapeHTML(message.body)}</div>` : '';
    return `<div class="message-row ${outgoing ? 'outgoing' : 'incoming'}" data-message-id="${escapeHTML(message.id)}">
      ${outgoing ? '' : `<span class="avatar mini ${avatarClass(message.username)}">${escapeHTML(initials(message.display_name || message.username))}</span>`}
      <div class="message-stack">${attachment}${caption}<time>${escapeHTML(formatTime(message.sent_at))}${outgoing && !message.uploading ? `${icon('check')}${icon('check')}` : ''}</time></div>
    </div>`;
  }).join('')}`;
}

async function sendMessage(text) {
  if (!state.activeConversation) return;
  const clientMessageId = crypto.randomUUID();
  const optimistic = { id: `temp_${clientMessageId}`, client_message_id: clientMessageId, body: text, sent_at: new Date().toISOString(), sender_id: state.user.id };
  state.messages.push(optimistic);
  renderMessages();
  messages.scrollTop = messages.scrollHeight;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(state.activeConversation.id)}/messages`, { method: 'POST', body: { body: text, clientMessageId } });
    state.messages = state.messages.map((item) => item.id === optimistic.id ? data.message : item);
    renderMessages();
    await loadConversations({ quiet: true });
  } catch (error) {
    state.messages = state.messages.filter((item) => item.id !== optimistic.id);
    renderMessages();
    toast(error.message, 'info');
    messageInput.value = text;
    autoSizeInput();
  }
}

async function sendAttachmentMessage(text) {
  if (!state.activeConversation || !state.pendingAttachment || state.uploadingAttachment) return;
  const file = state.pendingAttachment;
  const localUrl = state.pendingAttachmentUrl;
  const conversationId = state.activeConversation.id;
  const clientMessageId = crypto.randomUUID();
  const optimistic = { id: `temp_${clientMessageId}`, client_message_id: clientMessageId, body: text, sent_at: new Date().toISOString(), sender_id: state.user.id, local_url: localUrl, local_is_image: file.type.startsWith('image/'), attachment_name: file.name, attachment_type: file.type, attachment_bytes: file.size, uploading: true };
  state.uploadingAttachment = true;
  state.messages.push(optimistic);
  renderMessages();
  messages.scrollTop = messages.scrollHeight;
  autoSizeInput();
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('body', text);
  formData.append('clientMessageId', clientMessageId);
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, { method: 'POST', formData });
    if (state.activeConversation?.id === conversationId) {
      state.messages = state.messages.map((item) => item.id === optimistic.id ? data.message : item);
      messageInput.value = '';
      clearPendingAttachment();
      renderMessages();
      messages.scrollTop = messages.scrollHeight;
    }
    await loadConversations({ quiet: true });
  } catch (error) {
    state.messages = state.messages.filter((item) => item.id !== optimistic.id);
    renderMessages();
    toast(error.message, 'info');
  } finally {
    state.uploadingAttachment = false;
    autoSizeInput();
  }
}

function clearPendingAttachment() {
  if (state.pendingAttachmentUrl) URL.revokeObjectURL(state.pendingAttachmentUrl);
  state.pendingAttachment = null;
  state.pendingAttachmentUrl = null;
  fileInput.value = '';
  imageInput.value = '';
  $('#attachmentPreview').hidden = true;
  $('#attachmentPreviewImage').removeAttribute('src');
  $('#attachmentPreviewImage').hidden = true;
  $('#attachmentPreviewIcon').hidden = false;
  autoSizeInput();
}

function chooseAttachment(file) {
  if (!file) return;
  if (!file.size) { fileInput.value = ''; imageInput.value = ''; return toast('Không thể gửi tệp rỗng.', 'info'); }
  if (file.size > 10 * 1024 * 1024) { fileInput.value = ''; imageInput.value = ''; return toast('Tệp tối đa 10 MB.', 'info'); }
  if (state.pendingAttachmentUrl) URL.revokeObjectURL(state.pendingAttachmentUrl);
  state.pendingAttachment = file;
  state.pendingAttachmentUrl = URL.createObjectURL(file);
  const previewImage = $('#attachmentPreviewImage');
  const isImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type);
  previewImage.hidden = !isImage;
  $('#attachmentPreviewIcon').hidden = isImage;
  if (isImage) previewImage.src = state.pendingAttachmentUrl;
  else previewImage.removeAttribute('src');
  $('#attachmentPreviewName').textContent = file.name || 'Tệp đã chọn';
  $('#attachmentPreviewMeta').textContent = `${formatBytes(file.size)} · Sẵn sàng gửi`;
  $('#attachmentPreview').hidden = false;
  autoSizeInput();
  messageInput.focus();
}

function autoSizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 112)}px`;
  sendButton.disabled = messageInput.disabled || (!messageInput.value.trim() && !state.pendingAttachment) || state.offline || state.uploadingAttachment;
}

function setFilter(filter) {
  state.activeFilter = filter;
  $$('.filter-chip').forEach((chip) => {
    const active = chip.dataset.filter === filter;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-selected', String(active));
  });
  renderConversations();
}

async function searchUsers(query) {
  const results = $('#userResults');
  if (query.length < 2) {
    results.innerHTML = `<div class="search-empty">${icon('search')}<p>Nhập ít nhất 2 ký tự để tìm tài khoản.</p></div>`;
    return;
  }
  results.innerHTML = `<div class="search-empty"><p>Đang tìm...</p></div>`;
  try {
    const data = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
    results.innerHTML = data.users.length ? `<p>Kết quả</p>${data.users.map((user) => `<button data-username="${escapeHTML(user.username)}"><span class="avatar ${avatarClass(user.username)}">${escapeHTML(initials(user.displayName))}</span><span><strong>${escapeHTML(user.displayName)}</strong><small>@${escapeHTML(user.username)}</small></span>${icon('message')}</button>`).join('')}` : `<div class="search-empty">${icon('search')}<p>Không tìm thấy @username phù hợp.</p></div>`;
  } catch (error) {
    results.innerHTML = `<div class="search-empty"><p>${escapeHTML(error.message)}</p></div>`;
  }
}

async function createConversation(username) {
  try {
    const data = await api('/api/conversations', { method: 'POST', body: { username } });
    closeModal($('#newChatModal'));
    $('#userSearch').value = '';
    if (state.showArchived) state.showArchived = false;
    await loadConversations();
    if (!state.conversations.some((item) => item.id === data.conversation.id)) state.conversations.unshift(data.conversation);
    await selectConversation(data.conversation.id);
  } catch (error) {
    toast(error.message, 'info');
  }
}

function clearActiveConversation() {
  state.activeConversation = null;
  state.messages = [];
  messageInput.disabled = true;
  messageInput.value = '';
  clearPendingAttachment();
  $('#chatPanel').classList.add('no-active-chat');
  autoSizeInput();
  messages.innerHTML = `<div class="chat-empty">${icon('message')}<h2>Chọn một cuộc trò chuyện</h2><p>Chọn hội thoại bên trái hoặc tìm một người để bắt đầu.</p></div>`;
  appShell.classList.remove('mobile-chat-open', 'details-open');
  $('#infoButton').setAttribute('aria-expanded', 'false');
}

async function toggleArchiveView() {
  state.showArchived = !state.showArchived;
  state.activeFilter = 'all';
  $$('.filter-chip').forEach((chip) => {
    const active = chip.dataset.filter === 'all';
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-selected', String(active));
  });
  clearActiveConversation();
  await loadConversations();
}

async function archiveActiveConversation() {
  const conversation = state.activeConversation;
  if (!conversation) return;
  const archived = !Boolean(conversation.archived_at);
  const button = $('#archiveConversationButton');
  button.disabled = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(conversation.id)}/archive`, { method: 'POST', body: { archived } });
    toast(archived ? 'Đã lưu trữ hội thoại.' : 'Đã đưa hội thoại về hộp thư.', 'archive');
    clearActiveConversation();
    await loadConversations();
  } catch (error) {
    toast(error.message, 'info');
  } finally {
    button.disabled = false;
  }
}

async function toggleMute() {
  const conversation = state.activeConversation;
  if (!conversation) return;
  const muted = !Boolean(Number(conversation.muted));
  const button = $('#muteButton');
  button.disabled = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(conversation.id)}/mute`, { method: 'POST', body: { muted } });
    conversation.muted = muted ? 1 : 0;
    $('#muteLabel').textContent = muted ? 'Đang tắt' : 'Đang bật';
    toast(muted ? 'Đã tắt thông báo hội thoại.' : 'Đã bật thông báo hội thoại.', 'check');
  } catch (error) {
    toast(error.message, 'info');
  } finally {
    button.disabled = false;
  }
}

function renderMessageSearch(query) {
  const results = $('#messageSearchResults');
  const normalized = query.trim().toLocaleLowerCase('vi');
  if (!normalized) {
    results.innerHTML = '<div class="search-empty"><p>Nhập từ khóa để tìm trong 50 tin gần nhất.</p></div>';
    return;
  }
  const found = state.messages.filter((message) => String(message.body || '').toLocaleLowerCase('vi').includes(normalized));
  results.innerHTML = found.length ? found.map((message) => `<button class="message-search-result" data-message-id="${escapeHTML(message.id)}"><strong>${escapeHTML(message.body || message.attachment_name || 'Tệp đính kèm')}</strong><small>${message.sender_id === state.user.id ? 'Bạn' : escapeHTML(message.display_name || message.username)} · ${escapeHTML(formatTime(message.sent_at))}</small></button>`).join('') : '<div class="search-empty"><p>Không tìm thấy tin nhắn phù hợp.</p></div>';
}

function insertEmoji(emoji) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  messageInput.value = `${messageInput.value.slice(0, start)}${emoji}${messageInput.value.slice(end)}`;
  messageInput.focus();
  messageInput.setSelectionRange(start + emoji.length, start + emoji.length);
  autoSizeInput();
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.hidden || state.offline) return;
    await loadConversations({ quiet: true });
    await loadMessages({ quiet: true });
  }, 3500);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('veil-theme', theme);
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#0e1110' : '#eef2ef';
  $('.theme-icon use').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  $('#themeToggle').setAttribute('aria-label', theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối');
  $('#themeLabel').textContent = theme === 'dark' ? 'Tối' : 'Sáng';
  $('.toggle').classList.toggle('on', theme === 'dark');
}

function toggleTheme() { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
function openModal(selector) { const modal = $(selector); modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); setTimeout(() => $('input, button', modal)?.focus(), 80); }
function closeModal(modal) { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }
function closeAllModals() { $$('.modal-backdrop.show').forEach(closeModal); }
function toast(message, iconName = 'check') { const item = document.createElement('div'); item.className = 'toast'; item.innerHTML = `${icon(iconName)}<span>${escapeHTML(message)}</span>`; $('#toastRegion').append(item); setTimeout(() => item.remove(), 3600); }

$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#loginForm').addEventListener('submit', (event) => submitAuth(event, 'login'));
$('#registerForm').addEventListener('submit', (event) => submitAuth(event, 'register'));
$$('.password-toggle').forEach((button) => button.addEventListener('click', () => { const input = $(`#${button.dataset.target}`); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; button.textContent = show ? 'Ẩn' : 'Hiện'; button.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'); }));

conversationList.addEventListener('click', (event) => { const item = event.target.closest('.conversation-item'); if (item) selectConversation(item.dataset.id); });
chatSearch.addEventListener('input', renderConversations);
$$('.filter-chip').forEach((chip) => chip.addEventListener('click', () => setFilter(chip.dataset.filter)));
messageInput.disabled = true;
messageInput.addEventListener('input', autoSizeInput);
messageInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if ((!text && !state.pendingAttachment) || !state.activeConversation || state.uploadingAttachment) return;
  if (state.pendingAttachment) return sendAttachmentMessage(text);
  messageInput.value = '';
  autoSizeInput();
  sendMessage(text);
});

$('#attachButton').addEventListener('click', () => fileInput.click());
$('#attachImageButton').addEventListener('click', () => imageInput.click());
fileInput.addEventListener('change', () => chooseAttachment(fileInput.files?.[0]));
imageInput.addEventListener('change', () => chooseAttachment(imageInput.files?.[0]));
$('#removeAttachmentButton').addEventListener('click', clearPendingAttachment);
messages.addEventListener('click', (event) => {
  const button = event.target.closest('[data-image-src]');
  if (!button) return;
  $('#imageLightbox').src = button.dataset.imageSrc;
  openModal('#imageLightboxModal');
});

$('#newChatButton').addEventListener('click', () => { openModal('#newChatModal'); setTimeout(() => $('#userSearch').focus(), 100); });
$('#userSearch').addEventListener('input', (event) => { clearTimeout(state.searchTimer); const query = event.target.value.trim().replace(/^@/, '').toLowerCase(); state.searchTimer = setTimeout(() => searchUsers(query), 260); });
$('#userResults').addEventListener('click', (event) => { const button = event.target.closest('[data-username]'); if (button) createConversation(button.dataset.username); });
$('#profileButton').addEventListener('click', () => openModal('#profileModal'));
$('#mobileProfile').addEventListener('click', () => openModal('#profileModal'));
$('#logoutButton').addEventListener('click', async () => { $('#logoutButton').disabled = true; try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {} $('#logoutButton').disabled = false; leaveApp(); });

$$('.modal-close').forEach((button) => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
$$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) closeModal(backdrop); }));
$('#mobileBack').addEventListener('click', () => appShell.classList.remove('mobile-chat-open'));
$('#infoButton').addEventListener('click', () => { const open = !appShell.classList.contains('details-open'); appShell.classList.toggle('details-open', open); $('#infoButton').setAttribute('aria-expanded', String(open)); $('#detailsDrawer').setAttribute('aria-hidden', String(!open)); });
$('#personButton').addEventListener('click', () => state.activeConversation && $('#infoButton').click());
$('#closeDetails').addEventListener('click', () => { appShell.classList.remove('details-open'); $('#infoButton').setAttribute('aria-expanded', 'false'); $('#detailsDrawer').setAttribute('aria-hidden', 'true'); });
$('#themeToggle').addEventListener('click', toggleTheme);
$('#modalThemeToggle').addEventListener('click', toggleTheme);
$('#securityInfo').addEventListener('click', () => toast('Tin nhắn hiện lưu dạng rõ trong D1; E2EE chưa được triển khai.', 'info'));
$('#securityDetailsButton').addEventListener('click', () => toast('HTTPS và session đã bật; nội dung D1 chưa được mã hóa đầu cuối.', 'shield'));
$('#archiveButton').addEventListener('click', toggleArchiveView);
$('#archiveChip').addEventListener('click', toggleArchiveView);
$('#archiveConversationButton').addEventListener('click', archiveActiveConversation);
$('#muteButton').addEventListener('click', toggleMute);

const emojiChoices = ['😀', '😂', '🥰', '😍', '😊', '😎', '👍', '👏', '❤️', '🔥', '🎉', '🙏'];
$('#emojiPicker').innerHTML = emojiChoices.map((emoji) => `<button type="button" aria-label="Chèn ${emoji}">${emoji}</button>`).join('');
$('#emojiButton').addEventListener('click', () => {
  const picker = $('#emojiPicker');
  picker.hidden = !picker.hidden;
  $('#emojiButton').setAttribute('aria-expanded', String(!picker.hidden));
});
$('#emojiPicker').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  insertEmoji(button.textContent);
  $('#emojiPicker').hidden = true;
  $('#emojiButton').setAttribute('aria-expanded', 'false');
});

$('#messageSearchButton').addEventListener('click', () => {
  if (!state.activeConversation) return;
  $('#messageSearchInput').value = '';
  renderMessageSearch('');
  openModal('#messageSearchModal');
});
$('#messageSearchInput').addEventListener('input', (event) => renderMessageSearch(event.target.value));
$('#messageSearchResults').addEventListener('click', (event) => {
  const result = event.target.closest('[data-message-id]');
  if (!result) return;
  closeModal($('#messageSearchModal'));
  const row = messages.querySelector(`[data-message-id="${CSS.escape(result.dataset.messageId)}"]`);
  if (row) {
    row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    row.classList.add('search-highlight');
    setTimeout(() => row.classList.remove('search-highlight'), 1800);
  }
});

$('#editProfileButton').addEventListener('click', () => {
  const form = $('#profileEditForm');
  form.hidden = !form.hidden;
  if (!form.hidden) {
    $('#profileDisplayNameInput').value = state.user.displayName;
    $('#profileDisplayNameInput').focus();
  }
});
$('#profileEditForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#profileDisplayNameInput');
  const displayName = input.value.trim();
  const error = $('#profileEditError');
  if (!displayName) { error.textContent = 'Tên hiển thị không được để trống.'; input.focus(); return; }
  const button = $('#profileEditForm button');
  button.disabled = true;
  try {
    const data = await api('/api/profile', { method: 'PATCH', body: { displayName } });
    state.user = data.user;
    $('#profileName').textContent = data.user.displayName;
    $('#profileAvatar').childNodes[0].nodeValue = initials(data.user.displayName);
    $('#profileButton').childNodes[0].nodeValue = initials(data.user.displayName);
    $('#profileEditForm').hidden = true;
    error.textContent = '';
    toast('Đã cập nhật tên hiển thị.', 'check');
  } catch (apiError) {
    error.textContent = apiError.message;
  } finally {
    button.disabled = false;
  }
});

$$('[data-section]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.section === 'contacts') openModal('#newChatModal');
  if (button.dataset.section === 'inbox' && state.showArchived) toggleArchiveView();
}));
$('.nav-rail .brand-mark').addEventListener('click', () => { if (state.showArchived) toggleArchiveView(); });

document.addEventListener('click', (event) => { if (!event.target.closest('#emojiPicker, #emojiButton')) { $('#emojiPicker').hidden = true; $('#emojiButton').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && state.user) { event.preventDefault(); chatSearch.focus(); } if (event.key === 'Escape') { closeAllModals(); appShell.classList.remove('details-open'); $('#emojiPicker').hidden = true; } });
window.addEventListener('offline', () => { state.offline = true; $('#connectionBanner').classList.add('show'); autoSizeInput(); });
window.addEventListener('online', () => { state.offline = false; $('#connectionBanner').classList.remove('show'); autoSizeInput(); loadConversations(); loadMessages({ force: true }); toast('Đã kết nối lại và đồng bộ dữ liệu.', 'check'); });
$('#reconnectButton').addEventListener('click', () => { if (navigator.onLine) window.dispatchEvent(new Event('online')); });

init();
