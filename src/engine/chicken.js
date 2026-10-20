'use strict';

/**
 * 养鸡引擎：行情事件 -> 鸡的状态变化；时间衰减；互动；成长等级。
 * 设计底线：等级只与陪伴时长和照料投入相关，绝不与收益率挂钩；鸡不会「死亡」。
 */

const db = require('../db');
const { today, clamp, round, daysBetween } = require('../util');

const LEVELS = [
  { level: 1, name: '雏鸡', need: 0 },
  { level: 2, name: '仔鸡', need: 100 },
  { level: 3, name: '成鸡', need: 300 },
  { level: 4, name: '壮鸡', need: 800 },
  { level: 5, name: '金鸡', need: 2000 },
];

const BREEDS = {
  equity: { key: 'equity', name: '斗鸡', desc: '好动，涨跌反应最剧烈', color: '#E6503A', accent: '#FFC53D' },
  index: { key: 'index', name: '白羽鸡', desc: '稳健，跟着大盘走', color: '#F5F1E8', accent: '#E6503A' },
  hybrid: { key: 'hybrid', name: '芦丁鸡', desc: '温和，反应适中', color: '#C89B62', accent: '#7A5C3E' },
  bond: { key: 'bond', name: '芦花鸡', desc: '安静，很少掉毛', color: '#9AA5B1', accent: '#4B5563' },
  qdii: { key: 'qdii', name: '异域凤冠鸡', desc: '时差党，净值晚一天更新', color: '#3FB8AF', accent: '#FFC53D' },
  money: { key: 'money', name: '鹌鹑', desc: '几乎不动，天天小蛋', color: '#D9C6A5', accent: '#8B6E4E' },
  fof: { key: 'fof', name: '乌骨鸡', desc: '一篮子鸡蛋，稳中求进', color: '#5B5B7A', accent: '#C0A0D8' },
  other: { key: 'other', name: '土鸡', desc: '皮实好养', color: '#C89B62', accent: '#8B6E4E' },
};

function breedOf(type) {
  return BREEDS[type] ? BREEDS[type].key : 'other';
}

function breedInfo(key) {
  return BREEDS[key] || BREEDS.other;
}

