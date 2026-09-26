// Minimal WebRTC signaling server.
//
// What this server does NOT do: touch file data. It only ever forwards
// small JSON handshake messages (SDP offers/answers, ICE candidates)
// between exactly two browsers who've agreed on the same room code.
// Once RTCPeerConnection reports "connected", this server is out of
// the picture entirely.

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// room code -> array of up to 2 sockets
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

wss.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return; // ignore garbage
    }

    if (msg.type === 'join') {
      const room = String(msg.room || '').trim();
      if (!room) return;

      const peers = rooms.get(room) || [];

      if (peers.length >= 2) {
        socket.send(JSON.stringify({ type: 'room-full' }));
        return;
      }

      peers.push(socket);
      rooms.set(room, peers);
      joinedRoom = room;

      log('joined', room, 'peers now', peers.length);

      // Tell this socket whether it's first (will create the offer)
      // or second (will wait for an offer and create the answer).
      socket.send(JSON.stringify({
        type: 'joined',
        initiator: peers.length === 1,
      }));

      // If a second peer just joined, tell the first one someone arrived.
      if (peers.length === 2) {
        peers[0].send(JSON.stringify({ type: 'peer-joined' }));
      }
      return;
    }

    // Everything else (offer / answer / ice-candidate) just gets
    // relayed verbatim to the other peer in the same room.
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom) || [];
    for (const peer of peers) {
      if (peer !== socket && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify(msg));
      }
    }
  });

  socket.on('close', () => {
    if (!joinedRoom) return;
    const peers = rooms.get(joinedRoom) || [];
    const remaining = peers.filter((p) => p !== socket);

    if (remaining.length > 0) {
      remaining[0].send(JSON.stringify({ type: 'peer-left' }));
    }

    if (remaining.length === 0) {
      rooms.delete(joinedRoom);
    } else {
      rooms.set(joinedRoom, remaining);
    }
    log('left', joinedRoom, 'peers now', remaining.length);
  });
});

log(`signaling server listening on ws://localhost:${PORT}`);
