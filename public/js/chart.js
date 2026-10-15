import { esc } from './util.js';

/**
 * 净值走势图（自绘 SVG）：
 * - 平滑曲线 + 渐变面积，涨红跌绿
 * - 虚线网格 + 右侧净值刻度 + 首/中/末日期
 * - 最高/最低点标记、最新点高亮
 * - 指针移动显示十字准星与提示气泡（支持触摸）
 * - SVG 用 viewBox 0..1000 / 0..300 + preserveAspectRatio="none"，
 *   描边用 vector-effect 保持粗细、文字/圆点用 HTML 定位，避免非等比缩放跑形
 *
 * @param {{v:number,date?:string}[]} points
 * @returns {{html:string, bind:(root:HTMLElement)=>void}}
 */

const VW = 1000;
const VH = 300;
const PAD = { t: 16, r: 4, b: 26, l: 8 };

function fmtNav(v) {
  const a = Math.abs(Number(v) || 0);
  if (a >= 100) return Number(v).toFixed(2);
  if (a >= 10) return Number(v).toFixed(3);
  return Number(v).toFixed(4);
}

function shortDate(s) {
  const t = String(s || '');
  return t.length >= 10 ? t.slice(5, 10) : t;
}

/** Catmull-Rom 转三次贝塞尔：得到柔和不过冲的曲线 */
function smoothPath(pts, tension = 0.16) {
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(
      1
    )},${p2.y.toFixed(1)}`;
  }
  return d;
}

export function navChart(points, opts = {}) {
  const seen = new Set();
  const list = (points || [])
    .map((p) => ({ v: Number(p.v), date: String(p.date || '') }))
    .filter((p) => !Number.isNaN(p.v) && p.v !== null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .filter((p) => {
      if (p.date && seen.has(p.date)) return false;
      if (p.date) seen.add(p.date);
      return true;
    });

  if (list.length < 2) return { html: '', bind() {} };

  const vals = list.map((p) => p.v);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const span = rawMax - rawMin || Math.max(rawMax * 0.004, 0.001);
  const min = rawMin - span * 0.16;
  const max = rawMax + span * 0.16;
  const range = max - min || 1;

  const x0 = PAD.l;
  const x1 = VW - PAD.r;
  const y0 = PAD.t;
  const y1 = VH - PAD.b;

  // viewBox 坐标
  const sx = (i) => x0 + (i * (x1 - x0)) / (list.length - 1);
  const sy = (v) => y1 - ((v - min) / range) * (y1 - y0);
  // 百分比坐标（供 HTML 定位）
  const px = (i) => ((sx(i) / VW) * 100).toFixed(3);
  const py = (v) => ((sy(v) / VH) * 100).toFixed(3);

  const pts = list.map((p, i) => ({ x: sx(i), y: sy(p.v) }));
  const line = smoothPath(pts);
  const area = `${line} L${x1.toFixed(1)},${y1} L${x0},${y1} Z`;

  const first = vals[0];
  const last = vals[vals.length - 1];
  const change = last - first;
  const changePct = first ? (change / first) * 100 : 0;
  const up = change >= 0;
  const color = up ? '#e6503a' : '#2ba471';

  const grid = [0, 1, 2, 3].map((k) => {
    const v = min + (range * k) / 3;
    const y = sy(v);
    return {
      v,
      y,
      line: `<line class="c-grid" x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(
        1
      )}" vector-effect="non-scaling-stroke" />`,
      label: `<div class="chart-ylabel" style="top:${((y / VH) * 100).toFixed(3)}%">${fmtNav(v)}</div>`,
    };
  });

  const maxIdx = vals.indexOf(rawMax);
  const minIdx = vals.indexOf(rawMin);
  const lastIdx = list.length - 1;

  const xLabels = [0, Math.floor(lastIdx / 2), lastIdx]
    .filter((i, k, arr) => arr.indexOf(i) === k)
    .map((i) => {
      const cls = i === 0 ? 'first' : i === lastIdx ? 'last' : 'mid';
      return `<div class="chart-xlabel ${cls}" style="left:${px(i)}%">${esc(shortDate(list[i].date))}</div>`;
    })
    .join('');

  const dots = [
    `<div class="chart-dot mark" style="left:${px(maxIdx)}%;top:${py(rawMax)}%"></div>`,
    `<div class="chart-dot mark" style="left:${px(minIdx)}%;top:${py(rawMin)}%"></div>`,
    `<div class="chart-dot last" style="left:${px(lastIdx)}%;top:${py(last)}%;background:${color}"></div>`,
    `<div class="chart-dot cursor" style="background:${color}"></div>`,
  ].join('');

  const html = `
    <div class="chart-wrap">
      <div class="chart-plot">
        <svg class="nav-chart" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" role="img"
             aria-label="${esc(opts.label || '净值走势')}">
          <defs>
            <linearGradient id="ffArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${color}" stop-opacity="0.26" />
              <stop offset="100%" stop-color="${color}" stop-opacity="0.02" />
            </linearGradient>
          </defs>
          ${grid.map((g) => g.line).join('')}
          <path d="${area}" fill="url(#ffArea)" />
          <path class="c-line" d="${line}" stroke="${color}" vector-effect="non-scaling-stroke" />
          <line class="c-guide" x1="0" y1="${y0}" x2="0" y2="${y1}"
                vector-effect="non-scaling-stroke" style="display:none" />
        </svg>
        ${grid.map((g) => g.label).join('')}
        ${xLabels}
        ${dots}
        <div class="chart-tip"></div>
      </div>
      <div class="chart-legend">
        <span class="c-change ${up ? 'up' : 'down'}">${up ? '+' : ''}${changePct.toFixed(2)}%</span>
        <span class="muted">${esc(list[0].date)} ~ ${esc(list[lastIdx].date)} · ${list.length} 个交易日</span>
        <span class="muted">最新 ${fmtNav(last)}</span>
        <span class="muted">区间最高 ${fmtNav(rawMax)} / 最低 ${fmtNav(rawMin)}</span>
      </div>
    </div>`;

  const bind = (root) => {
    const svg = root.querySelector('.nav-chart');
    if (!svg) return;
    const plot = svg.parentElement;
    const tip = plot.querySelector('.chart-tip');
    const guide = svg.querySelector('.c-guide');
    const cursor = plot.querySelector('.chart-dot.cursor');

    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      const idx = Math.round(ratio * (list.length - 1));
      const p = list[idx];

      guide.setAttribute('x1', sx(idx).toFixed(1));
      guide.setAttribute('x2', sx(idx).toFixed(1));
      guide.style.display = '';
      cursor.style.display = '';
      cursor.style.left = `${px(idx)}%`;
      cursor.style.top = `${py(p.v)}%`;

      const vsFirst = first ? ((p.v - first) / first) * 100 : 0;
      tip.innerHTML =
        `<b>${esc(p.date)}</b> · 净值 ${fmtNav(p.v)}` +
        (idx === 0 ? '' : `<br/>较起点 <b>${vsFirst >= 0 ? '+' : ''}${vsFirst.toFixed(2)}%</b>`);
      tip.style.display = '';
      const left = (sx(idx) / VW) * rect.width;
      const tw = tip.offsetWidth || 120;
      tip.style.left = `${Math.min(Math.max(left - tw / 2, 0), rect.width - tw)}px`;
      tip.style.top = `${Math.max(((sy(p.v) / VH) * plot.clientHeight) - 58, 0)}px`;
    };

    const hide = () => {
      guide.style.display = 'none';
      cursor.style.display = 'none';
      tip.style.display = 'none';
    };

    svg.addEventListener('pointermove', (e) => move(e.clientX));
    svg.addEventListener('pointerdown', (e) => move(e.clientX));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);
  };

  return { html, bind };
}
