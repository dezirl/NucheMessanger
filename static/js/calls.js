// WebRTC calls via Socket.IO signaling

// ── Ringtone (Web Audio API) ──────────────────────────────────────────────────
let ringtoneInterval = null;
let audioCtx = null;

function startRingtone() {
  stopRingtone();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  function beep() {
    if (!audioCtx) return;
    const times = [[0, 440], [0.15, 480], [0.3, 440], [0.45, 480]];
    times.forEach(([offset, freq]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, audioCtx.currentTime + offset);
      gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + offset + 0.05);
      gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + offset + 0.14);
      osc.start(audioCtx.currentTime + offset);
      osc.stop(audioCtx.currentTime + offset + 0.15);
    });
  }

  beep();
  ringtoneInterval = setInterval(beep, 2000);
}

function stopRingtone() {
  if (ringtoneInterval) { clearInterval(ringtoneInterval); ringtoneInterval = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

let peerConnection = null;
let localStream = null;
let currentCallType = 'audio'; // 'audio' | 'video'
let incomingCallData = null;
let callTimerInterval = null;
let callSeconds = 0;
let isMuted = false;
let isCamOff = false;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ]
};

// ── Start outgoing call ───────────────────────────────────────────────────────

async function startCall(callType) {
  if (!currentPartnerId || !currentPartnerData) return;
  currentCallType = callType;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });
  } catch (e) {
    alert('Нет доступа к микрофону' + (callType === 'video' ? '/камере' : '') + '. Проверьте разрешения браузера.');
    return;
  }

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice_candidate', { target_id: currentPartnerId, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    if (callType === 'video') {
      document.getElementById('remoteVideo').srcObject = e.streams[0];
    } else {
      document.getElementById('remoteAudio').srcObject = e.streams[0];
    }
    document.getElementById('activeCallStatus').textContent = 'Соединено';
    startCallTimer();
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection && ['disconnected','failed','closed'].includes(peerConnection.iceConnectionState)) {
      endCall();
    }
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('call_offer', {
    target_id: currentPartnerId,
    offer: offer,
    call_type: callType,
  });

  showActiveCallOverlay(currentPartnerData, callType, 'Вызов...');
}

document.getElementById('callAudioBtn').onclick = () => startCall('audio');
document.getElementById('callVideoBtn').onclick = () => startCall('video');

// ── Incoming call ─────────────────────────────────────────────────────────────

socket.on('incoming_call', (data) => {
  incomingCallData = data;
  currentCallType = data.call_type;

  document.getElementById('incomingCallerName').textContent = data.caller_name;
  document.getElementById('incomingCallType').textContent =
    data.call_type === 'video' ? 'Входящий видеозвонок' : 'Входящий аудиозвонок';

  const avatarEl = document.getElementById('incomingCallerAvatar');
  if (data.caller_avatar) {
    avatarEl.src = data.caller_avatar;
    avatarEl.style.display = 'block';
  } else {
    avatarEl.style.display = 'none';
  }

  document.getElementById('incomingCallOverlay').classList.add('active');
  startRingtone();
});

async function acceptCall() {
  if (!incomingCallData) return;
  stopRingtone();
  document.getElementById('incomingCallOverlay').classList.remove('active');

  const data = incomingCallData;
  currentCallType = data.call_type;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: data.call_type === 'video',
    });
  } catch (e) {
    alert('Нет доступа к микрофону/камере.');
    return;
  }

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice_candidate', { target_id: data.caller_id, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    if (data.call_type === 'video') {
      document.getElementById('remoteVideo').srcObject = e.streams[0];
    } else {
      document.getElementById('remoteAudio').srcObject = e.streams[0];
    }
    document.getElementById('activeCallStatus').textContent = 'Соединено';
    startCallTimer();
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection && ['disconnected','failed','closed'].includes(peerConnection.iceConnectionState)) {
      endCall();
    }
  };

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('call_answer', { caller_id: data.caller_id, answer: answer });
  socket.emit('call_accepted_by_me', { caller_id: data.caller_id });

  const callerInfo = { display_name: data.caller_name, avatar: data.caller_avatar };
  showActiveCallOverlay(callerInfo, data.call_type, 'Соединение...');
  incomingCallData = null;
}

function rejectCall() {
  if (!incomingCallData) return;
  stopRingtone();
  socket.emit('call_reject', { caller_id: incomingCallData.caller_id });
  document.getElementById('incomingCallOverlay').classList.remove('active');
  incomingCallData = null;
}

// ── Answer received ───────────────────────────────────────────────────────────

socket.on('call_answered', async (data) => {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on('ice_candidate', async (data) => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (e) {}
});

socket.on('call_stop_ringing', () => {
  stopRingtone();
  document.getElementById('incomingCallOverlay').classList.remove('active');
  incomingCallData = null;
});

socket.on('call_rejected', () => {
  showCallToast('Звонок отклонён');
  cleanupCall();
});

socket.on('call_ended', () => {
  showCallToast('Звонок завершён');
  cleanupCall();
});

// ── End call ──────────────────────────────────────────────────────────────────

function endCall() {
  const targetId = incomingCallData ? incomingCallData.caller_id : currentPartnerId;
  if (targetId) socket.emit('call_end', { target_id: targetId });
  cleanupCall();
}

function cleanupCall() {
  stopRingtone();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  const rv = document.getElementById('remoteVideo');
  const lv = document.getElementById('localVideo');
  const ra = document.getElementById('remoteAudio');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  if (ra) ra.srcObject = null;

  document.getElementById('activeCallOverlay').classList.remove('active');
  document.getElementById('incomingCallOverlay').classList.remove('active');
  stopCallTimer();
  isMuted = false;
  isCamOff = false;
  incomingCallData = null;
}

// ── Controls ──────────────────────────────────────────────────────────────────

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  btn.style.background = isMuted ? 'var(--danger)' : 'var(--surface3)';
  btn.title = isMuted ? 'Включить микрофон' : 'Выключить микрофон';
}

function toggleCamera() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  btn.style.background = isCamOff ? 'var(--danger)' : 'var(--surface3)';
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showActiveCallOverlay(user, callType, status) {
  const avatarEl = document.getElementById('activeCallAvatar');
  const audioInfo = document.getElementById('audioCallInfo');
  const videoContainer = document.getElementById('videoContainer');
  const camBtn = document.getElementById('camBtn');

  if (user.avatar) {
    avatarEl.src = user.avatar;
    avatarEl.style.display = 'block';
  } else {
    avatarEl.style.display = 'none';
  }

  document.getElementById('activeCallName').textContent = user.display_name || '';
  document.getElementById('activeCallStatus').textContent = status;

  if (callType === 'video') {
    videoContainer.style.display = 'block';
    audioInfo.style.display = 'none';
    camBtn.style.display = 'flex';
    if (localStream) {
      document.getElementById('localVideo').srcObject = localStream;
    }
  } else {
    videoContainer.style.display = 'none';
    audioInfo.style.display = 'flex';
    audioInfo.style.flexDirection = 'column';
    audioInfo.style.alignItems = 'center';
    audioInfo.style.gap = '8px';
    camBtn.style.display = 'none';
  }

  document.getElementById('activeCallOverlay').classList.add('active');
}

function startCallTimer() {
  callSeconds = 0;
  stopCallTimer();
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const el = document.getElementById('activeCallStatus');
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  callSeconds = 0;
}

function showCallToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 20px;font-size:13px;z-index:9999;box-shadow:var(--shadow);';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
