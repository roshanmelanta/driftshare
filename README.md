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

## What's deliberately not included yet

- **TURN relay** — on strict/symmetric NATs, the direct connection can
  fail. Adding a TURN server (e.g. via `coturn`, or a hosted option like
  Twilio's) is the fix, but it's worth first *seeing* a connection fail
  across two real networks so the reason for TURN is concrete rather than
  theoretical.
- **Resumable transfers** — closing a tab mid-transfer means starting
  over.
- **More than 2 peers per room.**
