'use strict';

require('dotenv').config();

const REQUIRED = ['express','socket.io','helmet','express-rate-limit','cors',
                  'dotenv','validator','xss','uuid','morgan','compression','mongoose'];
const missing = REQUIRED.filter(m => {
  try { require.resolve(m); return false; } catch(e){ return true; }
});
if (missing.length) {
  console.error('\n❌ Missing packages:', missing.join(', '));
  console.error('→ Fix: Run   npm install   then restart.\n');
  process.exit(1);
}

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const path           = require('path');
const cors           = require('cors');
const morgan         = require('morgan');
const compression    = require('compression');
const { v4: uuidv4 } = require('uuid');
const mongoose       = require('mongoose');

const {
  helmetMiddleware, httpRateLimiter, createSocketRateLimiter,
  validateRoomTitle, validateTag, validateMessage,
} = require('./middleware/security');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT                   || '3000');
const NODE_ENV         = process.env.NODE_ENV                        || 'development';
const MONGODB_URI      = process.env.MONGODB_URI                     || '';
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
const MAX_ROOMS        = parseInt(process.env.MAX_ROOMS              || '200');
const MAX_MSG_PER_ROOM = parseInt(process.env.MAX_MSG_PER_ROOM       || '300');
const HISTORY_SIZE     = parseInt(process.env.HISTORY_SIZE           || '50');
const MSG_PER_MIN      = parseInt(process.env.SOCKET_MSG_PER_MINUTE  || '30');
const JOIN_PER_MIN     = parseInt(process.env.SOCKET_JOIN_PER_MINUTE || '10');
const EMPTY_ROOM_TTL   = parseInt(process.env.EMPTY_ROOM_TTL_MS      || '600000');

// ─── MongoDB Schemas ──────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  id:     { type: String, required: true, index: true },
  roomId: { type: String, required: true, index: true },
  text:   { type: String, required: true, maxlength: 1000 },
  time:   { type: String, required: true },
  ts:     { type: Number, required: true, index: true },
}, { _id: false });

const roomSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true, index: true },
  title:        { type: String, required: true, maxlength: 60 },
  tag:          { type: String, required: true, enum: ['random','tech','philosophy','creative','social'] },
  isDefault:    { type: Boolean, default: false },
  createdAt:    { type: Number, default: Date.now },
  emptyAt:      { type: Number, default: null },
  messageCount: { type: Number, default: 0 },
}, { _id: false });

const Room    = mongoose.model('Room',    roomSchema);
const Message = mongoose.model('Message', messageSchema);

// ─── In-Memory Live State ─────────────────────────────────────────────────────
const roomMemory = new Map(); // roomId → { memberCount, messages[] }
const socketMap  = new Map(); // socketId → roomId

// In-memory fallback when no MongoDB (rooms stored here)
const fallbackRooms = new Map();

// ─── App + Server ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed: ' + origin));
  },
  methods: ['GET','HEAD'],
  credentials: false,
};

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors:              corsOptions,
  pingTimeout:       20000,
  pingInterval:      25000,
  maxHttpBufferSize: 4096,
  transports:        ['websocket','polling'],
});

// ─── Express Middleware ───────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmetMiddleware);
app.use(cors(corsOptions));
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(httpRateLimiter);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true, lastModified: true,
  maxAge: NODE_ENV === 'production' ? '1d' : '0',
}));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    db:      MONGODB_URI ? (mongoose.connection.readyState === 1 ? 'connected' : 'disconnected') : 'memory-only',
    rooms:   roomMemory.size,
    clients: io.engine.clientsCount,
    uptime:  Math.floor(process.uptime()),
  });
});

// ─── DB Helpers ───────────────────────────────────────────────────────────────
const useDB = () => MONGODB_URI && mongoose.connection.readyState === 1;

async function getAllRooms() {
  if (useDB()) return await Room.find({}).lean();
  return Array.from(fallbackRooms.values());
}

async function findRoom(id) {
  if (useDB()) return await Room.findOne({ id }).lean();
  return fallbackRooms.get(id) || null;
}

