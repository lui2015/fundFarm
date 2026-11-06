'use strict';

/**
 * 猜涨跌：猜下一个交易日的 A股大盘 / 港股大盘 / 自己持仓的组合涨跌。
 *
 * 规则：
 * - 每个自然日每类只能猜一次（ UNIQUE(user_id, guess_date, kind) ），目标是下一个交易日；
 * - 结算用真实数据：指数走腾讯日 K（indexKline），持仓组合用 nav_history 里各基金当日涨跌按份额加权；
 * - 目标日遇到节假日自动顺延到下一个实际交易日；北京时间 15:30 之前不结算（避免盘中数据提前定胜负）；
 * - 猜中 +2 饲料，平局 +1，猜错不扣；
 * - 训练家称号由「猜涨跌命中率」与「持仓累计收益率」共同决定（命中率至少 5 次结算才计入）。
 */

const db = require('../db');
const quote = require('../quote');
const { id: gid, nowISO, round } = require('../util');

const KINDS = ['a_share', 'hk_share', 'portfolio'];
const KIND_NAMES = {
  a_share: 'A股大盘（上证指数）',
  hk_share: '港股大盘（恒生指数）',
  portfolio: '我的持仓（组合涨跌）',
};
const INDEX_CODES = { a_share: 'sh000001', hk_share: 'hkHSI' };
const REWARD_WIN = 2;
const REWARD_DRAW = 1;
const MIN_SETTLED_FOR_HIT = 5;

/** 北京时间日历日：YYYY-MM-DD */
function bjDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
}

/** 北京时间 ISO（前 16 位，即 YYYY-MM-DDTHH:mm） */
function bjStamp(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 16);
}

/** 下一个交易日（只跳过周末，节假日靠结算时顺延兜底） */
function nextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** 训练家称号：命中率（≥5 次结算才计入）与持仓收益率共同决定 */
const TIERS = [
  { key: 'rookie', emoji: '🌱', name: '见习训练家', desc: '初来乍到：养好鸡，多猜对几次' },
  { key: 'formal', emoji: '🎖️', name: '正式训练家', desc: '持仓收益率转正，或命中率 ≥55%', rate: 0, hit: 55, any: true },
  { key: 'senior', emoji: '🥈', name: '高级训练家', desc: '收益率 ≥10% 且命中率 ≥60%', rate: 10, hit: 60 },
  { key: 'ace', emoji: '🥇', name: '王牌训练家', desc: '收益率 ≥20% 且命中率 ≥65%', rate: 20, hit: 65 },
  { key: 'master', emoji: '👑', name: '大师训练家', desc: '收益率 ≥30% 且命中率 ≥70%', rate: 30, hit: 70 },
];

function levelOf(hitRate, profitRate, settled) {
  const hit = settled >= MIN_SETTLED_FOR_HIT ? hitRate : 0;
  let cur = TIERS[0];
  for (const t of TIERS) {
    if (t.any) {
      // 正式训练家：收益率转正 或 命中率达标，二者满足其一即可
      if ((profitRate !== null && profitRate > t.rate) || hit >= t.hit) cur = t;
    } else if (profitRate !== null && profitRate >= t.rate && hit >= t.hit) {
      cur = t;
    }
  }
  const next = TIERS[TIERS.indexOf(cur) + 1] || null;
  return {
    key: cur.key,
    emoji: cur.emoji,
    name: cur.name,
    desc: cur.desc,
    hitRate: round(hitRate, 1),
    hitCounted: settled >= MIN_SETTLED_FOR_HIT,
    profitRate: profitRate === null ? null : round(profitRate, 2),
    next: next ? { name: next.name, desc: next.desc } : null,
  };
}

