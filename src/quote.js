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
const holdingsCache = new TTLCache(7 * 24 * 3600 * 1000); // 基金持仓（按季披露）
const stockCache = new TTLCache(30 * 1000); // 个股实时行情

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const stats = { estimateOk: 0, estimateFail: 0, indexOk: 0, indexFail: 0, holdingsOk: 0 };

/** 实时刷新场景下的最大数据年龄：超过就回源重取（默认 15s） */
const LIVE_MAX_AGE = 15 * 1000;
/** 同一只基金的并发回源去重，避免轮询把第三方接口打爆 */
const inflight = new Map();

/** A 股交易时段（周一至周五 09:30-15:00，Asia/Shanghai） */
function isTrading(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000); // 转 UTC+8
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  return mins >= 9 * 60 + 25 && mins <= 15 * 60 + 5;
}

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

/** 东财市场前缀 → 腾讯行情符号前缀 */
const EM_MARKET = { 1: 'sh', 0: 'sz', 116: 'hk', 105: 'us', 106: 'us', 107: 'us', 90: 'hk' };

function guessMarket(code) {
  const c = String(code || '');
  if (/^[A-Za-z]/.test(c)) return 'us';
  if (c.length === 5) return 'hk';
  if (/^(6|9)/.test(c)) return 'sh';
  if (/^(0|3)/.test(c)) return 'sz';
  if (/^(8|4)/.test(c)) return 'bj';
  return 'sh';
}

function qqSymbol(market, code) {
  if (market === 'us') return 'us' + String(code).toUpperCase();
  if (market === 'hk') return 'hk' + String(code);
  return market + String(code);
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

/** 基金前十大持仓（天天基金 f10 股票投资明细） */
async function getHoldings(code) {
  const cached = holdingsCache.get(code);
  if (cached) return cached;
  const url =
    `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${encodeURIComponent(code)}` +
    `&topline=10&year=&month=&rt=${Date.now()}`;
  const text = await fetchText(url, {
    timeout: 8000,
    headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
  });
  const rows = text.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const items = [];
  for (const row of rows) {
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 7) continue;
    const rawCode = stripTags(tds[1]);
    const name = stripTags(tds[2]);
    const weight = parseFloat(stripTags(tds[6]));
    if (!rawCode || !/^[0-9A-Za-z.]{3,10}$/.test(rawCode) || !isFinite(weight) || weight <= 0) continue;
    const m = row.match(/unify\/r\/(\d+)\./);
    const market = (m && EM_MARKET[Number(m[1])]) || guessMarket(rawCode);
    if (market === 'bj') continue; // 北交所行情源不稳定，跳过
    items.push({
      code: rawCode,
      name,
      weight,
      market,
      shares: stripTags(tds[7]) || null,
      marketValue: stripTags(tds[8]) || null,
      symbol: qqSymbol(market, rawCode),
    });
    if (items.length >= 10) break;
  }
  if (!items.length) throw new Error('no_holdings');
  const result = { code, items, asOf: reportDate(text), updatedAt: new Date().toISOString() };
  return holdingsCache.set(code, result);
}

/** 重仓债券（天天基金 f10 债券投资明细，type=zqcc） */
async function getBondHoldings(code) {
  const key = `bond:${code}`;
  const cached = holdingsCache.get(key);
  if (cached) return cached;
  const url =
    `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=zqcc&code=${encodeURIComponent(code)}` +
    `&topline=10&year=&month=&rt=${Date.now()}`;
  const text = await fetchText(url, {
    timeout: 8000,
    headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
  });
  const rows = text.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const items = [];
  for (const row of rows) {
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 4) continue;
    const rawCode = stripTags(tds[1]);
    const name = stripTags(tds[2]);
    const weight = parseFloat(stripTags(tds[3]));
    if (!rawCode || !name || !isFinite(weight) || weight <= 0) continue;
    items.push({ code: rawCode, name, weight, marketValue: stripTags(tds[4]) || null });
    if (items.length >= 10) break;
  }
  if (!items.length) throw new Error('no_bond_holdings');
  return holdingsCache.set(key, { code, items, asOf: reportDate(text), updatedAt: new Date().toISOString() });
}