async function getRoomList() {
  const allRooms = await getAllRooms();
  return allRooms.map(r => {
    const mem = roomMemory.get(r.id) || { memberCount: 0 };
    return {
      id:           r.id,
      title:        r.title,
      tag:          r.tag,
      memberCount:  mem.memberCount,
      messageCount: r.messageCount || 0,
      createdAt:    r.createdAt,
    };
  });
}

async function getHistory(roomId) {
  const mem = roomMemory.get(roomId);
  if (mem && mem.messages && mem.messages.length > 0) return mem.messages.slice(-HISTORY_SIZE);
  if (useDB()) {
    return await Message.find({ roomId }).sort({ ts: 1 }).limit(HISTORY_SIZE).lean();
  }
  return [];
}

async function saveMessage(msg) {
  if (useDB()) {
    await Message.create(msg).catch(e => console.error('msg save:', e.message));
    await Room.updateOne({ id: msg.roomId }, { $inc: { messageCount: 1 } }).catch(() => {});
    // Trim old messages
    const total = await Message.countDocuments({ roomId: msg.roomId });
    if (total > MAX_MSG_PER_ROOM) {
      const oldest = await Message.find({ roomId: msg.roomId }).sort({ ts: 1 }).limit(total - MAX_MSG_PER_ROOM).lean();
      await Message.deleteMany({ id: { $in: oldest.map(m => m.id) } }).catch(() => {});
    }
  }
  const mem = roomMemory.get(msg.roomId);
  if (mem) {
    mem.messages.push(msg);
    if (mem.messages.length > MAX_MSG_PER_ROOM) mem.messages.shift();
    // Update fallback message count
    if (!useDB() && fallbackRooms.has(msg.roomId)) {
      const r = fallbackRooms.get(msg.roomId);
      r.messageCount = (r.messageCount || 0) + 1;
    }
  }
}

// ─── Handle Leave ─────────────────────────────────────────────────────────────
async function handleLeave(socket) {
  const roomId = socketMap.get(socket.id);
  if (!roomId) return;
  socket.leave(roomId);
  socketMap.delete(socket.id);
  const mem = roomMemory.get(roomId);
  if (mem) {
    mem.memberCount = Math.max(0, mem.memberCount - 1);
    io.to(roomId).emit('room:memberCount', { roomId, count: mem.memberCount });
    socket.to(roomId).emit('room:system', { text: 'An anonymous soul left.' });
    if (mem.memberCount === 0) {
      const now = Date.now();
      if (useDB()) await Room.updateOne({ id: roomId }, { emptyAt: now }).catch(() => {});
      else if (fallbackRooms.has(roomId)) fallbackRooms.get(roomId).emptyAt = now;
    }
  }
  io.emit('room:list', await getRoomList());
}

// ─── Default Rooms ────────────────────────────────────────────────────────────
const DEFAULT_ROOMS = [
  { title: 'Confessions at 3AM',         tag: 'social'     },
  { title: 'AI will outlive all of us',  tag: 'tech'       },
  { title: 'Does anyone truly exist?',   tag: 'philosophy' },
  { title: 'Art that hurts to look at',  tag: 'creative'   },
  { title: 'Unpopular truths',           tag: 'social'     },
  { title: 'Things I built nobody uses', tag: 'tech'       },
];

async function seedRooms() {
  if (useDB()) {
    for (const r of DEFAULT_ROOMS) {
      const exists = await Room.findOne({ title: r.title, isDefault: true });
      if (!exists) {
        const id = uuidv4();
        await Room.create({ id, title: r.title, tag: r.tag, isDefault: true, createdAt: Date.now(), emptyAt: null, messageCount: 0 });
      }
    }
    const all = await Room.find({}).lean();
    for (const r of all) roomMemory.set(r.id, { memberCount: 0, messages: [] });
    console.log(`  📦 ${all.length} rooms loaded from MongoDB`);
  } else {
    for (const r of DEFAULT_ROOMS) {
      const id = uuidv4();
      const room = { id, title: r.title, tag: r.tag, isDefault: true, createdAt: Date.now(), emptyAt: null, messageCount: 0 };
      fallbackRooms.set(id, room);
      roomMemory.set(id, { memberCount: 0, messages: [] });
    }
    console.log(`  📦 ${fallbackRooms.size} rooms seeded in memory (no DB)`);
  }
}

