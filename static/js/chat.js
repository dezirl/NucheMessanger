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
let currentTab = 'all';
let pinnedChats = [];
let unreadBelowCount = 0;
let ctxMsgId = null;
let ctxMsgSenderId = null;
let ctxMsgText = '';
let ctxChatType = null;
let ctxGroupId = null;
let replyToMsg = null; // {id, senderName, text}

// ── Audio player state ──────────────────────────────────────────────────────
const _audio = new Audio();
let audioPlaylist = []; // [{url, senderName}]
let audioIdx = -1;
let audioPlaying = false;

_audio.addEventListener('timeupdate', () => {
  const bar = document.getElementById('audioPlayerBar');
  if (!bar || !_audio.duration) return;
  const pct = (_audio.currentTime / _audio.duration) * 100;
  document.getElementById('apbProgress').value = pct;
  document.getElementById('apbTime').textContent =
    `${fmtTime(_audio.currentTime)} / ${fmtTime(_audio.duration)}`;
});
_audio.addEventListener('ended', () => audioPlayerNext());
_audio.addEventListener('play', () => {
  audioPlaying = true;
  document.getElementById('apbPlayIcon').style.display = 'none';
  document.getElementById('apbPauseIcon').style.display = '';
});
_audio.addEventListener('pause', () => {
  audioPlaying = false;
  document.getElementById('apbPlayIcon').style.display = '';
  document.getElementById('apbPauseIcon').style.display = 'none';
});

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function playAudio(url, senderName, msgEl) {
  const existing = audioPlaylist.findIndex(a => a.url === url);
  if (existing === -1) {
    audioPlaylist = collectAudioFromChat();
    audioIdx = audioPlaylist.findIndex(a => a.url === url);
    if (audioIdx === -1) { audioPlaylist.push({url, senderName}); audioIdx = audioPlaylist.length - 1; }
  } else { audioIdx = existing; }
  _audio.src = audioPlaylist[audioIdx].url;
  _audio.play().catch(e => console.warn('Audio play error:', e));
  document.getElementById('apbName').textContent = audioPlaylist[audioIdx].senderName || 'Аудио';
  document.getElementById('audioPlayerBar').classList.add('visible');
}

function collectAudioFromChat() {
  const msgs = document.querySelectorAll('.msg-audio-play[data-audio-url]');
  return Array.from(msgs).map(btn => ({
    url: btn.dataset.audioUrl,
    senderName: btn.dataset.senderName || 'Аудио'
  }));
}

function toggleAudioPlayback() {
  if (!_audio.src) return;
  audioPlaying ? _audio.pause() : _audio.play();
}
function seekAudio(val) { if (_audio.duration) _audio.currentTime = (_audio.duration * val) / 100; }
function audioPlayerNext() {
  if (audioIdx < audioPlaylist.length - 1) {
    audioIdx++;
    _audio.src = audioPlaylist[audioIdx].url;
    _audio.play().catch(e => console.warn('Audio play error:', e));
    document.getElementById('apbName').textContent = audioPlaylist[audioIdx].senderName || 'Аудио';
  } else { closeAudioPlayer(); }
}
function audioPlayerPrev() {
  if (audioIdx > 0) {
    audioIdx--;
    _audio.src = audioPlaylist[audioIdx].url;
    _audio.play().catch(e => console.warn('Audio play error:', e));
    document.getElementById('apbName').textContent = audioPlaylist[audioIdx].senderName || 'Аудио';
  }
}
function closeAudioPlayer() {
  _audio.pause();
  _audio.src = '';
  audioPlaying = false;
  document.getElementById('audioPlayerBar').classList.remove('visible');
}

// ── Voice recording ──────────────────────────────────────────────────────────
let mediaRecorder = null;
let voiceChunks = [];
let voiceTimerInterval = null;
let voiceSeconds = 0;

function startVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    voiceChunks = [];
    voiceSeconds = 0;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) voiceChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(voiceTimerInterval);
      document.getElementById('voiceRecordingIndicator').classList.remove('active');
      document.getElementById('voiceBtn').classList.remove('recording');
      if (voiceChunks.length && voiceSeconds >= 1) {
        const blob = new Blob(voiceChunks, { type: 'audio/webm' });
        sendVoiceMessage(blob);
      }
      mediaRecorder = null;
    };
    mediaRecorder.start();
    document.getElementById('voiceRecordingIndicator').classList.add('active');
    document.getElementById('voiceBtn').classList.add('recording');
    document.getElementById('voiceRecTimer').textContent = '0:00';
    voiceTimerInterval = setInterval(() => {
      voiceSeconds++;
      document.getElementById('voiceRecTimer').textContent = fmtTime(voiceSeconds);
    }, 1000);
    document.addEventListener('mouseup', stopVoiceRecord, {once: true});
    document.addEventListener('touchend', stopVoiceRecord, {once: true});
  }).catch(() => alert('Нет доступа к микрофону'));
}

function stopVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

function cancelVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    voiceChunks = [];
    voiceSeconds = 0;
    mediaRecorder.stop();
  }
}

function sendVoiceMessage(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'voice.webm');
  fd.append('is_voice', '1');
  let url;
  if (currentChatType === 'group' && currentGroupId) {
    url = `/api/groups/${currentGroupId}/send`;
  } else if (currentPartnerId) {
    fd.append('receiver_id', currentPartnerId);
    url = '/api/send_message';
  } else return;
  fetch(url, { method: 'POST', body: fd })
    .then(r => r.json())
    .then(msg => { if (!msg.error) { appendMessage(msg); scrollToBottom(); } });
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('connect', () => {
  const cached = localStorage.getItem('flight_convs_cache');
  if (cached) { try { renderConvList(JSON.parse(cached)); } catch(e) {} }
  loadConversations();
});

socket.on('new_message', (msg) => {
  if (currentChatType === 'direct' && currentPartnerId &&
      (msg.sender_id === currentPartnerId || msg.receiver_id === currentPartnerId)) {
    if (msg.sender_id !== CURRENT_USER_ID) {
      appendMessage(msg);
      if (!isNearBottom()) { unreadBelowCount++; updateScrollBtn(); }
      else scrollToBottom();
    }
  }
  loadConversations();
});

