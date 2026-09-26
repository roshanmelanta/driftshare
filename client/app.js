// ---------- view switching ----------
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.onclick = () => {
    showView(btn.dataset.back);
    teardownConnection({ manual: true });
    resetTransferUI();
  };
});

function resetTransferUI() {
  document.getElementById('code-display').classList.add('hidden');
  document.getElementById('drop-zone').classList.add('hidden');
  document.getElementById('send-progress-wrap').classList.add('hidden');
  document.getElementById('recv-progress-wrap').classList.add('hidden');
  setStatus('connecting…', 'pending');
}

function setStatus(text, kind) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot' + (kind === 'connected' ? ' connected' : kind === 'failed' ? ' failed' : '');
}

function generateRoomCode() {
  const words = ['giant', 'quiet', 'amber', 'coral', 'lucky', 'brave', 'drift', 'north'];
  const nouns = ['fern', 'otter', 'comet', 'delta', 'ember', 'ridge', 'harbor', 'birch'];
  return `${words[Math.floor(Math.random() * words.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}-${Math.floor(Math.random() * 900 + 100)}`;
}

// ---------- QR code ----------
// Encodes a direct link (not just the bare code) so scanning it on the
// receiver's phone skips typing entirely and joins straight away.
function renderQrCode(room) {
  const url = `${location.origin}${location.pathname}?code=${encodeURIComponent(room)}`;
  const qr = qrcode(0, 'M'); // typeNumber 0 = auto size, 'M' = medium error correction
  qr.addData(url);
  qr.make();
  document.getElementById('qr-container').innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
}

// ---------- entry points ----------
document.getElementById('btn-send').onclick = () => {
  const room = generateRoomCode();
  showView('view-room');
  resetTransferUI();
  document.getElementById('code-display').classList.remove('hidden');
  document.getElementById('code-value').textContent = room;
  document.getElementById('btn-copy-code').textContent = navigator.share ? 'Share' : 'Copy';
  renderQrCode(room);
  joinRoom(room);
};

// Typing a share code on a phone keyboard is annoying, so make sharing
// it a one-tap action instead: native share sheet when available,
// clipboard copy as the fallback everywhere else.
document.getElementById('btn-copy-code').onclick = async (e) => {
  const room = document.getElementById('code-value').textContent;
  const btn = e.currentTarget;
  const url = `${location.origin}${location.pathname}?code=${encodeURIComponent(room)}`;

  if (navigator.share) {
    try {
      await navigator.share({ text: `Driftshare code: ${room}`, url });
      return;
    } catch (_) {
      // user cancelled the share sheet — fall through to clipboard copy
    }
  }

  try {
    await navigator.clipboard.writeText(room);
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (_) {
    // clipboard API unavailable (e.g. non-HTTPS) — code is already on screen to read manually
  }
};

document.getElementById('btn-receive').onclick = () => showView('view-enter-code');

document.getElementById('btn-submit-code').onclick = () => {
  const room = document.getElementById('code-input').value.trim();
  if (!room) return;
  showView('view-room');
  resetTransferUI();
  joinRoom(room);
};

// ---------- WebRTC + signaling state ----------
let ws = null;
let pc = null;
let dataChannel = null;
let isInitiator = false;

let currentRoom = null;
let preferInitiator = null; // remembered role, resent on every reconnect so sender stays sender
let reconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1500;

const CHUNK_SIZE = 64 * 1024;
const BUFFER_THRESHOLD = 8 * 1024 * 1024;
let sendQueue = null; // { file, offset } — kept alive across a reconnect so a resume can continue it
let recvState = null; // { name, size, received, chunks } — same

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function transferInProgress() {
  return (sendQueue !== null) || (recvState !== null && recvState.received < recvState.size);
}

function teardownConnection({ manual }) {
  if (manual) {
    reconnecting = false;
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    sendQueue = null;
    recvState = null;
    currentRoom = null;
    preferInitiator = null;
  }
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; ws.close(); ws = null; }
  if (pc) { pc.onconnectionstatechange = pc.onicecandidate = pc.ondatachannel = null; pc.close(); pc = null; }
  dataChannel = null;
}

function joinRoom(room) {
  currentRoom = room;
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    const msg = { type: 'join', room };
    if (preferInitiator !== null) msg.preferInitiator = preferInitiator;
    ws.send(JSON.stringify(msg));
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        isInitiator = msg.initiator;
        preferInitiator = msg.initiator;
        setStatus(isInitiator ? 'waiting for the other side to connect…' : 'joining…', 'pending');
        setupPeerConnection();
        break;
      case 'peer-joined':
        setStatus('connecting…', 'pending');
        await createOffer();
        break;
      case 'offer':
        await handleOffer(msg.sdp);
        break;
      case 'answer':
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        break;
      case 'ice-candidate':
        if (msg.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (_) { }
        }
        break;
      case 'room-full':
        // During a normal fresh join this really does mean the code is
        // taken. But mid-reconnect, it's almost always our own previous
        // socket still occupying the room because it died silently (e.g.
        // airplane mode gives no clean close) and the server's heartbeat
        // hasn't pruned it yet — that clears within a few seconds, so
        // keep retrying instead of giving up.
        if (transferInProgress()) {
          maybeScheduleReconnect();
        } else {
          setStatus('that code is already in use — try a different one', 'failed');
        }
        break;
      case 'peer-left':
        setStatus('the other side disconnected', 'failed');
        maybeScheduleReconnect();
        break;
    }
  };

  ws.onclose = () => maybeScheduleReconnect();
}

