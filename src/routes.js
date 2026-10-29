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
const levelEngine = require('./engine/level');
const pnlEngine = require('./engine/pnl');
const alertEngine = require('./engine/alerts');
const { id: gid, today, nowISO, daysBetween, round } = require('./util');

const router = express.Router();

/* ============================ 工具 ============================ */

const CODE_RE = /^\d{6}$/;
const ALLOWED_EXT = ['.pdf', '.md', '.markdown', '.txt', '.csv', '.html', '.htm', '.png', '.jpg', '.jpeg', '.webp'];

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

/**
 * 基金类型图鉴：品种 ↔ 真实基金类型（东财 FTYPE 大类），带各类当前基金数量。
 * ft 可直接传给 /explore 做分类查询。
 */
router.get('/fund-types', async (req, res) => {
  const counts = {};
  try {
    const r = await quote.explore({ type: 'all', size: 10 });
    Object.assign(counts, r.counts || {});
  } catch (err) {
    /* 数量拿不到不影响图鉴 */
  }
  try {
    const m = await quote.explore({ type: 'hb', size: 10 });
    counts.hb = m.total || counts.hb || null;
  } catch (err) {
    /* 同上 */
  }

  // 细分类型以东财字典为准（静态列表文案可能和接口不一致，筛不到东西），拿不到时回退静态列表
  const catMap = {};
  await Promise.all(
    Object.entries(chickenEngine.FUND_TYPES).map(async ([key, t]) => {
      if (t.ft === 'hb' || t.ft === 'all') return;
      const list = await quote.categoryNames(t.name);
      if (list.length) catMap[key] = list;
    })
  );

  const types = Object.entries(chickenEngine.FUND_TYPES).map(([key, t]) => {
    const b = chickenEngine.breedInfo(key);
    return {
      key,
      ft: t.ft,
      name: t.name,
      categories: catMap[key] || t.categories,
      // other 指向「全部基金」，数量没有意义，不给数字
      count: key === 'other' ? null : counts[t.ft] || null,
      breed: { key: b.key, name: b.name, desc: b.desc, colors: { body: b.color, accent: b.accent } },
    };
  });
  types.sort((a, b) => {
    if (a.key === 'other') return 1;
    if (b.key === 'other') return -1;
    return (b.count || 0) - (a.count || 0);
  });
  res.json({ ok: true, types, updatedAt: nowISO() });
});

