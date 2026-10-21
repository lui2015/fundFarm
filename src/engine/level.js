'use strict';

/**
 * 养基等级：只看「真金白银的累计收益率」，与养鸡时长 / 成长值无关。
 * 上下界都用有限值，方便画进度条（低于最低档按 0% 处理，高于最高档按 100% 处理）。
 */
const TIERS = [
  { key: 'chive', name: '韭菜', min: -60, max: -20, emoji: '🥬', desc: '亏得比较狠，先别急着补仓，检查一下持仓结构' },
  { key: 'rookie', name: '养基小白', min: -20, max: -5, emoji: '🐣', desc: '还在交学费，先把成本和仓位理清楚' },
  { key: 'recover', name: '回本路上', min: -5, max: 0, emoji: '🚶', desc: '离回本只差一点，稳住别追涨' },
  { key: 'rising', name: '养基新秀', min: 0, max: 10, emoji: '🌱', desc: '开始赚钱了，别把行情当能力' },
  { key: 'steady', name: '稳健养基人', min: 10, max: 20, emoji: '🌿', desc: '有自己的节奏，继续保持' },
  { key: 'skilled', name: '养鸡高手', min: 20, max: 35, emoji: '🐓', desc: '已经跑赢大多数散户' },
  { key: 'master', name: '养鸡大师', min: 35, max: 60, emoji: '🏆', desc: '长期主义开始兑现' },
  { key: 'king', name: '鸡王', min: 60, max: 100, emoji: '👑', desc: '鸡舍里的传说' },
  { key: 'legend', name: '传奇养鸡人', min: 100, max: 200, emoji: '🌟', desc: '翻倍了，记得落袋为安' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 收益率 → 等级（含档内进度与下一档差距） */
function levelOf(profitRate) {
  if (profitRate === null || profitRate === undefined || !isFinite(profitRate)) return null;
  const rate = Number(profitRate);
  const idx = Math.max(
    0,
    TIERS.findIndex((t) => rate >= t.min && rate < t.max)
  );
  const tier = TIERS[idx];
  const next = TIERS[idx + 1] || null;
  const span = tier.max - tier.min;
  // 已经是最高档时直接满格，避免「最高等级但进度条只走一半」的观感问题
  const progress = next ? Math.round(clamp((rate - tier.min) / span, 0, 1) * 100) : 100;
  return {
    key: tier.key,
    name: tier.name,
    desc: tier.desc,
    emoji: tier.emoji,
    level: idx + 1,
    total: TIERS.length,
    profitRate: Math.round(rate * 100) / 100,
    range: { min: tier.min, max: tier.max },
    progress,
    next: next
      ? { name: next.name, emoji: next.emoji, need: Math.round((next.min - rate) * 100) / 100, min: next.min }
      : null,
  };
}

module.exports = { TIERS, levelOf };