/** 下注：每类每天一次，目标为下一个交易日 */
function place(userId, kind, dir) {
  if (!KINDS.includes(kind)) return { error: 'bad_kind' };
  if (!['up', 'down'].includes(dir)) return { error: 'bad_dir' };
  const guessDate = bjDate();
  const exists = db
    .prepare('SELECT 1 FROM guesses WHERE user_id = ? AND guess_date = ? AND kind = ?')
    .get(userId, guessDate, kind);
  if (exists) return { error: 'already_guessed' };
  const id = gid('gss');
  db.prepare(
    `INSERT INTO guesses (id, user_id, guess_date, target_date, kind, dir, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, guessDate, nextTradingDay(guessDate), kind, dir, nowISO());
  return { guess: db.prepare('SELECT * FROM guesses WHERE id = ?').get(id) };
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

/** 指数结算：目标日（或顺延后的首个交易日）相对前一收盘的涨跌幅；未收盘/无数据返回 null */
async function indexPct(kind, targetDate, nowStamp) {
  let k;
  try {
    k = await quote.indexKline(INDEX_CODES[kind], 45);
  } catch (e) {
    return null;
  }
  const i = k.findIndex((r) => r.date >= targetDate);
  if (i < 1) return null;
  const row = k[i];
  // 只用已收盘的 K 线：历史日必然已收盘；当日必须在 15:30 之后
  if (row.date > bjDate()) return null;
  if (row.date === bjDate() && nowStamp < `${row.date}T15:30`) return null;
  const prev = k[i - 1].close;
  if (!prev) return null;
  return ((row.close - prev) / prev) * 100;
}

/** 持仓组合结算：nav_history 里目标日（顺延到 ≥ 半数持仓有数据的首个日期）按份额加权涨跌 */
function portfolioPct(userId, targetDate, todayStr) {
  const rows = db
    .prepare(
      `SELECT a.fund_code, a.shares FROM adoptions a
       WHERE a.user_id = ? AND a.released_at IS NULL AND a.cost_price > 0 AND a.shares > 0`
    )
    .all(userId);
  if (!rows.length) return { pct: null, needWarm: [] };
  const codes = rows.map((r) => r.fund_code);
  const ph = codes.map(() => '?').join(',');
  const hist = db
    .prepare(
      `SELECT code, date, pct FROM nav_history WHERE code IN (${ph}) AND date >= ? AND date <= ? AND pct IS NOT NULL ORDER BY date ASC`
    )
    .all(...codes, targetDate, todayStr);
  if (!hist.length) return { pct: null, needWarm: codes };
  const byDate = new Map();
  for (const h of hist) {
    if (!byDate.has(h.date)) byDate.set(h.date, []);
    byDate.get(h.date).push(h);
  }
  const half = Math.ceil(codes.length / 2);
  for (const [date, list] of byDate) {
    if (list.length < half) continue;
    let wsum = 0;
    let psum = 0;
    const weight = new Map(rows.map((r) => [r.fund_code, Number(r.shares) || 0]));
    for (const h of list) {
      const w = weight.get(h.code) || 0;
      if (w <= 0) continue;
      wsum += w;
      psum += w * Number(h.pct);
    }
    // nav_history.pct 已经是百分数（如 1.23 = +1.23%），不要再乘 100
    if (wsum > 0) return { pct: psum / wsum, needWarm: [] };
  }
  return { pct: null, needWarm: codes };
}

function applyResult(row, pct, now) {
  let result;
  if (pct > 0) result = row.dir === 'up' ? 'win' : 'lose';
  else if (pct < 0) result = row.dir === 'down' ? 'win' : 'lose';
  else result = 'draw';
  db.prepare('UPDATE guesses SET result = ?, settle_pct = ?, settled_at = ? WHERE id = ? AND result IS NULL').run(
    result,
    round(pct, 4),
    now,
    row.id
  );
  if (result === 'win') addFeed(row.user_id, REWARD_WIN, '猜涨跌命中');
  else if (result === 'draw') addFeed(row.user_id, REWARD_DRAW, '猜涨跌平局');
}

/** 懒结算：把已到时间、且数据可用的未结算猜都结算掉 */
async function settlePending(userId) {
  const nowStamp = bjStamp();
  const todayStr = bjDate();
  const pending = db
    .prepare('SELECT * FROM guesses WHERE user_id = ? AND result IS NULL ORDER BY target_date ASC')
    .all(userId);
  if (!pending.length) return;

  let warmed = false;
  for (const row of pending) {
    if (nowStamp < `${row.target_date}T15:30`) continue; // 目标日还没收盘
    let pct = null;
    if (row.kind === 'portfolio') {
      const out = portfolioPct(userId, row.target_date, todayStr);
      pct = out.pct;
      if (pct === null && !warmed && out.needWarm.length) {
        // 净值还没缓存的历史基金，补拉一次（最多 10 只），下次结算就能用
        warmed = true;
        await Promise.all(out.needWarm.slice(0, 10).map((c) => quote.getHistory(c, 30).catch(() => null)));
        pct = portfolioPct(userId, row.target_date, todayStr).pct;
      }
    } else {
      pct = await indexPct(row.kind, row.target_date, nowStamp);
    }
    if (pct === null || !Number.isFinite(pct)) continue;
    applyResult(row, pct, nowStamp);
  }
}

/** 持仓累计收益率（成本 > 0 的持仓，按最新本地净值估值） */
function portfolioProfitRate(userId) {
  const rows = db
    .prepare(
      'SELECT fund_code, cost_price, shares FROM adoptions WHERE user_id = ? AND released_at IS NULL AND cost_price > 0 AND shares > 0'
    )
    .all(userId);
  let cost = 0;
  let value = 0;
  for (const r of rows) {
    const nav = quote.latestLocalNav(r.fund_code);
    cost += r.cost_price * r.shares;
    if (nav && nav.nav > 0) value += nav.nav * r.shares;
  }
  return cost > 0 && value > 0 ? ((value - cost) / cost) * 100 : null;
}

function statsOf(userId) {
  const rows = db
    .prepare(
      `SELECT result, COUNT(*) AS n FROM guesses WHERE user_id = ? AND result IS NOT NULL GROUP BY result`
    )
    .all(userId);
  const m = Object.fromEntries(rows.map((r) => [r.result, r.n]));
  const win = m.win || 0;
  const lose = m.lose || 0;
  const draw = m.draw || 0;
  const settled = win + lose + draw;
  const decided = win + lose;
  const hitRate = decided ? (win / decided) * 100 : null;
  // 连胜：从最近一条结算往前数，draw 不打断也不累计
  const recent = db
    .prepare(
      `SELECT result FROM guesses WHERE user_id = ? AND result IS NOT NULL ORDER BY target_date DESC, settled_at DESC LIMIT 60`
    )
    .all(userId);
  let streak = 0;
  for (const r of recent) {
    if (r.result === 'draw') continue;
    if (r.result === 'win') streak++;
    else break;
  }
  return { win, lose, draw, settled, hitRate: hitRate === null ? null : round(hitRate, 1), streak };
}

/** 页面所需全量数据：先懒结算，再返回今日三项、统计、称号与历史 */
async function overview(userId) {
  await settlePending(userId);

  const guessDate = bjDate();
  const target = nextTradingDay(guessDate);
  const todays = db
    .prepare('SELECT * FROM guesses WHERE user_id = ? AND guess_date = ?')
    .all(userId, guessDate);
  const targets = KINDS.map((kind) => {
    const g = todays.find((t) => t.kind === kind) || null;
    return {
      kind,
      name: KIND_NAMES[kind],
      dir: g ? g.dir : null,
      targetDate: g ? g.target_date : target,
    };
  });

  const s = statsOf(userId);
  const profitRate = portfolioProfitRate(userId);
  const level = levelOf(s.hitRate || 0, profitRate, s.settled);

  const history = db
    .prepare('SELECT * FROM guesses WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(userId)
    .map((g) => ({
      id: g.id,
      guessDate: g.guess_date,
      targetDate: g.target_date,
      kind: g.kind,
      kindName: KIND_NAMES[g.kind],
      dir: g.dir,
      result: g.result,
      pct: g.settle_pct === null ? null : Number(g.settle_pct),
    }));

  return { today: guessDate, targetDate: target, targets, stats: s, level, profitRate, history, rewardWin: REWARD_WIN };
}

module.exports = {
  KINDS,
  KIND_NAMES,
  TIERS,
  place,
  overview,
  settlePending,
  statsOf,
  levelOf,
  nextTradingDay,
  bjDate,
  MIN_SETTLED_FOR_HIT,
};
