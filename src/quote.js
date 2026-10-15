'use strict';

/**
 * 基金行情代理：统一由服务端请求第三方公开接口，前端不直连。
 * 策略：主源失败自动降级，缓存 + 保留过期数据（stale）以保证页面可用。
 */

const db = require('./db');
const { TTLCache, fetchText, fetchBuffer, decodeGbk, round } = require('./util');

const estimateCache = new TTLCache(60 * 1000); // 估值 60s
const historyCache = new TTLCache(6 * 3600 * 1000); // 历史净值 6h
const infoCache = new TTLCache(7 * 24 * 3600 * 1000); // 基础信息 7d
const searchCache = new TTLCache(10 * 60 * 1000);
const indexCache = new TTLCache(60 * 1000);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const stats = { estimateOk: 0, estimateFail: 0, indexOk: 0, indexFail: 0 };

function jsonpParse(text, fn) {
  const s = text.indexOf('(');
  const e = text.lastIndexOf(')');
  if (s < 0 || e <= s) return null;
  const body = text.slice(s + 1, e);
  return JSON.parse(body);
}

/** 单只基金实时估值（天天基金 fundgz） */
async function fetchFromFundgz(code) {
  const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
  const text = await fetchText(url, {
    timeout: 6000,
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
  });
  const d = jsonpParse(text);
  if (!d || !d.fundcode) throw new Error('bad payload');
  return {
    code: String(d.fundcode),
    name: d.name,
    nav: Number(d.dwjz) || null,
    estimate: Number(d.gsz) || null,
    pct: Number(d.gszzl) || 0,
    navDate: d.jzrq || null,
    estimateTime: d.gztime || null,
    live: true,
    source: 'fundgz',
    updatedAt: new Date().toISOString(),
  };
}

/** 备用：天天基金移动端基础信息（最新净值 + 日涨跌幅，非实时估值） */
async function fetchFromMobapi(code) {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?FCODE=${encodeURIComponent(code)}` +
    `&deviceid=1&plat=Android&product=EFund&version=6.5.5&_=${Date.now()}`;
  const text = await fetchText(url, { timeout: 8000, headers: { 'User-Agent': UA } });
  const d = JSON.parse(text);
  const v = d && d.Datas ? d.Datas : null;
  if (!v || !v.DWJZ) throw new Error('empty');
  return {
    code,
    name: v.SHORTNAME || null,
    nav: Number(v.DWJZ) || null,
    estimate: null,
    pct: Number(v.RZDF) || 0,
    navDate: v.FSRQ || null,
    estimateTime: null,
    live: false,
    source: 'mobapi',
    updatedAt: new Date().toISOString(),
  };
}

async function fetchEstimate(code) {
  const cached = estimateCache.get(code);
  if (cached) return cached;
  let item = null;
  try {
    item = await fetchFromFundgz(code);
  } catch (err) {
    try {
      item = await fetchFromMobapi(code);
    } catch (err2) {
      /* 两个源都失败 */
    }
  }
  if (item) {
    stats.estimateOk++;
    upsertFund({ code: item.code, name: item.name });
    return estimateCache.set(code, item);
  }
  stats.estimateFail++;
  const stale = estimateCache.getStale(code);
  if (stale) return { ...stale, live: false };
  return null;
}

/** 批量估值（并发受控） */
async function getEstimates(codes) {
  const uniq = Array.from(new Set(codes.filter(Boolean))).slice(0, 60);
  const out = {};
  const CHUNK = 8;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const part = uniq.slice(i, i + CHUNK);
    const res = await Promise.all(part.map((c) => fetchEstimate(c)));
    part.forEach((c, idx) => {
      if (res[idx]) out[c] = res[idx];
    });
  }
  return out;
}

/** 历史净值（天天基金 f10/lsjz） */
async function getHistory(code, pageSize = 30) {
  const key = `${code}:${pageSize}`;
  const cached = historyCache.get(key);
  if (cached) return cached;
  try {
    const url =
      `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${encodeURIComponent(code)}` +
      `&pageIndex=1&pageSize=${pageSize}&_=${Date.now()}`;
    const text = await fetchText(url, {
      timeout: 8000,
      headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` },
    });
    const d = jsonpParse(text);
    const list = d && d.Data && d.Data.LSJZList ? d.Data.LSJZList : null;
    if (!list || !list.length) throw new Error('empty');
    const items = list
      .map((r) => ({
        date: r.FSRQ,
        nav: Number(r.DWJZ) || null,
        accNav: Number(r.LJJZ) || null,
        pct: Number(r.JZZZL) || 0,
      }))
      .filter((r) => r.date)
      // 天天基金返回的是倒序（最新在前），统一成按日期升序，方便直接画走势 / 取最近 N 天
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const result = { code, items, updatedAt: new Date().toISOString() };
    saveHistory(code, items);
    return historyCache.set(key, result);
  } catch (err) {
    const stale = historyCache.getStale(key);
    if (stale) return { ...stale, stale: true };
    const local = loadHistory(code, pageSize);
    if (local.length) return { code, items: local, stale: true, updatedAt: null };
    return { code, items: [], stale: true, updatedAt: null };
  }
}