/** 从 f10 表格 HTML 里取报告期（如 2026-06-30） */
function reportDate(html) {
  const m = html.match(/截止至：[^>]*>([\d-]{8,10})</);
  return m ? m[1] : null;
}

/** 汇总：把一只基金的持仓 / 债券 / 主题按类型抓齐，供详情页展示 */
async function getFundProfile(code, type) {
  const key = `profile:${code}`;
  const cached = holdingsCache.get(key);
  if (cached) return cached;

  const wantStocks = ['equity', 'index', 'hybrid', 'qdii', 'fof', 'other'].indexOf(type) >= 0;
  const wantBonds = ['bond', 'hybrid'].indexOf(type) >= 0;

  const out = { code, type, stocks: [], bonds: [], asOf: null, stockPercent: null, bondPercent: null };
  const tasks = [];
  if (wantStocks)
    tasks.push(
      getHoldings(code)
        .then((h) => {
          out.stocks = h.items || [];
          out.asOf = out.asOf || h.asOf;
        })
        .catch(() => null)
    );
  if (wantBonds)
    tasks.push(
      getBondHoldings(code)
        .then((b) => {
          out.bonds = b.items || [];
          out.asOf = out.asOf || b.asOf;
        })
        .catch(() => null)
    );
  await Promise.all(tasks);

  if (out.stocks.length) out.stockPercent = round(out.stocks.reduce((s, i) => s + i.weight, 0), 2);
  if (out.bonds.length) out.bondPercent = round(out.bonds.reduce((s, i) => s + i.weight, 0), 2);
  return holdingsCache.set(key, out);
}

/** 腾讯个股 / 港股 / 美股实时行情（批量，GBK） */
async function getStockQuotes(symbols, maxAge) {
  const uniq = Array.from(new Set(symbols.filter(Boolean)));
  const out = {};
  const need = [];
  const age = typeof maxAge === 'number' ? maxAge : 20000;
  for (const s of uniq) {
    const c = stockCache.getWithin(s, age);
    if (c) out[s] = c;
    else need.push(s);
  }
  for (let i = 0; i < need.length; i += 40) {
    const part = need.slice(i, i + 40);
    try {
      const buf = await fetchBuffer('https://qt.gtimg.cn/q=' + part.join(','), {
        timeout: 6000,
        headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      });
      const text = decodeGbk(buf);
      const re = /v_(\w+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(text))) {
        const f = m[2].split('~');
        if (f.length < 33) continue;
        const price = Number(f[3]);
        const prev = Number(f[4]);
        let p = Number(f[32]);
        if (!isFinite(p) && isFinite(price) && isFinite(prev) && prev) p = ((price - prev) / prev) * 100;
        if (!isFinite(p)) continue;
        out[m[1]] = stockCache.set(m[1], { symbol: m[1], price: isFinite(price) ? price : null, pct: p, time: f[30] || null });
      }
    } catch (err) {
      /* 忽略，缺少的标的按无报价处理 */
    }
    for (const s of part) if (!out[s]) {
      const stale = stockCache.getStale(s);
      if (stale) out[s] = stale;
    }
  }
  return out;
}

/**
 * 盘中估算：用最新披露的前十大持仓 + 个股实时涨跌幅加权测算。
 * 天天基金 fundgz 估值接口大面积不可用时，这是唯一能给出「当下涨跌」的方式。
 * 持仓覆盖率不足 50% 时返回 null，交给净值日涨跌幅兜底。
 */