// ─── Auto-Delete Empty Rooms ──────────────────────────────────────────────────
setInterval(async () => {
  const cutoff = Date.now() - EMPTY_ROOM_TTL;
  let deleted = 0;
  try {
    if (useDB()) {
      const toDelete = await Room.find({ isDefault: false, emptyAt: { $lte: cutoff, $ne: null } }).lean();
      for (const r of toDelete) {
        const mem = roomMemory.get(r.id);
        if (!mem || mem.memberCount === 0) {
          await Room.deleteOne({ id: r.id });
          await Message.deleteMany({ roomId: r.id });
          roomMemory.delete(r.id);
          deleted++;
          console.log(`[LEXONIMOUS] Deleted empty room: "${r.title}"`);
        }
      }
    } else {
      for (const [id, r] of fallbackRooms.entries()) {
        if (r.isDefault) continue;
        const mem = roomMemory.get(id);
        if (r.emptyAt && r.emptyAt <= cutoff && (!mem || mem.memberCount === 0)) {
          fallbackRooms.delete(id);
          roomMemory.delete(id);
          deleted++;
          console.log(`[LEXONIMOUS] Deleted empty room: "${r.title}"`);
        }
      }
    }
    if (deleted > 0) io.emit('room:list', await getRoomList());
  } catch (err) {
    console.error('[LEXONIMOUS] Auto-delete error:', err.message);
  }
}, 60_000);