/* ------------------------------------------------------------------
 * 每只基金一只「长相不同」的鸡
 * 品种（breed）只决定基础色系，同一个品种下再用基金代码派生出花色：
 * 图案、配饰、鸡冠、尾巴、体型、色相偏移，全部由代码哈希稳定决定，
 * 换设备 / 重装浏览器 / 重新登录都不会变样。
 * ------------------------------------------------------------------ */

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(v, 16);
  if (!isFinite(n)) return [200, 155, 98];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const f = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`.toUpperCase();
}

function rgbToHsl([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  const H = ((h % 1) + 1) % 1;
  const S = Math.max(0, Math.min(1, s));
  const L = Math.max(0, Math.min(1, l));
  if (S === 0) {
    const v = L * 255;
    return [v, v, v];
  }
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const hue2rgb = (t) => {
    let T = t;
    if (T < 0) T += 1;
    if (T > 1) T -= 1;
    if (T < 1 / 6) return p + (q - p) * 6 * T;
    if (T < 1 / 2) return q;
    if (T < 2 / 3) return p + (q - p) * (2 / 3 - T) * 6;
    return p;
  };
  return [hue2rgb(H + 1 / 3) * 255, hue2rgb(H) * 255, hue2rgb(H - 1 / 3) * 255];
}

/** 在 HSL 空间平移颜色，越界自动夹紧 */
function shiftColor(hex, dh, ds, dl) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(...hslToRgb([h + dh / 360, Math.max(0.06, Math.min(1, s + ds)), Math.max(0.14, Math.min(0.96, l + dl))]));
}

/** 花色专用：先换色相，再把饱和度和明度压到温和区间，避免荧光色 */
function toneColor(hex, dh, maxS, loL, hiL) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(...hslToRgb([h + dh / 360, Math.min(s, maxS), Math.max(loL, Math.min(hiL, l))]));
}

const LOOK_PATTERNS = [
  { key: 'solid', name: '纯色' },
  { key: 'spots', name: '圆点花' },
  { key: 'stripes', name: '条纹' },
  { key: 'patch', name: '拼色' },
  { key: 'belly', name: '白肚' },
  { key: 'speckle', name: '麻点' },
];

const LOOK_ACCESSORIES = [
  { key: 'none', name: '' },
  { key: 'scarf', name: '围巾' },
  { key: 'glasses', name: '眼镜' },
  { key: 'bow', name: '蝴蝶结' },
  { key: 'bell', name: '铃铛' },
  { key: 'hat', name: '小帽' },
];

const LOOK_COMBS = ['triple', 'crest', 'single', 'fluff'];
const LOOK_TAILS = ['fan', 'curl', 'long', 'short'];

/**
 * 由（基金代码，品种）派生稳定外观。seed 建议传基金代码。
 */
function lookOf(seed, breedKey) {
  const base = breedInfo(breedKey);
  const key = String(seed || base.key || 'x');
  const h = hash32(key + '|' + base.key);
  const pick = (arr, shift) => arr[(h >>> shift) % arr.length];

  const pattern = pick(LOOK_PATTERNS, 0);
  const accessory = pick(LOOK_ACCESSORIES, 4);
  const comb = pick(LOOK_COMBS, 7);
  const tail = pick(LOOK_TAILS, 11);

  const [, s0, l0] = rgbToHsl(hexToRgb(base.color));
  const pale = s0 < 0.22 || l0 > 0.84; // 白羽 / 灰羽这类近白色，用色温与明暗变化区分
  const dh = pale ? (((h >>> 13) % 7) - 3) * 13 : (((h >>> 13) % 9) - 4) * 6;
  const dl = pale ? -((h >>> 17) % 5) * 0.028 : (((h >>> 17) % 5) - 2) * 0.022;
  const body = shiftColor(base.color, dh, pale ? 0.06 : 0.03, dl);
  const accent = shiftColor(base.accent, dh / 2, 0.02, 0);
  const accent2 = toneColor(base.accent, 145 + ((h >>> 21) % 70), 0.42, 0.4, 0.62);

  return {
    seed: key,
    variant: h % 4,
    pattern: pattern.key,
    patternName: pattern.name,
    accessory: accessory.key,
    comb,
    tail,
    body,
    accent,
    accent2,
    combColor: shiftColor(base.accent, 0, 0.18, 0.02),
    name: [pattern.name, accessory.name].filter(Boolean).join('·'),
  };
}

function levelInfo(growth) {
  let cur = LEVELS[0];
  let next = null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (growth >= LEVELS[i].need) cur = LEVELS[i];
    else {
      next = LEVELS[i];
      break;
    }
  }
  const curIdx = LEVELS.indexOf(cur);
  const base = cur.need;
  const target = next ? next.need : cur.need;
  const progress = next ? clamp((growth - base) / (target - base), 0, 1) : 1;
  return {
    level: cur.level,
    levelName: cur.name,
    growth,
    nextLevel: next ? next.level : null,
    nextNeed: next ? next.need : null,
    progress: round(progress, 3),
    nextGrowth: next ? Math.max(0, next.need - growth) : 0,
    idx: curIdx,
  };
}

/** 状态总评：用于展示「元气满满 / 有点蔫」 */
function overallMood(c) {
  const avg = (c.satiety + c.mood + c.health) / 3;
  if (avg >= 80) return { key: 'great', label: '元气满满' };
  if (avg >= 60) return { key: 'good', label: '还不错' };
  if (avg >= 40) return { key: 'ok', label: '一般' };
  return { key: 'bad', label: '有点蔫' };
}

function getChicken(adoptionId) {
  return db.prepare('SELECT * FROM chickens WHERE adoption_id = ?').get(adoptionId);
}

function saveChicken(c) {
  db.prepare(
    `UPDATE chickens SET breed=@breed, level=@level, growth=@growth, satiety=@satiety, mood=@mood,
       health=@health, bond=@bond, eggs=@eggs, golden_eggs=@goldenEggs, feathers=@feathers,
       streak_up=@streakUp, streak_down=@streakDown, sick=@sick, min_profit=@minProfit,
       cooldowns=@cooldowns, last_event_date=@lastEventDate, last_interact_at=@lastInteractAt,
       last_decay_at=@lastDecayAt
     WHERE id=@id`
  ).run({
    id: c.id,
    breed: c.breed,
    level: c.level,
    growth: c.growth,
    satiety: c.satiety,
    mood: c.mood,
    health: c.health,
    bond: c.bond,
    eggs: c.eggs,
    goldenEggs: c.golden_eggs,
    feathers: c.feathers,
    streakUp: c.streak_up,
    streakDown: c.streak_down,
    sick: c.sick,
    minProfit: c.min_profit,
    cooldowns: c.cooldowns,
    lastEventDate: c.last_event_date,
    lastInteractAt: c.last_interact_at,
    lastDecayAt: c.last_decay_at,
  });
}

/**
 * 应用每日行情事件（每个 adoption 每天只结算一次）
 * @returns {object|null} 事件描述
 */
function applyDailyEvent(adoption, pct, profitRate) {
  const date = today();
  const c = getChicken(adoption.id);
  if (!c) return null;
  if (c.last_event_date === date) return null;

  let type, text, growth = 0, mood = 0, health = 0, satiety = 0, eggs = 0, golden = 0, feathers = 0;
  if (pct >= 2) {
    type = 'golden_egg';
    text = `下了一枚金蛋`;
    mood = 12; satiety = -2; growth = 8; eggs = 1; golden = 1;
  } else if (pct >= 0.5) {
    type = 'egg';
    text = `下了一枚蛋`;
    mood = 8; growth = 5; eggs = 1;
  } else if (pct > -0.1) {
    type = 'idle';
    text = `在院子里散步`;
    mood = 2; growth = 3;
  } else if (pct > -1.5) {
    type = 'drop1';
    text = `掉了 1 根毛`;
    mood = -6; growth = 2; feathers = 1;
  } else if (pct > -3) {
    type = 'drop3';
    text = `掉了 3 根毛，有点打蔫`;
    mood = -12; health = -3; growth = 1; feathers = 3;
  } else {
    type = 'sick';
    text = `缩成一团躲雨`;
    mood = -20; health = -8; growth = -2; feathers = 3;
  }

  // 连涨 / 连跌
  const streakUp = pct > 0 ? c.streak_up + 1 : 0;
  const streakDown = pct < 0 ? c.streak_down + 1 : 0;
  if (streakUp >= 3) growth = Math.round(growth * 1.5);
  const isLowMood = streakDown >= 3 && c.sick === 1;
  if (isLowMood) growth = 0; // 情绪低谷：互动后才继续成长

  // 持有收益加成（只加成不惩罚）
  let profitBonus = 0;
  if (typeof profitRate === 'number') {
    if (profitRate > 0) profitBonus = 5;
    c.min_profit = Math.min(c.min_profit || 0, profitRate);
  }

  c.mood = clamp(c.mood + mood, 0, 100);
  c.health = clamp(c.health + health, 10, 100);
  c.satiety = clamp(c.satiety + satiety, 0, 100);
  c.eggs += eggs;
  c.golden_eggs += golden;
  c.feathers += feathers;
  c.streak_up = streakUp;
  c.streak_down = streakDown;
  c.sick = type === 'sick' || streakDown >= 3 ? 1 : 0;
  c.growth = Math.max(0, c.growth + growth + profitBonus);
  c.last_event_date = date;
  c.level = levelInfo(c.growth).level;
  saveChicken(c);

  db.prepare(
    `INSERT OR REPLACE INTO daily_events (id, adoption_id, date, pct, event_type, text, growth_delta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    db.prepare('SELECT id FROM daily_events WHERE adoption_id = ? AND date = ?').get(adoption.id, date)?.id ||
      'ev_' + Math.random().toString(36).slice(2, 11),
    adoption.id,
    date,
    round(pct, 3),
    type,
    text,
    growth + profitBonus,
    new Date().toISOString()
  );

  return { type, text, growth: growth + profitBonus, pct: round(pct, 2), fundCode: adoption.fund_code, nickname: adoption.nickname };
}

