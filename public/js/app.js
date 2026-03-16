'use strict';

// ─── Socket Connection ────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ─── State ────────────────────────────────────────────────────────────────────
let rooms       = [];
let currentRoom = null;
let activeTag   = 'all';
let typingTimer = null;
let isTyping    = false;

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const esc = (s) => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/\n/g,'<br/>');

function showToast(msg, duration = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  console.log('[LEXONIMOUS] Connected:', socket.id);
  $('conn-dot').classList.remove('offline');
  // Hide connecting screen
  const c = $('connecting');
  c.classList.add('fade');
  setTimeout(() => { c.style.display = 'none'; $('app').style.display = 'flex'; }, 500);
});

socket.on('disconnect', (reason) => {
  console.warn('[LEXONIMOUS] Disconnected:', reason);
  $('conn-dot').classList.add('offline');
  $('online-count').textContent = 'Disconnected';
  showToast('Connection lost. Reconnecting...');
});

socket.on('connect_error', (err) => {
  console.error('[LEXONIMOUS] Connection error:', err.message);
  showToast('Cannot reach LEXONIMOUS server.');
});

socket.on('error', (msg) => {
  console.warn('[LEXONIMOUS] Server error:', msg);
  showToast('⚠ ' + msg);
});

socket.on('server:online', (count) => {
  $('online-count').textContent = count + ' Soul' + (count !== 1 ? 's' : '');
});

socket.on('room:list', (list) => {
  rooms = list;
  renderRooms();
});

socket.on('room:created', ({ id }) => {
  joinRoom(id);
});

socket.on('room:history', ({ messages }) => {
  const box = $('chat-msgs');
  box.innerHTML = '';
  if (messages && messages.length) {
    messages.forEach(appendMsg);
  }
  box.scrollTop = box.scrollHeight;
});

socket.on('message:new', ({ msg }) => {
  appendMsg(msg);
  const box = $('chat-msgs');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) {
    box.scrollTop = box.scrollHeight;
  }
});

socket.on('room:system', ({ text }) => addSys(text));

socket.on('room:memberCount', ({ roomId, count }) => {
  if (currentRoom && currentRoom.id === roomId) {
    currentRoom.memberCount = count;
    $('chat-room-sub').textContent = '#' + currentRoom.tag + ' · ' + count + ' soul' + (count !== 1 ? 's' : '') + ' present';
  }
});

socket.on('typing:update', ({ count }) => {
  const bar = $('typing-indicator');
  if (count > 0) bar.classList.add('show');
  else           bar.classList.remove('show');
});

// ─── Render Room List ─────────────────────────────────────────────────────────
function renderRooms() {
  const q    = ($('search-input').value || '').toLowerCase();
  const grid = $('rooms-grid');

  const total = rooms.reduce((a, r) => a + (r.memberCount || 0), 0);
  $('online-count').textContent = total + ' Soul' + (total !== 1 ? 's' : '');
  $('room-count').textContent   = rooms.length + ' Chamber' + (rooms.length !== 1 ? 's' : '');

  const filtered = rooms.filter(r =>
    (activeTag === 'all' || r.tag === activeTag) &&
    r.title.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-ico">&#x25CC;</div><p>No chambers found. Open one.</p></div>';
    return;
  }

  const tagMap = { random:'Random', social:'Social', tech:'Tech', philosophy:'Philosophy', creative:'Creative' };

  grid.innerHTML = filtered.map(r =>
    '<div class="card" onclick="joinRoom(\'' + r.id + '\')">'
    + '<div class="c-tag">' + (tagMap[r.tag] || r.tag) + '</div>'
    + '<h3>' + esc(r.title) + '</h3>'
    + '<div class="c-meta">'
    + '<div class="c-stat"><div class="c-dot"></div>' + (r.memberCount || 0) + ' soul' + ((r.memberCount || 0) !== 1 ? 's' : '') + '</div>'
    + '<div class="c-stat"><div class="c-dot"></div>' + (r.messageCount || 0) + ' echo' + ((r.messageCount || 0) !== 1 ? 'es' : '') + '</div>'
    + '<div class="c-enter">Enter &rarr;</div>'
    + '</div></div>'
  ).join('');
}

