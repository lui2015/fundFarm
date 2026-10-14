'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const config = require('./config');
const auth = require('./auth');
const quote = require('./quote');
const ai = require('./ai');
const yardEngine = require('./engine/yard');
const chickenEngine = require('./engine/chicken');
const achEngine = require('./engine/achievements');
const tasks = require('./engine/tasks');
const { id: gid, today, nowISO, daysBetween, round } = require('./util');

const router = express.Router();

/* ============================ 工具 ============================ */

const CODE_RE = /^\d{6}$/;
const ALLOWED_EXT = ['.pdf', '.md', '.markdown', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.webp'];

function sanitizeFileName(name) {
  return String(name || 'report')
    .replace(/[^\w.\-一-龥]/g, '_')
    .slice(0, 80);
}

function ensureGroups(userId) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM groups WHERE user_id = ?').get(userId).n;
  if (n) return;
  const ins = db.prepare('INSERT INTO groups (id, user_id, name, sort, is_default) VALUES (?, ?, ?, ?, ?)');
  ins.run(gid('grp'), userId, '我的持仓', 0, 1);
  ins.run(gid('grp'), userId, '观察区', 1, 0);
}

function defaultGroupId(userId) {
  const g = db
    .prepare('SELECT id FROM groups WHERE user_id = ? ORDER BY is_default DESC, sort ASC LIMIT 1')
    .get(userId);
  return g ? g.id : null;
}

function getAdoption(userId, code) {
  return db
    .prepare('SELECT * FROM adoptions WHERE user_id = ? AND fund_code = ? AND released_at IS NULL')
    .get(userId, code);
}

function diary(userId, type, text, adoptionId = null, date = today()) {
  db.prepare(
    'INSERT INTO diary (id, user_id, adoption_id, date, type, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(gid('dr'), userId, adoptionId, date, type, text, nowISO());
}

function addFeed(userId, delta, reason) {
  db.prepare('UPDATE users SET feed = feed + ? WHERE id = ?').run(delta, userId);
  db.prepare('INSERT INTO feed_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    gid('fl'),
    userId,
    delta,
    reason,
    nowISO()
  );
}

/* ============================ 元信息 ============================ */

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'fundfarm',
    version: '1.0.0',
    time: nowISO(),
    ai: { configured: !!config.hunyuan.key, model: config.hunyuan.model },
    dataSource: quote.getStats(),
  });
});

router.get('/breeds', (req, res) => {
  const list = Object.values(chickenEngine.BREEDS).map((b) => ({
    key: b.key,
    name: b.name,
    desc: b.desc,
    colors: { body: b.color, accent: b.accent },
  }));
  res.json({ breeds: list, levels: chickenEngine.LEVELS });
});

router.get('/tips', (req, res) => {
  res.json({
    tips: [
      '鸡的等级只和陪伴时长、照料投入有关，和收益率无关——养得久就是胜利。',
      '掉毛只是暂时的，鸡不会死，别因为一天的下跌就放归它。',
      '跌得最多的那只会排在鸡舍最前面，去摸摸它吧。',
      '上传一份季报，让 AI 帮你提炼要点，比刷净值有用。',
      '连续签到可以攒饲料，饲料用来喂食提升亲密度。',
    ],
  });
});

/* ============================ 账号 ============================ */