socket.on('group_message', (msg) => {
  if (currentChatType === 'group' && currentGroupId === msg.group_id) {
    if (msg.sender_id !== CURRENT_USER_ID) {
      appendMessage(msg);
      if (!isNearBottom()) { unreadBelowCount++; updateScrollBtn(); }
      else scrollToBottom();
    }
  }
  loadConversations();
});

socket.on('message_edited', (data) => {
  const row = document.querySelector(`.message-row[data-msg-id="${data.msg_id}"]`);
  if (row) {
    const textEl = row.querySelector('.msg-text');
    if (textEl) textEl.textContent = data.content;
    const edited = row.querySelector('.msg-edited');
    if (!edited) {
      const timeEl = row.querySelector('.msg-time');
      if (timeEl) timeEl.insertAdjacentHTML('beforebegin', '<span class="msg-edited" style="font-size:10px;opacity:0.6;"> изм.</span>');
    }
  }
});

socket.on('message_deleted', (data) => {
  const row = document.querySelector(`.message-row[data-msg-id="${data.msg_id}"]`);
  if (row && data.scope === 'all') row.remove();
});

socket.on('group_message_edited', (data) => {
  const row = document.querySelector(`.message-row[data-msg-id="${data.msg_id}"]`);
  if (row) {
    const textEl = row.querySelector('.msg-text');
    if (textEl) textEl.textContent = data.content;
    const edited = row.querySelector('.msg-edited');
    if (!edited) {
      const timeEl = row.querySelector('.msg-time');
      if (timeEl) timeEl.insertAdjacentHTML('beforebegin', '<span class="msg-edited" style="font-size:10px;opacity:0.6;"> изм.</span>');
    }
  }
});

socket.on('group_message_deleted', (data) => {
  const row = document.querySelector(`.message-row[data-msg-id="${data.msg_id}"]`);
  if (row) {
    row.querySelector('.message-bubble').innerHTML = '<em style="opacity:0.5;font-size:13px;">Сообщение удалено</em>';
  }
});

socket.on('added_to_group', () => { loadConversations(); });

socket.on('typing', (data) => {
  if (currentChatType === 'direct' && data.user_id === currentPartnerId) {
    const el = document.getElementById('typingIndicator');
    el.style.display = data.typing ? 'flex' : 'none';
  }
});

socket.on('user_status', (data) => {
  if (currentChatType === 'direct' && data.user_id === currentPartnerId) {
    const statusEl = document.getElementById('partnerStatus');
    if (statusEl) { statusEl.textContent = data.online ? 'онлайн' : 'офлайн'; statusEl.className = 'status' + (data.online ? ' online' : ''); }
  }
  loadConversations();
});

socket.on('new_conversation_notify', (msg) => {
  loadConversations();
  if (msg.sender_id !== currentPartnerId) {
    showToast(msg.sender ? msg.sender.display_name : 'Новое сообщение', msg.content || '📷 Медиа', null);
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
    if (statusEl) { statusEl.textContent = user.online ? 'онлайн' : user.last_seen; statusEl.className = 'status' + (user.online ? ' online' : ''); }
  }
  loadConversations();
});

socket.on('ticket_reply_notify', (data) => {
  showToast('Поддержка', `Ответ на тикет: ${data.subject}`, `/support/ticket/${data.ticket_id}`);
});

// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.chat-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  if (_lastConvItems.length) renderConvList(_lastConvItems);
  else { _lastConvRender = ''; loadConversations(); }
}

// ── Conversations + Groups ────────────────────────────────────────────────────

let _convLoadTimer = null;
let _lastConvRender = '';
let _lastConvItems = [];

function loadConversations() {
  clearTimeout(_convLoadTimer);
  _convLoadTimer = setTimeout(_doLoadConversations, 120);
}

function _doLoadConversations() {
  Promise.all([
    fetch('/api/conversations').then(r => r.json()),
    fetch('/api/groups').then(r => r.json()),
    fetch('/api/channels/subscribed').then(r => r.json()),
    fetch('/api/pins').then(r => r.json()),
  ]).then(([convs, groups, channels, pins]) => {
    pinnedChats = pins;

    const isPinned = (type, id) => pins.some(p => p.chat_type === type && p.target_id === id);

    const directItems = convs.map(c => ({
      type: 'direct', pinned: isPinned('direct', c.partner.id),
      sortKey: c.last_message ? (c.last_message.created_date + c.last_message.created_at) : '',
      data: c,
    }));
    const groupItems = groups.map(g => ({
      type: 'group', pinned: isPinned('group', g.group.id),
      sortKey: g.last_message ? (g.last_message.created_date + g.last_message.created_at) : '',
      data: g,
    }));
    const channelItems = channels.map(ch => ({
      type: 'channel', pinned: isPinned('channel', ch.channel.id),
      sortKey: ch.last_post ? (ch.last_post.created_date + ch.last_post.created_at) : '',
      data: ch,
    }));

    let all = [...directItems, ...groupItems, ...channelItems];
    all.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.sortKey.localeCompare(a.sortKey);
    });

    const signature = JSON.stringify(all.map(x =>
      x.type === 'direct'
        ? `d${x.data.partner.id}:${x.data.last_message?.created_at||''}:${x.data.unread_count}:${x.pinned}`
        : x.type === 'group'
        ? `g${x.data.group.id}:${x.data.last_message?.created_at||''}:${x.pinned}`
        : `c${x.data.channel.id}:${x.data.last_post?.created_at||''}:${x.data.channel.is_live}:${x.pinned}`
    ));
    if (signature === _lastConvRender) return;
    _lastConvRender = signature;
    _lastConvItems = all;

    localStorage.setItem('flight_convs_cache', JSON.stringify(all));
    renderConvList(all);
  });
}

function renderConvList(items) {
  const list = document.getElementById('conversationsList');
  let filtered = items;
  if (currentTab !== 'all') filtered = items.filter(i => i.type === currentTab);
  if (!filtered.length) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:13px;">Нет диалогов.</div>`;
    return;
  }
  list.innerHTML = filtered.map(item =>
    item.type === 'group'
      ? renderGroupItem(item.data, item.pinned)
      : item.type === 'channel'
      ? renderChannelItem(item.data, item.pinned)
      : renderConversationItem(item.data, item.pinned)
  ).join('');
}

