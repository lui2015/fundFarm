import { Api } from './api.js';
import { esc, pct, pctClass, fmtAmount } from './util.js';
import { getState } from './app.js';

/**
 * 涨跌幅实时刷新：页面打开期间按节奏向 /api/v1/quotes 轮询，
 * 只就地更新带 data-live-* 标记的节点，不重渲染整页（不打断滚动 / 不闪）。
 * 交易时段 20s 一次，非交易时段 120s 一次，页面切到后台自动暂停。
 */

const TRADING_TICK = 20 * 1000;
const IDLE_TICK = 120 * 1000;

let timer = null;
let rootEl = null;
let ticking = false;
let lastOk = 0;
let visible = true;
let lastTrading = true;

function hhmmss(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function applyClass(el, v) {
  const base = (el.className || '')
    .split(/\s+/)
    .filter((c) => c && c !== 'up' && c !== 'down' && c !== 'flat')
    .join(' ');
  el.className = (base + ' ' + pctClass(v)).trim();
}

function setPct(el, v) {
  el.textContent = pct(v);
  applyClass(el, v);
}

function updateSummary(data) {
  const s = data.summary || {};
  const st = (getState() && getState().settings) || {};
  rootEl.querySelectorAll('[data-live-summary]').forEach((el) => {
    switch (el.getAttribute('data-live-summary')) {
      case 'todayPct':
        setPct(el, s.todayPct);
        break;
      case 'profitRate':
        setPct(el, s.profitRate);
        break;
      case 'marketValue':
        el.textContent = s.marketValue === null || s.marketValue === undefined ? '--' : fmtAmount(s.marketValue, st, 0);
        break;
      case 'profit':
        el.textContent = s.profit === null || s.profit === undefined ? '--' : fmtAmount(s.profit, st, 0);
        applyClass(el, s.profit);
        break;
      case 'updown':
        el.textContent = s.total ? `${s.up} 涨 ${s.down} 跌` : '空空如也';
        break;
      default:
        break;
    }
  });
}

function updateIndex(data) {
  const idx = (data.indices || [])[0];
  if (!idx) return;
  rootEl.querySelectorAll('[data-live-index]').forEach((el) => {
    el.innerHTML = `${esc(idx.name || '大盘')} <span class="${pctClass(idx.pct)}">${pct(idx.pct)}</span>`;
  });
}

function markTime(data, failed) {
  rootEl.querySelectorAll('[data-live-time]').forEach((el) => {
    el.textContent = failed ? '更新失败，稍后重试' : `更新于 ${hhmmss(data && data.updatedAt)}`;
  });
  rootEl.querySelectorAll('[data-live-state]').forEach((el) => {
    if (failed) {
      el.textContent = '离线';
      el.className = 'live-tag off';
      return;
    }
    const trading = !!data.trading;
    el.textContent = trading ? '实时' : '盘后';
    el.className = 'live-tag' + (trading ? '' : ' idle');
  });
}

function apply(data) {
  lastTrading = data.trading !== false;
  const items = data.items || {};
  Object.keys(items).forEach((code) => {
    const it = items[code];
    if (!it) return;
    rootEl.querySelectorAll(`[data-live-pct="${code}"]`).forEach((el) => setPct(el, it.pct));
    rootEl.querySelectorAll(`[data-live-est="${code}"]`).forEach((el) => {
      el.textContent = it.estimate === null || it.estimate === undefined ? '--' : it.estimate;
    });
  });
  updateSummary(data);
  updateIndex(data);
  markTime(data, false);
}

async function tick() {
  if (!rootEl || ticking) return;
  ticking = true;
  rootEl.querySelectorAll('[data-live-refresh]').forEach((b) => {
    b.classList.add('loading');
  });
  try {
    const codes = Array.from(rootEl.querySelectorAll('[data-live-pct]')).map((el) =>
      el.getAttribute('data-live-pct')
    );
    const data = await Api.quotes(codes);
    lastOk = Date.now();
    apply(data);
  } catch (err) {
    if (rootEl) markTime(null, true);
  } finally {
    ticking = false;
    if (rootEl)
      rootEl.querySelectorAll('[data-live-refresh]').forEach((b) => {
        b.classList.remove('loading');
      });
  }
}

function schedule(ms) {
  clearTimeout(timer);
  const wait = typeof ms === 'number' ? ms : lastTrading ? TRADING_TICK : IDLE_TICK;
  timer = setTimeout(async () => {
    if (!rootEl) return;
    if (visible && !document.hidden) await tick();
    if (rootEl) schedule();
  }, wait);
}

export function startLive(r) {
  stopLive();
  if (!r) return;
  rootEl = r;
  visible = true;
  lastOk = Date.now();

  r.querySelectorAll('[data-live-refresh]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      tick();
    };
  });

  // 首屏数据可能来自最长 60s 的缓存，先补一次实时数据
  schedule(1200);
}

export function stopLive() {
  clearTimeout(timer);
  timer = null;
  ticking = false;
  rootEl = null;
}

/** 交易时段判定（与服务端口径一致，仅用于决定轮询节奏） */
export function isTradingNow() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  return mins >= 9 * 60 + 25 && mins <= 15 * 60 + 5;
}

document.addEventListener('visibilitychange', () => {
  visible = !document.hidden;
  if (visible && rootEl && Date.now() - lastOk > 8000) tick();
});