router.get('/tips', (req, res) => {
  res.json({
    tips: [
      '鸡的等级只和陪伴时长、照料投入有关，和收益率无关——养得久就是胜利。',
      '掉毛只是暂时的，鸡不会死，别因为一天的下跌就放归它。',
      '跌得最多的那只会排在鸡舍最前面，去摸摸它吧。',
      '上传一份季报，让 AI 帮你提炼要点，比刷净值有用。',
      '饲料就是经验值：上传一份报告 +20，写一条心得 +8，攒着看自己养基的用心程度。',
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
    // 右栏「分析报告」：只要最新 3 份，字段精简（详情去 #/report/{id}）
    const latestReports = db
      .prepare(
        `SELECT r.id, r.title, r.report_date, r.fund_code, r.status, r.created_at, f.name AS fund_name
           FROM reports r LEFT JOIN funds f ON f.code = r.fund_code
          WHERE r.user_id = ?
          ORDER BY r.created_at DESC LIMIT 3`
      )
      .all(req.user.id)
      .map((r) => ({
        id: r.id,
        title: r.title,
        reportDate: r.report_date || String(r.created_at || '').slice(0, 10),
        fundCode: r.fund_code || '',
        fundName: r.fund_name || null,
        status: r.status,
      }));
    const reportsTotal = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ?').get(req.user.id).n;
    // 买入/卖出提醒：现价已到达预期价的基金，在卡片上打角标
    const alertPrices = {};
    for (const it of data.items) {
      alertPrices[it.fundCode] = it.quote ? it.quote.estimate || it.quote.nav : null;
    }
    const alertHits = alertEngine.triggeredByCode(req.user.id, alertPrices);
    data.items = data.items.map((it) => ({ ...it, alert: alertHits[it.fundCode] || null }));
    res.json({
      ok: true,
      ...data,
      reports: latestReports,
      reportsTotal,
      alertCount: Object.keys(alertHits).length,
    });
  } catch (err) {
    res.status(500).json({ error: 'yard_failed', message: String(err.message || err) });
  }
});

// 注：纯点击的「打扫 / 放音乐」已下线——它们不产生任何信息，只是刷数字。
// 现在鸡舍只保留带真实动作的照料：喂食（附报告或心得）、安抚（写心态笔记）、加餐喂全场。

router.post('/yard/feed-all', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id FROM chickens c JOIN adoptions a ON a.id = c.adoption_id
       WHERE a.user_id = ? AND a.released_at IS NULL AND a.cost_price > 0 AND a.shares > 0 AND c.satiety < 100`
    )
    .all(req.user.id);
  if (!rows.length) return res.json({ ok: true, fed: 0, text: '大家都不饿' });

  // 一次加餐喂全场：同样必须附素材（一份报告或一条心得），但成长加成递减
  const mat = takeMaterial(req, { minLen: NOTE_MIN.feed, kind: 'feed', fundCode: '', adoptionId: null });
  if (mat.error) return res.status(400).json({ error: mat.error, minLen: mat.minLen });
  const matAll = { ...mat, bonus: Math.max(1, (mat.bonus || 0) - 2) };

  let fed = 0;
  let cooling = 0;
  let hungry = 0;
  for (const r of rows) {
    const out = chickenEngine.interact(r.id, 'feed', req.user.id, matAll);
    if (out.ok) {
      fed++;
      tasks.bump(req.user.id, 'feed_3', 1);
    } else if (out.error === 'cooldown') {
      cooling++;
    } else break;
  }
  hungry = rows.length;
  if (fed) diary(req.user.id, 'care', `用同一份${mat.label}给 ${fed} 只鸡加餐`, null);
  res.json({
    ok: true,
    fed,
    cooling,
    hungry,
    feedLeft: (db.prepare('SELECT feed FROM users WHERE id = ?').get(req.user.id) || {}).feed,
    material: mat.label,
    text: fed ? `喂了 ${fed} 只鸡` : cooling ? '它们刚吃过，还在冷却中' : '大家都不饿',
  });
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
    const fundType = String(req.query.type || '').trim();
    let list = items;
    if (groupId && groupId !== 'all') list = list.filter((i) => i.groupId === groupId);
    if (fundType && fundType !== 'all') list = list.filter((i) => i.type === fundType);
    if (groupId === 'none') list = list.filter((i) => !i.groupId);
    if (filter === 'profit') list = list.filter((i) => (i.profitRate ?? 0) > 0);
    if (filter === 'loss') list = list.filter((i) => (i.profitRate ?? 0) < 0);
    if (filter === 'hungry') list = list.filter((i) => i.chicken?.hungry && i.hasPosition);
    if (filter === 'up') list = list.filter((i) => (i.todayPct ?? 0) > 0);
    if (filter === 'down') list = list.filter((i) => (i.todayPct ?? 0) < 0);
    if (filter === 'in_yard') list = list.filter((i) => i.hasPosition);
    if (filter === 'watching') list = list.filter((i) => !i.hasPosition);

    const cmp = {
      pct: (a, b) => (b.todayPct ?? -999) - (a.todayPct ?? -999),
      profitRate: (a, b) => (b.profitRate ?? -999) - (a.profitRate ?? -999),
      value: (a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1),
      level: (a, b) => (b.chicken?.growth ?? 0) - (a.chicken?.growth ?? 0),
      adopted: (a, b) => String(b.adoptedAt).localeCompare(String(a.adoptedAt)),
    }[sort];
    if (cmp) list = [...list].sort(cmp);

    const positioned = items.filter((i) => i.hasPosition).length;
    res.json({
      ok: true,
      items: list,
      count: list.length,
      total: items.length,
      // 已建仓（进鸡舍）的数量 / 只在自选里观察的数量
      positioned,
      watching: items.length - positioned,
      maxAdoptions: config.maxAdoptions,
      updatedAt: nowISO(),
    });
  } catch (err) {
    res.status(500).json({ error: 'list_failed', message: String(err.message || err) });
  }
});

/**
 * 实时行情（供前端轮询）：
 * - 数据要求不老于 15s，过期即回源重取，保证涨跌幅是当下的；
 * - 只读，不结算鸡的状态，避免轮询把成长值 / 饱食度刷掉；
 * - 顺带回一份按持仓市值加权的今日涨跌汇总，前端可直接更新概况卡片。
 */
router.get('/quotes', auth.requireAuth, async (req, res) => {
  try {
    const asked = String(req.query.codes || '')
      .split(',')
      .map((s) => s.trim())
      .filter((c) => CODE_RE.test(c))
      .slice(0, 60);
    const rows = db
      .prepare('SELECT fund_code, cost_price, shares FROM adoptions WHERE user_id = ? AND released_at IS NULL')
      .all(req.user.id);
    const codes = asked.length ? asked : rows.map((r) => r.fund_code);

    const maxAgeMs = quote.LIVE_MAX_AGE;
    const [quotes, indices] = await Promise.all([
      quote.getEstimates(codes, { maxAgeMs }),
      quote.getIndices({ maxAgeMs }),
    ]);

    const items = {};
    for (const c of codes) {
      const q = quotes[c];
      if (!q) {
        const p = yardEngine.lastLocalPct(c);
        items[c] = { code: c, pct: typeof p === 'number' ? round(p, 2) : null, live: false, updatedAt: null };
        continue;
      }
      items[c] = {
        code: c,
        name: q.name || null,
        nav: q.nav === undefined ? null : q.nav,
        estimate: q.estimate === undefined ? null : q.estimate,
        pct: typeof q.pct === 'number' ? round(q.pct, 2) : null,
        navDate: q.navDate || null,
        estimateTime: q.estimateTime || null,
        live: q.live !== false,
        approx: !!q.approx,
        coverage: typeof q.coverage === 'number' ? q.coverage : null,
        source: q.source || null,
        updatedAt: q.updatedAt || null,
      };
    }

    // 汇总只算鸡舍里的（已建仓）基金，与 /yard 口径保持一致
    const pseudo = rows.filter((r) => Number(r.cost_price) > 0 && Number(r.shares) > 0).map((r) => {
      const q = quotes[r.fund_code];
      const pctV = q ? q.pct : yardEngine.lastLocalPct(r.fund_code);
      const local = quote.latestLocalNav(r.fund_code);
      const value = q ? q.estimate || q.nav : local ? local.nav : null;
      let marketValue = null;
      if (r.cost_price && r.shares && value) marketValue = r.shares * value;
      return {
        shares: r.shares,
        costPrice: r.cost_price,
        marketValue,
        todayPct: typeof pctV === 'number' ? pctV : null,
      };
    });

    // 买入/卖出提醒：轮询时同步角标（现价到达预期价才算）
    const hitPrices = {};
    for (const c of codes) {
      const q = quotes[c];
      hitPrices[c] = q ? q.estimate || q.nav : null;
    }
    const alerts = alertEngine.triggeredByCode(req.user.id, hitPrices);

    res.json({
      ok: true,
      trading: quote.isTrading(),
      updatedAt: nowISO(),
      items,
      alerts,
      summary: yardEngine.summarize(pseudo),
      indices: indices.items || [],
      indicesUpdatedAt: indices.updatedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'quotes_failed', message: String(err.message || err) });
  }
});

/**
 * 全球大盘指数（首页天气栏点击后查看）：
 * A股 / 港股 / 美股 / 亚太 / 欧洲 分组返回，数据来自腾讯 + 新浪公开接口。
 */
router.get('/indices/global', auth.requireAuth, async (req, res) => {
  try {
    const g = await quote.getGlobalIndices({ maxAgeMs: quote.LIVE_MAX_AGE });
    res.json({ ok: true, ...g });
  } catch (err) {
    res.status(500).json({ error: 'global_indices_failed', message: String(err.message || err) });
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
    // 饲料=经验值：领养不再送饲料（只有上传报告 / 写心得会涨经验）
    db.prepare('UPDATE users SET last_adopt_at = ? WHERE id = ?').run(now, req.user.id);
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
  // 成本价 / 份额要能被清空（清空 = 退出鸡舍回到自选观察），所以不能再用 COALESCE
  const num = (v) => (v === '' || v === null ? null : Number(v));
  db.prepare(
    `UPDATE adoptions SET nickname = COALESCE(?, nickname), group_id = ?,
       cost_price = ?, shares = ?, first_buy_date = COALESCE(?, first_buy_date)
     WHERE id = ?`
  ).run(
    nickname !== undefined ? String(nickname).slice(0, 30) : null,
    groupId !== undefined ? groupId : a.group_id,
    costPrice !== undefined ? num(costPrice) : a.cost_price,
    shares !== undefined ? num(shares) : a.shares,
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
  // 「巡视鸡舍」要求真的点开一只鸡看持仓详情，而不是打开页面就算完
  tasks.bump(req.user.id, 'check_yard', 1);
  const a = getAdoption(req.user.id, code);
  const info = await quote.getFundInfo(code);
  // 详情页支持 30/60/180/全部 切换，一次把全量净值取回来（命中缓存，6h 有效）
  const hist = await quote.getFullHistory(code);
  const q = await quote.fetchEstimate(code);
  // 按基金类型取差异化信息：指数→跟踪指数与重仓股，债券→重仓债券，其余→重仓股
  const profile = await quote.getFundProfile(code, info.type || quote.normalizeType(info.category));
  if (!a) {
    return res.json({
      ok: true,
      adopted: false,
      fund: { ...info, code },
      quote: q,
      history: hist.items,
      historyStale: !!hist.stale,
      profile,
      alerts: alertEngine.list(req.user.id, code, alertEngine.priceOf(q)),
      reports: [],
      notes: [],
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

  // 持仓盈亏走势：全量历史净值 × 当时份额/成本（交易记录全量回放，不受上面 50 条展示限制）
  const allTrades = db
    .prepare('SELECT date, type, price, shares FROM trades WHERE adoption_id = ? ORDER BY date ASC')
    .all(a.id);
  const pnl = pnlEngine.buildSeries({
    history: hist.items,
    trades: allTrades,
    shares: a.shares,
    costPrice: a.cost_price,
    current: current ? { date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), nav: current } : null,
  });

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
    profile,
    pnl,
    alerts: alertEngine.list(req.user.id, code, current || alertEngine.priceOf(q)),
    metrics: {
      current: current ? round(current, 4) : null,
      marketValue: marketValue ? round(marketValue, 2) : null,
      profit: profit === null ? null : round(profit, 2),
      profitRate: profitRate === null ? null : round(profitRate, 2),
    },
    chicken: c ? chickenEngine.publicChicken(c, code, profitRate) : null,
    trades,
    reports,
    notes: db
      .prepare('SELECT * FROM notes WHERE user_id = ? AND fund_code = ? ORDER BY created_at DESC LIMIT 30')
      .all(req.user.id, code)
      .map(publicNote),
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

/* ============================ 买入 / 卖出价格提醒 ============================ */

/** 提醒列表（附带现价与是否已到达） */
router.get('/funds/:code/alerts', auth.requireAuth, async (req, res) => {
  const code = String(req.params.code);
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad_fund_code' });
  const q = await quote.fetchEstimate(code).catch(() => null);
  const price = alertEngine.priceOf(q);
  res.json({
    ok: true,
    max: alertEngine.MAX_ALERTS,
    current: price === null ? null : round(price, 4),
    alerts: alertEngine.list(req.user.id, code, price),
  });
});

/** 新增提醒：type=buy|sell，price=预期价 */
router.post('/funds/:code/alerts', auth.requireAuth, async (req, res) => {
  const code = String(req.params.code);
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad_fund_code' });
  const body = req.body || {};
  const out = alertEngine.add(req.user.id, code, String(body.type || ''), body.price);
  if (out.error) {
    const status = out.error === 'alert_limit' || out.error === 'alert_exists' ? 409 : 400;
    const message =
      out.error === 'alert_limit'
        ? `最多只能设 ${alertEngine.MAX_ALERTS} 条提醒`
        : out.error === 'alert_exists'
        ? '这条提醒已经加过了'
        : '预期价不合法';
    return res.status(status).json({ error: out.error, message, limit: alertEngine.MAX_ALERTS });
  }
  const q = await quote.fetchEstimate(code).catch(() => null);
  const price = alertEngine.priceOf(q);
  res.json({
    ok: true,
    max: alertEngine.MAX_ALERTS,
    current: price === null ? null : round(price, 4),
    alerts: alertEngine.list(req.user.id, code, price),
  });
});

router.delete('/funds/:code/alerts/:alertId', auth.requireAuth, (req, res) => {
  const code = String(req.params.code);
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad_fund_code' });
  if (!alertEngine.remove(req.user.id, String(req.params.alertId))) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ ok: true });
});

/* ============================ 投研素材：心得 / 笔记 ============================ */

/** 字数按字符计（中文按 1 个计），用于素材最小长度校验 */
function countChars(s) {
  return [...String(s || '')].length;
}

const NOTE_MIN = { feed: 20, pat: 10 };

function publicNote(n) {
  const f = n.fund_code ? db.prepare('SELECT name FROM funds WHERE code = ?').get(n.fund_code) : null;
  return {
    id: n.id,
    fundCode: n.fund_code || '',
    fundName: f ? f.name : null,
    kind: n.kind,
    content: n.content,
    reportId: n.report_id || null,
    createdAt: n.created_at,
  };
}

/**
 * 取一次互动所需的投研素材：关联一份报告，或新写一条心得。
 * 这是「养鸡必须有实际投入」的落点：喂食/安抚都不能只点一下。
 * @returns {{error?:string,minLen?:number,kind?:string,label?:string,bonus?:number,noteId?:string,reportId?:string}}
 */
function takeMaterial(req, { minLen, kind, fundCode, adoptionId }) {
  const body = req.body || {};
  const reportId = String(body.report_id || '').trim();
  if (reportId) {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
    if (!r || r.user_id !== req.user.id) return { error: 'bad_report' };
    if (fundCode && !r.fund_code) {
      // 没关联基金的报告，顺手挂到被投喂的这只鸡上
      const adoption = getAdoption(req.user.id, fundCode);
      db.prepare('UPDATE reports SET fund_code = ?, adoption_id = ? WHERE id = ?').run(
        fundCode,
        (adoption || {}).id || null,
        r.id
      );
    }
    return {
      kind: 'report',
      reportId: r.id,
      reportTitle: r.title,
      label: `报告《${r.title}》`,
      bonus: kind === 'mood' ? 2 : 5,
    };
  }

  const content = String(body.note || '').trim().replace(/\s+/g, ' ');
  if (countChars(content) < minLen) return { error: 'need_material', minLen };
  const noteId = gid('nt');
  db.prepare(
    'INSERT INTO notes (id, user_id, adoption_id, fund_code, kind, content, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(noteId, req.user.id, adoptionId || null, fundCode || null, kind, content.slice(0, 2000), null, nowISO());
  return {
    kind: 'note',
    noteId,
    label: kind === 'mood' ? '心态笔记' : '投资心得',
    bonus: kind === 'mood' ? 1 : 3,
  };
}

/** 我的心得列表（可按基金过滤） */
router.get('/notes', auth.requireAuth, (req, res) => {
  const code = String(req.query.code || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = code
    ? db
        .prepare('SELECT * FROM notes WHERE user_id = ? AND fund_code = ? ORDER BY created_at DESC LIMIT ?')
        .all(req.user.id, code, limit)
    : db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.id, limit);
  res.json({ ok: true, items: rows.map(publicNote), count: rows.length });
});

/** 写一条投资心得 */
router.post('/notes', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const content = String(body.content || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (countChars(content) < 10) return res.status(400).json({ error: 'note_too_short', minLen: 10 });
  const code = String(body.fund_code || '').trim();
  if (code && !CODE_RE.test(code)) return res.status(400).json({ error: 'bad_fund_code' });
  const adoption = code ? getAdoption(req.user.id, code) : null;
  const noteId = gid('nt');
  // 写心得也是饲料来源，但每天最多计 5 条，避免复制粘贴刷经验
  const todayNotes = db
    .prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND substr(created_at, 1, 10) = ?')
    .get(req.user.id, today()).n;
  const feedGain = todayNotes < 5 ? FEED_REWARD.note : 0;
  db.prepare(
    'INSERT INTO notes (id, user_id, adoption_id, fund_code, kind, content, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(noteId, req.user.id, (adoption || {}).id || null, code || null, 'note', content.slice(0, 2000), null, nowISO());
  const feed = feedGain ? addFeed(req.user.id, feedGain, `写心得${code ? '（' + code + '）' : ''}`) : null;
  const rewarded = tasks.bump(req.user.id, 'note_1', 1);
  diary(req.user.id, 'report', `写下了投资心得${code ? '（' + code + '）' : ''}`, (adoption || {}).id || null);
  res.status(201).json({
    ok: true,
    note: publicNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId)),
    feed,
    feedGain,
    rewarded,
  });
});

router.delete('/notes/:id', auth.requireAuth, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!n || n.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

/* ============================ 互动 ============================ */

router.post('/chickens/:id/interact', auth.requireAuth, (req, res) => {
  const action = String((req.body || {}).action || '');
  if (!['feed', 'pat'].includes(action)) return res.status(400).json({ error: 'bad_action' });

  const pre = chickenEngine.checkCooldown(req.params.id, action, req.user.id);
  if (pre.error) {
    const code = { not_found: 404, cooldown: 429 }[pre.error] || 400;
    return res.status(code).json({ error: pre.error, leftMin: pre.leftMin });
  }
  const chicken = pre.chicken;

  // 喂食 / 安抚必须附一份投研素材：报告 或 心得
  const mat = takeMaterial(req, {
    minLen: NOTE_MIN[action],
    kind: action === 'feed' ? 'feed' : 'mood',
    fundCode: chicken.fund_code,
    adoptionId: chicken.adoption_id,
  });
  if (mat.error) return res.status(400).json({ error: mat.error, minLen: mat.minLen });

  const out = chickenEngine.interact(req.params.id, action, req.user.id, mat);
  if (out.error) {
    const code = { not_found: 404, cooldown: 429, no_feed: 400, bad_action: 400 }[out.error] || 400;
    return res.status(code).json({ error: out.error, leftMin: out.leftMin });
  }

  const name = chicken.nickname || chicken.fund_code;
  if (action === 'feed') {
    tasks.bump(req.user.id, 'feed_3', 1);
    diary(req.user.id, 'care', `给 ${name} 加餐：${mat.label}`, chicken.adoption_id);
  } else {
    diary(req.user.id, 'care', `安抚了 ${name}：记下一条 ${mat.label}`, chicken.adoption_id);
    const worst = db
      .prepare(
        `SELECT a.fund_code FROM adoptions a JOIN daily_events e ON e.adoption_id = a.id
         WHERE a.user_id = ? AND e.date = ? ORDER BY e.pct ASC LIMIT 1`
      )
      .get(req.user.id, today());
    if (worst && worst.fund_code === chicken.fund_code) tasks.bump(req.user.id, 'pat_sad', 1);
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

/** 按类型 / 业绩排序筛选基金（领养弹窗的「按类型挑」） */
router.get('/explore', auth.requireAuth, async (req, res) => {
  try {
    const data = await quote.explore({
      type: String(req.query.type || 'all'),
      sort: String(req.query.sort || '1nzf'),
      page: req.query.page,
      size: req.query.size,
      cat: String(req.query.cat || ''),
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(502).json({ error: 'explore_failed', message: String(err.message || err) });
  }
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
  const fund = r.fund_code
    ? db.prepare('SELECT name, type FROM funds WHERE code = ?').get(r.fund_code)
    : null;
  const adopted = r.fund_code
    ? !!db
        .prepare('SELECT 1 FROM adoptions WHERE user_id = ? AND fund_code = ? AND released_at IS NULL')
        .get(r.user_id, r.fund_code)
    : false;
  return {
    id: r.id,
    fundCode: r.fund_code || '',
    fundName: fund ? fund.name : null,
    fundType: fund ? fund.type : null,
    linked: !!(r.fund_code && fund),
    adopted,
    title: r.title,
    source: r.source,
    contentType: r.content_type || 'text',
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
    if (['.md', '.markdown', '.txt', '.csv', '.html', '.htm'].includes(ext)) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (e) {
    /* ignore */
  }
  return '';
}

/**
 * 判定报告内容类型：text / markdown / html / file
 * 优先级：显式 content_type > 文件扩展名 > 内容嗅探
 */
function detectContentType(body, fileName, content, hasFile) {
  const explicit = String(body.content_type || '').trim().toLowerCase();
  if (['html', 'markdown', 'text', 'file'].includes(explicit)) return explicit;
  const ext = fileName ? path.extname(fileName).toLowerCase() : '';
  if (['.html', '.htm'].includes(ext)) return 'html';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (['.txt', '.csv'].includes(ext)) return 'text';
  if (hasFile) return 'file';
  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(String(content || ''))) return 'html';
  return 'markdown';
}

router.get('/funds/:code/reports', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM reports WHERE user_id = ? AND fund_code = ? ORDER BY created_at DESC')
    .all(req.user.id, req.params.code);
  res.json({ items: rows.map(publicReport) });
});

/**
 * 饲料 = 经验值：只有真实产出（上传报告 / 写心得）才增加，
 * 签到 / 领养 / 任务不再白送，喂食也不消耗。
 */
const FEED_REWARD = { report: 20, note: 8 };
function addFeed(userId, delta, reason) {
  if (!delta) return null;
  db.prepare('UPDATE users SET feed = feed + ? WHERE id = ?').run(delta, userId);
  db.prepare('INSERT INTO feed_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    gid('fl'),
    userId,
    delta,
    reason,
    nowISO()
  );
  const row = db.prepare('SELECT feed FROM users WHERE id = ?').get(userId);
  return row ? row.feed : null;
}

/** 创建报告（/funds/:code/reports 与 /reports 共用；fund_code 可为空表示暂不关联） */
function createReportHandler(resolveFundCode) {
  return (req, res) => {
    req.reportId = gid('rpt');
    upload.single('file')(req, res, async (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(code).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed', message: err.message });
    }
    try {
      const fundCode = String(resolveFundCode(req) || '').trim();
      if (fundCode && !CODE_RE.test(fundCode)) return res.status(400).json({ error: 'bad_fund_code' });
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
      const contentType = detectContentType(body, fileName, text, !!req.file);
      db.prepare(
        `INSERT INTO reports (id, user_id, adoption_id, fund_code, title, source, report_date, tags,
           file_name, file_path, mime, size, content, content_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        reportId,
        req.user.id,
        (getAdoption(req.user.id, fundCode) || {}).id || null,
        fundCode,
        title,
        body.source || (req.file ? 'user' : contentType === 'html' ? 'ai-html' : 'text'),
        body.report_date ? String(body.report_date).slice(0, 10) : today(),
        tags,
        fileName,
        filePath,
        mime,
        size,
        text ? text.slice(0, 200000) : null,
        contentType,
        wantParse ? 'parsing' : 'done',
        nowISO()
      );

      diary(req.user.id, 'report', `上传了报告《${title}》`, null);
      tasks.bump(req.user.id, 'read_report', 1);
      // 待办「传一份研报」要求挂到具体持仓基金上
      if (fundCode) tasks.bump(req.user.id, 'report_1', 1);
      // 上传报告是饲料（经验值）的主要来源
      const feed = addFeed(req.user.id, FEED_REWARD.report, `上传报告《${title}》`);
      const achs = achEngine.check(req.user.id, {});

      const report = publicReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId));
      res.status(201).json({ ok: true, report, feed, feedGain: FEED_REWARD.report, newAchievements: achs });

      if (wantParse && text) {
        parseInBackground(reportId, text, req.user.id, fundCode, contentType);
      } else if (wantParse && !text) {
        db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('done', reportId);
      }
    } catch (e) {
      res.status(500).json({ error: 'upload_failed', message: String(e.message || e) });
    }
    });
  };
}