function renderConversationItem(c, pinned) {
  const p = c.partner;
  const active = (currentChatType === 'direct' && currentPartnerId === p.id) ? 'active' : '';
  const initials = p.display_name ? p.display_name[0].toUpperCase() : '?';
  const avatar = p.avatar ? `<img class="avatar" src="${p.avatar}" alt="">` : `<div class="avatar-placeholder">${initials}</div>`;
  const onlineDot = p.online ? '<span class="online-dot"></span>' : '';
  const lastMsg = c.last_message
    ? (c.last_message.message_type === 'image' ? '📷 Фото'
       : c.last_message.message_type === 'audio' ? '🎵 Аудио'
       : c.last_message.message_type === 'voice' ? '🎤 Голосовое'
       : escapeHtml(c.last_message.content.slice(0, 40))) : '';
  const time = c.last_message ? c.last_message.created_at : '';
  const unread = c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : '';
  const pinIcon = pinned ? '<span class="conv-pin-icon">📌</span>' : '';

  return `<div class="conv-item ${active}" onclick="openConversation(${p.id})" oncontextmenu="openConvContextMenu(event,'direct',${p.id})">
    <div class="avatar-wrap">${avatar}${onlineDot}</div>
    <div class="conv-info">
      <div class="conv-name">${escapeHtml(p.display_name)}${pinIcon}</div>
      <div class="conv-preview">${lastMsg}</div>
    </div>
    <div class="conv-meta"><span class="conv-time">${time}</span>${unread}</div>
  </div>`;
}

function renderGroupItem(g, pinned) {
  const gr = g.group;
  const active = (currentChatType === 'group' && currentGroupId === gr.id) ? 'active' : '';
  const lastMsg = g.last_message
    ? (g.last_message.message_type === 'image' ? '📷 Фото'
       : g.last_message.message_type === 'voice' ? '🎤 Голосовое'
       : escapeHtml((g.last_message.content || '').slice(0, 40))) : 'Нет сообщений';
  const time = g.last_message ? g.last_message.created_at : '';
  const initials = gr.name ? gr.name[0].toUpperCase() : '#';
  const pinIcon = pinned ? '<span class="conv-pin-icon">📌</span>' : '';

  return `<div class="conv-item ${active}" onclick="openGroup(${gr.id})" oncontextmenu="openConvContextMenu(event,'group',${gr.id})">
    <div class="avatar-wrap">
      ${gr.avatar ? `<img class="avatar" src="${gr.avatar}" alt="">` : `<div class="conv-group-badge">${initials}</div>`}
    </div>
    <div class="conv-info">
      <div class="conv-name">${escapeHtml(gr.name)}${pinIcon}<span class="group-indicator">ГРУППА</span></div>
      <div class="conv-preview">${lastMsg}</div>
    </div>
    <div class="conv-meta"><span class="conv-time">${time}</span></div>
  </div>`;
}

function renderChannelItem(ch, pinned) {
  const c = ch.channel;
  const active = (currentChatType === 'channel' && currentChannelId === c.id) ? 'active' : '';
  const lastPost = ch.last_post ? (ch.last_post.message_type === 'image' ? '📷 Фото' : escapeHtml((ch.last_post.content || '').slice(0, 40))) : 'Нет постов';
  const time = ch.last_post ? ch.last_post.created_at : '';
  const liveTag = c.is_live ? ' <span style="color:#ef4444;font-size:10px;font-weight:700;">LIVE</span>' : '';
  const initials = c.name ? c.name[0].toUpperCase() : '#';
  const pinIcon = pinned ? '<span class="conv-pin-icon">📌</span>' : '';
  return `<div class="conv-item ${active}" onclick="openChannelInSidebar(${c.id}, '${escapeHtml(c.username)}')" oncontextmenu="openConvContextMenu(event,'channel',${c.id})">
    <div class="avatar-wrap" style="position:relative;">
      ${c.avatar ? `<img class="avatar" src="${c.avatar}" alt="">` : `<div class="conv-channel-badge">${initials}</div>`}
      ${c.is_live ? '<span style="position:absolute;bottom:0;right:0;width:10px;height:10px;background:#ef4444;border-radius:50%;border:2px solid var(--surface);"></span>' : ''}
    </div>
    <div class="conv-info">
      <div class="conv-name">${escapeHtml(c.name)}${liveTag}${pinIcon}<span class="group-indicator" style="background:rgba(239,68,68,0.12);color:#ef4444;">КАНАЛ</span></div>
      <div class="conv-preview">${lastPost}</div>
    </div>
    <div class="conv-meta"><span class="conv-time">${time}</span></div>
  </div>`;
}

let currentChannelId = null;
function openChannelInSidebar(channelId, channelUsername) {
  window.location.href = `/channel/${channelUsername}`;
}

// ── Context menu (right-click on conv items) ──────────────────────────────────
let convCtxType = null, convCtxId = null;