router.post('/auth/register', (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username_and_password_required' });
  if (!/^[\w.@+-]{3,32}$/.test(username)) return res.status(400).json({ error: 'bad_username' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password_too_short' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'username_taken' });
  const userId = gid('usr');
  db.prepare(
    'INSERT INTO users (id, username, pass_hash, nickname, anonymous, feed, created_at) VALUES (?, ?, ?, ?, 0, 20, ?)'
  ).run(userId, username, auth.hashPassword(String(password)), nickname || username, nowISO());
  ensureGroups(userId);
  const session = auth.createSession(userId);
  auth.setSessionCookie(res, session.token, session.expires);
  res.json({ ok: true, user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
});

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !u.pass_hash || !auth.verifyPassword(String(password || ''), u.pass_hash)) {
    return res.status(401).json({ error: 'bad_credentials' });
  }
  const session = auth.createSession(u.id);
  auth.setSessionCookie(res, session.token, session.expires);
  res.json({ ok: true, user: auth.publicUser(u) });
});

router.post('/auth/guest', (req, res) => {
  const userId = gid('usr');
  const username = 'anon_' + userId.slice(4, 12);
  db.prepare(
    'INSERT INTO users (id, username, nickname, anonymous, feed, created_at) VALUES (?, ?, ?, 1, 20, ?)'
  ).run(userId, username, '游客农场主', nowISO());
  ensureGroups(userId);
  const session = auth.createSession(userId);
  auth.setSessionCookie(res, session.token, session.expires);
  diary(userId, 'system', '欢迎来到养基场！先去领养第一只基金鸡吧');
  res.json({ ok: true, user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
});

router.post('/auth/logout', (req, res) => {
  const token = req.cookies ? req.cookies[config.cookieName] : null;
  auth.destroySession(token);
  res.clearCookie(config.cookieName, { path: '/' });
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: auth.publicUser(req.user) });
});

/* 修改/设置密码（游客设置密码后自动转为正式账号） */
router.post('/me/password', auth.requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'password_too_short' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.pass_hash && !auth.verifyPassword(String(oldPassword || ''), u.pass_hash)) {
    return res.status(401).json({ error: 'bad_old_password' });
  }
  db.prepare('UPDATE users SET pass_hash = ?, anonymous = 0 WHERE id = ?').run(
    auth.hashPassword(String(newPassword)),
    u.id
  );
  res.json({ ok: true });
});

/* 管理员：运营概览（只读统计，不含任何用户隐私数据） */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

router.get('/admin/overview', auth.requireAuth, requireAdmin, (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    ok: true,
    users: one('SELECT COUNT(*) AS n FROM users'),
    admins: one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
    guests: one('SELECT COUNT(*) AS n FROM users WHERE anonymous = 1'),
    adoptions: one('SELECT COUNT(*) AS n FROM adoptions WHERE released_at IS NULL'),
    chickens: one('SELECT COUNT(*) AS n FROM chickens'),
    reports: one('SELECT COUNT(*) AS n FROM reports'),
    achievementsUnlocked: one('SELECT COUNT(*) AS n FROM user_achievements'),
    todayEvents: one('SELECT COUNT(*) AS n FROM daily_events WHERE date = ?', today()),
    dataSource: quote.getStats(),
    ai: { configured: !!config.hunyuan.key },
  });
});

/* ============================ 鸡舍 ============================ */

router.get('/yard', auth.requireAuth, async (req, res) => {
  try {
    const data = await yardEngine.buildYard(req.user.id);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: 'yard_failed', message: String(err.message || err) });
  }
});

router.post('/yard/clean', auth.requireAuth, (req, res) => {
  const r = chickenEngine.yardAction(req.user.id, 'clean');
  tasks.bump(req.user.id, 'clean_yard', 1);
  diary(req.user.id, 'care', '打扫了鸡舍，全体鸡健康 +8');
  res.json({ ok: true, ...r });
});

router.post('/yard/music', auth.requireAuth, (req, res) => {
  const r = chickenEngine.yardAction(req.user.id, 'music');
  diary(req.user.id, 'care', '给鸡舍放了音乐，全体心情 +10');
  res.json({ ok: true, ...r });
});

router.post('/yard/feed-all', auth.requireAuth, (req, res) => {
  const user = db.prepare('SELECT feed FROM users WHERE id = ?').get(req.user.id);
  const rows = db
    .prepare(
      `SELECT c.id FROM chickens c JOIN adoptions a ON a.id = c.adoption_id
       WHERE a.user_id = ? AND a.released_at IS NULL AND c.satiety < 100`
    )
    .all(req.user.id);
  let fed = 0;
  for (const r of rows) {
    if (user.feed <= fed) break;
    const out = chickenEngine.interact(r.id, 'feed', req.user.id);
    if (out.ok) {
      fed++;
      tasks.bump(req.user.id, 'feed_3', 1);
    } else if (out.error === 'cooldown') {
      continue;
    } else break;
  }
  res.json({ ok: true, fed, feedLeft: user.feed - fed });
});

router.get('/diary', auth.requireAuth, (req, res) => {
  const date = req.query.date || today();
  const rows = db
    .prepare('SELECT * FROM diary WHERE user_id = ? AND date = ? ORDER BY created_at DESC')
    .all(req.user.id, date);
  res.json({ date, items: rows });
});

