const socket = io();
let currentPartnerId = null;
let currentPartnerData = null;
let currentPage = 1;
let hasMoreMessages = false;
let typingTimeout = null;
let isTyping = false;
let selectedFile = null;

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('connect', () => {
  console.log('[socket] connected');
  loadConversations();
});

socket.on('new_message', (msg) => {
  if (currentPartnerId && (msg.sender_id === currentPartnerId || msg.receiver_id === currentPartnerId)) {
    if (msg.sender_id !== CURRENT_USER_ID) {
      appendMessage(msg);
      scrollToBottom();
    }
    fetch(`/api/messages/${currentPartnerId}?page=1`); // mark as read
  }
  loadConversations();
});

socket.on('typing', (data) => {
  if (data.user_id === currentPartnerId) {
    const el = document.getElementById('typingIndicator');
    el.style.display = data.typing ? 'flex' : 'none';
  }
});

socket.on('user_status', (data) => {
  if (data.user_id === currentPartnerId) {
    const statusEl = document.getElementById('partnerStatus');
    if (statusEl) {
      statusEl.textContent = data.online ? 'онлайн' : 'офлайн';
      statusEl.className = 'status' + (data.online ? ' online' : '');
    }
  }
  loadConversations();
});

socket.on('ticket_reply_notify', (data) => {
  showNotification(`Ответ на тикет: ${data.subject}`, `/support/ticket/${data.ticket_id}`);
});

// ── Conversations ─────────────────────────────────────────────────────────────

function loadConversations() {
  fetch('/api/conversations')
    .then(r => r.json())
    .then(convs => {
      const list = document.getElementById('conversationsList');
      if (!convs.length) {
        list.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-faint); font-size:13px;">Нет диалогов.<br>Найдите пользователя выше.</div>`;
        return;
      }
      list.innerHTML = convs.map(c => renderConversationItem(c)).join('');
    });
}

function renderConversationItem(c) {
  const p = c.partner;
  const active = currentPartnerId === p.id ? 'active' : '';
  const initials = p.display_name ? p.display_name[0].toUpperCase() : '?';
  const avatar = p.avatar
    ? `<img class="avatar" src="${p.avatar}" alt="">`
    : `<div class="avatar-placeholder">${initials}</div>`;
  const onlineDot = p.online ? '<span class="online-dot"></span>' : '';
  const lastMsg = c.last_message
    ? (c.last_message.message_type === 'image' ? '📷 Фото' : escapeHtml(c.last_message.content.slice(0, 40)))
    : '';
  const time = c.last_message ? c.last_message.created_at : '';
  const unread = c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : '';

  return `<div class="conv-item ${active}" onclick="openConversation(${p.id})">
    <div class="avatar-wrap">${avatar}${onlineDot}</div>
    <div class="conv-info">
      <div class="conv-name">${escapeHtml(p.display_name)}</div>
      <div class="conv-preview">${lastMsg}</div>
    </div>
    <div class="conv-meta">
      <span class="conv-time">${time}</span>
      ${unread}
    </div>
  </div>`;
}

// ── Open conversation ─────────────────────────────────────────────────────────

function openConversation(partnerId) {
  if (currentPartnerId === partnerId) return;

  if (currentPartnerId) {
    socket.emit('leave_conversation', { partner_id: currentPartnerId });
  }

  currentPartnerId = partnerId;
  currentPage = 1;
  hasMoreMessages = false;

  socket.emit('join_conversation', { partner_id: partnerId });

  document.getElementById('chatEmpty').style.display = 'none';
  const win = document.getElementById('chatWindow');
  win.style.display = 'flex';
  win.style.flexDirection = 'column';
  win.style.height = '100%';

  document.getElementById('messagesArea').innerHTML = `
    <div class="load-more" id="loadMoreBtn" style="text-align:center; padding:10px; display:none;">
      <button class="btn btn-ghost btn-sm" onclick="loadMoreMessages()">Загрузить ещё</button>
    </div>`;

  loadPartnerInfo(partnerId);
  loadMessages(partnerId, 1);

  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.conv-item').forEach(el => {
    if (el.onclick && el.onclick.toString().includes(partnerId)) el.classList.add('active');
  });
  loadConversations();
}

