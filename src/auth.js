'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { id, nowISO, sha256 } = require('./util');

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

function verifyPassword(pw, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(pw, hash);
  } catch (e) {
    return false;
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlHours * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    nowISO(),
    expires.toISOString()
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
  return { token, expires };
}

function sessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT s.*, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ---------- API Key ---------- */

function createApiKey(userId, name = 'default') {
  const raw = 'fa_' + crypto.randomBytes(24).toString('hex');
  const keyId = id('key');
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(keyId, userId, name, sha256(raw), raw.slice(0, 10), nowISO());
  return { id: keyId, name, key: raw };
}

function apiKeyUser(raw) {
  if (!raw || !raw.startsWith('fa_')) return null;
  const row = db
    .prepare('SELECT k.*, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.revoked = 0')
    .get(sha256(raw));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowISO(), row.id);
  return row;
}

/* ---------- 中间件 ---------- */

function attachUser(req, res, next) {
  req.user = null;
  req.apiKeyMode = false;

  const authHeader = req.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const raw = authHeader.slice(7).trim();
    const u = apiKeyUser(raw) || sessionUser(raw);
    if (u) {
      req.user = u;
      req.apiKeyMode = raw.startsWith('fa_');
      return next();
    }
  }
  const cookieToken = req.cookies ? req.cookies[config.cookieName] : null;
  if (cookieToken) {
    const u = sessionUser(cookieToken);
    if (u) req.user = u;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function setSessionCookie(res, token, expires) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    expires,
    path: '/',
  });
}

function publicUser(u) {
  if (!u) return null;
  const settings = JSON.parse(u.settings || '{}');
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    anonymous: !!u.anonymous,
    isAdmin: !!u.is_admin,
    feed: u.feed,
    checkinStreak: u.checkin_streak,
    lastCheckin: u.last_checkin,
    totalInteract: u.total_interact,
    settings,
    createdAt: u.created_at,
  };
}

function updateSettings(userId, patch) {
  const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId);
  const cur = JSON.parse(row?.settings || '{}');
  const next = { ...cur, ...patch };
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(next), userId);
  return next;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  sessionUser,
  destroySession,
  createApiKey,
  apiKeyUser,
  attachUser,
  requireAuth,
  setSessionCookie,
  publicUser,
  updateSettings,
};