router.get('/diary/range', auth.requireAuth, (req, res) => {
  const days = Math.min(Number(req.query.days || 30), 180);
  const rows = db
    .prepare(
      'SELECT * FROM diary WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT ?'
    )
    .all(req.user.id, days * 20);
  res.json({ items: rows.slice(0, 300) });
});

router.get('/tasks', auth.requireAuth, (req, res) => {
  res.json({ items: tasks.list(req.user.id) });
});

/* ============================ 分组 ============================ */

router.get('/groups', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM groups WHERE user_id = ? ORDER BY sort ASC').all(req.user.id);
  res.json({ items: rows });
});

router.post('/groups', auth.requireAuth, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const gidNew = gid('grp');
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM groups WHERE user_id = ?').get(req.user.id).m;
  db.prepare('INSERT INTO groups (id, user_id, name, sort, is_default) VALUES (?, ?, ?, ?, 0)').run(
    gidNew,
    req.user.id,
    name,
    maxSort + 1
  );
  res.json({ ok: true, group: db.prepare('SELECT * FROM groups WHERE id = ?').get(gidNew) });
});

router.patch('/groups/:id', auth.requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  const { name, sort } = req.body || {};
  db.prepare('UPDATE groups SET name = COALESCE(?, name), sort = COALESCE(?, sort) WHERE id = ?').run(
    name ? String(name).slice(0, 20) : null,
    typeof sort === 'number' ? sort : null,
    g.id
  );
  res.json({ ok: true });
});

router.delete('/groups/:id', auth.requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE adoptions SET group_id = NULL WHERE group_id = ?').run(g.id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  res.json({ ok: true });
});

/* ============================ 自选基金 ============================ */

router.get('/funds', auth.requireAuth, async (req, res) => {
  try {
    const { items } = await yardEngine.buildAdoptions(req.user.id);
    const groupId = req.query.groupId;
    const sort = req.query.sort || 'adopted';
    const filter = req.query.filter;
    let list = items;
    if (groupId && groupId !== 'all') list = list.filter((i) => i.groupId === groupId);
    if (groupId === 'none') list = list.filter((i) => !i.groupId);
    if (filter === 'profit') list = list.filter((i) => (i.profitRate ?? 0) > 0);
    if (filter === 'loss') list = list.filter((i) => (i.profitRate ?? 0) < 0);
    if (filter === 'hungry') list = list.filter((i) => i.chicken?.hungry);
    if (filter === 'up') list = list.filter((i) => (i.todayPct ?? 0) > 0);
    if (filter === 'down') list = list.filter((i) => (i.todayPct ?? 0) < 0);

    const cmp = {
      pct: (a, b) => (b.todayPct ?? -999) - (a.todayPct ?? -999),
      profitRate: (a, b) => (b.profitRate ?? -999) - (a.profitRate ?? -999),
      value: (a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1),
      level: (a, b) => (b.chicken?.growth ?? 0) - (a.chicken?.growth ?? 0),
      adopted: (a, b) => String(b.adoptedAt).localeCompare(String(a.adoptedAt)),
    }[sort];
    if (cmp) list = [...list].sort(cmp);

    res.json({
      ok: true,
      items: list,
      count: list.length,
      total: items.length,
      maxAdoptions: config.maxAdoptions,
      updatedAt: nowISO(),
    });
  } catch (err) {
    res.status(500).json({ error: 'list_failed', message: String(err.message || err) });
  }
});