function loadPartnerInfo(partnerId) {
  fetch(`/api/user/${partnerId}`)
    .then(r => r.json())
    .then(user => {
      currentPartnerData = user;
      const initials = user.display_name ? user.display_name[0].toUpperCase() : '?';
      const avatarWrap = document.getElementById('partnerAvatarWrap');
      avatarWrap.innerHTML = user.avatar
        ? `<img class="avatar" src="${user.avatar}" alt=""><span class="online-dot" id="partnerOnlineDot" style="${user.online ? '' : 'display:none'}"></span>`
        : `<div class="avatar-placeholder">${initials}</div>`;
      document.getElementById('partnerName').textContent = user.display_name;
      const statusEl = document.getElementById('partnerStatus');
      statusEl.textContent = user.online ? 'онлайн' : `был(а) ${user.last_seen}`;
      statusEl.className = 'status' + (user.online ? ' online' : '');
      document.getElementById('partnerProfileLink').href = `/profile/${user.username}`;
      window._currentCallTarget = user;
    });
}

// ── Messages ──────────────────────────────────────────────────────────────────

function loadMessages(partnerId, page) {
  fetch(`/api/messages/${partnerId}?page=${page}`)
    .then(r => r.json())
    .then(data => {
      const area = document.getElementById('messagesArea');
      hasMoreMessages = data.has_more;
      document.getElementById('loadMoreBtn').style.display = data.has_more ? 'block' : 'none';

      if (page === 1) {
        const msgs = data.messages;
        let lastDate = null;
        let html = '';
        msgs.forEach(msg => {
          if (msg.created_date !== lastDate) {
            html += `<div class="date-divider"><span>${msg.created_date}</span></div>`;
            lastDate = msg.created_date;
          }
          html += renderMessage(msg);
        });
        area.insertAdjacentHTML('beforeend', html);
        scrollToBottom();
      } else {
        const scrollBottom = area.scrollHeight - area.scrollTop;
        const msgs = data.messages;
        let html = '';
        msgs.forEach(msg => html += renderMessage(msg));
        const sentinel = document.getElementById('loadMoreBtn');
        sentinel.insertAdjacentHTML('afterend', html);
        area.scrollTop = area.scrollHeight - scrollBottom;
      }

      currentPage = page;
      loadConversations();
    });
}

function loadMoreMessages() {
  if (currentPartnerId && hasMoreMessages) {
    loadMessages(currentPartnerId, currentPage + 1);
  }
}