function saveHistory(code, items) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO nav_history (code, date, nav, acc_nav, pct) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const it of items) stmt.run(code, it.date, it.nav, it.accNav, it.pct);
  })();
}

function loadHistory(code, limit = 30) {
  return db
    .prepare('SELECT date, nav, acc_nav AS accNav, pct FROM nav_history WHERE code = ? ORDER BY date DESC LIMIT ?')
    .all(code, limit)
    .reverse();
}

/** 本地缓存的最新单位净值（第三方不可用时兜底） */
function latestLocalNav(code) {
  const row = db.prepare('SELECT nav, date FROM nav_history WHERE code = ? ORDER BY date DESC LIMIT 1').get(code);
  return row && row.nav ? { nav: row.nav, date: row.date } : null;
}

/** 基金基础信息（天天基金移动端接口，失败降级） */
async function getFundInfo(code) {
  const cached = infoCache.get(code);
  if (cached && cached.name) return cached;
  const local = db.prepare('SELECT * FROM funds WHERE code = ?').get(code);
  try {
    const url =
      `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?FCODE=${encodeURIComponent(code)}` +
      `&deviceid=1&plat=Android&product=EFund&version=6.5.5&_=${Date.now()}`;
    const text = await fetchText(url, { timeout: 8000, headers: { 'User-Agent': UA } });
    const d = JSON.parse(text);
    const v = d && d.Datas ? d.Datas : null;
    if (!v) throw new Error('empty');
    const info = {
      code,
      name: v.SHORTNAME || local?.name || null,
      type: normalizeType(v.FTYPE || v.INVESTMENT_TYPE || local?.type),
      company: v.JJGS || local?.company || null,
      manager: v.JJJL || local?.manager || null,
      established: v.ESTABDATE || local?.established || null,
      scale: v.ENDNAV || local?.scale || null,
    };
    upsertFund(info);
    return infoCache.set(code, info);
  } catch (err) {
    const est = await fetchEstimate(code);
    const info = {
      code,
      name: est?.name || local?.name || null,
      type: local?.type || guessType(code),
      company: local?.company || null,
      manager: local?.manager || null,
      established: local?.established || null,
      scale: local?.scale || null,
      partial: true,
    };
    upsertFund(info);
    return infoCache.set(code, info);
  }
}

function upsertFund(info) {
  if (!info || !info.code) return;
  db.prepare(
    `INSERT INTO funds (code, name, type, company, manager, established, scale, cached_at)
     VALUES (@code, @name, @type, @company, @manager, @established, @scale, @cachedAt)
     ON CONFLICT(code) DO UPDATE SET
       name = COALESCE(excluded.name, funds.name),
       type = COALESCE(excluded.type, funds.type),
       company = COALESCE(excluded.company, funds.company),
       manager = COALESCE(excluded.manager, funds.manager),
       established = COALESCE(excluded.established, funds.established),
       scale = COALESCE(excluded.scale, funds.scale),
       cached_at = excluded.cached_at`
  ).run({
    code: info.code,
    name: info.name || null,
    type: info.type || null,
    company: info.company || null,
    manager: info.manager || null,
    established: info.established || null,
    scale: info.scale || null,
    cachedAt: new Date().toISOString(),
  });
}

const TYPE_MAP = [
  [/股票型|股票指数|普通股票|增强指数/, 'equity'],
  [/指数/, 'index'],
  [/混合|灵活配置|偏股|偏债/, 'hybrid'],
  [/债券|纯债|一级债|二级债|可转债/, 'bond'],
  [/货币|现金/, 'money'],
  [/QDII|海外|国际|全球|纳斯达克|标普|恒生|港股|美国/, 'qdii'],
  [/FOF|养老/, 'fof'],
];

