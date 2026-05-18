const socket = io();
let currentPartnerId = null;
let currentPartnerData = null;
let currentGroupId = null;
let currentChatType = 'direct'; // 'direct' | 'group'
let currentPage = 1;
let hasMoreMessages = false;
let typingTimeout = null;
let isTyping = false;
let selectedFile = null;

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('connect', () => {
  loadConversations();
});

socket.on('new_message', (msg) => {
  if (currentChatType === 'direct' && currentPartnerId &&
      (msg.sender_id === currentPartnerId || msg.receiver_id === currentPartnerId)) {
    if (msg.sender_id !== CURRENT_USER_ID) {
      appendMessage(msg);
      scrollToBottom();
    }
    fetch(`/api/messages/${currentPartnerId}?page=1`);
  }
  loadConversations();
});

socket.on('group_message', (msg) => {
  if (currentChatType === 'group' && currentGroupId === msg.group_id) {
    if (msg.sender_id !== CURRENT_USER_ID) {
      appendMessage(msg);
      scrollToBottom();
    }
  }
  loadConversations();
});

socket.on('added_to_group', () => {
  loadConversations();
});

socket.on('typing', (data) => {
  if (currentChatType === 'direct' && data.user_id === currentPartnerId) {
    const el = document.getElementById('typingIndicator');
    el.style.display = data.typing ? 'flex' : 'none';
  }
});

socket.on('user_status', (data) => {
  if (currentChatType === 'direct' && data.user_id === currentPartnerId) {
    const statusEl = document.getElementById('partnerStatus');
    if (statusEl) {
      statusEl.textContent = data.online ? 'онлайн' : 'офлайн';
      statusEl.className = 'status' + (data.online ? ' online' : '');
    }
  }
  loadConversations();
});

socket.on('new_conversation_notify', (msg) => {
  loadConversations();
  if (msg.sender_id !== currentPartnerId) {
    showToast(msg.sender ? msg.sender.display_name : 'Новое сообщение',
              msg.content || '📷 Фото', null);
  }
});

socket.on('user_updated', (user) => {
  if (currentChatType === 'direct' && currentPartnerId === user.id) {
    document.getElementById('partnerName').textContent = user.display_name;
    const avatarWrap = document.getElementById('partnerAvatarWrap');
    const initials = user.display_name ? user.display_name[0].toUpperCase() : '?';
    avatarWrap.innerHTML = user.avatar
      ? `<img class="avatar" src="${user.avatar}?t=${Date.now()}" alt=""><span class="online-dot" id="partnerOnlineDot" style="${user.online ? '' : 'display:none'}"></span>`
      : `<div class="avatar-placeholder">${initials}</div>`;
    const statusEl = document.getElementById('partnerStatus');
    if (statusEl) {
      statusEl.textContent = user.online ? 'онлайн' : user.last_seen;
      statusEl.className = 'status' + (user.online ? ' online' : '');
    }
  }
  loadConversations();
});

socket.on('ticket_reply_notify', (data) => {
  showToast('Поддержка', `Ответ на тикет: ${data.subject}`, `/support/ticket/${data.ticket_id}`);
});

// ── Conversations + Groups ────────────────────────────────────────────────────

function loadConversations() {
  // Show cached immediately
  const cached = localStorage.getItem('flight_convs_cache');
  if (cached) {
    try {
      renderConvList(JSON.parse(cached));
    } catch(e) {}
  }

  // Fetch fresh
  Promise.all([
    fetch('/api/conversations').then(r => r.json()),
    fetch('/api/groups').then(r => r.json()),
  ]).then(([convs, groups]) => {
    const directItems = convs.map(c => ({
      type: 'direct',
      sortKey: c.last_message ? (c.last_message.created_date + c.last_message.created_at) : '',
      data: c,
    }));
    const groupItems = groups.map(g => ({
      type: 'group',
      sortKey: g.last_message ? (g.last_message.created_date + g.last_message.created_at) : '',
      data: g,
    }));
    const all = [...directItems, ...groupItems]
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    localStorage.setItem('flight_convs_cache', JSON.stringify(all));
    renderConvList(all);
  });
}

