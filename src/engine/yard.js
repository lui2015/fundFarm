'use strict';

const db = require('../db');
const quote = require('../quote');
const chickenEngine = require('./chicken');
const achEngine = require('./achievements');
const tasks = require('./tasks');
const { today, nowISO, round, daysBetween } = require('../util');

const ADOPT_SQL = `
  SELECT a.*, f.name AS fund_name, f.type AS fund_type, f.company, f.manager, f.established, f.scale,
         g.name AS group_name, c.id AS chicken_id
  FROM adoptions a
  LEFT JOIN funds f ON f.code = a.fund_code
  LEFT JOIN groups g ON g.id = a.group_id
  LEFT JOIN chickens c ON c.adoption_id = a.id
  WHERE a.user_id = ? AND a.released_at IS NULL
  ORDER BY a.sort ASC, a.adopted_at ASC
`;

function lastLocalPct(code) {
  const row = db.prepare('SELECT pct FROM nav_history WHERE code = ? ORDER BY date DESC LIMIT 1').get(code);
  return row ? row.pct : null;
}

/**
 * 构建用户的鸡群数据（含行情、盈亏、鸡状态），并结算当日事件。
 */
async function buildAdoptions(userId) {
  chickenEngine.decayAll(userId);
  const rows = db.prepare(ADOPT_SQL).all(userId);
  const codes = rows.map((r) => r.fund_code);

  // 预热历史净值：仅对本地无缓存的基金，且一次最多 10 只（保证首屏速度）
  const missing = codes.filter((c) => !quote.latestLocalNav(c)).slice(0, 10);
  if (missing.length) await Promise.all(missing.map((c) => quote.getHistory(c, 30).catch(() => null)));

  const quotes = await quote.getEstimates(codes);

  const items = [];
  const profitRates = {};
  for (const r of rows) {
    const q = quotes[r.fund_code] || null;
    const localNav = quote.latestLocalNav(r.fund_code);
    const pct = q ? q.pct : lastLocalPct(r.fund_code);
    const currentValue = q ? q.estimate || q.nav : localNav ? localNav.nav : null;

    let profit = null;
    let profitRate = null;
    let marketValue = null;
    if (r.cost_price && r.shares && currentValue) {
      marketValue = r.shares * currentValue;
      profit = marketValue - r.shares * r.cost_price;
      profitRate = (profit / (r.shares * r.cost_price)) * 100;
      profitRates[r.chicken_id] = profitRate;
    }

    const adoption = { id: r.id, fund_code: r.fund_code, nickname: r.nickname };
    if (typeof pct === 'number') {
      chickenEngine.applyDailyEvent(adoption, pct, profitRate);
    }

    const c = chickenEngine.getChicken(r.id);
    const holdDays = chickenEngine.holdingDays(r);
    const fundName = r.fund_name || q?.name || r.fund_code;
    const ftype = r.fund_type || (q?.name ? null : null);

    items.push({
      adoptionId: r.id,
      fundCode: r.fund_code,
      name: fundName,
      type: ftype || null,
      company: r.company || null,
      manager: r.manager || null,
      nickname: r.nickname || fundName,
      groupId: r.group_id,
      groupName: r.group_name || '未分组',
      costPrice: r.cost_price,
      shares: r.shares,
      firstBuyDate: r.first_buy_date,
      adoptedAt: r.adopted_at,
      holdingDays: holdDays,
      quote: q
        ? {
            nav: q.nav,
            navDate: q.navDate,
            estimate: q.estimate,
            pct: round(q.pct, 2),
            estimateTime: q.estimateTime,
            live: q.live !== false,
            updatedAt: q.updatedAt,
          }
        : { nav: null, estimate: null, pct: lastLocalPct(r.fund_code), live: false, updatedAt: null },
      marketValue: marketValue ? round(marketValue, 2) : null,
      profit: profit === null ? null : round(profit, 2),
      profitRate: profitRate === null ? null : round(profitRate, 2),
      todayPct: typeof pct === 'number' ? round(pct, 2) : null,
      chicken: c ? chickenEngine.publicChicken(c) : null,
    });
  }
  return { items, profitRates };
}