router.post('/funds', auth.requireAuth, async (req, res) => {
  const { code, nickname, groupId, costPrice, shares, firstBuyDate } = req.body || {};
  const fundCode = String(code || '').trim();
  if (!CODE_RE.test(fundCode)) return res.status(400).json({ error: 'bad_fund_code' });

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM adoptions WHERE user_id = ? AND released_at IS NULL')
    .get(req.user.id).n;
  if (count >= config.maxAdoptions) return res.status(400).json({ error: 'yard_full', max: config.maxAdoptions });
  if (getAdoption(req.user.id, fundCode)) return res.status(409).json({ error: 'already_adopted' });

  const info = await quote.getFundInfo(fundCode);
  const breed = chickenEngine.breedOf(info?.type);
  const adoptionId = gid('adp');
  const now = nowISO();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO adoptions (id, user_id, fund_code, nickname, group_id, cost_price, shares, first_buy_date, adopted_at, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      adoptionId,
      req.user.id,
      fundCode,
      nickname ? String(nickname).slice(0, 30) : null,
      groupId || defaultGroupId(req.user.id),
      costPrice ? Number(costPrice) : null,
      shares ? Number(shares) : null,
      firstBuyDate || today(),
      now,
      count
    );
    db.prepare(
      `INSERT INTO chickens (id, adoption_id, breed, growth, level, last_decay_at)
       VALUES (?, ?, ?, 10, 1, ?)`
    ).run(gid('chk'), adoptionId, breed, now);
    db.prepare('UPDATE users SET last_adopt_at = ?, feed = feed + 10 WHERE id = ?').run(now, req.user.id);
    db.prepare('INSERT INTO feed_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      gid('fl'),
      req.user.id,
      10,
      '领养新鸡',
      now
    );
  })();

  diary(req.user.id, 'adopt', `领养了 ${nickname || info?.name || fundCode}`, adoptionId);
  tasks.bump(req.user.id, 'add_fund', 1);
  const achs = achEngine.check(req.user.id, {});

  res.json({
    ok: true,
    adoptionId,
    fund: { code: fundCode, name: info?.name || null, type: info?.type || null },
    breed,
    newAchievements: achs,
  });
});

router.patch('/funds/:code', auth.requireAuth, (req, res) => {
  const a = getAdoption(req.user.id, req.params.code);
  if (!a) return res.status(404).json({ error: 'not_found' });
  const { nickname, groupId, costPrice, shares, firstBuyDate } = req.body || {};
  db.prepare(
    `UPDATE adoptions SET nickname = COALESCE(?, nickname), group_id = ?,
       cost_price = COALESCE(?, cost_price), shares = COALESCE(?, shares),
       first_buy_date = COALESCE(?, first_buy_date)
     WHERE id = ?`
  ).run(
    nickname !== undefined ? String(nickname).slice(0, 30) : null,
    groupId !== undefined ? groupId : a.group_id,
    costPrice !== undefined ? (costPrice === '' ? null : Number(costPrice)) : null,
    shares !== undefined ? (shares === '' ? null : Number(shares)) : null,
    firstBuyDate !== undefined ? firstBuyDate : null,
    a.id
  );
  res.json({ ok: true });
});

router.delete('/funds/:code', auth.requireAuth, (req, res) => {
  const a = getAdoption(req.user.id, req.params.code);
  if (!a) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE adoptions SET released_at = ? WHERE id = ?').run(nowISO(), a.id);
  diary(req.user.id, 'release', `放归了 ${a.nickname || a.fund_code}`, a.id);
  res.json({ ok: true, restoreUntil: new Date(Date.now() + 30 * 86400000).toISOString() });
});