async function estimateByHoldings(code, base, opts = {}) {
  if (!isTrading()) return null;
  let h = null;
  try {
    h = await getHoldings(code);
  } catch (err) {
    return null;
  }
  const quotes = await getStockQuotes(
    h.items.map((i) => i.symbol),
    typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : undefined
  );
  let totalW = 0;
  let usedW = 0;
  let acc = 0;
  for (const it of h.items) {
    totalW += it.weight;
    const q = quotes[it.symbol];
    if (q && typeof q.pct === 'number') {
      usedW += it.weight;
      acc += it.weight * q.pct;
    }
  }
  if (!totalW || usedW / totalW < 0.5) return null;

  const local = latestLocalNav(code);
  const nav = base && base.nav ? base.nav : local ? local.nav : null;
  const pctV = round(acc / 100, 2);
  if (nav === null) return null;
  stats.holdingsOk++;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    code,
    name: (base && base.name) || null,
    nav,
    estimate: round(nav * (1 + pctV / 100), 4),
    pct: pctV,
    navDate: (base && base.navDate) || (local && local.date) || null,
    estimateTime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}:${pad(d.getSeconds())}`,
    live: true,
    approx: true,
    source: 'holdings',
    coverage: round(usedW / totalW, 3),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 单只基金估值。opts.maxAgeMs：要求数据不老于该毫秒数（实时刷新用），
 * 缓存不足够新时回源重取；同一 code 的并发请求会合并成一次真实网络请求。
 */
async function fetchEstimate(code, opts = {}) {
  const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : null;
  const cached = maxAge === null ? estimateCache.get(code) : estimateCache.getWithin(code, maxAge);
  if (cached) return cached;

  if (inflight.has(code)) return inflight.get(code);

  const task = (async () => {
    let item = null;
    try {
      item = await fetchFromFundgz(code);
    } catch (err) {
      /* fundgz 已大面积 404，走下面的盘中估算 / 净值兜底 */
    }
    if (!item) {
      // 拿最新净值作为估算基准（fundgz 失败时 mobapi 通常仍可用）
      let base = null;
      try {
        base = await fetchFromMobapi(code);
      } catch (err) {
        base = null;
      }
      const est = await estimateByHoldings(code, base, opts).catch(() => null);
      if (est) return estimateCache.set(code, est);
      item = base;
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
  })();

  inflight.set(code, task);
  try {
    return await task;
  } finally {
    inflight.delete(code);
  }
}

/** 批量估值（并发受控） */
async function getEstimates(codes, opts = {}) {
  const uniq = Array.from(new Set(codes.filter(Boolean))).slice(0, 60);
  const out = {};
  const CHUNK = 8;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const part = uniq.slice(i, i + CHUNK);
    const res = await Promise.all(part.map((c) => fetchEstimate(c, opts)));
    part.forEach((c, idx) => {
      if (res[idx]) out[c] = res[idx];
    });
  }
  return out;
}

/**
 * 历史净值（天天基金 f10/lsjz）。
 * 注意：该接口单页最多返回 20 条（pageSize 传再大也只有 20），必须靠 pageIndex 翻页。
 */
async function getHistory(code, rows = 30) {
  const want = Math.max(1, Math.min(Number(rows) || 30, 300));
  const key = `${code}:${want}`;
  const cached = historyCache.get(key);
  if (cached) return cached;
  try {
    const items = [];
    const pages = Math.ceil(want / 20);
    for (let pageIndex = 1; pageIndex <= pages; pageIndex++) {
      const url =
        `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${encodeURIComponent(code)}` +
        `&pageIndex=${pageIndex}&pageSize=20&_=${Date.now()}`;
      const text = await fetchText(url, {
        timeout: 8000,
        headers: { 'User-Agent': UA, Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` },
      });
      const d = jsonpParse(text);
      const list = d && d.Data && d.Data.LSJZList ? d.Data.LSJZList : null;
      if (!list || !list.length) break;
      for (const r of list) {
        if (!r.FSRQ) continue;
        items.push({
          date: r.FSRQ,
          nav: Number(r.DWJZ) || null,
          accNav: Number(r.LJJZ) || null,
          pct: Number(r.JZZZL) || 0,
        });
      }
      if (list.length < 20) break;
    }
    if (!items.length) throw new Error('empty');
    // 天天基金返回倒序（最新在前），统一成按日期升序
    const sorted = items.sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-want);
    const result = { code, items: sorted, updatedAt: new Date().toISOString() };
    saveHistory(code, sorted);
    return historyCache.set(key, result);
  } catch (err) {
    const stale = historyCache.getStale(key);
    if (stale) return { ...stale, stale: true };
    const local = loadHistory(code, want);
    if (local.length) return { code, items: local, stale: true, updatedAt: null };
    return { code, items: [], stale: true, updatedAt: null };
  }
}