router.post('/funds/:code/reports', auth.requireAuth, createReportHandler((req) => req.params.code));
router.post('/reports', auth.requireAuth, createReportHandler((req) => (req.body || {}).fund_code));

/** 全部报告列表（支持按基金/状态/未关联/关键词筛选） */
router.get('/reports', auth.requireAuth, (req, res) => {
  const { fundCode, status, link, q } = req.query;
  const where = ['r.user_id = ?'];
  const params = [req.user.id];
  if (fundCode) {
    where.push('r.fund_code = ?');
    params.push(String(fundCode));
  }
  if (status && ['done', 'parsing', 'pending', 'failed'].includes(String(status))) {
    where.push('r.status = ?');
    params.push(String(status));
  }
  if (link === 'none') where.push("(r.fund_code IS NULL OR r.fund_code = '')");
  if (link === 'linked') where.push("r.fund_code IS NOT NULL AND r.fund_code != ''");
  if (q) {
    where.push('(r.title LIKE ? OR r.fund_code LIKE ? OR f.name LIKE ?)');
    const like = `%${String(q).slice(0, 40)}%`;
    params.push(like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT r.*, f.name AS fund_name FROM reports r
       LEFT JOIN funds f ON f.code = r.fund_code
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC LIMIT 200`
    )
    .all(...params);
  res.json({
    items: rows.map((r) => publicReport(r)),
    count: rows.length,
    stats: {
      total: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ?').get(req.user.id).n,
      done: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND status = 'done'").get(req.user.id).n,
      parsing: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND status = 'parsing'").get(req.user.id).n,
      unlinked: db
        .prepare("SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND (fund_code IS NULL OR fund_code = '')")
        .get(req.user.id).n,
    },
  });
});

/** 修改报告：改标题/日期/标签，或关联（改挂）到某只基金 */
router.patch('/reports/:id', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  let fundCode = r.fund_code;
  if (body.fund_code !== undefined) {
    const fc = String(body.fund_code || '').trim();
    if (fc && !CODE_RE.test(fc)) return res.status(400).json({ error: 'bad_fund_code' });
    fundCode = fc;
  }
  const adoption = fundCode ? getAdoption(req.user.id, fundCode) : null;
  const tags =
    body.tags !== undefined
      ? String(body.tags)
          .split(/[,，\s]+/)
          .filter(Boolean)
          .slice(0, 8)
          .join(',')
      : r.tags;
  db.prepare(
    `UPDATE reports SET title = ?, report_date = ?, tags = ?, fund_code = ?, adoption_id = ? WHERE id = ?`
  ).run(
    body.title !== undefined ? String(body.title).slice(0, 120) || r.title : r.title,
    body.report_date !== undefined ? String(body.report_date).slice(0, 10) : r.report_date,
    tags,
    fundCode,
    (adoption || {}).id || null,
    r.id
  );
  if (fundCode && fundCode !== r.fund_code) {
    diary(req.user.id, 'report', `报告《${body.title || r.title}》已关联到 ${fundCode}`, null);
  }
  res.json({ ok: true, report: publicReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(r.id)) });
});

/** 去标签：AI 解析的输入与输出都不该带 HTML 标签（HTML 报告解析后会变成一堆尖括号） */
function stripTags(s) {
  return String(s || '')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function parseInBackground(reportId, text, userId, fundCode, contentType) {
  try {
    const fund = db.prepare('SELECT name FROM funds WHERE code = ?').get(fundCode);
    const input = contentType === 'html' ? stripTags(text) : text;
    const result = await ai.parseReport(input, fund?.name || fundCode, userId);
    db.prepare(
      `INSERT OR REPLACE INTO report_parses (report_id, summary, key_points, risks, sentiment, rating, confidence, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reportId,
      stripTags(result.summary),
      JSON.stringify((result.key_points || []).map((k) => stripTags(k)).filter(Boolean)),
      JSON.stringify((result.risks || []).map((k) => stripTags(k)).filter(Boolean)),
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

/** 直接整屏打开 HTML 报告时，缺 viewport 会导致手机上缩得很小，这里补一个 */
function withViewportMeta(html) {
  if (/<meta\s+name=["']viewport["']/i.test(String(html || ''))) return html;
  const headIdx = String(html).search(/<head[^>]*>/i);
  if (headIdx === -1) return html;
  const end = String(html).indexOf('>', headIdx) + 1;
  return (
    String(html).slice(0, end) +
    '\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    String(html).slice(end)
  );
}

/**
 * 报告原文：HTML 报告直接整屏打开（浏览器新标签），也可在 sandbox iframe 中预览。
 * 安全：响应头带严格 CSP（default-src 'none'，仅允许内联样式与 data: 图片），
 * 脚本不会执行、外链资源不会加载。
 */
router.get('/reports/:id/raw', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (!r.content) return res.status(404).json({ error: 'no_content' });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
  );
  const type = r.content_type || 'text';
  if (type === 'html') return res.type('text/html; charset=utf-8').send(withViewportMeta(r.content));
  return res.type('text/plain; charset=utf-8').send(r.content);
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
  parseInBackground(r.id, r.content, req.user.id, r.fund_code, r.content_type);
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

/** 构造给 AI 的调用提示词：html（默认，重点支持）/ markdown */
function buildAiPrompt(base, code, fundName, format) {
  const name = fundName || '（基金名称）';
  const target = code || '{基金代码}';
  const head = `你现在是「养基场」的基金研究助手。目标基金：${name}（代码 ${target}）。`;

  const apiSection = `
完成后，调用养基场开放接口把报告写回用户的项目（需要用户已授权的 API Key）：

POST ${base}/api/v1/funds/${target}/reports
Headers:
  Authorization: Bearer {API_KEY}
  Content-Type: application/json
Body:
{
  "title": "<报告标题>",
  "report_date": "<YYYY-MM-DD>",
  "tags": ["AI生成"${format === 'html' ? ', "HTML"' : ''}],
  "content_type": "${format === 'html' ? 'html' : 'markdown'}",
  "content": "<报告正文>",
  "parse": true
}

其他可用接口：
- GET  ${base}/api/v1/search?q=<关键词>        查询基金代码
- GET  ${base}/api/v1/funds                    查看用户自选基金列表
- POST ${base}/api/v1/reports                  上传报告（fund_code 可选，为空表示暂不关联）
- GET  ${base}/api/v1/reports                  报告库列表
- GET  ${base}/api/v1/reports/{id}/raw         读取报告原文（HTML 报告以 text/html 返回）
- 也支持 multipart/form-data 直接上传文件：字段 file = 报告.html，fund_code = ${target}

API Key 由用户在「养基场 → 我的 → 开发者 API Key」生成（fa_ 前缀），请让用户提供。
若调用失败：401 = Key 无效，403 = 无权限，413 = 文件超过 20MB。`;

  if (format === 'markdown') {
    return `${head}

任务：
1. 检索并阅读该基金最近一期季报/年报、近期净值表现、基金经理观点、行业动态。
2. 输出一份不超过 800 字的分析报告，使用 Markdown，结构如下：
   - 一、业绩回顾（近 1 月 / 近 1 年 / 同类排名）
   - 二、持仓与风格变化
   - 三、关键风险（列 3 条）
   - 四、后续观察指标（列 3 条）
3. 全文不得出现「建议买入/建议卖出/必涨」等投资建议表述，仅陈述事实与数据。
${apiSection}

最后向我回复：报告已写入，并附 3 条要点摘要与查看地址 ${base}/#/reports`;
  }

  return `${head}

任务：
1. 检索并阅读该基金最近一期季报/年报、近期净值表现、基金经理观点、行业动态。
2. 生成一份**自包含的 HTML 报告**（本平台重点支持 HTML 格式）：
   - 单个 HTML 文档，样式写在 <style> 内联标签中；**不得引用外部 CDN / 外链图片 / 外部字体**；**不得包含 <script> 标签**（脚本会被沙箱拦截且不允许）
   - 移动端友好：内容区 max-width 720px 居中、字号 14-16px、行高 1.6、表格可横向滚动
   - 建议结构：标题区（基金名称 + 代码 + 报告日期）→ 一、业绩回顾 → 二、持仓与风格变化 → 三、关键风险（3 条）→ 四、后续观察指标（3 条）
   - 用表格 / 卡片 / 色块呈现数据，主色建议 #4CAF50，风险项可用 #E6503A，涨用 #E6503A、跌用 #2BA471
   - 结尾附一行小字：本报告由 AI 生成，仅供参考，不构成投资建议
   - 全文不得出现「建议买入 / 建议卖出 / 必涨 / 推荐」等投资建议表述，仅陈述事实与数据
3. 把生成的 HTML 原文（完整字符串）作为 content 字段提交，不要做 HTML 实体转义。
${apiSection}

最后向我回复：报告已写入，并附 3 条要点摘要与查看地址 ${base}/#/reports`;
}

router.get('/ai-prompt', auth.requireAuth, async (req, res) => {
  const code = String(req.query.code || '').trim();
  const format = String(req.query.format || 'html').toLowerCase() === 'markdown' ? 'markdown' : 'html';
  const fund = code ? await quote.getFundInfo(code) : null;
  const base = siteBase(req);
  const prompt = buildAiPrompt(base, code, fund?.name, format);
  res.json({
    prompt,
    format,
    base,
    fundCode: code,
    fundName: fund?.name || null,
    endpoints: [
      'POST /api/v1/funds/{code}/reports',
      'POST /api/v1/reports',
      'GET /api/v1/reports',
      'GET /api/v1/reports/{id}/raw',
      'GET /api/v1/search?q=',
    ],
  });
});

/* ============================ 成就 / 我的 ============================ */

router.get('/achievements', auth.requireAuth, (req, res) => {
  const items = achEngine.list(req.user.id).map((a) => {
    const p = achEngine.progressFor(req.user.id, a.code);
    return { ...a, progress: p };
  });
  res.json({ items, unlocked: items.filter((i) => i.unlocked).length, total: items.length });
});

/**
 * 每日签到已下线：饲料是「经验值」，不能靠每天点一下就白拿，
 * 只保留上传报告 / 写心得两个真实产出渠道。
 */
router.get('/me/checkin', auth.requireAuth, (req, res) => {
  res.status(410).json({
    error: 'checkin_removed',
    message: '签到已下线，饲料改为靠上传报告（+20）或写心得（+8）获得',
  });
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

/**
 * 养基等级：按「已建仓持仓」的累计收益率定级（不看成长值 / 陪伴时长）。
 * 净值取本地 nav_history，避免每次打开「我的」都打第三方接口。
 */
router.get('/me/level', auth.requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT fund_code, cost_price, shares FROM adoptions
       WHERE user_id = ? AND released_at IS NULL AND cost_price > 0 AND shares > 0`
    )
    .all(req.user.id);
  let cost = 0;
  let value = 0;
  let priced = 0;
  for (const r of rows) {
    const nav = quote.latestLocalNav(r.fund_code);
    if (!nav || !nav.nav) continue;
    cost += Number(r.cost_price) * Number(r.shares);
    value += Number(nav.nav) * Number(r.shares);
    priced++;
  }
  const profit = priced && cost ? value - cost : null;
  const profitRate = cost ? (profit / cost) * 100 : null;
  res.json({
    ok: true,
    positions: rows.length,
    priced,
    cost: round(cost, 2),
    marketValue: round(value, 2),
    profit: profit === null ? null : round(profit, 2),
    profitRate: profitRate === null ? null : round(profitRate, 2),
    level: levelEngine.levelOf(profitRate),
    tiers: levelEngine.TIERS.map((t) => ({ key: t.key, name: t.name, emoji: t.emoji, min: t.min, max: t.max })),
  });
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

  const gmap = new Map(groups.map((g) => [g.id, g.name]));
  const csvCell = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const round2 = (v) => (v === null || v === undefined || !isFinite(v) ? '' : Math.round(v * 100) / 100);

  if (req.query.format === 'csv') {
    const header = '基金代码,昵称,分组,成本价,份额,首次买入,领养时间\n';
    const body = adoptions
      .map((a) =>
        [a.fund_code, a.nickname || '', gmap.get(a.group_id) || '', a.cost_price ?? '', a.shares ?? '', a.first_buy_date || '', a.adopted_at]
          .map(csvCell)
          .join(',')
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fundfarm.csv"');
    return res.send('\uFEFF' + header + body);
  }

  /**
   * 持仓明细 CSV：带最新净值、市值、浮动盈亏、收益率、今日涨跌、持有天数，
   * 可直接丢进 Excel 做二次分析（净值取本地 nav_history，不依赖第三方接口实时可用）。
   */
  if (req.query.format === 'holdings') {
    const fundRows = db.prepare('SELECT code, name, category, type FROM funds').all();
    const fundMap = new Map(fundRows.map((f) => [f.code, f]));
    const navStmt = db.prepare('SELECT date, nav FROM nav_history WHERE code = ? ORDER BY date DESC LIMIT 2');
    const header = [
      '基金代码',
      '基金名称',
      '昵称',
      '分类',
      '分组',
      '成本价',
      '份额',
      '成本金额',
      '最新净值',
      '净值日期',
      '持仓市值',
      '浮动盈亏',
      '收益率(%)',
      '今日涨跌(%)',
      '持有天数',
      '建仓日',
    ].join(',');
    const lines = adoptions.map((a) => {
      const f = fundMap.get(a.fund_code) || {};
      const navs = navStmt.all(a.fund_code);
      const nav = navs[0] ? Number(navs[0].nav) : null;
      const prev = navs[1] ? Number(navs[1].nav) : null;
      const dayPct = nav && prev ? ((nav - prev) / prev) * 100 : null;
      const shares = a.shares ? Number(a.shares) : null;
      const cost = a.cost_price && shares ? Number(a.cost_price) * shares : null;
      const mv = nav && shares ? nav * shares : null;
      const profit = cost !== null && mv !== null ? mv - cost : null;
      const rate = cost ? (profit / cost) * 100 : null;
      const start = a.first_buy_date || (a.adopted_at || '').slice(0, 10);
      const days = start ? Math.max(0, Math.round((Date.now() - Date.parse(start)) / 864e5)) : '';
      return [
        a.fund_code,
        f.name || '',
        a.nickname || '',
        f.category || f.type || '',
        gmap.get(a.group_id) || '',
        a.cost_price ?? '',
        a.shares ?? '',
        round2(cost),
        nav ?? '',
        navs[0] ? navs[0].date : '',
        round2(mv),
        round2(profit),
        round2(rate),
        round2(dayPct),
        days,
        start,
      ]
        .map(csvCell)
        .join(',');
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fundfarm-holdings-${today()}.csv"`);
    return res.send('\uFEFF' + header + '\n' + lines.join('\n'));
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
      { method: 'GET', path: '/reports/{id}/raw', desc: '报告原文（HTML 报告以 text/html 返回，带 CSP）' },
      { method: 'PATCH', path: '/reports/{id}', desc: '修改报告或关联到某只基金' },
      { method: 'DELETE', path: '/reports/{id}', desc: '删除报告' },
      { method: 'GET', path: '/notes', desc: '投资心得 / 投研笔记列表' },
      { method: 'POST', path: '/notes', desc: '写一条投资心得（content ≥ 10 字）' },
      { method: 'POST', path: '/chickens/{id}/interact', desc: '喂食 / 安抚（必须附 report_id 或 note）' },
      { method: 'GET', path: '/achievements', desc: '成就与解锁状态' },
    ],
    disclaimer: '数据来自第三方公开接口，可能存在延迟或误差；本工具不构成投资建议。',
  });
});

module.exports = router;