function openConvContextMenu(e, type, id) {
  e.preventDefault();
  convCtxType = type; convCtxId = id;
  // Reuse ctx menu for pin action
  const menu = document.getElementById('ctxMenu');
  // Temporarily show only pin option
  document.getElementById('ctxEdit').style.display = 'none';
  document.getElementById('ctxDeleteAll').style.display = 'none';
  document.querySelectorAll('.ctx-item').forEach(i => { if (!i.id || i.id === 'ctxPin') i.style.display = 'none'; });
  document.getElementById('ctxPin').style.display = '';
  const isPinned = pinnedChats.some(p => p.chat_type === type && p.target_id === id);
  document.getElementById('ctxPin').querySelector('svg + text') ||
    (document.getElementById('ctxPin').lastChild.textContent = isPinned ? ' Открепить чат' : ' Закрепить чат');
  document.getElementById('ctxPin').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>${isPinned ? ' Открепить' : ' Закрепить'}`;
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';
}

function ctxPinChat() {
  hideCtxMenu();
  if (!convCtxType || !convCtxId) return;
  const fd = new FormData();
  fd.append('chat_type', convCtxType);
  fd.append('target_id', convCtxId);
  fetch('/api/pin', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(() => { _lastConvRender = ''; loadConversations(); });
  convCtxType = null; convCtxId = null;
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
  unreadBelowCount = 0;
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
  unreadBelowCount = 0;
  socket.emit('join_group', { group_id: groupId });
  showChatWindow();
  loadGroupInfo(groupId);
  loadGroupMessages(groupId, 1);
  mobileOpenChat();
  loadConversations();
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
      window._currentGroupData = g;
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
        let lastDate = null, html = '';
        data.messages.forEach(msg => {
          if (msg.created_date !== lastDate) { html += `<div class="date-divider"><span>${msg.created_date}</span></div>`; lastDate = msg.created_date; }
          html += renderMessage(msg);
        });
        area.insertAdjacentHTML('beforeend', html);
        setTimeout(() => scrollToBottom(), 50);
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
  document.getElementById('callAudioBtn').style.display = '';
  document.getElementById('callVideoBtn').style.display = '';
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
      window._currentCallTarget = user;
    });
}

// ── Chat header click ─────────────────────────────────────────────────────────

function openChatInfo() {
  if (currentChatType === 'group') openGroupMembersModal();
  else openUserInfoPanel();
}

// ── User Info Panel ───────────────────────────────────────────────────────────

function openUserInfoPanel() {
  if (currentChatType !== 'direct' || !currentPartnerData) return;
  const u = currentPartnerData;
  const panel = document.getElementById('userInfoPanel');
  const initials = u.display_name ? u.display_name[0].toUpperCase() : '?';
  document.getElementById('uipAvatarWrap').innerHTML = u.avatar
    ? `<img class="uip-avatar" src="${u.avatar}" alt="" onclick="openLightbox('${u.avatar}')">`
    : `<div class="uip-avatar-placeholder">${initials}</div>`;
  document.getElementById('uipDisplayName').textContent = u.display_name;
  document.getElementById('uipUsername').textContent = '@' + u.username;
  const statusEl = document.getElementById('uipStatus');
  statusEl.textContent = u.online ? '● Онлайн' : `● ${u.last_seen}`;
  statusEl.className = 'uip-status' + (u.online ? ' online' : '');
  document.getElementById('uipBio').textContent = u.bio || '';
  document.getElementById('uipProfileLink').href = `/profile/${u.username}`;

  // Collect shared images from current chat
  const imgs = document.querySelectorAll('.msg-image');
  const grid = document.getElementById('uipMediaGrid');
  const titleEl = document.getElementById('uipMediaTitle');
  if (imgs.length) {
    titleEl.style.display = '';
    grid.innerHTML = Array.from(imgs).slice(0, 9).map(img =>
      `<img src="${img.src}" onclick="openLightbox('${img.src}')" alt="">`
    ).join('');
  } else {
    titleEl.style.display = 'none';
    grid.innerHTML = '';
  }

  panel.classList.add('open');
}

function closeUserInfoPanel() {
  document.getElementById('userInfoPanel').classList.remove('open');
}

// ── Group Members Modal ───────────────────────────────────────────────────────

let _gmGroupId = null;

function openGroupMembersModal() {
  if (!currentGroupId) return;
  _gmGroupId = currentGroupId;
  fetch(`/api/groups/${currentGroupId}/info`)
    .then(r => r.json())
    .then(g => {
      document.getElementById('groupMembersTitle').textContent = `Участники — ${g.name} (${g.member_count})`;
      const myId = CURRENT_USER ? CURRENT_USER.id : null;
      const isAdmin = g.created_by === myId ||
        g.members.some(m => m.user.id === myId && m.role === 'admin');

      const avatarContent = g.avatar
        ? `<img src="${g.avatar}" id="gmAvatarImg" style="width:64px;height:64px;border-radius:16px;object-fit:cover;">`
        : `<div id="gmAvatarImg" style="width:64px;height:64px;border-radius:16px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:28px;">👥</div>`;

      const adminHover = isAdmin
        ? `<div id="gmAvatarHover" onclick="document.getElementById('gmAvatarFile').click()"
             style="position:absolute;inset:0;border-radius:16px;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity .15s;">
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2" style="width:22px;height:22px;"><path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
           </div>`
        : '';

      const body = document.getElementById('groupMembersBody');
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px;padding:12px 0 16px;border-bottom:1px solid var(--border);margin-bottom:8px;">
          <div style="position:relative;flex-shrink:0;" id="gmAvatarWrap">
            ${avatarContent}
            ${adminHover}
          </div>
          <div>
            <div style="font-weight:700;font-size:16px;">${escapeHtml(g.name)}</div>
            <div style="font-size:13px;color:var(--text-muted);">${g.member_count} участников</div>
          </div>
        </div>
        <input type="file" id="gmAvatarFile" accept="image/*" style="display:none" onchange="gmUploadAvatar(this)">
        ${g.members.map(m => {
          const u = m.user;
          const initials = u.display_name ? u.display_name[0].toUpperCase() : '?';
          const av = u.avatar
            ? `<img class="avatar" style="width:40px;height:40px;" src="${u.avatar}" alt="">`
            : `<div class="avatar-placeholder" style="width:40px;height:40px;font-size:14px;">${initials}</div>`;
          const roleBadge = m.role === 'admin' ? '<span class="member-role-badge">Админ</span>' : '';
          const onlineDot = u.online ? '<span class="online-dot" style="bottom:-1px;right:-1px;"></span>' : '';
          return `<div class="member-list-item" onclick="closeGroupMembersModal();openConversation(${u.id})">
            <div class="avatar-wrap">${av}${onlineDot}</div>
            <div class="member-info">
              <div class="member-name">${escapeHtml(u.display_name)}</div>
              <div class="member-username">@${escapeHtml(u.username)}</div>
            </div>
            ${roleBadge}
          </div>`;
        }).join('')}`;

      if (isAdmin) {
        const wrap = document.getElementById('gmAvatarWrap');
        const hover = document.getElementById('gmAvatarHover');
        if (wrap && hover) {
          wrap.addEventListener('mouseenter', () => hover.style.opacity = '1');
          wrap.addEventListener('mouseleave', () => hover.style.opacity = '0');
        }
      }
      document.getElementById('groupMembersModal').classList.add('open');
    });
}

