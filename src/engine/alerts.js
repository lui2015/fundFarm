'use strict';

/**
 * 买入 / 卖出价格提醒。
 *
 * 语义：给自己设一个「预期价」——
 * - 买入提醒：现价跌到预期价（现价 ≤ 预期价）算到达，适合等回调加仓；
 * - 卖出提醒：现价涨到预期价（现价 ≥ 预期价）算到达，适合等止盈。
 * 现价优先用实时估值，估值不可用时退回最新净值。
 * 每人每只基金最多 6 条；第一次到达时把 hit_at 落库，方便详情页显示「曾到达」。
 */

const db = require('../db');
const { id: gid, nowISO } = require('../util');

const MAX_ALERTS = 6;
const TYPES = ['buy', 'sell'];

/** 现价：优先实时估值，其次最新净值 */
function priceOf(q) {
  if (!q) return null;
  const est = Number(q.estimate);
  if (Number.isFinite(est) && est > 0) return est;
  const nav = Number(q.nav);
  if (Number.isFinite(nav) && nav > 0) return nav;
  return null;
}

/** 评估一条提醒（纯函数，便于复用） */
function evaluate(row, price) {
  const target = Number(row.price);
  const p = price === null || price === undefined ? NaN : Number(price);
  const valid = Number.isFinite(p) && p > 0 && Number.isFinite(target) && target > 0;
  const triggered = valid ? (row.type === 'buy' ? p <= target : p >= target) : false;
  // gap：还差多少才到达（正数）。买入看还需下跌多少，卖出看还需上涨多少。
  const gap = valid ? Math.abs(row.type === 'buy' ? p - target : target - p) : null;
  return {
    id: row.id,
    type: row.type,
    price: Number(target.toFixed(4)),
    current: valid ? Number(p.toFixed(4)) : null,
    triggered,
    gap: gap === null ? null : Number(gap.toFixed(4)),
    gapPct: gap === null || !valid ? null : Number(((gap / p) * 100).toFixed(2)),
    createdAt: row.created_at,
    hitAt: row.hit_at || null,
  };
}

const markHitSql = 'UPDATE price_alerts SET hit_at = ? WHERE id = ? AND hit_at IS NULL';

/** 某只基金的提醒列表（顺带把首次到达时间落库） */
function list(userId, code, price) {
  const rows = db
    .prepare('SELECT * FROM price_alerts WHERE user_id = ? AND fund_code = ? ORDER BY created_at ASC')
    .all(userId, code);
  const out = rows.map((r) => evaluate(r, price));
  const mark = db.prepare(markHitSql);
  const now = nowISO();
  for (const a of out) {
    if (a.triggered && !a.hitAt) {
      mark.run(now, a.id);
      a.hitAt = now;
    }
  }
  return out;
}

/** 新增提醒；返回 { error } 或 { alert } */
function add(userId, code, type, price) {
  if (!TYPES.includes(type)) return { error: 'bad_type' };
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return { error: 'bad_price' };
  if (p > 100000) return { error: 'bad_price' };
  const n = db.prepare('SELECT COUNT(*) AS n FROM price_alerts WHERE user_id = ? AND fund_code = ?').get(userId, code).n;
  if (n >= MAX_ALERTS) return { error: 'alert_limit', limit: MAX_ALERTS };
  const dup = db
    .prepare('SELECT 1 FROM price_alerts WHERE user_id = ? AND fund_code = ? AND type = ? AND price = ?')
    .get(userId, code, type, p);
  if (dup) return { error: 'alert_exists' };
  const id = gid('alr');
  db.prepare(
    'INSERT INTO price_alerts (id, user_id, fund_code, type, price, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, code, type, Number(p.toFixed(4)), nowISO());
  const row = db.prepare('SELECT * FROM price_alerts WHERE id = ?').get(id);
  return { alert: row };
}

/** 删除提醒（只能删自己的） */
function remove(userId, id) {
  const info = db.prepare('DELETE FROM price_alerts WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

/**
 * 批量判断「哪些基金已到达提醒点」，用于鸡舍卡片角标 / 实时轮询。
 * @param {Record<string, number|null>} priceByCode
 * @returns {Record<string, object>} code -> 第一条已到达的提醒
 */
function triggeredByCode(userId, priceByCode) {
  const rows = db.prepare('SELECT * FROM price_alerts WHERE user_id = ?').all(userId);
  if (!rows.length) return {};
  const out = {};
  const mark = db.prepare(markHitSql);
  const now = nowISO();
  for (const r of rows) {
    const a = evaluate(r, priceByCode[r.fund_code]);
    if (!a.triggered) continue;
    if (!out[r.fund_code]) out[r.fund_code] = a;
    if (!r.hit_at) mark.run(now, r.id);
  }
  return out;
}

module.exports = { MAX_ALERTS, TYPES, priceOf, evaluate, list, add, remove, triggeredByCode };
