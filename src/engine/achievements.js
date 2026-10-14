'use strict';

const db = require('../db');
const { today, nowISO, daysBetween } = require('../util');
const { holdingDays } = require('./chicken');

const q = {
  activeAdoptions: db.prepare('SELECT COUNT(*) AS n FROM adoptions WHERE user_id = ? AND released_at IS NULL'),
  breeds: db.prepare(
    `SELECT COUNT(DISTINCT f.type) AS n FROM adoptions a
     JOIN funds f ON f.code = a.fund_code
     WHERE a.user_id = ? AND a.released_at IS NULL AND f.type IS NOT NULL`
  ),
  adoptedFunds: db.prepare(
    `SELECT a.*, f.type FROM adoptions a LEFT JOIN funds f ON f.code = a.fund_code
     WHERE a.user_id = ? AND a.released_at IS NULL`
  ),
  chickens: db.prepare(
    `SELECT c.* FROM chickens c JOIN adoptions a ON a.id = c.adoption_id
     WHERE a.user_id = ? AND a.released_at IS NULL`
  ),
  reportCount: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ?'),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
};

function unlock(userId, code) {
  const exists = db.prepare('SELECT 1 FROM user_achievements WHERE user_id = ? AND code = ?').get(userId, code);
  if (exists) return null;
  const ach = db.prepare('SELECT * FROM achievements WHERE code = ?').get(code);
  if (!ach) return null;
  db.prepare('INSERT INTO user_achievements (user_id, code, unlocked_at) VALUES (?, ?, ?)').run(
    userId,
    code,
    nowISO()
  );
  db.prepare('UPDATE users SET feed = feed + ? WHERE id = ?').run(ach.reward, userId);
  db.prepare(
    'INSERT INTO feed_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('fl_' + Math.random().toString(36).slice(2, 11), userId, ach.reward, '成就：' + ach.name, nowISO());
  db.prepare(
    'INSERT INTO diary (id, user_id, adoption_id, date, type, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'dr_' + Math.random().toString(36).slice(2, 11),
    userId,
    null,
    today(),
    'achievement',
    `解锁成就「${ach.name}」：${ach.desc}`,
    nowISO()
  );
  return ach;
}

/**
 * 成就检测。可传入上下文 { hour, profitRates: {adoptionId: rate} }
 * @returns {Array} 本次新解锁的成就
 */
function check(userId, ctx = {}) {
  const unlocked = [];
  const tryUnlock = (code) => {
    const a = unlock(userId, code);
    if (a) unlocked.push(a);
  };

  const adoptCount = q.activeAdoptions.get(userId).n;
  if (adoptCount >= 1) tryUnlock('first_adopt');
  if (adoptCount >= 10) tryUnlock('yard_10');
  if (q.breeds.get(userId).n >= 5) tryUnlock('breed_all');

  const user = q.user.get(userId);
  if (user && user.checkin_streak >= 7) tryUnlock('checkin_7');

  const adoptions = q.adoptedFunds.all(userId);
  let maxDays = 0;
  for (const a of adoptions) maxDays = Math.max(maxDays, holdingDays(a));
  if (maxDays >= 100) tryUnlock('hold_100');
  if (maxDays >= 365) tryUnlock('hold_365');

  const chickens = q.chickens.all(userId);
  let maxLevel = 0;
  let totalEggs = 0;
  const rates = ctx.profitRates || {};
  for (const c of chickens) {
    maxLevel = Math.max(maxLevel, c.level);
    totalEggs += c.eggs;
    const rate = rates[c.adoption_id];
    if (typeof rate === 'number') {
      if (c.min_profit <= -15 && rate >= 0) tryUnlock('storm_together');
      if (c.min_profit <= -1 && rate > 0) tryUnlock('turn_profit');
    }
  }
  if (maxLevel >= 3) tryUnlock('level_3');
  if (maxLevel >= 5) tryUnlock('level_5');
  if (totalEggs >= 100) tryUnlock('egg_100');

  if (user && user.total_interact >= 50) tryUnlock('interact_50');

  const reports = q.reportCount.get(userId).n;
  if (reports >= 1) tryUnlock('report_1');
  if (reports >= 10) tryUnlock('report_10');

  if (user && user.last_adopt_at && adoptCount > 0) {
    const d = daysBetween(user.last_adopt_at.slice(0, 10), today());
    if (d >= 30) tryUnlock('steady_30');
  }

  if (typeof ctx.hour === 'number') {
    if (ctx.hour >= 1 && ctx.hour < 5) tryUnlock('night_owl');
    if (ctx.hour < 7 && ctx.event === 'checkin') tryUnlock('early_bird');
  }

  return unlocked;
}

function list(userId) {
  const rows = db.prepare('SELECT * FROM achievements ORDER BY category, reward').all();
  const owned = new Set(
    db
      .prepare('SELECT code FROM user_achievements WHERE user_id = ?')
      .all(userId)
      .map((r) => r.code)
  );
  return rows.map((a) => ({ ...a, unlocked: owned.has(a.code) }));
}

function progressFor(userId, code) {
  const user = q.user.get(userId);
  switch (code) {
    case 'first_adopt':
    case 'yard_10':
      return { current: q.activeAdoptions.get(userId).n, target: code === 'first_adopt' ? 1 : 10 };
    case 'breed_all':
      return { current: q.breeds.get(userId).n, target: 5 };
    case 'checkin_7':
      return { current: user?.checkin_streak || 0, target: 7 };
    case 'report_1':
      return { current: Math.min(q.reportCount.get(userId).n, 1), target: 1 };
    case 'report_10':
      return { current: q.reportCount.get(userId).n, target: 10 };
    case 'interact_50':
      return { current: user?.total_interact || 0, target: 50 };
    case 'level_3':
    case 'level_5': {
      const max = q.chickens.all(userId).reduce((m, c) => Math.max(m, c.level), 0);
      return { current: max, target: code === 'level_3' ? 3 : 5 };
    }
    case 'egg_100': {
      const eggs = q.chickens.all(userId).reduce((s, c) => s + c.eggs, 0);
      return { current: eggs, target: 100 };
    }
    case 'hold_100':
    case 'hold_365': {
      const max = q.adoptedFunds.all(userId).reduce((m, a) => Math.max(m, holdingDays(a)), 0);
      return { current: max, target: code === 'hold_100' ? 100 : 365 };
    }
    default:
      return null;
  }
}

module.exports = { check, list, unlock, progressFor };
