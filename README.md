# LEXONIMOUS — Anonymous Real-Time Chat

> *Speak in darkness. Leave no name.*

Full-stack anonymous chat platform built with **Node.js + Express + Socket.io**.
No login. No display names. Everyone is a Wraith.

---

## Project Structure

```
lexonimous/
├── server.js                  ← Main server (Express + Socket.io)
├── package.json
├── .env.example               ← Copy to .env and configure
├── .gitignore
├── middleware/
│   └── security.js            ← Helmet, rate limiters, input validation, XSS
└── public/                    ← Served statically
    ├── index.html             ← Single-page app
    ├── css/
    │   └── style.css
    └── js/
        └── app.js             ← Socket.io client + UI logic
```

---

## Quick Start

### 1. Prerequisites
- Node.js v18+ → https://nodejs.org

### 2. Install
```bash
cd lexonimous
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env — at minimum set SESSION_SECRET to a long random string
```

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 4. Run (development)
```bash
npm run dev
```

### 5. Run (production)
```bash
NODE_ENV=production npm start
```

### 6. Open
```
http://localhost:3000
```

**Test multi-user:** Open two different browser windows pointing to the same URL.
Messages appear in real-time across all connected clients. ✅

---

## Security Features

| Layer | Implementation |
|---|---|
| **HTTP Headers** | Helmet.js — CSP, HSTS, X-Frame-Options, noSniff, XSS filter, referrer policy |
| **CORS** | Strict origin whitelist via `ALLOWED_ORIGINS` env var |
| **HTTP Rate Limiting** | express-rate-limit — 100 req/min per IP (configurable) |
| **Socket Message Rate** | Custom per-socket bucket — 30 messages/min |
| **Socket Join Rate** | Custom per-socket bucket — 10 joins/min |
| **Input Validation** | All inputs validated: type check, length, allowed values |
| **XSS Sanitization** | `xss` + `validator.escape` on every user string before storage |
| **Payload Size Limit** | Express body limit 10 KB, Socket.io buffer 4 KB |
| **Room ID Validation** | Strict string + length check before any room lookup |
| **Connection Guard** | Auto-disconnect if server exceeds 5,000 clients |
| **No Identity Storage** | Zero PII — no usernames, emails, IPs stored |
| **Graceful Shutdown** | SIGTERM/SIGINT handled — no data corruption |
| **Error Boundaries** | uncaughtException + unhandledRejection global handlers |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `production` enables stricter behaviour |
| `SESSION_SECRET` | — | **Required.** Long random secret string |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS whitelist |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `100` | Max HTTP requests per window per IP |
| `SOCKET_MSG_PER_MINUTE` | `30` | Max Socket messages per minute per client |
| `SOCKET_JOIN_PER_MINUTE` | `10` | Max room joins per minute per client |
| `MAX_ROOMS` | `200` | Max simultaneous rooms |
| `MAX_MSG_PER_ROOM` | `300` | Rolling message window per room |
| `MAX_ROOM_TITLE_LENGTH` | `60` | Max chars in room title |
| `MAX_MESSAGE_LENGTH` | `1000` | Max chars per message |
| `HISTORY_SIZE` | `50` | Messages sent to new joiners |

---

## Socket.io Events Reference

### Client → Server
| Event | Payload | Description |
|---|---|---|
| `room:create` | `{ title, tag }` | Create a new room |
| `room:join` | `roomId` (string) | Join an existing room |
| `room:leave` | — | Leave current room |
| `message:send` | `{ roomId, text }` | Send a message |
| `typing:start` | — | Notify others you're typing |
| `typing:stop` | — | Stop typing notification |

### Server → Client
| Event | Payload | Description |
|---|---|---|
| `room:list` | `Room[]` | Full room list (on connect + updates) |
| `room:created` | `{ id, title, tag }` | Confirms room creation |
| `room:history` | `{ roomId, messages[] }` | Last N messages on join |
| `message:new` | `{ roomId, msg }` | New message in room |
| `room:system` | `{ text }` | System message (join/leave) |
| `room:memberCount` | `{ roomId, count }` | Live member count update |
| `typing:update` | `{ count }` | Typing indicator update |
| `server:online` | `number` | Total connected clients |
| `error` | `string` | Server-side error message |

---

## Deploy to Production

### Option A — Railway (easiest, free tier)
```bash
# 1. Push to GitHub
# 2. Go to railway.app → New Project → Deploy from GitHub
# 3. Set env vars in Railway dashboard
# 4. Railway auto-detects Node.js and deploys
```

### Option B — Render
```bash
# 1. Push to GitHub
# 2. render.com → New Web Service → connect repo
# 3. Build command: npm install
# 4. Start command: node server.js
# 5. Add env vars
```

### Option C — VPS (Ubuntu/Debian)
```bash
# Install Node
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 process manager
sudo npm install -g pm2

# Clone/upload your project, then:
cd lexonimous
npm install --production
cp .env.example .env && nano .env   # fill in your values

# Start with PM2
pm2 start server.js --name lexonimous
pm2 save
pm2 startup  # auto-start on reboot

# Nginx reverse proxy (optional)
# proxy_pass http://localhost:3000;
```

### Option D — Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Health Check

```
GET /health
```
Returns:
```json
{ "status": "ok", "rooms": 6, "clients": 42, "uptime": 3600.5 }
```

---

## Add Persistent Storage (Optional Upgrade)

Currently messages are stored **in-memory** — they reset on server restart.
To persist:

**SQLite (simple)**
```bash
npm install better-sqlite3
```

**MongoDB Atlas (cloud)**
```bash
npm install mongoose
```

**Redis (fast + ephemeral)**
```bash
npm install ioredis
```

---

*LEXONIMOUS — No identity. No trace. Only the void.*