function summarize(items) {
  let cost = 0;
  let value = 0;
  let weightedPct = 0;
  let weightSum = 0;
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const it of items) {
    if (it.marketValue !== null) {
      value += it.marketValue;
      cost += (it.shares || 0) * (it.costPrice || 0);
    }
    if (typeof it.todayPct === 'number') {
      const w = it.marketValue || 1;
      weightedPct += it.todayPct * w;
      weightSum += w;
      if (it.todayPct > 0) up++;
      else if (it.todayPct < 0) down++;
      else flat++;
    }
  }
  const profit = value && cost ? value - cost : null;
  return {
    marketValue: round(value, 2) || null,
    cost: round(cost, 2) || null,
    profit: profit === null ? null : round(profit, 2),
    profitRate: profit === null || !cost ? null : round((profit / cost) * 100, 2),
    todayPct: weightSum ? round(weightedPct / weightSum, 2) : null,
    up,
    down,
    flat,
    total: items.length,
  };
}

async function buildYard(userId, options = {}) {
  const { items, profitRates } = await buildAdoptions(userId);
  const indices = await quote.getIndices();
  const mainIdx = indices.items?.[0] || null;
  const weather = quote.weatherOf(mainIdx ? mainIdx.pct : 0);

  // 天气影响全体心情（每天仅结算一次）
  const date = today();
  const weatherApplied = db
    .prepare('SELECT 1 FROM diary WHERE user_id = ? AND date = ? AND type = ?')
    .get(userId, date, 'weather');
  if (!weatherApplied && weather.moodDelta !== 0 && items.length) {
    const stmt = db.prepare('UPDATE chickens SET mood = MAX(0, MIN(100, mood + ?)) WHERE adoption_id = ?');
    db.transaction(() => {
      for (const it of items) stmt.run(weather.moodDelta, it.adoptionId);
      db.prepare(
        'INSERT INTO diary (id, user_id, adoption_id, date, type, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('dr_' + Math.random().toString(36).slice(2, 11), userId, null, date, 'weather', `今日鸡舍天气：${weather.label}`, nowISO());
    })();
  }

  const summary = summarize(items);
  const newAchievements = achEngine.check(userId, {
    hour: new Date().getHours(),
    profitRates,
    event: options.event,
  });
  tasks.bump(userId, 'check_yard', 1);
  const taskList = tasks.list(userId);

  const events = db
    .prepare(
      `SELECT e.*, a.nickname, a.fund_code, f.name AS fund_name
       FROM daily_events e
       JOIN adoptions a ON a.id = e.adoption_id
       LEFT JOIN funds f ON f.code = a.fund_code
       WHERE a.user_id = ? AND e.date = ?
       ORDER BY e.created_at DESC`
    )
    .all(userId, date);

  return {
    date,
    weather: { ...weather, index: mainIdx },
    indices: indices.items || [],
    summary,
    items,
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      text: e.text,
      pct: e.pct,
      fundCode: e.fund_code,
      name: e.nickname || e.fund_name || e.fund_code,
      growthDelta: e.growth_delta,
    })),
    tasks: taskList,
    newAchievements,
    reminders: buildReminders(items),
  };
}

function buildReminders(items) {
  const out = [];
  const hungry = items.filter((i) => i.chicken && i.chicken.hungry);
  if (hungry.length) {
    out.push({
      type: 'hungry',
      text: `有 ${hungry.length} 只鸡饿了，快去喂食`,
      codes: hungry.map((i) => i.fundCode),
    });
  }
  const bigDrop = items.filter((i) => typeof i.todayPct === 'number' && i.todayPct <= -3);
  if (bigDrop.length) {
    out.push({
      type: 'drop',
      text: `${bigDrop.map((i) => i.nickname).join('、')} 今天跌超 3%，正在躲雨`,
      codes: bigDrop.map((i) => i.fundCode),
    });
  }
  const sick = items.filter((i) => i.chicken && i.chicken.sick);
  if (sick.length) {
    out.push({ type: 'sick', text: '有鸡情绪低落，摸摸头就能恢复', codes: sick.map((i) => i.fundCode) });
  }
  return out;
}

module.exports = { buildAdoptions, buildYard, summarize };
