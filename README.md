# Driftshare

Peer-to-peer file transfer over WebRTC. Two browsers connect directly;
files never touch a server. This repo has two independently-deployed
pieces:

```
driftshare/
├── client/              → deploy to Vercel (static, no build step)
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── config.js        ← the one file you edit before deploying
└── signaling-server/    → deploy to Render / Fly.io / Railway
    ├── server.js
    └── package.json
```

## Why two deployments?

Vercel runs code in short-lived serverless functions — great for the
static frontend, but it can't hold a WebSocket connection open
indefinitely, which is what the signaling handshake needs (two browsers
have to stay connected to the same relay long enough to exchange a few
messages). So:

- **`client/`** → Vercel. Pure static files, zero build step.
- **`signaling-server/`** → a host that keeps a process running. Render's
  free tier works well for this; Fly.io and Railway are equally fine.

The signaling server only ever relays a handshake (SDP + ICE candidates).
It never sees file bytes.

## 1. Deploy the signaling server first (Render, free tier)

1. Push this repo to GitHub.
2. On [render.com](https://render.com) → New → Web Service → connect the repo.
3. Set **Root Directory** to `signaling-server`.
4. Build command: `npm install`. Start command: `node server.js`.
5. Deploy. Render gives you a URL like `fileshare-signaling.onrender.com`.
6. Your signaling URL is `wss://fileshare-signaling.onrender.com` (note
   `wss`, not `ws` — Render terminates TLS for you).

Note: Render's free tier spins the service down after inactivity, so the
first connection after a while may take ~30s to wake up. Fine for
personal use; upgrade the plan if you want it always warm.

## 2. Point the client at it

Edit `client/config.js`:
```js
const SIGNALING_URL = "wss://fileshare-signaling.onrender.com";
```

## 3. Deploy the client to Vercel

1. On [vercel.com](https://vercel.com) → New Project → import the same repo.
2. Set **Root Directory** to `client`.
3. Framework Preset: **Other** (it's plain static files — no build
   command needed).
4. Deploy. Vercel gives you a URL like `driftshare.vercel.app`.

That's it — anyone with that link can send files to anyone else who has
the share code, from any network, no install.

## Running it locally first (recommended before deploying)

```
cd signaling-server
npm install
node server.js
```
Leave that running, then just open `client/index.html` directly in two
browser tabs (`config.js` already points at `ws://localhost:8080` by
default). Confirm a transfer works locally before you touch deployment.

## What's included

- **Resumable transfers.** If the connection drops mid-file (Wi-Fi blip, NAT
  rebind, brief network loss), the app auto-reconnects to the same signaling
  room and continues from the last byte the receiver actually has — it
  doesn't restart from zero. This only works while the tab itself stays
  alive in memory; a full page reload or a tab the OS has killed loses the
  in-progress file object and the transfer has to start over (there's no
  way around that from JS — the browser doesn't let a reloaded page recover
  an in-memory `File` reference).
- **QR code pairing.** The sender's share code now also renders as a QR
  code encoding a direct link (`?code=...`). Scanning it on the receiver's
  phone skips typing the code entirely and joins the room straight away.

### How resume actually works, if you want to dig in

- The **signaling server** now runs a heartbeat (ping every 15s) so a dead
  socket — e.g. a phone that lost signal without a clean disconnect — gets
  pruned instead of sitting in the room forever and blocking a reconnect
  with a false "room full."
- The server also remembers which side asked to be the WebRTC offer-creator
  (`preferInitiator`) so the **sender stays the sender** across a
  reconnect — this matters because only the sender still holds the actual
  `File` object to resume sending from.
- On reconnect, the **receiver** tells the sender exactly how many bytes it
  already has (`resume-request`), and the sender continues from that offset
  rather than trusting its own idea of how much it already sent — some of
  what it sent may never have arrived before the connection dropped.

Try it yourself: start a transfer with a large-ish file, then toggle airplane
mode on the receiving device for a couple of seconds and turn it back on.
Watch the log/status area go through "connection lost → reconnecting →
resuming transfer."

## Still not included

- **TURN relay** — on strict/symmetric NATs, the direct connection can
  fail outright, and no amount of reconnect logic fixes that (there's
  nothing to reconnect to). Adding a TURN server (e.g. via `coturn`) is
  the real fix, worth doing once you've *seen* a connection fail across
  two genuinely different networks.
- **More than 2 peers per room.**
- **Multi-file queues** — one file at a time.