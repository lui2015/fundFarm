'use strict';

const crypto = require('crypto');

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('hex');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function daysBetween(a, b) {
  const d1 = Date.parse(a + 'T00:00:00Z');
  const d2 = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(d1) || Number.isNaN(d2)) return 0;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function round(v, n = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const p = Math.pow(10, n);
  return Math.round(v * p) / p;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** 简单内存限流：key -> 时间窗内计数 */
class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }
  hit(key, limit, windowMs) {
    const now = Date.now();
    const b = this.buckets.get(key) || [];
    const recent = b.filter((t) => now - t < windowMs);
    recent.push(now);
    this.buckets.set(key, recent);
    return recent.length <= limit;
  }
}

/** 带 TTL 的内存缓存 */
class TTLCache {
  constructor(defaultTtlMs) {
    this.defaultTtl = defaultTtlMs;
    this.map = new Map();
  }
  get(key) {
    const it = this.map.get(key);
    if (!it) return undefined;
    if (Date.now() > it.expires) {
      this.map.delete(key);
      return undefined;
    }
    return it.value;
  }
  set(key, value, ttlMs) {
    this.map.set(key, { value, at: Date.now(), expires: Date.now() + (ttlMs || this.defaultTtl) });
    return value;
  }
  /** 缓存未命中时必须返回值的场景：失败时回退到过期数据 */
  getStale(key) {
    const it = this.map.get(key);
    return it ? it.value : undefined;
  }
  /** 数据写入至今的毫秒数（无缓存返回 Infinity） */
  age(key) {
    const it = this.map.get(key);
    return it ? Date.now() - it.at : Infinity;
  }
  /** 实时场景：只要数据在 maxAgeMs 内就直接复用（哪怕 TTL 更长），否则视为过期需重新拉取 */
  getWithin(key, maxAgeMs) {
    const it = this.map.get(key);
    if (!it) return undefined;
    return Date.now() - it.at <= maxAgeMs ? it.value : undefined;
  }
}

async function fetchText(url, { timeout = 8000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url, { timeout = 8000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** 解码 GBK 文本（腾讯行情等接口使用 GBK） */
function decodeGbk(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return Buffer.from(buf).toString('utf8');
  }
}

module.exports = {
  id,
  today,
  nowISO,
  daysBetween,
  clamp,
  round,
  sha256,
  RateLimiter,
  TTLCache,
  fetchText,
  fetchBuffer,
  decodeGbk,
};