function renderConvList(items) {
  const list = document.getElementById('conversationsList');
  if (!items.length) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:13px;">Нет диалогов.<br>Найдите пользователя выше.</div>`;
    return;
  }
  list.innerHTML = items.map(item =>
    item.type === 'group'
      ? renderGroupItem(item.data)
      : renderConversationItem(item.data)
  ).join('');
}

function renderConversationItem(c) {
  const p = c.partner;
  const active = (currentChatType === 'direct' && currentPartnerId === p.id) ? 'active' : '';
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

function renderGroupItem(g) {
  const gr = g.group;
  const active = (currentChatType === 'group' && currentGroupId === gr.id) ? 'active' : '';
  const lastMsg = g.last_message
    ? (g.last_message.message_type === 'image' ? '📷 Фото' : escapeHtml((g.last_message.content || '').slice(0, 40)))
    : 'Нет сообщений';
  const time = g.last_message ? g.last_message.created_at : '';
  const initials = gr.name ? gr.name[0].toUpperCase() : '#';

  return `<div class="conv-item ${active}" onclick="openGroup(${gr.id})">
    <div class="avatar-wrap">
      ${gr.avatar
        ? `<img class="avatar" src="${gr.avatar}" alt="">`
        : `<div class="conv-group-badge">${initials}</div>`}
    </div>
    <div class="conv-info">
      <div class="conv-name">${escapeHtml(gr.name)}<span class="group-indicator">ГРУППА</span></div>
      <div class="conv-preview">${lastMsg}</div>
    </div>
    <div class="conv-meta">
      <span class="conv-time">${time}</span>
    </div>
  </div>`;
}

// ── Open direct conversation ──────────────────────────────────────────────────

function openConversation(partnerId) {
  if (currentChatType === 'direct' && currentPartnerId === partnerId) return;

  if (currentPartnerId) socket.emit('leave_conversation', { partner_id: currentPartnerId });

  currentPartnerId = partnerId;
  currentGroupId = null;
  currentChatType = 'direct';
  currentPage = 1;
  hasMoreMessages = false;

  socket.emit('join_conversation', { partner_id: partnerId });

  showChatWindow();
  loadPartnerInfo(partnerId);
  loadMessages(partnerId, 1);
  mobileOpenChat();
  loadConversations();
}

// ── Open group ────────────────────────────────────────────────────────────────

function openGroup(groupId) {
  if (currentChatType === 'group' && currentGroupId === groupId) return;

  if (currentPartnerId) socket.emit('leave_conversation', { partner_id: currentPartnerId });

  currentPartnerId = null;
  currentGroupId = groupId;
  currentChatType = 'group';
  currentPage = 1;
  hasMoreMessages = false;

  socket.emit('join_group', { group_id: groupId });

  showChatWindow();
  loadGroupInfo(groupId);
  loadGroupMessages(groupId, 1);
  mobileOpenChat();
  loadConversations();

  // Hide call buttons for groups
  document.getElementById('callAudioBtn').style.display = 'none';
  document.getElementById('callVideoBtn').style.display = 'none';
}

function loadGroupInfo(groupId) {
  fetch(`/api/groups/${groupId}/info`)
    .then(r => r.json())
    .then(g => {
      const initials = g.name ? g.name[0].toUpperCase() : '#';
      const avatarWrap = document.getElementById('partnerAvatarWrap');
      avatarWrap.innerHTML = g.avatar
        ? `<img class="avatar" src="${g.avatar}" alt="">`
        : `<div class="conv-group-badge">${initials}</div>`;
      document.getElementById('partnerName').textContent = g.name;
      const statusEl = document.getElementById('partnerStatus');
      statusEl.textContent = `${g.member_count} участников`;
      statusEl.className = 'status';
      const link = document.getElementById('partnerProfileLink');
      if (link) link.style.display = 'none';
    });
}

function loadGroupMessages(groupId, page) {
  fetch(`/api/groups/${groupId}/messages?page=${page}`)
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
        let html = '';
        data.messages.forEach(msg => html += renderMessage(msg));
        document.getElementById('loadMoreBtn').insertAdjacentHTML('afterend', html);
        area.scrollTop = area.scrollHeight - scrollBottom;
      }
      currentPage = page;
    });
}