/**
 * 全量历史净值：一次请求拿到成立以来所有净值（天天基金 pingzhongdata）。
 * 供详情页「30 天 / 60 天 / 180 天 / 全部」切换使用，避免为每个区间反复翻页。
 */
async function getFullHistory(code, maxPoints = 1500) {
  const key = `full:${code}`;
  const cached = historyCache.get(key);
  if (cached) return cached;
  try {
    const url = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js?v=${Date.now()}`;
    const text = await fetchText(url, {
      timeout: 12000,
      headers: { 'User-Agent': UA, Referer: `https://fund.eastmoney.com/${code}.html` },
    });
    const navM = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!navM) throw new Error('no_trend');
    const trend = JSON.parse(navM[1]);
    const accM = text.match(/var\s+Data_ACWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
    const accList = accM ? JSON.parse(accM[1]) : [];
    const accMap = new Map();
    for (const row of accList) {
      if (Array.isArray(row) && row.length >= 2) accMap.set(dayOfTs(row[0]), Number(row[1]) || null);
    }
    const items = trend
      .map((p) => {
        const date = dayOfTs(p.x);
        return {
          date,
          nav: Number(p.y) || null,
          accNav: accMap.get(date) || null,
          pct: Number(p.equityReturn) || 0,
        };
      })
      .filter((r) => r.date && r.nav)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-maxPoints);
    if (items.length < 2) throw new Error('empty');
    saveHistory(code, items.slice(-260));
    return historyCache.set(key, { code, items, updatedAt: new Date().toISOString() });
  } catch (err) {
    // 兜底：翻页拉最近 300 条
    const fallback = await getHistory(code, 300);
    return { ...fallback, partial: true };
  }
}