// Only reconnect if there's actually something worth resuming — a network
// hiccup mid-transfer is worth chasing, a dead room from the landing view
// is not.
function maybeScheduleReconnect() {
  if (reconnecting) return;
  if (!currentRoom || !transferInProgress()) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setStatus('lost the connection and couldn\u2019t get it back — try starting over', 'failed');
    return;
  }

  reconnecting = true;
  reconnectAttempts += 1;
  const delay = RECONNECT_BASE_DELAY_MS * reconnectAttempts;
  setStatus(`connection lost — reconnecting (attempt ${reconnectAttempts})…`, 'pending');

  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    if (ws) { ws.onclose = null; ws.close(); }
    if (pc) { pc.close(); }
    joinRoom(currentRoom);
  }, delay);
}

function setupPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('connected', 'connected');
      reconnectAttempts = 0;
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      maybeScheduleReconnect();
    }
  };

  if (isInitiator) {
    dataChannel = pc.createDataChannel('file-transfer');
    wireUpDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      wireUpDataChannel(dataChannel);
    };
  }
}

async function createOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
}

async function handleOffer(sdp) {
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
}

// ---------- data channel: send / receive ----------
function wireUpDataChannel(channel) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    document.getElementById('drop-zone').classList.remove('hidden');

    // Reconnect case: if we're the receiver and already have part of a
    // file, ask the sender to continue from exactly where our disk/buffer
    // left off — our own byte count is the source of truth, not whatever
    // the sender thinks it already sent (some of that may never have
    // arrived).
    if (recvState && recvState.received < recvState.size) {
      setStatus('resuming transfer…', 'connected');
      channel.send(JSON.stringify({
        type: 'resume-request',
        name: recvState.name,
        size: recvState.size,
        offset: recvState.received,
      }));
    }

    // Reconnect case: if we're the sender and still have a pending file,
    // don't resume blindly — wait for the receiver's resume-request (it
    // knows the true offset). If nothing arrives shortly, the receiver
    // must have lost its state too (e.g. its tab reloaded), so start over.
    if (sendQueue) {
      sendQueue.awaitingResume = true;
      setTimeout(() => {
        if (sendQueue && sendQueue.awaitingResume) startFreshSend(sendQueue.file);
      }, 3000);
    }
  };

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.type === 'file-meta') {
        recvState = { name: msg.name, size: msg.size, received: 0, chunks: [] };
        document.getElementById('recv-progress-wrap').classList.remove('hidden');
        document.getElementById('recv-filename').textContent = msg.name;
        document.getElementById('recv-pct').textContent = '0%';
        document.getElementById('recv-download').classList.add('hidden');
        return;
      }

      if (msg.type === 'resume-request') {
        if (sendQueue && sendQueue.file.name === msg.name && sendQueue.file.size === msg.size) {
          sendQueue.awaitingResume = false;
          sendQueue.offset = msg.offset;
          pumpSend();
        }
        return;
      }

      return;
    }

    if (!recvState) return;
    recvState.chunks.push(event.data);
    recvState.received += event.data.byteLength;
    const pct = Math.round((recvState.received / recvState.size) * 100);
    document.getElementById('recv-bar').style.width = pct + '%';
    document.getElementById('recv-pct').textContent = pct + '%';

    if (recvState.received >= recvState.size) {
      const blob = new Blob(recvState.chunks);
      const url = URL.createObjectURL(blob);
      const a = document.getElementById('recv-download');
      a.href = url;
      a.download = recvState.name;
      a.textContent = 'Download ' + recvState.name;
      a.classList.remove('hidden');
      recvState = null;
    }
  };
}

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
dropZone.ondragleave = () => dropZone.classList.remove('dragover');
dropZone.ondrop = (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) startFreshSend(e.dataTransfer.files[0]);
};
fileInput.onchange = () => { if (fileInput.files.length) startFreshSend(fileInput.files[0]); };

function startFreshSend(file) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;

  dataChannel.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size }));
  document.getElementById('send-progress-wrap').classList.remove('hidden');
  document.getElementById('send-filename').textContent = file.name;

  sendQueue = { file, offset: 0, awaitingResume: false };
  pumpSend();
}

function pumpSend() {
  if (!sendQueue) return;
  if (!dataChannel || dataChannel.readyState !== 'open') return; // paused — a reconnect will resume this
  const { file, offset } = sendQueue;

  if (offset >= file.size) {
    document.getElementById('send-bar').style.width = '100%';
    document.getElementById('send-pct').textContent = '100%';
    sendQueue = null;
    return;
  }

  if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
    dataChannel.onbufferedamountlow = () => { dataChannel.onbufferedamountlow = null; pumpSend(); };
    return;
  }

  const slice = file.slice(offset, offset + CHUNK_SIZE);
  slice.arrayBuffer().then((buf) => {
    if (!sendQueue) return; // resume-request may have reset things while this slice was reading
    dataChannel.send(buf);
    sendQueue.offset += buf.byteLength;
    const pct = Math.round((sendQueue.offset / file.size) * 100);
    document.getElementById('send-bar').style.width = pct + '%';
    document.getElementById('send-pct').textContent = pct + '%';
    pumpSend();
  });
}

// ---------- QR / link auto-join ----------
// Placed here deliberately, at the very end of the file: this calls
// joinRoom(), which touches the `let`-declared state above (ws, pc,
// currentRoom, ...). Calling it any earlier — before those declarations
// have actually executed — hits the temporal dead zone and throws
// silently, which is why this used to just hang on "connecting…" forever
// when opened from a scanned QR code.
(function autoJoinFromLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  showView('view-room');
  resetTransferUI();
  joinRoom(code);
})();