function renderMessage(msg) {
  const own = msg.sender_id === CURRENT_USER_ID;
  const cls = own ? 'own' : 'other';
  const initials = msg.sender ? msg.sender.display_name[0].toUpperCase() : '?';
  const avatar = msg.sender && !own
    ? (msg.sender.avatar
        ? `<img class="message-avatar" src="${msg.sender.avatar}" alt="">`
        : `<div class="message-avatar-placeholder">${initials}</div>`)
    : '';

  let content = '';
  if (msg.image_url) {
    content += `<img class="msg-image" src="${msg.image_url}" alt="фото" onclick="openLightbox('${msg.image_url}')">`;
  }
  if (msg.content) {
    content += `<div class="msg-text">${escapeHtml(msg.content)}</div>`;
  }

  const checkmark = own
    ? `<svg class="read-check" fill="none" viewBox="0 0 24 24" stroke="${msg.is_read ? '#818cf8' : 'rgba(255,255,255,0.5)'}"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
    : '';

  return `<div class="message-row ${cls}" data-msg-id="${msg.id}">
    ${avatar}
    <div class="message-bubble">
      ${content}
      <div class="msg-time">${msg.created_at}${checkmark}</div>
    </div>
  </div>`;
}

function appendMessage(msg) {
  const area = document.getElementById('messagesArea');
  area.insertAdjacentHTML('beforeend', renderMessage(msg));
}

function scrollToBottom() {
  const area = document.getElementById('messagesArea');
  area.scrollTop = area.scrollHeight;
}

// ── Send message ──────────────────────────────────────────────────────────────

function sendMessage() {
  if (!currentPartnerId) return;
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text && !selectedFile) return;

  const fd = new FormData();
  fd.append('receiver_id', currentPartnerId);
  fd.append('content', text);
  if (selectedFile) fd.append('image', selectedFile);

  input.value = '';
  autoResize(input);
  clearFileAttachment();
  stopTyping();

  fetch('/api/send_message', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(msg => {
      if (msg.error) return;
      appendMessage(msg);
      scrollToBottom();
      loadConversations();
    });
}

// ── File handling ─────────────────────────────────────────────────────────────

function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  selectedFile = file;
  const preview = document.getElementById('filePreviewArea');
  const img = document.getElementById('filePreviewImg');
  const name = document.getElementById('filePreviewName');
  const reader = new FileReader();
  reader.onload = e => { img.src = e.target.result; };
  reader.readAsDataURL(file);
  name.textContent = file.name;
  preview.style.display = 'flex';
}

function clearFileAttachment() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('filePreviewArea').style.display = 'none';
  document.getElementById('filePreviewImg').src = '';
}

// ── Typing indicator ──────────────────────────────────────────────────────────

const messageInput = document.getElementById('messageInput');
if (messageInput) {
  messageInput.addEventListener('input', function() {
    autoResize(this);
    if (!currentPartnerId) return;
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing', { partner_id: currentPartnerId, typing: true });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2000);
  });

  messageInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

function stopTyping() {
  if (isTyping && currentPartnerId) {
    isTyping = false;
    socket.emit('typing', { partner_id: currentPartnerId, typing: false });
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Search ────────────────────────────────────────────────────────────────────

const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const convList = document.getElementById('conversationsList');
let searchDelay;

if (searchInput) {
  searchInput.addEventListener('input', function() {
    clearTimeout(searchDelay);
    const q = this.value.trim();
    if (!q) {
      searchResults.style.display = 'none';
      convList.style.display = 'block';
      return;
    }
    searchDelay = setTimeout(() => {
      fetch(`/api/search_users?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(users => {
          if (!users.length) {
            searchResults.innerHTML = `<div style="padding:12px; color:var(--text-faint); font-size:13px; text-align:center;">Не найдено</div>`;
          } else {
            searchResults.innerHTML = users.map(u => {
              const initials = u.display_name ? u.display_name[0].toUpperCase() : '?';
              const avatar = u.avatar
                ? `<img class="avatar avatar-sm" src="${u.avatar}" alt="">`
                : `<div class="avatar-placeholder sm">${initials}</div>`;
              return `<div class="search-result-item" onclick="openConversation(${u.id}); searchInput.value=''; searchResults.style.display='none'; convList.style.display='block';">
                <div class="avatar-wrap">${avatar}${u.online ? '<span class="online-dot"></span>' : ''}</div>
                <div>
                  <div style="font-weight:600; font-size:13px;">${escapeHtml(u.display_name)}</div>
                  <div style="color:var(--text-muted); font-size:12px;">@${escapeHtml(u.username)}</div>
                </div>
              </div>`;
            }).join('');
          }
          searchResults.style.display = 'block';
          convList.style.display = 'none';
        });
    }, 300);
  });
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// ── Dropdown menu ─────────────────────────────────────────────────────────────

const userMenuBtn = document.getElementById('userMenuBtn');
const userMenu = document.getElementById('userMenu');
if (userMenuBtn) {
  userMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    userMenu.classList.toggle('open');
  });
  document.addEventListener('click', () => userMenu.classList.remove('open'));
}

// ── Notification ──────────────────────────────────────────────────────────────

function showNotification(text, link) {
  const n = document.createElement('div');
  n.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px;box-shadow:var(--shadow);z-index:9999;cursor:pointer;max-width:300px;font-size:13px;';
  n.innerHTML = `<strong>Уведомление</strong><br>${escapeHtml(text)}`;
  n.onclick = () => { if (link) window.location.href = link; n.remove(); };
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 5000);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