router.post('/funds/:code/restore', auth.requireAuth, (req, res) => {
  const a = db
    .prepare(
      `SELECT * FROM adoptions WHERE user_id = ? AND fund_code = ? AND released_at IS NOT NULL
       ORDER BY released_at DESC LIMIT 1`
    )
    .get(req.user.id, req.params.code);
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (getAdoption(req.user.id, req.params.code)) return res.status(409).json({ error: 'already_adopted' });
  db.prepare('UPDATE adoptions SET released_at = NULL WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

router.get('/funds/:code', auth.requireAuth, async (req, res) => {
  const code = String(req.params.code);
  const a = getAdoption(req.user.id, code);
  const info = await quote.getFundInfo(code);
  const hist = await quote.getHistory(code, 60);
  const q = await quote.fetchEstimate(code);
  if (!a) {
    return res.json({
      ok: true,
      adopted: false,
      fund: { ...info, code },
      quote: q,
      history: hist.items,
      historyStale: !!hist.stale,
      reports: [],
    });
  }
  const c = chickenEngine.getChicken(a.id);
  const reports = db
    .prepare('SELECT * FROM reports WHERE user_id = ? AND fund_code = ? ORDER BY created_at DESC')
    .all(req.user.id, code)
    .map(publicReport);

  let profit = null;
  let profitRate = null;
  let marketValue = null;
  const current = q?.estimate || q?.nav || hist.items.at(-1)?.nav || null;
  if (a.cost_price && a.shares && current) {
    marketValue = a.shares * current;
    profit = marketValue - a.shares * a.cost_price;
    profitRate = (profit / (a.shares * a.cost_price)) * 100;
  }
  const trades = db
    .prepare('SELECT * FROM trades WHERE adoption_id = ? ORDER BY date DESC LIMIT 50')
    .all(a.id);

  return res.json({
    ok: true,
    adopted: true,
    adoption: {
      id: a.id,
      fundCode: a.fund_code,
      nickname: a.nickname,
      groupId: a.group_id,
      costPrice: a.cost_price,
      shares: a.shares,
      firstBuyDate: a.first_buy_date,
      adoptedAt: a.adopted_at,
      holdingDays: chickenEngine.holdingDays(a),
    },
    fund: { ...info, code },
    quote: q,
    history: hist.items,
    historyStale: !!hist.stale,
    metrics: {
      current: current ? round(current, 4) : null,
      marketValue: marketValue ? round(marketValue, 2) : null,
      profit: profit === null ? null : round(profit, 2),
      profitRate: profitRate === null ? null : round(profitRate, 2),
    },
    chicken: c ? chickenEngine.publicChicken(c) : null,
    trades,
    reports,
  });
});

router.post('/funds/:code/trades', auth.requireAuth, (req, res) => {
  const a = getAdoption(req.user.id, req.params.code);
  if (!a) return res.status(404).json({ error: 'not_found' });
  const { date, type, price, shares, amount } = req.body || {};
  if (!date || !type || !price || !shares) return res.status(400).json({ error: 'missing_fields' });
  const p = Number(price);
  const s = Number(shares);
  db.prepare(
    'INSERT INTO trades (id, adoption_id, date, type, price, shares, amount) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(gid('trd'), a.id, String(date).slice(0, 10), String(type), p, s, Number(amount || p * s));

  // 按移动加权更新成本价与份额
  const trades = db.prepare('SELECT * FROM trades WHERE adoption_id = ? ORDER BY date ASC').all(a.id);
  let sharesSum = 0;
  let costSum = 0;
  let firstBuy = null;
  for (const t of trades) {
    if (t.type === 'buy') {
      sharesSum += t.shares;
      costSum += t.shares * t.price;
      if (!firstBuy) firstBuy = t.date;
    } else if (t.type === 'sell') {
      const avg = sharesSum ? costSum / sharesSum : 0;
      sharesSum = Math.max(0, sharesSum - t.shares);
      costSum = Math.max(0, costSum - avg * Math.min(t.shares, sharesSum + t.shares));
    }
  }
  db.prepare('UPDATE adoptions SET shares = ?, cost_price = ?, first_buy_date = COALESCE(first_buy_date, ?) WHERE id = ?').run(
    sharesSum || 0,
    sharesSum ? costSum / sharesSum : null,
    firstBuy,
    a.id
  );
  res.json({ ok: true, shares: sharesSum, costPrice: sharesSum ? round(costSum / sharesSum, 4) : null });
});

router.delete('/funds/:code/trades/:tradeId', auth.requireAuth, (req, res) => {
  const a = getAdoption(req.user.id, req.params.code);
  if (!a) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM trades WHERE id = ? AND adoption_id = ?').run(req.params.tradeId, a.id);
  res.json({ ok: true });
});

/* ============================ 互动 ============================ */

router.post('/chickens/:id/interact', auth.requireAuth, (req, res) => {
  const action = String((req.body || {}).action || '');
  if (!['feed', 'pat'].includes(action)) return res.status(400).json({ error: 'bad_action' });
  const out = chickenEngine.interact(req.params.id, action, req.user.id);
  if (out.error) {
    const code = { not_found: 404, cooldown: 429, no_feed: 400, bad_action: 400 }[out.error] || 400;
    return res.status(code).json({ error: out.error, leftMin: out.leftMin });
  }
  if (action === 'feed') tasks.bump(req.user.id, 'feed_3', 1);
  const chicken = db.prepare('SELECT * FROM chickens WHERE id = ?').get(req.params.id);
  const adoption = db.prepare('SELECT * FROM adoptions WHERE id = ?').get(chicken.adoption_id);
  if (adoption) {
    const worst = db
      .prepare(
        `SELECT a.fund_code FROM adoptions a JOIN daily_events e ON e.adoption_id = a.id
         WHERE a.user_id = ? AND e.date = ? ORDER BY e.pct ASC LIMIT 1`
      )
      .get(req.user.id, today());
    if (action === 'pat' && worst && worst.fund_code === adoption.fund_code) tasks.bump(req.user.id, 'pat_sad', 1);
  }
  const achs = achEngine.check(req.user.id, {});
  res.json({ ok: true, ...out, newAchievements: achs });
});

/* ============================ 行情 / 搜索 ============================ */

router.get('/quote', auth.requireAuth, async (req, res) => {
  const codes = String(req.query.codes || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CODE_RE.test(s));
  const data = await quote.getEstimates(codes);
  res.json({ ok: true, quotes: data, updatedAt: nowISO() });
});

router.get('/search', auth.requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const items = await quote.search(q, 20);
  res.json({ items, query: q });
});

/* ============================ 报告 ============================ */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => cb(null, `${req.reportId}_${sanitizeFileName(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error('unsupported_file_type'));
    cb(null, true);
  },
});

function publicReport(r, includeContent = false) {
  const parse = db.prepare('SELECT * FROM report_parses WHERE report_id = ?').get(r.id);
  return {
    id: r.id,
    fundCode: r.fund_code,
    title: r.title,
    source: r.source,
    reportDate: r.report_date,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
    fileName: r.file_name,
    mime: r.mime,
    size: r.size,
    status: r.status,
    content: includeContent ? r.content : r.content ? r.content.slice(0, 200) : null,
    createdAt: r.created_at,
    parse: parse
      ? {
          summary: parse.summary,
          keyPoints: JSON.parse(parse.key_points || '[]'),
          risks: JSON.parse(parse.risks || '[]'),
          sentiment: parse.sentiment,
          confidence: parse.confidence,
          model: parse.model,
          createdAt: parse.created_at,
        }
      : null,
  };
}

function readTextFile(filePath, ext) {
  try {
    if (['.md', '.markdown', '.txt', '.csv'].includes(ext)) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (e) {
    /* ignore */
  }
  return '';
}

router.get('/funds/:code/reports', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM reports WHERE user_id = ? AND fund_code = ? ORDER BY created_at DESC')
    .all(req.user.id, req.params.code);
  res.json({ items: rows.map(publicReport) });
});

router.post('/funds/:code/reports', auth.requireAuth, (req, res) => {
  req.reportId = gid('rpt');
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(code).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed', message: err.message });
    }
    try {
      const fundCode = String(req.params.code);
      if (!CODE_RE.test(fundCode)) return res.status(400).json({ error: 'bad_fund_code' });
      const body = req.body || {};
      const title = String(body.title || '').trim() || (req.file ? req.file.originalname : '未命名报告');
      const content = String(body.content || '');
      const tags = String(body.tags || '')
        .split(/[,，\s]+/)
        .filter(Boolean)
        .slice(0, 8)
        .join(',');

      let text = content;
      let filePath = null;
      let fileName = null;
      let mime = null;
      let size = 0;
      if (req.file) {
        filePath = req.file.path;
        fileName = req.file.originalname;
        mime = req.file.mimetype;
        size = req.file.size;
        const ext = path.extname(fileName).toLowerCase();
        if (!text) text = readTextFile(filePath, ext);
      } else {
        size = Buffer.byteLength(content, 'utf8');
      }

      const reportId = req.reportId;
      const wantParse = String(body.parse || '') === 'true' || body.parse === true;
      db.prepare(
        `INSERT INTO reports (id, user_id, adoption_id, fund_code, title, source, report_date, tags,
           file_name, file_path, mime, size, content, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        reportId,
        req.user.id,
        (getAdoption(req.user.id, fundCode) || {}).id || null,
        fundCode,
        title,
        body.source || (req.file ? 'user' : 'text'),
        body.report_date ? String(body.report_date).slice(0, 10) : today(),
        tags,
        fileName,
        filePath,
        mime,
        size,
        text ? text.slice(0, 200000) : null,
        wantParse ? 'parsing' : 'done',
        nowISO()
      );

      diary(req.user.id, 'report', `上传了报告《${title}》`, null);
      tasks.bump(req.user.id, 'read_report', 1);
      const achs = achEngine.check(req.user.id, {});

      const report = publicReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId));
      res.status(201).json({ ok: true, report, newAchievements: achs });

      if (wantParse && text) {
        parseInBackground(reportId, text, req.user.id, fundCode);
      } else if (wantParse && !text) {
        db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('done', reportId);
      }
    } catch (e) {
      res.status(500).json({ error: 'upload_failed', message: String(e.message || e) });
    }
  });
});