function showChatWindow() {
  document.getElementById('chatEmpty').style.display = 'none';
  const win = document.getElementById('chatWindow');
  win.style.display = 'flex';
  win.style.flexDirection = 'column';
  win.style.height = '100%';

  document.getElementById('messagesArea').innerHTML = `
    <div class="load-more" id="loadMoreBtn" style="text-align:center;padding:10px;display:none;">
      <button class="btn btn-ghost btn-sm" onclick="loadMoreMessages()">Загрузить ещё</button>
    </div>`;

  // Restore call buttons for direct chats
  document.getElementById('callAudioBtn').style.display = '';
  document.getElementById('callVideoBtn').style.display = '';

  const link = document.getElementById('partnerProfileLink');
  if (link) link.style.display = '';
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
        let html = '';
        data.messages.forEach(msg => html += renderMessage(msg));
        document.getElementById('loadMoreBtn').insertAdjacentHTML('afterend', html);
        area.scrollTop = area.scrollHeight - scrollBottom;
      }

      currentPage = page;
      loadConversations();
    });
}

function loadMoreMessages() {
  if (hasMoreMessages) {
    if (currentChatType === 'group' && currentGroupId) {
      loadGroupMessages(currentGroupId, currentPage + 1);
    } else if (currentPartnerId) {
      loadMessages(currentPartnerId, currentPage + 1);
    }
  }
}

function renderMessage(msg) {
  const own = msg.sender_id === CURRENT_USER_ID;
  const cls = own ? 'own' : 'other';
  const initials = msg.sender ? msg.sender.display_name[0].toUpperCase() : '?';

  // Show sender name in group chats for incoming messages
  const showName = currentChatType === 'group' && !own && msg.sender;
  const senderName = showName ? `<div class="msg-sender-name">${escapeHtml(msg.sender.display_name)}</div>` : '';

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

  const checkmark = own && !msg.group_id
    ? `<svg class="read-check" fill="none" viewBox="0 0 24 24" stroke="${msg.is_read ? '#818cf8' : 'rgba(255,255,255,0.5)'}"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
    : '';

  return `<div class="message-row ${cls}" data-msg-id="${msg.id || ''}">
    ${avatar}
    <div class="message-bubble">
      ${senderName}
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
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text && !selectedFile) return;

  const fd = new FormData();
  fd.append('content', text);
  if (selectedFile) fd.append('image', selectedFile);

  input.value = '';
  autoResize(input);
  clearFileAttachment();
  stopTyping();

  let url;
  if (currentChatType === 'group' && currentGroupId) {
    url = `/api/groups/${currentGroupId}/send`;
  } else if (currentPartnerId) {
    fd.append('receiver_id', currentPartnerId);
    url = '/api/send_message';
  } else {
    return;
  }

  fetch(url, { method: 'POST', body: fd })
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
    if (!currentPartnerId || currentChatType !== 'direct') return;
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
            searchResults.innerHTML = `<div style="padding:12px;color:var(--text-faint);font-size:13px;text-align:center;">Не найдено</div>`;
          } else {
            searchResults.innerHTML = users.map(u => {
              const initials = u.display_name ? u.display_name[0].toUpperCase() : '?';
              const avatar = u.avatar
                ? `<img class="avatar avatar-sm" src="${u.avatar}" alt="">`
                : `<div class="avatar-placeholder sm">${initials}</div>`;
              return `<div class="search-result-item" onclick="openConversation(${u.id}); searchInput.value=''; searchResults.style.display='none'; convList.style.display='block';">
                <div class="avatar-wrap">${avatar}${u.online ? '<span class="online-dot"></span>' : ''}</div>
                <div>
                  <div style="font-weight:600;font-size:13px;">${escapeHtml(u.display_name)}</div>
                  <div style="color:var(--text-muted);font-size:12px;">@${escapeHtml(u.username)}</div>
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

// ── Create group modal ────────────────────────────────────────────────────────

let selectedGroupMembers = {};

function openCreateGroup() {
  selectedGroupMembers = {};
  document.getElementById('groupNameInput').value = '';
  document.getElementById('membersChips').innerHTML = '';
  document.getElementById('groupMemberSearch').value = '';
  document.getElementById('groupMemberResults').innerHTML = '';
  document.getElementById('createGroupModal').classList.add('open');
}

function closeCreateGroup() {
  document.getElementById('createGroupModal').classList.remove('open');
}

const groupMemberSearchInput = document.getElementById('groupMemberSearch');
if (groupMemberSearchInput) {
  let gDelay;
  groupMemberSearchInput.addEventListener('input', function() {
    clearTimeout(gDelay);
    const q = this.value.trim();
    if (!q) { document.getElementById('groupMemberResults').innerHTML = ''; return; }
    gDelay = setTimeout(() => {
      fetch(`/api/search_users?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(users => {
          const res = document.getElementById('groupMemberResults');
          res.innerHTML = users.filter(u => !selectedGroupMembers[u.id]).map(u => {
            const initials = u.display_name ? u.display_name[0].toUpperCase() : '?';
            const avatar = u.avatar
              ? `<img class="avatar avatar-sm" src="${u.avatar}" alt="">`
              : `<div class="avatar-placeholder sm">${initials}</div>`;
            return `<div class="search-result-item" onclick="addGroupMember(${u.id}, '${escapeHtml(u.display_name)}')">
              <div class="avatar-wrap">${avatar}</div>
              <div>
                <div style="font-weight:600;font-size:13px;">${escapeHtml(u.display_name)}</div>
                <div style="color:var(--text-muted);font-size:12px;">@${escapeHtml(u.username)}</div>
              </div>
            </div>`;
          }).join('');
        });
    }, 300);
  });
}