/** 时间戳（毫秒）→ YYYY-MM-DD（按北京时间） */
function dayOfTs(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return null;
  const d = new Date(n + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
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

/** 数值字段解析：'--' / 空 / 非数字 一律视为无数据 */
function toNum(v) {
  if (v === null || v === undefined || v === '' || v === '--' || v === '—') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** 清洗占位值：'--' / '—' / 空串 一律视为无数据 */
function cleanText(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s || s === '--' || s === '—' || s === '-' || s === 'null') return null;
  return s;
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
      // 东财原始分类，如「指数型-股票」「混合型-偏股」「债券型-信用债」
      category: cleanText(v.FTYPE || v.INVESTMENT_TYPE) || local?.category || null,
      indexName: cleanText(v.INDEXNAME) || local?.index_name || null,
      indexCode: cleanText(v.INDEXCODE) || null,
      // 关联板块 / 主题（如「食品饮料」），带近 1 月涨跌
      subjects: Array.isArray(v.FUNDSUBJECTLIST)
        ? v.FUNDSUBJECTLIST.map((s) => ({
            code: cleanText(s && s.TTYPE),
            name: cleanText(s && s.TTYPENAME),
            pct1m: toNum(s && s.SYL_Y),
          })).filter((s) => s.name)
        : [],
      company: v.JJGS || local?.company || null,
      manager: v.JJJL || local?.manager || null,
      established: v.ESTABDATE || local?.established || null,
      scale: v.ENDNAV || local?.scale || null,
      // 基金「健康指标」：收益、回撤、夏普、波动、风险等级（东财口径，缺失为 null）
      metrics: {
        syl1n: toNum(v.SYL_1N),
        syl3n: toNum(v.SYL_3N),
        sharpe: toNum(v.SHARP1),
        maxDrawdown: toNum(v.MAXRETRA1),
        volatility: toNum(v.STDDEV1),
        riskLevel: toNum(v.RISKLEVEL),
      },
    };
    upsertFund(info);
    return infoCache.set(code, info);
  } catch (err) {
    const est = await fetchEstimate(code);
    const info = {
      code,
      name: est?.name || local?.name || null,
      type: local?.type || guessType(code),
      category: local?.category || null,
      indexName: local?.index_name || null,
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
    `INSERT INTO funds (code, name, type, category, index_name, company, manager, established, scale, cached_at)
     VALUES (@code, @name, @type, @category, @indexName, @company, @manager, @established, @scale, @cachedAt)
     ON CONFLICT(code) DO UPDATE SET
      name = COALESCE(excluded.name, funds.name),
      type = COALESCE(excluded.type, funds.type),
      category = COALESCE(excluded.category, funds.category),
      index_name = COALESCE(excluded.index_name, funds.index_name),
      company = COALESCE(excluded.company, funds.company),
      manager = COALESCE(excluded.manager, funds.manager),
      established = COALESCE(excluded.established, funds.established),
      scale = COALESCE(excluded.scale, funds.scale),
      cached_at = excluded.cached_at`
  ).run({
    code: info.code,
    name: info.name || null,
    type: info.type || null,
    category: info.category || null,
    indexName: info.indexName || null,
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

/* ------------------------- 基金筛选（排行接口） ------------------------- */

const exploreCache = new TTLCache(10 * 60 * 1000);

/** type -> 天天基金排行 ft 参数 */
const EXPLORE_TYPES = { all: 'all', zs: 'zs', gp: 'gp', hh: 'hh', zq: 'zq', qdii: 'qdii', fof: 'fof' };
/** 排序字段白名单：近1年 / 近6月 / 近3月 / 近1月 / 日涨幅 / 成立来 / 今年来 */
const EXPLORE_SORTS = { '1nzf': 11, '6yzf': 10, '3yzf': 9, '1yzf': 8, rzdf: 6, lnzf: 15, jnzf: 14 };

const numAt = (arr, i) => {
  const n = Number(arr[i]);
  return isFinite(n) && String(arr[i]).trim() !== '' ? n : null;
};

/**
 * 按类型 / 业绩排序筛选基金（东财排行，无需逐个请求详情）
 * @returns {{items:Array,total:number,counts:object,page:number,size:number}}
 */
async function explore(opts = {}) {
  const type = EXPLORE_TYPES[opts.type] ? opts.type : 'all';
  const sort = EXPLORE_SORTS[opts.sort] ? opts.sort : '1nzf';
  const page = Math.max(1, Math.min(Number(opts.page) || 1, 200));
  const size = Math.max(10, Math.min(Number(opts.size) || 20, 40));
  const key = `${type}:${sort}:${page}:${size}`;
  const cached = exploreCache.get(key);
  if (cached) return cached;

  const url =
    `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${EXPLORE_TYPES[type]}` +
    `&rs=&gs=0&sc=${sort}&st=desc&pi=${page}&pn=${size}&dx=1&v=${Date.now()}`;
  const text = await fetchText(url, {
    timeout: 10000,
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/data/fundranking.html' },
  });
  const m = text.match(/datas:(\[[\s\S]*?\]),allRecords:(\d+)/);
  if (!m) throw new Error('bad_explore_payload');
  const rows = JSON.parse(m[1]);
  const items = rows
    .map((line) => {
      const f = String(line).split(',');
      if (!f[0] || !/^\d{6}$/.test(f[0])) return null;
      return {
        code: f[0],
        name: f[1],
        date: f[3] || null,
        nav: numAt(f, 4),
        dayPct: numAt(f, 6),
        m1: numAt(f, 8),
        m3: numAt(f, 9),
        m6: numAt(f, 10),
        y1: numAt(f, 11),
        y3: numAt(f, 13),
        ytd: numAt(f, 14),
        estab: f[16] || null,
      };
    })
    .filter(Boolean);

  const counts = {};
  const cnt = text.match(/zs_count:(\d+),gp_count:(\d+),hh_count:(\d+),zq_count:(\d+),qdii_count:(\d+),fof_count:(\d+)/);
  if (cnt) {
    counts.all = Number(m[2]) || null;
    counts.zs = Number(cnt[1]);
    counts.gp = Number(cnt[2]);
    counts.hh = Number(cnt[3]);
    counts.zq = Number(cnt[4]);
    counts.qdii = Number(cnt[5]);
    counts.fof = Number(cnt[6]);
  }

  return exploreCache.set(key, {
    type,
    sort,
    page,
    size,
    total: Number(m[2]) || items.length,
    counts,
    items,
    updatedAt: new Date().toISOString(),
  });
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
async function getIndices(opts = {}) {
  const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : null;
  const cached = maxAge === null ? indexCache.get('idx') : indexCache.getWithin('idx', maxAge);
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

/**
 * 全球大盘指数。
 * - A股 / 港股 / 美股 / 富时100：腾讯 qt.gtimg.cn（服务器可达、字段规范、带更新时间）
 * - 日经 / 韩国 / 台湾 / 印度 / 德法 / 斯托克50 / 巴西：新浪 hq.sinajs.cn 的 znb_ 系列
 * 两组并发拉取，任一组失败不影响另一组；整体失败时返回上一份过期数据（stale）。
 */
const QQ_GLOBAL_DEF = [
  { region: 'A股', symbol: 'sh000001', name: '上证指数' },
  { region: 'A股', symbol: 'sz399001', name: '深证成指' },
  { region: 'A股', symbol: 'sz399006', name: '创业板指' },
  { region: 'A股', symbol: 'sh000300', name: '沪深300' },
  { region: 'A股', symbol: 'sh000016', name: '上证50' },
  { region: 'A股', symbol: 'sz399905', name: '中证500' },
  { region: 'A股', symbol: 'sh000688', name: '科创50' },
  { region: '港股', symbol: 'hkHSI', name: '恒生指数' },
  { region: '港股', symbol: 'hkHSTECH', name: '恒生科技' },
  { region: '港股', symbol: 'hkHSCEI', name: '国企指数' },
  { region: '美股', symbol: 'usDJI', name: '道琼斯' },
  { region: '美股', symbol: 'usIXIC', name: '纳斯达克' },
  { region: '美股', symbol: 'usINX', name: '标普500' },
  { region: '欧洲', symbol: 'ukUKX', name: '英国富时100' },
];

const SINA_GLOBAL_DEF = [
  { region: '亚太', symbol: 'znb_NKY', name: '日经225' },
  { region: '亚太', symbol: 'znb_KOSPI', name: '韩国综合' },
  { region: '亚太', symbol: 'znb_TWSE', name: '台湾加权' },
  { region: '亚太', symbol: 'znb_SENSEX', name: '印度SENSEX' },
  { region: '欧洲', symbol: 'znb_DAX', name: '德国DAX' },
  { region: '欧洲', symbol: 'znb_CAC', name: '法国CAC40' },
  { region: '欧洲', symbol: 'znb_SX5E', name: '欧洲斯托克50' },
  { region: '其他', symbol: 'znb_IBOV', name: '巴西IBOVESPA' },
];

const REGION_ORDER = ['A股', '港股', '亚太', '美股', '欧洲', '其他'];

/** 腾讯行情时间字段：20261020112027 / 2026/10/20 11:05:27 / 2026-10-19 16:44:25 */
function normQQTime(t) {
  const s = String(t || '').trim();
  if (/^\d{14}$/.test(s))
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  return s ? s.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3') : null;
}

/** 新浪 znb_ 时间：优先取第 7/8 段的「日期 + 时间」，否则第 5 段的 HH:MM(:SS) */
function normSinaTime(f) {
  if (f[6] && f[7]) {
    const d = String(f[6]).trim();
    const t = String(f[7]).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && /^\d{1,2}:\d{2}/.test(t)) return `${d} ${t}`;
  }
  const t4 = String(f[4] || '').trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t4)) return t4;
  return null;
}

async function fetchQQGlobal() {
  const symbols = QQ_GLOBAL_DEF.map((d) => d.symbol).join(',');
  const buf = await fetchBuffer(`https://qt.gtimg.cn/q=${symbols}`, {
    timeout: 7000,
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
  });
  const text = decodeGbk(buf);
  const map = new Map();
  const re = /v_([A-Za-z0-9_.]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const f = m[2].split('~');
    if (f.length < 33) continue;
    map.set(m[1], f);
  }
  return QQ_GLOBAL_DEF.map((d) => {
    const f = map.get(d.symbol);
    if (!f) return null;
    const price = Number(f[3]);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      region: d.region,
      code: d.symbol,
      name: d.name,
      price: round(price, 2),
      change: Number.isFinite(Number(f[31])) ? round(Number(f[31]), 2) : null,
      pct: Number.isFinite(Number(f[32])) ? round(Number(f[32]), 2) : null,
      time: normQQTime(f[30]),
      source: 'qq',
    };
  }).filter(Boolean);
}

async function fetchSinaGlobal() {
  const symbols = SINA_GLOBAL_DEF.map((d) => d.symbol).join(',');
  const buf = await fetchBuffer(`https://hq.sinajs.cn/list=${symbols}`, {
    timeout: 7000,
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
  });
  const text = decodeGbk(buf);
  const map = new Map();
  const re = /hq_str_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const f = m[2].split(',');
    if (f.length < 4 || !f[1]) continue;
    map.set(m[1], f);
  }
  return SINA_GLOBAL_DEF.map((d) => {
    const f = map.get(d.symbol);
    if (!f) return null;
    const price = Number(f[1]);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      region: d.region,
      code: d.symbol,
      name: d.name,
      price: round(price, 2),
      change: Number.isFinite(Number(f[2])) ? round(Number(f[2]), 2) : null,
      pct: Number.isFinite(Number(f[3])) ? round(Number(f[3]), 2) : null,
      time: normSinaTime(f),
      source: 'sina',
    };
  }).filter(Boolean);
}