// ─── Socket Rate Limiters ─────────────────────────────────────────────────────
const msgRateLimit  = createSocketRateLimiter(MSG_PER_MIN);
const joinRateLimit = createSocketRateLimiter(JOIN_PER_MIN);

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  if (io.engine.clientsCount > 5000) {
    socket.emit('error', 'Server at capacity.');
    socket.disconnect(true);
    return;
  }
  console.log('[+] ' + socket.id + ' connected (total: ' + io.engine.clientsCount + ')');
  socket.emit('room:list', await getRoomList());
  io.emit('server:online', io.engine.clientsCount);

  // ── Create Room ────────────────────────────────────────────────────────────
  socket.on('room:create', async (data) => {
    if (!data || typeof data !== 'object') return socket.emit('error', 'Invalid payload.');
    const titleR = validateRoomTitle(data.title);
    if (!titleR.ok) return socket.emit('error', titleR.error);
    const tagR = validateTag(data.tag);
    if (!tagR.ok) return socket.emit('error', tagR.error);

    const count = useDB() ? await Room.countDocuments() : fallbackRooms.size;
    if (count >= MAX_ROOMS) return socket.emit('error', 'Room limit reached.');

    const id   = uuidv4();
    const room = { id, title: titleR.value, tag: tagR.value, isDefault: false, createdAt: Date.now(), emptyAt: Date.now(), messageCount: 0 };

    if (useDB()) await Room.create(room).catch(e => { socket.emit('error', 'Could not create room.'); return; });
    else fallbackRooms.set(id, room);

    roomMemory.set(id, { memberCount: 0, messages: [] });
    io.emit('room:list', await getRoomList());
    socket.emit('room:created', { id, title: titleR.value, tag: tagR.value });
  });

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('room:join', async (roomId) => {
    if (!joinRateLimit(socket.id)) return socket.emit('error', 'Joining too fast.');
    if (typeof roomId !== 'string' || roomId.length > 64) return socket.emit('error', 'Invalid room ID.');
    await handleLeave(socket);

    const room = await findRoom(roomId);
    if (!room) return socket.emit('error', 'Room not found.');

    socket.join(roomId);
    socketMap.set(socket.id, roomId);
    if (!roomMemory.has(roomId)) roomMemory.set(roomId, { memberCount: 0, messages: [] });
    const mem = roomMemory.get(roomId);
    mem.memberCount++;
    mem.emptyAt = null;

    if (useDB()) await Room.updateOne({ id: roomId }, { emptyAt: null }).catch(() => {});
    else if (fallbackRooms.has(roomId)) fallbackRooms.get(roomId).emptyAt = null;

    const history = await getHistory(roomId);
    socket.emit('room:history', { roomId, messages: history });
    io.to(roomId).emit('room:memberCount', { roomId, count: mem.memberCount });
    socket.to(roomId).emit('room:system', { text: 'A new anonymous soul arrived.' });
    io.emit('room:list', await getRoomList());
  });

  // ── Send Message ───────────────────────────────────────────────────────────
  socket.on('message:send', async (data) => {
    if (!msgRateLimit(socket.id)) return socket.emit('error', 'Sending too fast.');
    if (!data || typeof data !== 'object') return socket.emit('error', 'Invalid payload.');
    const roomId = socketMap.get(socket.id);
    if (!roomId) return socket.emit('error', 'Not in a room.');
    if (data.roomId !== roomId) return socket.emit('error', 'Room ID mismatch.');
    const msgR = validateMessage(data.text);
    if (!msgR.ok) return socket.emit('error', msgR.error);
    const room = await findRoom(roomId);
    if (!room) return socket.emit('error', 'Room not found.');

    const msg = {
      id: uuidv4(), roomId, text: msgR.value, senderId: socket.id,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ts: Date.now(),
    };
    await saveMessage(msg);
    io.to(roomId).emit('message:new', { roomId, msg });
  });

  // ── Typing ─────────────────────────────────────────────────────────────────
  socket.on('typing:start', () => { const r = socketMap.get(socket.id); if(r) socket.to(r).emit('typing:update',{count:1}); });
  socket.on('typing:stop',  () => { const r = socketMap.get(socket.id); if(r) socket.to(r).emit('typing:update',{count:0}); });
  socket.on('room:leave', () => handleLeave(socket));

  socket.on('disconnect', async (reason) => {
    console.log('[-] ' + socket.id + ' disconnected (' + reason + ')');
    await handleLeave(socket);
    io.emit('server:online', io.engine.clientsCount);
  });

  socket.on('error', (err) => console.error('Socket error [' + socket.id + ']:', err.message));
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  if (MONGODB_URI) {
    console.log('\n  🔄 Connecting to MongoDB...');
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 45000 });
      console.log('  ✅ MongoDB connected');
    } catch (err) {
      console.error('  ❌ MongoDB failed:', err.message);
      console.error('  → Check your MONGODB_URI in .env');
      console.error('  → Running in memory-only mode\n');
    }
  } else {
    console.log('\n  ⚠️  No MONGODB_URI — memory-only mode (data lost on restart)');
    console.log('  → Add MONGODB_URI=mongodb+srv://... to .env for persistence\n');
  }

  await seedRooms();

  server.listen(PORT, () => {
    console.log('\n');
    console.log('  ██╗  ██╗██╗   ██╗███╗   ██╗ ██████╗ ██████╗  █████╗ ');
    console.log('  ╚██╗██╔╝╚██╗ ██╔╝████╗  ██║██╔═══██╗██╔══██╗██╔══██╗');
    console.log('   ╚███╔╝  ╚████╔╝ ██╔██╗ ██║██║   ██║██████╔╝███████║');
    console.log('   ██╔██╗   ╚██╔╝  ██║╚██╗██║██║   ██║██╔══██╗██╔══██║');
    console.log('  ██╔╝ ██╗   ██║   ██║ ╚████║╚██████╔╝██║  ██║██║  ██║');
    console.log('  ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝');
    console.log('\n  Speak in darkness. Leave no name.\n');
    console.log(`  🟢 Server   : http://localhost:${PORT}`);
    console.log(`  🗄️  Database : ${MONGODB_URI ? (mongoose.connection.readyState===1 ? 'MongoDB ✅' : 'MongoDB ❌ (check URI)') : 'Memory only ⚠️'}`);
    console.log(`  🔐 Security : Helmet + CORS + Rate limiting + XSS`);
    console.log(`  🌍 Env      : ${NODE_ENV}`);
    console.log(`  🚪 Rooms    : ${roomMemory.size} loaded\n`);
  });
}

start().catch(err => { console.error('❌ Startup failed:', err.message); process.exit(1); });

async function shutdown(sig) {
  console.log(`\n${sig} — shutting down...`);
  server.close(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => { console.error('Uncaught:', err);  process.exit(1); });
process.on('unhandledRejection', err => { console.error('Rejection:', err); process.exit(1); });