function addGroupMember(id, name) {
  if (selectedGroupMembers[id]) return;
  selectedGroupMembers[id] = name;
  renderMemberChips();
  document.getElementById('groupMemberSearch').value = '';
  document.getElementById('groupMemberResults').innerHTML = '';
}

function removeGroupMember(id) {
  delete selectedGroupMembers[id];
  renderMemberChips();
}

function renderMemberChips() {
  const chips = document.getElementById('membersChips');
  chips.innerHTML = Object.entries(selectedGroupMembers).map(([id, name]) =>
    `<span class="member-chip" onclick="removeGroupMember(${id})">
      ${escapeHtml(name)} ✕
    </span>`
  ).join('');
}

function submitCreateGroup() {
  const name = document.getElementById('groupNameInput').value.trim();
  if (!name) { alert('Введите название группы'); return; }

  const fd = new FormData();
  fd.append('name', name);
  Object.keys(selectedGroupMembers).forEach(id => fd.append('member_ids', id));

  fetch('/api/groups/create', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(g => {
      if (g.error) { alert(g.error); return; }
      closeCreateGroup();
      loadConversations();
      setTimeout(() => openGroup(g.id), 300);
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeCreateGroup(); } });

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

// ── Toast notification ────────────────────────────────────────────────────────

function showToast(title, text, link) {
  const n = document.createElement('div');
  n.className = 'toast-notification';
  n.innerHTML = `
    <div class="toast-icon">✉</div>
    <div class="toast-content">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(text || '')}</span>
    </div>`;
  n.onclick = () => { if (link) window.location.href = link; n.remove(); };
  document.body.appendChild(n);
  setTimeout(() => {
    n.style.opacity = '0';
    n.style.transform = 'translateX(50px)';
    n.style.transition = 'all 0.3s ease';
    setTimeout(() => n.remove(), 300);
  }, 4000);
}

// Keep old showNotification for compatibility
function showNotification(text, link) {
  showToast('Уведомление', text, link);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Mobile navigation ─────────────────────────────────────────────────────────

function isMobile() {
  return window.innerWidth <= 768;
}

function mobileOpenChat() {
  if (!isMobile()) return;
  document.getElementById('sidebar').classList.add('mobile-hidden');
  document.getElementById('chatArea').classList.add('mobile-active');
}

function mobileBackToSidebar() {
  if (!isMobile()) return;
  document.getElementById('sidebar').classList.remove('mobile-hidden');
  document.getElementById('chatArea').classList.remove('mobile-active');
}

// ── iOS visual viewport fix ───────────────────────────────────────────────────

if (window.visualViewport) {
  const layout = document.querySelector('.app-layout');
  function onVVResize() {
    const h = window.visualViewport.height;
    if (layout) layout.style.height = h + 'px';
    const area = document.getElementById('messagesArea');
    if (area) area.scrollTop = area.scrollHeight;
  }
  window.visualViewport.addEventListener('resize', onVVResize);
  window.visualViewport.addEventListener('scroll', onVVResize);
}