function filterTag(tag, el) {
  activeTag = tag;
  document.querySelectorAll('.ftag').forEach(t => t.classList.remove('on'));
  el.classList.add('on');
  renderRooms();
}

function scrollRooms() {
  $('rooms-anchor').scrollIntoView({ behavior: 'smooth' });
}

// ─── Join / Leave ─────────────────────────────────────────────────────────────
function joinRoom(id) {
  currentRoom = rooms.find(r => r.id === id) || { id, tag: '', memberCount: 0, title: '' };
  $('chat-room-name').textContent = currentRoom.title || '';
  $('chat-room-sub').textContent  = '#' + currentRoom.tag + ' · ' + (currentRoom.memberCount || 0) + ' souls present';
  $('chat-view').classList.add('open');
  document.body.style.overflow = 'hidden';

  socket.emit('room:join', id);
  setTimeout(() => { $('in-box').focus(); }, 200);
}

function leaveRoom() {
  socket.emit('room:leave');
  currentRoom = null;
  $('chat-view').classList.remove('open');
  $('chat-msgs').innerHTML = '';
  $('typing-indicator').classList.remove('show');
  document.body.style.overflow = '';
  stopTyping();
}

// ─── Message Rendering ────────────────────────────────────────────────────────
function appendMsg(msg) {
  const box  = $('chat-msgs');
  const isOwn = msg.senderId === socket.id;
  const div  = document.createElement('div');
  div.className = 'msg' + (isOwn ? ' own' : '');

  const lbl = isOwn
    ? '<span class="own-lbl">You &middot; Wraith</span>'
    : '<span>Wraith</span>';

  div.innerHTML =
    '<div class="msg-ico">' + (isOwn ? '&#x25C9;' : '&#x25CE;') + '</div>'
    + '<div class="msg-body">'
    + '<div class="msg-meta">' + lbl + '<span>' + esc(msg.time) + '</span></div>'
    + '<div class="bubble">' + esc(msg.text) + '</div>'
    + '</div>';

  box.appendChild(div);
}

function addSys(text) {
  const box = $('chat-msgs');
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ─── Send Message ─────────────────────────────────────────────────────────────
function sendMsg() {
  const inp  = $('in-box');
  const text = inp.value.trim();
  if (!text || !currentRoom) return;
  socket.emit('message:send', { roomId: currentRoom.id, text });
  inp.value = '';
  inp.style.height = 'auto';
  stopTyping();
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); return; }
  // Typing indicators
  if (!isTyping) { isTyping = true; socket.emit('typing:start'); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 2000);
}

function stopTyping() {
  if (isTyping) { isTyping = false; socket.emit('typing:stop'); }
  clearTimeout(typingTimer);
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ─── Create Room Modal ────────────────────────────────────────────────────────
function openModal() {
  $('modal').classList.add('open');
  setTimeout(() => $('new-title').focus(), 100);
}

function closeModal() {
  $('modal').classList.remove('open');
  $('new-title').value = '';
  $('title-err').classList.remove('show');
}

function modalBg(e) {
  if (e.target === $('modal')) closeModal();
}

function createRoom() {
  const title = $('new-title').value.trim();
  const tag   = $('new-cat').value;

  if (!title) {
    $('title-err').classList.add('show');
    $('new-title').focus();
    return;
  }
  $('title-err').classList.remove('show');

  socket.emit('room:create', { title, tag });
  closeModal();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Keyboard: Escape closes modal / chat
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('modal').classList.contains('open')) { closeModal(); return; }
      if ($('chat-view').classList.contains('open')) { leaveRoom(); }
    }
  });
});