async function getGlobalIndices(opts = {}) {
  const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : null;
  const cached = maxAge === null ? indexCache.get('gidx') : indexCache.getWithin('gidx', maxAge);
  if (cached) return cached;

  const [qqRes, sinaRes] = await Promise.all([
    fetchQQGlobal().catch(() => []),
    fetchSinaGlobal().catch(() => []),
  ]);
  const items = [].concat(qqRes, sinaRes);
  if (!items.length) {
    const stale = indexCache.getStale('gidx');
    if (stale) return { ...stale, stale: true };
    return { groups: [], items: [], sources: [], stale: true, updatedAt: null };
  }

  const groups = REGION_ORDER.map((region) => ({
    region,
    items: items.filter((it) => it.region === region),
  })).filter((g) => g.items.length);
  const unknown = items.filter((it) => REGION_ORDER.indexOf(it.region) < 0);
  if (unknown.length) groups.push({ region: '其他', items: unknown });

  const result = {
    groups,
    items,
    sources: [].concat(qqRes.length ? ['qq'] : [], sinaRes.length ? ['sina'] : []),
    count: items.length,
    stale: false,
    updatedAt: new Date().toISOString(),
  };
  return indexCache.set('gidx', result);
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
  LIVE_MAX_AGE,
  isTrading,
  getEstimates,
  fetchEstimate,
  getHistory,
  getFullHistory,
  getFundProfile,
  getBondHoldings,
  latestLocalNav,
  loadHistory,
  getFundInfo,
  search,
  explore,
  getIndices,
  getGlobalIndices,
  weatherOf,
  normalizeType,
  getStats,
  upsertFund,
};