function gmUploadAvatar(input) {
  const file = input.files[0];
  if (!file || !_gmGroupId) return;
  const fd = new FormData();
  fd.append('avatar', file);
  fetch(`/api/groups/${_gmGroupId}/update`, { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      if (data.ok && data.avatar) {
        const wrap = document.getElementById('gmAvatarWrap');
        const existing = document.getElementById('gmAvatarImg');
        const img = document.createElement('img');
        img.id = 'gmAvatarImg';
        img.src = data.avatar;
        img.style = 'width:64px;height:64px;border-radius:16px;object-fit:cover;';
        if (existing) existing.replaceWith(img);
        // update chat header if open
        const headerAvatar = document.getElementById('partnerAvatar');
        if (headerAvatar) headerAvatar.src = data.avatar;
      }
    });
}

function closeGroupMembersModal() {
  document.getElementById('groupMembersModal').classList.remove('open');
}

// ── Profile Edit Modal ────────────────────────────────────────────────────────

let peAvatarFile = null;

// ── My Profile Modal ──────────────────────────────────────────────────────────

function openMyProfileModal() {
  document.getElementById('userMenu').classList.remove('open');
  const u = CURRENT_USER;
  const img = document.getElementById('mpAvatarImg');
  const initials = document.getElementById('mpAvatarInitials');
  if (u.avatar && !u.avatar.includes('default_avatar')) {
    img.src = u.avatar;
    img.style.display = '';
    initials.style.display = 'none';
  } else {
    img.style.display = 'none';
    initials.style.display = 'flex';
    initials.textContent = (u.display_name || '?')[0].toUpperCase();
  }
  document.getElementById('mpDisplayName').innerHTML =
    escapeHtml(u.display_name) +
    (u.is_admin ? ' <span style="font-size:11px;background:var(--accent);color:#fff;padding:2px 7px;border-radius:20px;font-weight:600;vertical-align:middle;">Admin</span>' : '');
  document.getElementById('mpUsername').textContent = '@' + u.username;
  const st = document.getElementById('mpStatus');
  st.textContent = u.online ? '● Онлайн' : '● ' + u.last_seen;
  st.style.color = u.online ? 'var(--online)' : 'var(--text-muted)';
  const bioEl = document.getElementById('mpBio');
  if (u.bio) { bioEl.textContent = u.bio; bioEl.style.display = ''; }
  else bioEl.style.display = 'none';
  document.getElementById('mpJoined').textContent = u.created_at || '';
  document.getElementById('myProfileModal').classList.add('open');
}

function closeMyProfileModal() {
  document.getElementById('myProfileModal').classList.remove('open');
}

function openProfileEditModal() {
  document.getElementById('userMenu').classList.remove('open');
  const u = CURRENT_USER;
  document.getElementById('peUsername').value = u.username || '';
  document.getElementById('peDisplayName').value = u.display_name || '';
  document.getElementById('peBio').value = u.bio || '';
  document.getElementById('peHideLastSeen').checked = u.hide_last_seen || false;
  const img = document.getElementById('peAvatarImg');
  const initials = document.getElementById('peAvatarInitials');
  if (u.avatar) {
    img.src = u.avatar;
    img.style.display = '';
    initials.style.display = 'none';
  } else {
    img.style.display = 'none';
    initials.style.display = 'flex';
    initials.textContent = (u.display_name || '?')[0].toUpperCase();
  }
  peAvatarFile = null;
  document.getElementById('profileEditError').style.display = 'none';
  document.getElementById('profileEditModal').classList.add('open');
}

function closeProfileEditModal() {
  document.getElementById('profileEditModal').classList.remove('open');
}

function pePreviewAvatar(input) {
  peAvatarFile = input.files[0];
  if (!peAvatarFile) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('peAvatarImg');
    img.src = e.target.result;
    img.style.display = '';
    document.getElementById('peAvatarInitials').style.display = 'none';
  };
  reader.readAsDataURL(peAvatarFile);
}