async function parseInBackground(reportId, text, userId, fundCode) {
  try {
    const fund = db.prepare('SELECT name FROM funds WHERE code = ?').get(fundCode);
    const result = await ai.parseReport(text, fund?.name || fundCode, userId);
    db.prepare(
      `INSERT OR REPLACE INTO report_parses (report_id, summary, key_points, risks, sentiment, rating, confidence, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reportId,
      result.summary || '',
      JSON.stringify(result.key_points || []),
      JSON.stringify(result.risks || []),
      result.sentiment || 'neutral',
      result.rating || null,
      result.confidence ?? null,
      result.model || 'unknown',
      nowISO()
    );
    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('done', reportId);
  } catch (err) {
    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('failed', reportId);
  }
}

router.get('/reports/:id', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  tasks.bump(req.user.id, 'read_report', 1);
  res.json({ report: publicReport(r, true) });
});

router.get('/reports/:id/download', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r || r.user_id !== req.user.id || !r.file_path) return res.status(404).json({ error: 'not_found' });
  if (!fs.existsSync(r.file_path)) return res.status(404).json({ error: 'file_missing' });
  res.download(r.file_path, r.file_name || 'report');
});

router.post('/reports/:id/reparse', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (!r.content) return res.status(400).json({ error: 'no_text' });
  db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('parsing', r.id);
  res.json({ ok: true });
  parseInBackground(r.id, r.content, req.user.id, r.fund_code);
});

router.delete('/reports/:id', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (r.file_path && fs.existsSync(r.file_path)) {
    try {
      fs.unlinkSync(r.file_path);
    } catch (e) {
      /* ignore */
    }
  }
  db.prepare('DELETE FROM report_parses WHERE report_id = ?').run(r.id);
  db.prepare('DELETE FROM reports WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

/* ============================ AI 提示词 ============================ */

function siteBase(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host') || `localhost:${config.port}`;
  return `${proto}://${host}${config.basePath}`;
}

router.get('/ai-prompt', auth.requireAuth, async (req, res) => {
  const code = String(req.query.code || '').trim();
  const fund = code ? await quote.getFundInfo(code) : null;
  const base = siteBase(req);
  const prompt = `你现在是「养基场」的基金研究助手。目标基金：${fund?.name || '（基金名称）'}（代码 ${code || '（基金代码）'}）。

任务：
1. 检索并阅读该基金最近一期季报/年报、近期净值表现、基金经理观点、行业动态。
2. 输出一份不超过 800 字的分析报告，使用 Markdown，结构如下：
   - 一、业绩回顾（近 1 月 / 近 1 年 / 同类排名）
   - 二、持仓与风格变化
   - 三、关键风险（列 3 条）
   - 四、后续观察指标（列 3 条）
3. 全文不得出现「建议买入/建议卖出/必涨」等投资建议表述，仅陈述事实与数据。

完成后，调用养基场接口把报告写回（需要用户已授权 API Key）：

POST ${base}/api/v1/funds/${code || '{基金代码}'}/reports
Headers: Authorization: Bearer {API_KEY}; Content-Type: application/json
Body: {
  "title": "<报告标题>",
  "report_date": "<YYYY-MM-DD>",
  "tags": ["AI生成"],
  "content_type": "markdown",
  "content": "<Markdown 正文>",
  "parse": true
}

最后向我回复：报告已写入，并附 3 条要点摘要。`;
  res.json({ prompt, base, endpoints: ['POST /api/v1/funds/{code}/reports', 'GET /api/v1/funds/{code}/reports'] });
});

/* ============================ 成就 / 我的 ============================ */

router.get('/achievements', auth.requireAuth, (req, res) => {
  const items = achEngine.list(req.user.id).map((a) => {
    const p = achEngine.progressFor(req.user.id, a.code);
    return { ...a, progress: p };
  });
  res.json({ items, unlocked: items.filter((i) => i.unlocked).length, total: items.length });
});

router.get('/me/checkin', auth.requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const t = today();
  if (u.last_checkin === t) return res.json({ ok: false, error: 'already_checked', feed: u.feed, streak: u.checkin_streak });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const streak = u.last_checkin === yesterday ? u.checkin_streak + 1 : 1;
  const bonus = streak % 7 === 0 ? 20 : 0;
  const gain = 5 + bonus;
  db.prepare('UPDATE users SET last_checkin = ?, checkin_streak = ?, feed = feed + ? WHERE id = ?').run(t, streak, gain, req.user.id);
  db.prepare('INSERT INTO feed_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    gid('fl'),
    req.user.id,
    gain,
    `签到（连续 ${streak} 天）`,
    nowISO()
  );
  const achs = achEngine.check(req.user.id, { hour: new Date().getHours(), event: 'checkin' });
  res.json({ ok: true, gain, bonus, streak, newAchievements: achs });
});

router.post('/me/settings', auth.requireAuth, (req, res) => {
  const patch = req.body || {};
  const allowed = {};
  for (const k of ['hideAmount', 'hideProfit', 'remindDrop', 'remindHungry', 'remindInvest', 'theme', 'reduceMotion']) {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  }
  const settings = auth.updateSettings(req.user.id, allowed);
  res.json({ ok: true, settings });
});

router.get('/me/keys', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, name, prefix, last_used_at, created_at, revoked FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ items: rows });
});

