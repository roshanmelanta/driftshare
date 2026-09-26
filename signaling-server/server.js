// Minimal WebRTC signaling server.
//
// What this server does NOT do: touch file data. It only ever forwards
// small JSON handshake messages (SDP offers/answers, ICE candidates)
// between exactly two browsers who've agreed on the same room code.
// Once RTCPeerConnection reports "connected", this server is out of
// the picture entirely.
//
// Two additions on top of the original bare version, both in service
// of resumable transfers:
//
// 1. Heartbeat / dead-socket detection. A phone that loses signal
//    doesn't send a clean TCP close — the socket just goes silent. Without
//    checking for that, a stale entry can sit in a room forever, and the
//    real peer trying to reconnect gets told the room is "full" by a
//    socket that isn't actually there anymore.
//
// 2. Role-preserving rejoin. Whoever HAS the file (the sender) needs to
//    stay the WebRTC offer-creator across a reconnect, or the resume
//    handshake on the client side breaks. A join message can carry
//    { preferInitiator: true|false } and the server honors it instead of
//    always deciding by arrival order.

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL_MS = 5000; // short on purpose: a socket dropped by
// something like airplane mode (no clean close) sits in the room and blocks
// a genuine reconnect with a false "room full" until this interval catches it

const wss = new WebSocketServer({ port: PORT });

// room code -> array of up to 2 sockets
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function removeFromRoom(socket, room) {
  const peers = rooms.get(room);
  if (!peers) return;
  const remaining = peers.filter((p) => p !== socket);

  if (remaining.length > 0) {
    remaining[0].send(JSON.stringify({ type: 'peer-left' }));
  }
  if (remaining.length === 0) {
    rooms.delete(room);
  } else {
    rooms.set(room, remaining);
  }
  log('left', room, 'peers now', remaining.length);
}

wss.on('connection', (socket) => {
  let joinedRoom = null;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

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

      // Default: first to arrive is the initiator (offer-creator). But if
      // this socket explicitly asked for a role (a reconnect trying to
      // resume as the peer it was before), honor that instead, as long as
      // it doesn't collide with a role the other peer already holds.
      let initiator = peers.length === 1;
      if (typeof msg.preferInitiator === 'boolean') {
        const other = peers.find((p) => p !== socket);
        const otherWantsSame = other && other._preferInitiator === msg.preferInitiator;
        if (!otherWantsSame) initiator = msg.preferInitiator;
      }
      socket._preferInitiator = initiator;

      log('joined', room, 'peers now', peers.length, 'initiator', initiator);

      socket.send(JSON.stringify({ type: 'joined', initiator }));

      // Tell whichever peer is actually the initiator to create the offer
      // once both are present — NOT just "whoever arrived first". Those
      // used to always be the same peer, but preserving roles across a
      // reconnect can mean the initiator arrives second (e.g. its old
      // slot is occupied by the other side's not-yet-pruned stale
      // socket). Notifying position 0 unconditionally left the real
      // initiator waiting forever with nothing ever prompting it to act.
      if (peers.length === 2) {
        const initiatorPeer = peers.find((p) => p._preferInitiator === true) || peers[0];
        initiatorPeer.send(JSON.stringify({ type: 'peer-joined' }));
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
    if (joinedRoom) removeFromRoom(socket, joinedRoom);
  });
});

// Standard `ws` heartbeat pattern: ping everyone every interval; if a
// socket didn't pong back since the last check, it's presumed dead (the
// network vanished without a clean close) and gets terminated, which
// frees its slot in the room for the real peer to reclaim on reconnect.
const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

log(`signaling server listening on ws://localhost:${PORT}`);