function submitProfileEdit() {
  const btn = document.getElementById('peSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Сохранение...';
  const fd = new FormData();
  fd.append('username', document.getElementById('peUsername').value);
  fd.append('display_name', document.getElementById('peDisplayName').value);
  fd.append('bio', document.getElementById('peBio').value);
  fd.append('hide_last_seen', document.getElementById('peHideLastSeen').checked ? '1' : '0');
  if (peAvatarFile) fd.append('avatar', peAvatarFile);
  fetch('/api/profile/update', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
      if (data.error) {
        const errEl = document.getElementById('profileEditError');
        errEl.textContent = data.error;
        errEl.style.display = '';
      } else {
        Object.assign(CURRENT_USER, data.user);
        closeProfileEditModal();
        // Update footer avatar/name
        const footer = document.getElementById('sidebarFooter');
        footer.querySelector('.name').textContent = data.user.display_name;
        footer.querySelector('.username').textContent = '@' + data.user.username;
      }
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
        let lastDate = null, html = '';
        data.messages.forEach(msg => {
          if (msg.created_date !== lastDate) { html += `<div class="date-divider"><span>${msg.created_date}</span></div>`; lastDate = msg.created_date; }
          html += renderMessage(msg);
        });
        area.insertAdjacentHTML('beforeend', html);
        setTimeout(() => scrollToBottom(), 50);
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

function loadMoreMessages() {
  if (hasMoreMessages) {
    if (currentChatType === 'group' && currentGroupId) loadGroupMessages(currentGroupId, currentPage + 1);
    else if (currentPartnerId) loadMessages(currentPartnerId, currentPage + 1);
  }
}

function renderMessage(msg) {
  const own = msg.sender_id === CURRENT_USER_ID;
  const cls = own ? 'own' : 'other';
  const initials = msg.sender ? msg.sender.display_name[0].toUpperCase() : '?';

  const showName = currentChatType === 'group' && !own && msg.sender;
  const senderName = showName ? `<div class="msg-sender-name">${escapeHtml(msg.sender.display_name)}</div>` : '';

  const avatar = msg.sender && !own
    ? (msg.sender.avatar
        ? `<img class="message-avatar" src="${msg.sender.avatar}" alt="">`
        : `<div class="message-avatar-placeholder">${initials}</div>`)
    : '';

  let content = '';
  if (msg.deleted_for_all) {
    content = '<em style="opacity:0.5;font-size:13px;">Сообщение удалено</em>';
  } else if (msg.is_deleted) {
    content = '<em style="opacity:0.5;font-size:13px;">Сообщение удалено</em>';
  } else {
    if (msg.reply_to) {
      const rt = msg.reply_to;
      const rtText = rt.message_type === 'image' ? '📷 Фото' : (rt.message_type === 'voice' ? '🎤 Голосовое' : escapeHtml((rt.content || '').slice(0, 60)));
      content += `<div class="reply-quote" onclick="scrollToMsg(${rt.id})">
        <div class="reply-quote-name">${escapeHtml(rt.sender_name)}</div>
        <div class="reply-quote-text">${rtText}</div>
      </div>`;
    }
    if (msg.audio_url || (msg.message_type === 'audio' || msg.message_type === 'voice')) {
      const audioUrl = msg.audio_url || '';
      const sName = msg.sender ? msg.sender.display_name : 'Аудио';
      const icon = msg.message_type === 'voice' ? '🎤' : '🎵';
      content += `<div class="msg-audio">
        <button class="msg-audio-play" data-audio-url="${audioUrl}" data-sender-name="${escapeHtml(sName)}"
          onclick="playAudio('${audioUrl}','${escapeHtml(sName)}',this)">
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div class="msg-audio-info">
          <div style="font-size:12px;opacity:0.8;">${icon} ${msg.message_type === 'voice' ? 'Голосовое' : 'Аудио'}</div>
          <input type="range" class="msg-audio-progress" min="0" max="100" value="0" style="pointer-events:none;">
          <div class="msg-audio-time">0:00</div>
        </div>
      </div>`;
    } else {
      if (msg.image_url) content += `<img class="msg-image" src="${msg.image_url}" alt="фото" onclick="openLightbox('${msg.image_url}')">`;
      if (msg.content) content += `<div class="msg-text">${escapeHtml(msg.content)}</div>`;
    }
  }

  const editedMark = msg.is_edited ? '<span class="msg-edited" style="font-size:10px;opacity:0.6;"> изм.</span>' : '';
  const checkmark = own && !msg.group_id
    ? `<svg class="read-check" fill="none" viewBox="0 0 24 24" stroke="${msg.is_read ? '#818cf8' : 'rgba(255,255,255,0.5)'}"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
    : '';

  const _msgTextEsc = (msg.content || '').replace(/'/g, "\\'").replace(/\n/g, ' ');
  return `<div class="message-row ${cls}" data-msg-id="${msg.id || ''}" data-sender-id="${msg.sender_id || ''}"
    oncontextmenu="openMsgContextMenu(event,${msg.id||0},${msg.sender_id||0},'${msg.message_type||'text'}','${_msgTextEsc}')">
    ${avatar}
    <div class="message-bubble">
      ${senderName}${content}
      <div class="msg-time">${msg.created_at}${editedMark}${checkmark}</div>
    </div>
  </div>`;
}

function appendMessage(msg) {
  const area = document.getElementById('messagesArea');
  area.insertAdjacentHTML('beforeend', renderMessage(msg));
}

// ── Scroll logic ──────────────────────────────────────────────────────────────

function scrollToBottom() {
  const area = document.getElementById('messagesArea');
  area.scrollTop = area.scrollHeight;
  unreadBelowCount = 0;
  updateScrollBtn();
}

function scrollToMsg(msgId) {
  const row = document.querySelector(`.message-row[data-msg-id="${msgId}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.style.transition = 'background 0.3s';
  row.style.background = 'rgba(99,102,241,0.15)';
  setTimeout(() => { row.style.background = ''; }, 1200);
}

function isNearBottom() {
  const area = document.getElementById('messagesArea');
  return area.scrollHeight - area.scrollTop - area.clientHeight < 120;
}

function updateScrollBtn() {
  const btn = document.getElementById('scrollBottomBtn');
  const badge = document.getElementById('scrollBottomBadge');
  const area = document.getElementById('messagesArea');
  const farUp = area.scrollHeight - area.scrollTop - area.clientHeight > 200;
  btn.classList.toggle('visible', farUp);
  if (unreadBelowCount > 0) { badge.style.display = ''; badge.textContent = unreadBelowCount; }
  else badge.style.display = 'none';
}

const messagesAreaEl = document.getElementById('messagesArea');
if (messagesAreaEl) {
  messagesAreaEl.addEventListener('scroll', updateScrollBtn);
}

// ── Message context menu ──────────────────────────────────────────────────────

function openMsgContextMenu(e, msgId, senderId, msgType, msgText) {
  e.preventDefault();
  if (!msgId) return;
  ctxMsgId = msgId;
  ctxMsgSenderId = senderId;
  ctxMsgText = msgText || '';
  ctxChatType = currentChatType;
  ctxGroupId = currentGroupId;

  const menu = document.getElementById('ctxMenu');
  const isOwn = senderId === CURRENT_USER_ID;
  const isText = msgType === 'text' || msgType === 'mixed';
  const hasText = !!msgText;

  document.getElementById('ctxPin').style.display = 'none';
  document.getElementById('ctxSep1').style.display = '';
  document.getElementById('ctxReply').style.display = '';
  document.getElementById('ctxForward').style.display = hasText ? '' : 'none';
  document.getElementById('ctxCopy').style.display = hasText ? '' : 'none';
  document.getElementById('ctxEdit').style.display = (isOwn && isText) ? '' : 'none';
  document.getElementById('ctxDeleteAll').style.display = isOwn ? '' : 'none';

  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctxMenu').style.display = 'none';
}

// ── Reply ─────────────────────────────────────────────────────────────────────

function ctxReplyMessage() {
  hideCtxMenu();
  if (!ctxMsgId) return;
  const row = document.querySelector(`.message-row[data-msg-id="${ctxMsgId}"]`);
  const senderName = row ? (row.querySelector('.msg-sender-name')?.textContent || (ctxMsgSenderId === CURRENT_USER_ID ? 'Вы' : '')) : '';
  const text = ctxMsgText || (row?.querySelector('.msg-text')?.textContent) || '📷 Медиа';
  replyToMsg = { id: ctxMsgId, senderName, text };
  document.getElementById('replyPreviewName').textContent = senderName || 'Вы';
  document.getElementById('replyPreviewText').textContent = text.slice(0, 80);
  document.getElementById('replyPreview').style.display = 'flex';
  document.getElementById('messageInput').focus();
}

function cancelReply() {
  replyToMsg = null;
  document.getElementById('replyPreview').style.display = 'none';
}

// ── Copy ──────────────────────────────────────────────────────────────────────

function ctxCopyMessage() {
  hideCtxMenu();
  if (ctxMsgText) navigator.clipboard.writeText(ctxMsgText).catch(() => {});
}

// ── Forward ───────────────────────────────────────────────────────────────────

let _fwdMsgId = null, _fwdMsgText = '', _fwdChatType = null, _fwdGroupId = null;

function ctxForwardMessage() {
  hideCtxMenu();
  _fwdMsgId = ctxMsgId;
  _fwdMsgText = ctxMsgText;
  _fwdChatType = ctxChatType;
  _fwdGroupId = ctxGroupId;
  const list = document.getElementById('forwardConvList');
  list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">Загрузка...</div>';
  document.getElementById('forwardModal').classList.add('open');
  const items = _lastConvItems.filter(i => i.type === 'direct' || i.type === 'group');
  if (!items.length) { list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">Нет диалогов</div>'; return; }
  list.innerHTML = items.map(item => {
    if (item.type === 'direct') {
      const p = item.data.partner;
      const initials = p.display_name ? p.display_name[0].toUpperCase() : '?';
      const av = p.avatar ? `<img class="avatar" style="width:36px;height:36px;" src="${p.avatar}" alt="">` : `<div class="avatar-placeholder" style="width:36px;height:36px;font-size:13px;">${initials}</div>`;
      return `<div class="member-list-item" onclick="doForward('direct',${p.id})"><div class="avatar-wrap">${av}</div><div class="member-info"><div class="member-name">${escapeHtml(p.display_name)}</div></div></div>`;
    } else {
      const g = item.data.group;
      const initials = g.name ? g.name[0].toUpperCase() : '#';
      const av = g.avatar ? `<img class="avatar" style="width:36px;height:36px;" src="${g.avatar}" alt="">` : `<div class="conv-group-badge" style="width:36px;height:36px;font-size:13px;">${initials}</div>`;
      return `<div class="member-list-item" onclick="doForward('group',${g.id})"><div class="avatar-wrap">${av}</div><div class="member-info"><div class="member-name">${escapeHtml(g.name)}</div><div class="member-username">группа</div></div></div>`;
    }
  }).join('');
}

function closeForwardModal() {
  document.getElementById('forwardModal').classList.remove('open');
}

function doForward(type, id) {
  closeForwardModal();
  if (!_fwdMsgText) return;
  const fd = new FormData();
  fd.append('content', _fwdMsgText);
  let url;
  if (type === 'group') { url = `/api/groups/${id}/send`; }
  else { fd.append('receiver_id', id); url = '/api/send_message'; }
  fetch(url, { method: 'POST', body: fd }).then(r => r.json()).then(msg => {
    if (!msg.error && type === 'direct' && id === currentPartnerId) { appendMessage(msg); scrollToBottom(); }
    if (!msg.error && type === 'group' && id === currentGroupId) { appendMessage(msg); scrollToBottom(); }
  });
}

function ctxEditMessage() {
  hideCtxMenu();
  if (!ctxMsgId) return;
  const row = document.querySelector(`.message-row[data-msg-id="${ctxMsgId}"]`);
  if (!row) return;
  const bubble = row.querySelector('.message-bubble');
  const textEl = bubble.querySelector('.msg-text');
  const currentText = textEl ? textEl.textContent : '';
  const timeEl = bubble.querySelector('.msg-time');

  const editArea = document.createElement('textarea');
  editArea.value = currentText;
  editArea.style.cssText = 'width:100%;background:transparent;border:none;outline:none;resize:none;font-size:14px;line-height:1.5;color:inherit;padding:0;font-family:inherit;';
  editArea.rows = Math.max(1, currentText.split('\n').length);

  const editControls = document.createElement('div');
  editControls.style.cssText = 'display:flex;gap:6px;margin-top:4px;justify-content:flex-end;';
  editControls.innerHTML = `
    <button onclick="cancelEdit(this)" style="background:none;border:none;color:rgba(255,255,255,0.6);cursor:pointer;font-size:12px;">Отмена</button>
    <button onclick="confirmEdit(${ctxMsgId},this)" style="background:rgba(255,255,255,0.2);border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;padding:2px 8px;">✓ Сохранить</button>`;

  if (textEl) textEl.replaceWith(editArea);
  else bubble.insertBefore(editArea, timeEl);
  bubble.appendChild(editControls);
  editArea.focus();
  editArea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit(ctxMsgId, editControls.lastElementChild); }
    if (e.key === 'Escape') cancelEdit(editControls.firstElementChild);
  });
}

function cancelEdit(btn) {
  const bubble = btn.closest('.message-bubble');
  const editArea = bubble.querySelector('textarea');
  const controls = bubble.querySelector('div:last-child');
  const originalText = editArea.value;
  const textDiv = document.createElement('div');
  textDiv.className = 'msg-text';
  textDiv.textContent = originalText;
  editArea.replaceWith(textDiv);
  controls.remove();
}

function confirmEdit(msgId, btn) {
  const bubble = btn.closest('.message-bubble');
  const editArea = bubble.querySelector('textarea');
  const content = editArea.value.trim();
  if (!content) return;

  const fd = new FormData();
  fd.append('content', content);
  const isGroup = ctxChatType === 'group' && ctxGroupId;
  const url = isGroup
    ? `/api/groups/${ctxGroupId}/messages/${msgId}`
    : `/api/messages/${msgId}`;

  fetch(url, { method: 'PUT', body: fd })
    .then(r => r.json())
    .then(data => {
      if (data.error) return;
      const textDiv = document.createElement('div');
      textDiv.className = 'msg-text';
      textDiv.textContent = content;
      editArea.replaceWith(textDiv);
      bubble.querySelector('div:last-child').remove();
      // Add edited mark if not present
      const timeEl = bubble.querySelector('.msg-time');
      if (timeEl && !bubble.querySelector('.msg-edited')) {
        timeEl.insertAdjacentHTML('beforebegin', '<span class="msg-edited" style="font-size:10px;opacity:0.6;"> изм.</span>');
      }
    });
}

function ctxDeleteMessage(scope) {
  hideCtxMenu();
  if (!ctxMsgId) return;
  const isGroup = ctxChatType === 'group' && ctxGroupId;
  const url = isGroup
    ? `/api/groups/${ctxGroupId}/messages/${ctxMsgId}?scope=${scope}`
    : `/api/messages/${ctxMsgId}?scope=${scope}`;

  fetch(url, { method: 'DELETE' }).then(r => r.json()).then(data => {
    if (data.ok) {
      const row = document.querySelector(`.message-row[data-msg-id="${ctxMsgId}"]`);
      if (row && scope === 'all') row.remove();
      else if (row && scope === 'me') row.remove();
    }
  });
}

// Close context menu on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#ctxMenu')) hideCtxMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideCtxMenu(); closeUserInfoPanel(); closeForwardModal(); cancelReply(); }
});