function normalizeType(t) {
  if (!t) return null;
  const s = String(t);
  for (const [re, val] of TYPE_MAP) if (re.test(s)) return val;
  return 'other';
}

function guessType(code) {
  const c = String(code || '');
  if (/^(000198|000509|000638|004|x)/i.test(c)) return null;
  return null;
}

/** 基金搜索（天天基金 suggest） */
async function search(keyword, limit = 20) {
  const key = String(keyword || '').trim();
  if (!key) return [];
  const cached = searchCache.get(key);
  if (cached) return cached;
  try {
    const url =
      `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?callback=cb&m=1&key=${encodeURIComponent(key)}&_=${Date.now()}`;
    const text = await fetchText(url, {
      timeout: 8000,
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
    });
    const d = jsonpParse(text, 'cb');
    const list = (d && d.Datas) || [];
    const items = list.slice(0, limit).map((r) => ({
      code: r.CODE || r.code,
      name: r.NAME || r.name,
      type: normalizeType(r.FTYPE || r.CATEGORYDESC || r.InvestType),
      company: r.JJGS || r.COMPANYNAME || null,
    }));
    return searchCache.set(key, items);
  } catch (err) {
    // 降级：本地已缓存的基金里做模糊匹配
    const like = `%${key}%`;
    return db
      .prepare('SELECT code, name, type, company FROM funds WHERE code LIKE ? OR name LIKE ? LIMIT ?')
      .all(like, like, limit);
  }
}

/**
 * 大盘指数（天气）：主用腾讯行情（服务器可达性更好），失败回退东财 push2。
 */
async function getIndices() {
  const cached = indexCache.get('idx');
  if (cached) return cached;
  let result = null;
  try {
    const buf = await fetchBuffer('https://qt.gtimg.cn/q=sh000001,sh000300,sz399006', {
      timeout: 6000,
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    });
    const text = decodeGbk(buf);
    const rows = text.split(';');
    const parsed = [];
    for (const row of rows) {
      const m = row.match(/v_(\w+)="([^"]*)"/);
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length < 33) continue;
      parsed.push({
        code: f[2],
        name: f[1],
        value: Number(f[3]) || null,
        pct: Number(f[32]) || 0,
      });
    }
    if (parsed.length) {
      stats.indexOk++;
      result = { source: 'qq', items: parsed, updatedAt: new Date().toISOString() };
    }
  } catch (err) {
    stats.indexFail++;
  }
  if (!result) {
    try {
      const text = await fetchText(
        'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,1.000300,0.399006&fields=f2,f3,f12,f14',
        { timeout: 6000, headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } }
      );
      const d = JSON.parse(text);
      const items = (d?.data?.diff || []).map((r) => ({
        code: String(r.f12),
        name: r.f14,
        value: Number(r.f2) || null,
        pct: Number(r.f3) || 0,
      }));
      if (items.length) result = { source: 'em', items, updatedAt: new Date().toISOString() };
    } catch (err) {
      /* ignore */
    }
  }
  if (!result) {
    const stale = indexCache.getStale('idx');
    if (stale) return { ...stale, stale: true };
    return { source: 'none', items: [], stale: true, updatedAt: null };
  }
  return indexCache.set('idx', result);
}

/** 天气：由上证指数涨跌幅映射 */
function weatherOf(pct) {
  if (pct >= 0.8) return { key: 'sunny', label: '晴', icon: 'sun', moodDelta: 5 };
  if (pct > -0.8) return { key: 'cloudy', label: '多云', icon: 'cloud', moodDelta: 0 };
  if (pct > -2) return { key: 'overcast', label: '阴', icon: 'overcast', moodDelta: -3 };
  return { key: 'rain', label: '雨', icon: 'rain', moodDelta: -8 };
}

function getStats() {
  const totalE = stats.estimateOk + stats.estimateFail;
  return {
    estimateSuccessRate: totalE ? round(stats.estimateOk / totalE, 3) : null,
    indexSuccessRate: stats.indexOk + stats.indexFail ? round(stats.indexOk / (stats.indexOk + stats.indexFail), 3) : null,
    ...stats,
  };
}

module.exports = {
  getEstimates,
  fetchEstimate,
  getHistory,
  latestLocalNav,
  loadHistory,
  getFundInfo,
  search,
  getIndices,
  weatherOf,
  normalizeType,
  getStats,
  upsertFund,
};