/** 时间衰减：每 24h 未互动，饱食 -10 / 心情 -5 / 健康 -2（下限保护） */
function decay(chickens) {
  const now = Date.now();
  for (const c of chickens) {
    const last = Date.parse(c.last_decay_at || now);
    const hours = Math.floor((now - last) / 3600000);
    if (hours < 24) continue;
    const times = Math.min(Math.floor(hours / 24), 7); // 最多补 7 天
    for (let i = 0; i < times; i++) {
      c.satiety = Math.max(20, c.satiety - 10);
      c.mood = Math.max(20, c.mood - 5);
      c.health = Math.max(30, c.health - 2);
    }
    c.last_decay_at = new Date().toISOString();
    saveChicken(c);
  }
}

/** 只有进了鸡舍（已填成本价 + 份额）的鸡才会自然衰减；自选里的观察鸡不受影响 */
const IN_YARD = 'a.released_at IS NULL AND a.cost_price > 0 AND a.shares > 0';

function decayAll(userId) {
  const rows = db
    .prepare(`SELECT c.* FROM chickens c JOIN adoptions a ON a.id = c.adoption_id
       WHERE a.user_id = ? AND ${IN_YARD}`)
    .all(userId);
  decay(rows);
}

const COOLDOWN = { feed: 2 * 3600 * 1000, pat: 4 * 3600 * 1000 };