// ── Send message ──────────────────────────────────────────────────────────────

function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text && !selectedFile) return;
  const fd = new FormData();
  fd.append('content', text);
  if (selectedFile) {
    const isAudio = selectedFile.type.startsWith('audio/') ||
      /\.(mp3|ogg|wav|webm|m4a)$/i.test(selectedFile.name);
    fd.append(isAudio ? 'audio' : 'image', selectedFile);
  }
  if (replyToMsg) { fd.append('reply_to_id', replyToMsg.id); cancelReply(); }
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
  } else return;
  fetch(url, { method: 'POST', body: fd })
    .then(r => {
      if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(msg => {
      if (msg.error) { console.warn('Send error:', msg.error); return; }
      appendMessage(msg);
      scrollToBottom();
    })
    .catch(e => console.error('sendMessage failed:', e));
}

// ── File handling ─────────────────────────────────────────────────────────────

function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  selectedFile = file;
  const isAudio = file.type.startsWith('audio/') || file.name.match(/\.(mp3|ogg|wav|webm|m4a)$/i);
  const preview = document.getElementById('filePreviewArea');
  const img = document.getElementById('filePreviewImg');
  const name = document.getElementById('filePreviewName');
  if (isAudio) {
    img.src = '';
    img.style.display = 'none';
    name.textContent = '🎵 ' + file.name;
  } else {
    img.style.display = '';
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; };
    reader.readAsDataURL(file);
    name.textContent = file.name;
  }
  preview.style.display = 'flex';
}