router.post('/me/keys', auth.requireAuth, (req, res) => {
  const name = String((req.body || {}).name || 'default').slice(0, 30);
  const k = auth.createApiKey(req.user.id, name);
  res.json({ ok: true, key: k });
});

router.delete('/me/keys/:id', auth.requireAuth, (req, res) => {
  db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.get('/me/export', auth.requireAuth, (req, res) => {
  const adoptions = db
    .prepare('SELECT * FROM adoptions WHERE user_id = ? AND released_at IS NULL')
    .all(req.user.id);
  const groups = db.prepare('SELECT * FROM groups WHERE user_id = ?').all(req.user.id);
  const reports = db
    .prepare('SELECT id, fund_code, title, source, report_date, tags, created_at FROM reports WHERE user_id = ?')
    .all(req.user.id);
  const achs = db.prepare('SELECT code, unlocked_at FROM user_achievements WHERE user_id = ?').all(req.user.id);

  if (req.query.format === 'csv') {
    const header = '基金代码,昵称,分组,成本价,份额,首次买入,领养时间\n';
    const gmap = new Map(groups.map((g) => [g.id, g.name]));
    const body = adoptions
      .map((a) =>
        [a.fund_code, a.nickname || '', gmap.get(a.group_id) || '', a.cost_price ?? '', a.shares ?? '', a.first_buy_date || '', a.adopted_at]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fundfarm.csv"');
    return res.send('\uFEFF' + header + body);
  }

  res.json({ exportedAt: nowISO(), adoptions, groups, reports, achievements: achs });
});

/* ============================ 机器可读能力描述 ============================ */

router.get('/capabilities', (req, res) => {
  const base = siteBase(req);
  res.json({
    name: '养基场 FundFarm',
    version: '1.0.0',
    description: '游戏化基金自选管理工具。可用接口：查询自选基金、上传/获取研究报告、查询成就。',
    auth: { type: 'bearer', note: '在「我的 - 开发者」中生成 API Key（fa_ 前缀）' },
    baseUrl: base + '/api/v1',
    endpoints: [
      { method: 'GET', path: '/funds', desc: '自选基金列表' },
      { method: 'GET', path: '/funds/{code}', desc: '单只基金详情' },
      { method: 'POST', path: '/funds/{code}/reports', desc: '上传报告（multipart file 或 JSON content）' },
      { method: 'GET', path: '/funds/{code}/reports', desc: '报告列表' },
      { method: 'GET', path: '/reports/{id}', desc: '报告详情与解析结果' },
      { method: 'DELETE', path: '/reports/{id}', desc: '删除报告' },
      { method: 'GET', path: '/achievements', desc: '成就与解锁状态' },
    ],
    disclaimer: '数据来自第三方公开接口，可能存在延迟或误差；本工具不构成投资建议。',
  });
});

module.exports = router;