/**
 * 冷却预检：让调用方在写入手心/报告关联之前就能拦住无意义的请求
 */
function checkCooldown(chickenId, action, userId) {
  const c = db
    .prepare(
      `SELECT c.*, a.user_id, a.nickname, a.fund_code, a.cost_price, a.shares FROM chickens c
       JOIN adoptions a ON a.id = c.adoption_id WHERE c.id = ?`
    )
    .get(chickenId);
  if (!c || c.user_id !== userId) return { error: 'not_found' };
  // 没设置持仓的基金不在鸡舍里，也不能喂 / 摸
  if (!(Number(c.cost_price) > 0 && Number(c.shares) > 0)) return { error: 'no_position' };
  const cd = JSON.parse(c.cooldowns || '{}');
  const now = Date.now();
  if (cd[action] && now - cd[action] < COOLDOWN[action]) {
    return { error: 'cooldown', leftMin: Math.ceil((COOLDOWN[action] - (now - cd[action])) / 60000) };
  }
  return { ok: true, chicken: c, cooldowns: cd };
}

/**
 * 互动。material 形如 { kind: 'report'|'note', label, bonus }：
 * 喂食 / 安抚都必须附一份投研素材（报告或心得），素材质量决定成长加成。
 */
function interact(chickenId, action, userId, material = null) {
  const pre = checkCooldown(chickenId, action, userId);
  if (pre.error) return pre;
  const c = pre.chicken;
  const cd = pre.cooldowns;
  const now = Date.now();
  const bonus = material ? material.bonus || 0 : 0;
  const isReport = material && material.kind === 'report';

  if (action === 'feed') {
    const user = db.prepare('SELECT feed FROM users WHERE id = ?').get(userId);
    if (!user || user.feed < 1) return { error: 'no_feed' };
    db.prepare('UPDATE users SET feed = feed - 1 WHERE id = ?').run(userId);
    c.satiety = clamp(c.satiety + (isReport ? 30 : 25), 0, 100);
    c.bond = clamp(c.bond + 3, 0, 100);
    c.growth += 2 + bonus;
  } else if (action === 'pat') {
    c.mood = clamp(c.mood + 15, 0, 100);
    c.bond = clamp(c.bond + 2, 0, 100);
    c.growth += 1 + bonus;
    c.sick = 0; // 抚摸解除情绪低谷
    if (c.streak_down >= 3) c.streak_down = 0;
  } else {
    return { error: 'bad_action' };
  }

  cd[action] = now;
  c.cooldowns = JSON.stringify(cd);
  c.last_interact_at = new Date().toISOString();
  c.last_decay_at = c.last_interact_at;
  c.level = levelInfo(c.growth).level;
  db.prepare('UPDATE users SET total_interact = total_interact + 1 WHERE id = ?').run(userId);
  saveChicken(c);

  const base = action === 'feed' ? '吃饱啦，亲密度 +3' : '被摸了摸头，心情好起来了';
  return {
    ok: true,
    action,
    bonus,
    material: material ? material.label : null,
    chicken: publicChicken(c, c.fund_code),
    text: material ? `${base}（${material.label}，成长 +${bonus}）` : base,
  };
}