function clearFileAttachment() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('filePreviewArea').style.display = 'none';
  document.getElementById('filePreviewImg').src = '';
  document.getElementById('filePreviewImg').style.display = '';
}

// ── Typing indicator ──────────────────────────────────────────────────────────

const messageInput = document.getElementById('messageInput');
if (messageInput) {
  messageInput.addEventListener('input', function() {
    autoResize(this);
    if (!currentPartnerId || currentChatType !== 'direct') return;
    if (!isTyping) { isTyping = true; socket.emit('typing', { partner_id: currentPartnerId, typing: true }); }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2000);
  });
  messageInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
}

function stopTyping() {
  if (isTyping && currentPartnerId) { isTyping = false; socket.emit('typing', { partner_id: currentPartnerId, typing: false }); }
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
    if (!q) { searchResults.style.display = 'none'; convList.style.display = 'block'; return; }
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

function closeCreateGroup() { document.getElementById('createGroupModal').classList.remove('open'); }

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

function removeGroupMember(id) { delete selectedGroupMembers[id]; renderMemberChips(); }

function renderMemberChips() {
  const chips = document.getElementById('membersChips');
  chips.innerHTML = Object.entries(selectedGroupMembers).map(([id, name]) =>
    `<span class="member-chip" onclick="removeGroupMember(${id})">${escapeHtml(name)} ✕</span>`
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
    .then(g => { if (g.error) { alert(g.error); return; } closeCreateGroup(); loadConversations(); setTimeout(() => openGroup(g.id), 300); });
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeCreateGroup(); closeGroupMembersModal(); closeProfileEditModal(); closeMyProfileModal(); } });

// ── Dropdown menu ─────────────────────────────────────────────────────────────

const userMenu = document.getElementById('userMenu');
const sidebarFooter = document.getElementById('sidebarFooter');
if (sidebarFooter && userMenu) {
  sidebarFooter.addEventListener('click', (e) => {
    if (userMenu.contains(e.target)) return;
    e.stopPropagation();
    userMenu.classList.toggle('open');
  });
  document.addEventListener('click', () => userMenu.classList.remove('open'));
}

// ── Toast notification ────────────────────────────────────────────────────────

function showToast(title, text, link) {
  const n = document.createElement('div');
  n.className = 'toast-notification';
  n.innerHTML = `<div class="toast-icon">✉</div><div class="toast-content"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text || '')}</span></div>`;
  n.onclick = () => { if (link) window.location.href = link; n.remove(); };
  document.body.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transform = 'translateX(50px)'; n.style.transition = 'all 0.3s ease'; setTimeout(() => n.remove(), 300); }, 4000);
}

function showNotification(text, link) { showToast('Уведомление', text, link); }

// ── Utils ─────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Mobile navigation ─────────────────────────────────────────────────────────

function isMobile() { return window.innerWidth <= 768; }

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
