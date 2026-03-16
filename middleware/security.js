'use strict';

const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

// ─── HTTP Security Headers via Helmet ────────────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:       ["'self'"],
      // Allow self scripts + inline <script> blocks (needed for embedded JS in index.html)
      // No onclick/inline event handlers allowed — we use addEventListener only
      scriptSrc:        ["'self'", "'unsafe-inline'"],
      scriptSrcAttr:    ["'none'"],   // blocks onclick= and all inline event attributes
      styleSrc:         ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      fontSrc:          ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:           ["'self'", 'data:'],
      connectSrc:       ["'self'", 'ws:', 'wss:'],
      objectSrc:        ["'none'"],
      baseUri:          ["'self'"],
      frameAncestors:   ["'none'"],
      formAction:       ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // needed for socket.io
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
});

// ─── HTTP Rate Limiter ────────────────────────────────────────────────────────
const httpRateLimiter = rateLimit({
  windowMs:    parseInt(process.env.RATE_LIMIT_WINDOW_MS  || '60000'),
  max:         parseInt(process.env.RATE_LIMIT_MAX        || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Slow down.' },
  skip: (req) => req.path === '/health', // allow health checks
});

// ─── Socket Rate Limiter (per-socket event bucket) ───────────────────────────
// Returns a function that tracks call counts per socket per window.
function createSocketRateLimiter(maxPerMinute) {
  const buckets = new Map(); // socketId -> { count, resetAt }

  return function isAllowed(socketId) {
    const now = Date.now();
    let b = buckets.get(socketId);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + 60_000 };
      buckets.set(socketId, b);
    }
    b.count++;
    if (b.count > maxPerMinute) return false;
    return true;
  };
}

// ─── Input Validation Helpers ─────────────────────────────────────────────────
const xss        = require('xss');
const validator  = require('validator');

const MAX_TITLE   = parseInt(process.env.MAX_ROOM_TITLE_LENGTH || '60');
const MAX_MSG     = parseInt(process.env.MAX_MESSAGE_LENGTH    || '1000');
const VALID_TAGS  = ['random','tech','philosophy','creative','social'];

function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return xss(validator.escape(str.trim()));
}

function validateRoomTitle(title) {
  if (typeof title !== 'string') return { ok: false, error: 'Title must be a string.' };
  const t = title.trim();
  if (t.length < 1)          return { ok: false, error: 'Title is required.' };
  if (t.length > MAX_TITLE)  return { ok: false, error: 'Title max ' + MAX_TITLE + ' chars.' };
  return { ok: true, value: sanitizeText(t) };
}

function validateTag(tag) {
  if (!VALID_TAGS.includes(tag)) return { ok: false, error: 'Invalid category.' };
  return { ok: true, value: tag };
}

function validateMessage(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Message must be a string.' };
  const t = text.trim();
  if (t.length < 1)         return { ok: false, error: 'Message is empty.' };
  if (t.length > MAX_MSG)   return { ok: false, error: 'Message max ' + MAX_MSG + ' chars.' };
  return { ok: true, value: sanitizeText(t) };
}

module.exports = {
  helmetMiddleware,
  httpRateLimiter,
  createSocketRateLimiter,
  sanitizeText,
  validateRoomTitle,
  validateTag,
  validateMessage,
};
