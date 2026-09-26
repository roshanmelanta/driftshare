// ---------- view switching ----------
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.onclick = () => {
    showView(btn.dataset.back);
    if (ws) ws.close();
    if (pc) pc.close();
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

// ---------- entry points ----------
document.getElementById('btn-send').onclick = () => {
  const room = generateRoomCode();
  showView('view-room');
  resetTransferUI();
  document.getElementById('code-display').classList.remove('hidden');
  document.getElementById('code-value').textContent = room;
  document.getElementById('btn-copy-code').textContent = navigator.share ? 'Share' : 'Copy';
  joinRoom(room);
};

// Typing a share code on a phone keyboard is annoying, so make sharing
// it a one-tap action instead: native share sheet when available,
// clipboard copy as the fallback everywhere else.
document.getElementById('btn-copy-code').onclick = async (e) => {
  const room = document.getElementById('code-value').textContent;
  const btn = e.currentTarget;

  if (navigator.share) {
    try {
      await navigator.share({ text: `Driftshare code: ${room}` });
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

// ---------- WebRTC state ----------
let ws = null;
let pc = null;
let dataChannel = null;
let isInitiator = false;

const CHUNK_SIZE = 64 * 1024;
const BUFFER_THRESHOLD = 8 * 1024 * 1024;
let sendQueue = null;
let recvState = null;

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function joinRoom(room) {
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room }));

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        isInitiator = msg.initiator;
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
        setStatus('that code is already in use — try a different one', 'failed');
        break;
      case 'peer-left':
        setStatus('the other side disconnected', 'failed');
        break;
    }
  };
}

function setupPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('connected', 'connected');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('connection lost', 'failed');
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
  };

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const meta = JSON.parse(event.data);
      if (meta.type === 'file-meta') {
        recvState = { name: meta.name, size: meta.size, received: 0, chunks: [] };
        document.getElementById('recv-progress-wrap').classList.remove('hidden');
        document.getElementById('recv-filename').textContent = meta.name;
        document.getElementById('recv-pct').textContent = '0%';
        document.getElementById('recv-download').classList.add('hidden');
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
  if (e.dataTransfer.files.length) sendFile(e.dataTransfer.files[0]);
};
fileInput.onchange = () => { if (fileInput.files.length) sendFile(fileInput.files[0]); };

function sendFile(file) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;

  dataChannel.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size }));
  document.getElementById('send-progress-wrap').classList.remove('hidden');
  document.getElementById('send-filename').textContent = file.name;

  sendQueue = { file, offset: 0 };
  pumpSend();
}

function pumpSend() {
  if (!sendQueue) return;
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
    dataChannel.send(buf);
    sendQueue.offset += buf.byteLength;
    const pct = Math.round((sendQueue.offset / file.size) * 100);
    document.getElementById('send-bar').style.width = pct + '%';
    document.getElementById('send-pct').textContent = pct + '%';
    pumpSend();
  });
}