/**
 * 需要照料的鸡：饿了（饱食 < 30）或情绪低落（打蔫），
 * 但正在冷却中的鸡不算「欠照料」——否则会被冷却卡成死局。
 */
function careNeeded(userId) {
  const now = Date.now();
  return db
    .prepare(
      `SELECT a.fund_code, a.nickname, c.satiety, c.sick, c.cooldowns, c.id AS chicken_id
       FROM chickens c JOIN adoptions a ON a.id = c.adoption_id
       WHERE a.user_id = ? AND ${IN_YARD} AND (c.satiety < 30 OR c.sick = 1)
       ORDER BY c.satiety ASC`
    )
    .all(userId)
    .filter((r) => {
      const cd = JSON.parse(r.cooldowns || '{}');
      const canFeed = !cd.feed || now - cd.feed >= COOLDOWN.feed;
      const canPat = !cd.pat || now - cd.pat >= COOLDOWN.pat;
      if (r.satiety < 30 && canFeed) return true;
      if (r.sick === 1 && canPat) return true;
      return false;
    })
    .map((r) => ({
      chickenId: r.chicken_id,
      fundCode: r.fund_code,
      nickname: r.nickname || r.fund_code,
      satiety: r.satiety,
      sick: !!r.sick,
      reason: r.sick ? '情绪低落' : '肚子饿了',
    }));
}

/** 全场打扫 / 播放音乐 */
function yardAction(userId, action) {
  const rows = db
    .prepare(
      `SELECT c.* FROM chickens c JOIN adoptions a ON a.id = c.adoption_id
       WHERE a.user_id = ? AND ${IN_YARD}`
    )
    .all(userId);
  const now = new Date().toISOString();
  for (const c of rows) {
    if (action === 'clean') {
      c.health = clamp(c.health + 8, 0, 100);
      c.mood = clamp(c.mood + 5, 0, 100);
    } else if (action === 'music') {
      c.mood = clamp(c.mood + 10, 0, 100);
    }
    c.growth += 1;
    c.level = levelInfo(c.growth).level;
    c.last_decay_at = now;
    saveChicken(c);
  }
  return { ok: true, affected: rows.length };
}

function publicChicken(c, seed) {
  const lv = levelInfo(c.growth);
  const mood = overallMood(c);
  const cd = JSON.parse(c.cooldowns || '{}');
  const now = Date.now();
  const look = lookOf(seed || c.adoption_id || c.id, c.breed);
  return {
    id: c.id,
    breed: c.breed,
    breedName: breedInfo(c.breed).name,
    breedDesc: breedInfo(c.breed).desc,
    colors: { body: look.body, accent: look.accent },
    look,
    level: lv.level,
    levelName: lv.levelName,
    growth: c.growth,
    progress: lv.progress,
    nextLevel: lv.nextLevel,
    nextGrowth: lv.nextGrowth,
    satiety: c.satiety,
    moodValue: c.mood,
    health: c.health,
    bond: c.bond,
    eggs: c.eggs,
    goldenEggs: c.golden_eggs,
    feathers: c.feathers,
    sick: c.sick,
    streakUp: c.streak_up,
    streakDown: c.streak_down,
    state: mood.key,
    stateLabel: mood.label,
    thin: c.health < 40,
    canFeed: !cd.feed || now - cd.feed >= COOLDOWN.feed,
    canPat: !cd.pat || now - cd.pat >= COOLDOWN.pat,
    hungry: c.satiety < 30,
    lastEventDate: c.last_event_date,
  };
}

function holdingDays(adoption) {
  const start = adoption.first_buy_date || adoption.adopted_at?.slice(0, 10);
  return start ? daysBetween(start, today()) : 0;
}

module.exports = {
  LEVELS,
  BREEDS,
  breedOf,
  breedInfo,
  lookOf,
  levelInfo,
  getChicken,
  applyDailyEvent,
  decay,
  decayAll,
  checkCooldown,
  interact,
  careNeeded,
  yardAction,
  publicChicken,
  overallMood,
  holdingDays,
};
