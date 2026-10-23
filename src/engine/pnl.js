'use strict';

/**
 * 持仓盈亏走势：把「历史净值 × 当时的份额与成本」还原成一条盈亏曲线。
 *
 * 规则：
 * - 有交易记录时，按日期顺序回放买入/卖出（买入加权成本，卖出按均价扣减），
 *   每个净值日的盈亏 = 当时份额 × 净值 − 当时总成本；
 * - 没有交易记录时（用户直接填了成本价与份额），退化为静态持仓；
 * - 最后一个点可用实时估值补一个「今天」，让曲线末端跟着当日涨跌动。
 */

function round(v, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(Number(v) * p) / p;
}

/** 单笔交易后的份额与成本 */
function step(hold, cost, t) {
  if (t.type === 'buy') return [hold + t.shares, cost + t.shares * t.price];
  // 卖出：按当前均价扣减成本，卖不掉的份额直接归零
  const avg = hold > 0 ? cost / hold : 0;
  const sold = Math.min(t.shares, hold);
  return [hold - sold, Math.max(0, cost - avg * sold)];
}

function buildSeries({ history, trades, shares, costPrice, current } = {}) {
  const list = (history || [])
    .filter((h) => h && h.date && Number.isFinite(Number(h.nav)))
    .map((h) => ({ date: String(h.date).slice(0, 10), nav: Number(h.nav) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return { points: [] };

  const tx = (trades || [])
    .filter((t) => t && t.date && (t.type === 'buy' || t.type === 'sell'))
    .map((t) => ({
      date: String(t.date).slice(0, 10),
      type: t.type,
      price: Number(t.price) || 0,
      shares: Number(t.shares) || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const staticShares = Number(shares) || 0;
  const staticCost = staticShares * (Number(costPrice) || 0);

  // 先走一遍完整回放，决定用「交易回放」还是「静态持仓」
  let endHold = 0;
  let endCost = 0;
  for (const t of tx) [endHold, endCost] = step(endHold, endCost, t);
  const useTrades = tx.length > 0 && endHold > 0 && endCost > 0;

  const points = [];
  const push = (date, nav, hold, cost) => {
    if (!(hold > 0) || !(cost > 0) || !Number.isFinite(nav)) return;
    const profit = hold * nav - cost;
    points.push([date, round(profit, 2), round((profit / cost) * 100, 2)]);
  };

  let hold = 0;
  let cost = 0;
  let ti = 0;
  for (const h of list) {
    if (useTrades) {
      while (ti < tx.length && tx[ti].date <= h.date) {
        [hold, cost] = step(hold, cost, tx[ti]);
        ti++;
      }
      push(h.date, h.nav, hold, cost);
    } else {
      push(h.date, h.nav, staticShares, staticCost);
    }
  }

  // 用实时估值补一个今天的点（净值还没更新的时段，曲线末端也能跟上当日涨跌）
  const curNav = current ? Number(current.nav) : NaN;
  const curDate = current && current.date ? String(current.date).slice(0, 10) : '';
  const lastDate = points.length ? points[points.length - 1][0] : '';
  if (Number.isFinite(curNav) && curNav > 0 && curDate && curDate > lastDate) {
    push(curDate, curNav, useTrades ? endHold : staticShares, useTrades ? endCost : staticCost);
  }

  return { points };
}

module.exports = { buildSeries };
