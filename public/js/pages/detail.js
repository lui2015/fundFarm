import { Api } from '../api.js';
import { chickenSVG } from '../chicken.js';
import { esc, pct, pctClass, fmtAmount, money, fmtDate, toast, modal, confirmBox, copyText } from '../util.js';
import { getState } from '../app.js';
import { showAchievements } from './yard.js';
import { uploadModal, linkReportModal, reportExcerpt } from './reports.js';
import { feedModal, patModal, noteModal } from './care.js';
import { navChart } from '../chart.js';
import { startLive } from '../live.js';

let data = null;
let range = 60;
let pnlRange = 60;
let alertType = 'buy';
let root = null;
let code = '';
let chartHandle = null;
let pnlHandle = null;

/** 基金规模（原始单位为元）→「x.xx 亿 / x.xx 万」 */
function fmtScale(v) {
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
  if (!isFinite(n) || !n) return '--';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
  return n.toFixed(2) + ' 元';
}

/** 持仓市值（万元）→「x.xx 亿 / xxx 万」 */
function fmtWan(v) {
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
  if (!isFinite(n) || !n) return '';
  return n >= 10000 ? (n / 10000).toFixed(2) + ' 亿' : n.toFixed(0) + ' 万';
}

/** 按自然日截取区间：只保留离最后一个点 range-1 天内的数据 */
function sliceByRange(points, days) {
  if (!points.length || days >= 9999) return points;
  const last = new Date(points[points.length - 1].date + 'T00:00:00');
  if (Number.isNaN(last.getTime())) return points;
  return points.filter((p) => (last - new Date(p.date + 'T00:00:00')) / 86400000 <= days - 1);
}

/** 按当前 range 从全量历史里按自然日筛出净值序列 */
function chartSeries() {
  const all = (data && data.history) || [];
  return sliceByRange(
    all.map((h) => ({ v: h.nav, date: h.date })),
    range
  );
}

/** 生成图表句柄（html + bind + 本区间点数） */
function buildChart() {
  const points = chartSeries();
  const label = `${(data.adoption && data.adoption.nickname) || (data.fund && data.fund.name) || code} 净值走势`;
  const handle = navChart(points, { label });
  return { ...handle, items: points };
}

/** 全量持仓盈亏序列（后端已按交易记录回放好，格式 [日期, 盈亏金额, 收益率]） */
function pnlPoints() {
  const rows = (data && data.pnl && data.pnl.points) || [];
  return rows
    .filter((r) => Array.isArray(r) && r[0])
    .map((r) => ({ date: String(r[0]), v: Number(r[1]), rate: Number(r[2]) }));
}

/** 持仓盈亏走势图：0 轴为盈亏分界，数值按金额（元）显示 */
function buildPnlChart() {
  const points = sliceByRange(pnlPoints(), pnlRange);
  const st = (getState() && getState().settings) || {};
  const amount = (v) => fmtAmount(v, st, 0);
  const signed = (v) => (Number(v) > 0 ? '+' : '') + amount(v);
  const label = `${(data.adoption && data.adoption.nickname) || (data.fund && data.fund.name) || code} 持仓盈亏走势`;

  const handle = navChart(points, {
    label,
    baseline: 0,
    fmt: amount,
    tip: (p) =>
      `<b>${esc(p.date)}</b> · 累计盈亏 ${signed(p.v)}` +
      (Number.isFinite(p.rate) ? `<br/>收益率 <b>${pct(p.rate, 2)}</b>` : ''),
    legend: (list) => {
      const lastP = list[list.length - 1];
      const vals = list.map((x) => x.v);
      const hi = Math.max(...vals);
      const lo = Math.min(...vals);
      return `<span class="c-change ${pctClass(lastP.v)}">${signed(lastP.v)}${
        Number.isFinite(lastP.rate) ? `（${pct(lastP.rate, 2)}）` : ''
      }</span>
      <span class="muted">${esc(list[0].date)} ~ ${esc(lastP.date)} · ${list.length} 个交易日</span>
      <span class="muted">区间最高 ${signed(hi)} / 最低 ${signed(lo)}</span>`;
    },
  });
  return { ...handle, items: points };
}

const PNL_EMPTY = '<div class="empty" style="padding:12px">暂无持仓盈亏数据</div>';

/** 当前价：优先实时估值，其次最新净值 */
function currentPrice() {
  const q = (data && data.quote) || {};
  const est = Number(q.estimate);
  if (Number.isFinite(est) && est > 0) return est;
  const nav = Number(q.nav);
  return Number.isFinite(nav) && nav > 0 ? nav : null;
}

/** 买入 / 卖出提醒卡片内容（增删后就地重绘这一块） */
function alertsInner() {
  const list = (data && data.alerts) || [];
  const cur = currentPrice();
  const rows = list.length
    ? list
        .map((a) => {
          const hit = !!a.triggered;
          const gapText = hit
            ? '已到达 ✓'
            : a.gap === null || a.gap === undefined
            ? '--'
            : `还差 ${money(a.gap, 4)}${a.gapPct === null ? '' : `（${pct(a.gapPct, 1)}${a.type === 'buy' ? ' 待跌' : ' 待涨'}）`}`;
          return `<div class="alert-row ${hit ? 'hit' : ''}">
            <span class="alert-tag ${esc(a.type)}">${a.type === 'buy' ? '买' : '卖'}</span>
            <span class="alert-target">到达 ${money(a.price, 4)}</span>
            <span class="spacer"></span>
            <span class="alert-gap ${hit ? 'hit' : ''}">${gapText}</span>
            <button class="alert-del" data-alert-del="${esc(a.id)}" title="删除这条提醒" aria-label="删除">×</button>
          </div>`;
        })
        .join('')
    : `<div class="muted" style="font-size:12px;padding:8px 0 2px">还没有提醒。跌到心理价位想加仓就设「买入」，涨到目标价想止盈就设「卖出」。</div>`;

  return `<div class="alert-form">
      <div class="seg alert-seg">
        <button data-alert-type="buy" class="${alertType === 'buy' ? 'active' : ''}">买入提醒</button>
        <button data-alert-type="sell" class="${alertType === 'sell' ? 'active' : ''}">卖出提醒</button>
      </div>
      <input class="input alert-input" data-alert-price type="number" step="0.0001" min="0" inputmode="decimal"
        placeholder="预期价（现价 ${cur === null ? '--' : money(cur, 4)}）" />
      <button class="btn small" data-alert-add ${list.length >= 6 ? 'disabled' : ''}>添加</button>
    </div>
    <div class="alert-list">${rows}</div>`;
}

async function rerender() {
  if (!root) return;
  data = await Api.fund(code);
  root.innerHTML = await render();
  await mount(root);
}

export async function render(param) {
  if (param) code = param; // rerender 时复用已保存的基金代码
  const s = getState();
  data = await Api.fund(code);
  const f = data.fund || {};
  const q = data.quote || {};
  const m = data.metrics || {};
  const c = data.chicken;

  /* ---------- 基金健康指标：两列，收益用同一把尺子，风险用区间条 ---------- */
  const fm = f.metrics || {};
  const RISK_LABEL = ['', 'R1 低风险', 'R2 中低风险', 'R3 中风险', 'R4 中高风险', 'R5 高风险'];
  // 收益类共用一把尺子：±50% 满格，中线为 0，条形长度可以直接横向比较
  const RET_RANGE = 50;

  const RET_DEFS = [
    { key: 'sylY', label: '近1月' },
    { key: 'syl3y', label: '近3月' },
    { key: 'syl6y', label: '近6月' },
    { key: 'sylJn', label: '今年来' },
    { key: 'syl1n', label: '近1年' },
    { key: 'syl2n', label: '近2年' },
    { key: 'syl3n', label: '近3年' },
    { key: 'sylLn', label: '成立来' },
  ];

  /** 双向条形：中线为 0，正红负绿（A 股习惯），range 为单侧满格刻度 */
  const barTile = (label, v, range, text, cls, tip) => {
    const w = Math.min(50, (Math.abs(v) / range) * 50);
    const left = v >= 0 ? 50 : 50 - w;
    return `<div class="m-cell" title="${esc(tip)}">
      <div class="m-top"><span class="m-label">${label}</span><b class="${cls}">${text}</b></div>
      <div class="m-bar"><span class="m-fill ${cls === 'up' ? 'up' : cls === 'down' ? 'down' : 'flat'}"
        style="left:${left.toFixed(1)}%;width:${w.toFixed(1)}%"></span></div>
    </div>`;
  };

  /** 单列整行：周期涨跌统一排成一列，条形更长、更好比 */
  const barRow = (label, v, range, text, cls, tip) => {
    const w = Math.min(50, (Math.abs(v) / range) * 50);
    const left = v >= 0 ? 50 : 50 - w;
    return `<div class="m-row" title="${esc(tip)}">
      <span class="m-label">${label}</span>
      <span class="m-bar"><span class="m-fill ${cls === 'up' ? 'up' : cls === 'down' ? 'down' : 'flat'}"
        style="left:${left.toFixed(1)}%;width:${w.toFixed(1)}%"></span></span>
      <b class="${cls}">${text}</b>
    </div>`;
  };

  const retRows = RET_DEFS.map((d) => {
    const v = fm[d.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    return barRow(d.label, v, RET_RANGE, pct(v), v >= 0 ? 'up' : 'down', `${d.label}净值增长率（±50% 刻度）`);
  }).filter(Boolean);

  /** 风险类：红黄绿区间条 + 游标，游标落在哪一段就是哪一档 */
  const RISK_TILES = [
    {
      key: 'maxDrawdown',
      label: '最大回撤',
      max: 60,
      cuts: [20, 40],
      sev: (v) => (v >= 40 ? 'danger' : v >= 20 ? 'warn' : 'ok'),
      text: (v) => pct(-Math.abs(v)),
      tip: '近 1 年最大回撤：<20% 温和 / 20~40% 偏大 / >40% 很大',
    },
    {
      key: 'volatility',
      label: '年化波动',
      max: 40,
      cuts: [15, 25],
      sev: (v) => (v >= 25 ? 'danger' : v >= 15 ? 'warn' : 'ok'),
      text: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)) + '%',
      tip: '近 1 年年化波动率：<15% 温和 / 15~25% 偏大 / >25% 剧烈',
    },
  ];

  const riskTiles = RISK_TILES.map((d) => {
    const raw = fm[d.key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return '';
    const v = Math.abs(raw);
    const sev = d.sev(v);
    const [a, b] = d.cuts;
    const x = Math.max(0, Math.min(1, v / d.max)) * 100;
    return `<div class="m-cell" title="${esc(d.tip)}">
      <div class="m-top"><span class="m-label">${d.label}</span><b class="${sev === 'ok' ? '' : 'risk-' + sev}">${d.text(raw)}</b></div>
      <div class="m-track">
        <span class="zone ok" style="flex:${a}"></span>
        <span class="zone warn" style="flex:${b - a}"></span>
        <span class="zone danger" style="flex:${d.max - b}"></span>
        <i class="m-pin" style="left:${x.toFixed(1)}%"></i>
      </div>
    </div>`;
  }).filter(Boolean);

  // 夏普：±3 为刻度，>1 才算风险调整后收益不错；货币基金波动趋 0 会被放大到 ±10 外，不展示
  const sharpeV = fm.sharpe;
  const sharpeTile =
    typeof sharpeV === 'number' && Number.isFinite(sharpeV) && Math.abs(sharpeV) <= 10
      ? barTile(
          '夏普比率',
          sharpeV,
          3,
          sharpeV.toFixed(2),
          sharpeV >= 1 ? 'up' : sharpeV < 0 ? 'down' : '',
          '近 1 年夏普比率：>1 说明风险调整后的收益不错（±3 刻度）'
        )
      : '';

  const lvl = fm.riskLevel;
  const riskLevelTile =
    typeof lvl === 'number' && RISK_LABEL[lvl]
      ? `<div class="m-cell" title="东财风险等级，R1 最低、R5 最高">
          <div class="m-top"><span class="m-label">风险等级</span><b class="${
            lvl >= 5 ? 'risk-danger' : lvl >= 4 ? 'risk-warn' : ''
          }">${RISK_LABEL[lvl]}</b></div>
          <div class="risk-scale lv${lvl}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= lvl ? 'on' : ''}"></i>`).join('')}</div>
        </div>`
      : '';

  /* ---------- 关键指标：右栏补充 8 项（年化 / 卡玛 / 胜率 / 规模 / 年限 / 集中度 / 费率） ---------- */
  const yearsSince = (d) => {
    if (!d) return null;
    const t = Date.parse(d);
    if (!Number.isFinite(t)) return null;
    return (Date.now() - t) / (365.25 * 864e5);
  };
  const annualize = (totalPct, years) => {
    if (typeof totalPct !== 'number' || !Number.isFinite(totalPct) || !years || years < 0.5) return null;
    const base = 1 + totalPct / 100;
    if (base <= 0) return null;
    return (Math.pow(base, 1 / years) - 1) * 100;
  };
  const fmtScale = (scale) => {
    const n = Number(scale);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : (n / 1e4).toFixed(0) + ' 万';
  };
  // 月度胜率：按自然月首末净值判断涨跌，取最近 24 个完整月
  const monthWin = (() => {
    const items = (data.history || []).filter((h) => h && h.date && Number.isFinite(Number(h.nav)));
    if (items.length < 60) return null;
    const groups = new Map();
    for (const it of items) {
      const key = String(it.date).slice(0, 7);
      const g = groups.get(key);
      if (!g) groups.set(key, { first: Number(it.nav), last: Number(it.nav) });
      else g.last = Number(it.nav);
    }
    const thisMonth = new Date().toISOString().slice(0, 7);
    const closed = [...groups.keys()].sort().filter((k) => k !== thisMonth).slice(-24);
    if (closed.length < 12) return null;
    const up = closed.filter((k) => groups.get(k).last > groups.get(k).first).length;
    return { up, n: closed.length, rate: (up / closed.length) * 100 };
  })();

  const extraRow = (label, value, cls, tip) => `<div class="m-row plain" title="${esc(tip)}">
      <span class="m-label">${label}</span><span class="m-dots"></span><b class="${cls}">${value}</b>
    </div>`;

  const extraRows = [];
  if (typeof fm.sylZ === 'number') {
    extraRows.push(extraRow('近1周', pct(fm.sylZ), fm.sylZ >= 0 ? 'up' : 'down', '近 1 周净值增长率'));
  }
  const yrs = yearsSince(f.established);
  const annual = annualize(fm.sylLn, yrs);
  if (annual !== null) {
    extraRows.push(
      extraRow('年化收益', pct(annual), annual >= 0 ? 'up' : 'down', `成立以来 ${yrs.toFixed(1)} 年的年化收益率`)
    );
  }
  const annual3 = annualize(fm.syl3n, 3);
  const calmar =
    annual3 !== null && typeof fm.maxDrawdown === 'number' && Math.abs(fm.maxDrawdown) > 0.5
      ? annual3 / Math.abs(fm.maxDrawdown)
      : null;
  if (calmar !== null) {
    extraRows.push(
      extraRow(
        '卡玛比率',
        calmar > 10 ? '>10' : calmar.toFixed(2),
        calmar >= 1 ? 'up' : calmar < 0 ? 'down' : '',
        '近 3 年年化收益 ÷ 最大回撤，>1 说明单位回撤换来的收益不错'
      )
    );
  }
  if (monthWin) {
    extraRows.push(
      extraRow('月度胜率', monthWin.rate.toFixed(0) + '%', '', `近 ${monthWin.n} 个月里 ${monthWin.up} 个月上涨`)
    );
  }
  const scaleTxt = fmtScale(f.scale);
  if (scaleTxt) extraRows.push(extraRow('基金规模', scaleTxt, '', '最新披露的基金资产净值'));
  if (yrs !== null) extraRows.push(extraRow('成立年限', yrs.toFixed(1) + ' 年', '', `成立日 ${f.established}`));
  const conc = data.profile ? data.profile.stockPercent || data.profile.bondPercent : null;
  if (typeof conc === 'number') {
    extraRows.push(
      extraRow(
        '前十持仓',
        conc.toFixed(1) + '%',
        '',
        conc > 100 ? '前十大重仓（债券）合计占净值比，超过 100% 说明有杠杆' : '前十大重仓合计占净值比'
      )
    );
  }
  if (typeof fm.rate === 'number') {
    extraRows.push(
      extraRow(
        '申购费率',
        fm.rate.toFixed(2) + '%',
        '',
        typeof fm.sourceRate === 'number' && fm.sourceRate !== fm.rate
          ? `折后申购费率，原价 ${fm.sourceRate}%`
          : '申购费率'
      )
    );
  }
  // 货币基金等没有回撤 / 持仓数据的品种，用交易信息把右栏补齐
  if (extraRows.length < 8 && fm.buyStatus) {
    extraRows.push(extraRow('申购状态', esc(fm.buyStatus), '', '第三方接口披露的申购状态'));
  }
  if (extraRows.length < 8 && typeof fm.minBuy === 'number' && fm.minBuy > 0) {
    extraRows.push(extraRow('起购金额', fm.minBuy + ' 元', '', '最低申购金额'));
  }

  const retCol = retRows.length
    ? `<div class="m-sub">区间涨跌<span class="m-sub-tip">共用 ±50% 刻度，中线为 0</span></div>
       <div class="m-rows">${retRows.join('')}</div>`
    : '';
  const extraCol = extraRows.length
    ? `<div class="m-sub">关键指标</div>
       <div class="m-rows">${extraRows.join('')}</div>`
    : '';
  const topCols =
    retCol || extraCol
      ? `<div class="health-cols">${
          retCol ? `<div class="health-col">${retCol}</div>` : ''
        }${extraCol ? `<div class="health-col">${extraCol}</div>` : ''}</div>`
      : '';
  const riskItems = [...riskTiles, sharpeTile, riskLevelTile].filter(Boolean);
  const riskBlock = riskItems.length
    ? `<div class="m-sub">风险与性价比</div>
       <div class="metric-grid">${riskItems.join('')}</div>`
    : '';

  // 风险画像：把三个风控指标翻译成一句人话
  const profileTags = [];
  if (typeof fm.volatility === 'number') {
    const v = fm.volatility;
    profileTags.push(v < 8 ? '低波动' : v < 15 ? '中低波动' : v < 25 ? '中高波动' : '高波动');
  }
  if (typeof fm.maxDrawdown === 'number') {
    const v = Math.abs(fm.maxDrawdown);
    profileTags.push(v < 10 ? '回撤温和' : v < 25 ? '回撤中等' : v < 40 ? '回撤偏大' : '回撤很大');
  }
  if (typeof sharpeV === 'number' && Math.abs(sharpeV) <= 10) {
    profileTags.push(sharpeV >= 1 ? '性价比好' : sharpeV >= 0 ? '性价比一般' : '性价比差');
  }

  const healthBlock = `<div class="metric-block">
      <div class="card-title" style="margin:0 0 6px;font-size:13px">基金健康指标
        <span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:11.5px">东方财富口径 · 近 1 年</span>
      </div>
      ${
        profileTags.length
          ? `<div class="m-profile">风险画像：${profileTags.map((t) => `<b>${esc(t)}</b>`).join(' · ')}</div>`
          : ''
      }
      ${
        topCols || riskBlock
          ? `${topCols}${riskBlock}
             <div class="m-legend">涨红跌绿；回撤 / 波动是红黄绿区间条，黑色游标是当前值</div>`
          : '<div class="muted" style="font-size:12px">暂无健康指标数据（第三方接口暂不可用）</div>'
      }
    </div>`;

  // 昵称可能被用户自定义（或历史数据被截断），基金全名单独显示一行，避免看不全
  const displayName = data.adoption?.nickname || f.name || code;
  const header = `
    <div class="card">
      <div style="display:flex;gap:14px;align-items:center">
        <div style="flex:0 0 110px">${c ? chickenSVG(c, { size: 110, showHungry: true }) : '<div class="empty">未领养</div>'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:17px;line-height:1.35;word-break:break-word">${esc(displayName)}</div>
          ${
            f.name && f.name !== displayName
              ? `<div class="muted" style="font-size:13px;word-break:break-word">${esc(f.name)}</div>`
              : ''
          }
          <div class="muted" style="font-size:13px">${esc(code)} · ${esc(f.category || f.type || '')} ${esc(f.company || '')}
            ${
              c && c.build
                ? `<span class="build-tag ${(data.metrics && data.metrics.profitRate) < 0 ? 'down' : (data.metrics && data.metrics.profitRate) > 0 ? 'up' : ''}">体型 · ${esc(c.build.label)}</span>`
                : ''
            }
          </div>
          <div style="margin-top:6px;font-size:26px;font-weight:800;display:flex;align-items:baseline;gap:8px" class="${pctClass(q.pct ?? m.current?.pct)}">
            <span data-live-pct="${esc(code)}">${q.pct !== undefined && q.pct !== null ? pct(q.pct) : '--'}</span>
            <span class="live-tag" data-live-state>实时</span>
            <button class="live-refresh" data-live-refresh title="立即刷新">↻</button>
          </div>
          <div class="muted" style="font-size:12px">
            估算 <b data-live-est="${esc(code)}">${q.estimate ?? '--'}</b> · 净值 ${q.nav ?? '--'} ${q.navDate ? '（' + esc(q.navDate) + '）' : ''}
            ${q.approx ? ' · 按最新持仓实时估算' : q.live === false ? ' · 数据可能延迟' : ''}
            <span data-live-time></span>
          </div>
        </div>
      </div>
      ${healthBlock}
      ${
        c
          ? `<div style="margin-top:12px">
              <div class="muted" style="font-size:12px">
                ${esc(c.breedName)}${c.look && c.look.name ? '（' + esc(c.look.name) + '）' : ''} · ${esc(c.stateLabel)} · 产蛋 ${c.eggs}（金蛋 ${c.goldenEggs}） · 掉毛 ${c.feathers}
              </div>
              <div class="muted" style="font-size:12px;margin-top:2px">
                养鸡状态：饱食 ${c.satiety} · 心情 ${c.moodValue} · 健康 ${c.health} · 亲密 ${c.bond}
              </div>
              <div class="chicken-actions" style="margin-top:10px;max-width:340px">
                <button class="btn ghost small" data-act="feed" data-id="${esc(c.id)}" ${
        c.canFeed ? '' : 'disabled'
      } title="喂食：需附一份报告或一条 ≥20 字心得">🌾 喂食</button>
                <button class="btn ghost small" data-act="pat" data-id="${esc(c.id)}" ${
        c.canPat ? '' : 'disabled'
      } title="抚摸：需写一句 ≥10 字心态笔记">🤲 抚摸</button>
              </div>
              <div class="muted" style="font-size:12px;margin-top:6px">
                喂食 / 安抚都需要附上投研素材：一份报告，或一条投资心得 / 心态笔记。
              </div>
            </div>`
          : `<button class="btn block" data-act="adopt-here" style="margin-top:12px">领养这只基金</button>`
      }
    </div>`;

  chartHandle = buildChart();
  const chart = `
    <div class="card">
      <div class="card-title">净值走势
        <span class="spacer"></span>
        <div class="seg chart-seg">
          ${[30, 60, 180, 9999]
            .map((r) => `<button data-range="${r}" class="${range === r ? 'active' : ''}">${r === 9999 ? '全部' : r + '天'}</button>`)
            .join('')}
        </div>
      </div>
      <div data-chart-slot>${
        chartHandle.items.length > 1 ? chartHandle.html : '<div class="empty" style="padding:12px">暂无净值数据</div>'
      }</div>
      ${
        data.historyStale
          ? '<div class="muted" style="font-size:12px;text-align:center">历史数据为本地缓存，第三方接口暂不可用</div>'
          : ''
      }
    </div>`;

  /* ---------- 按基金类型展示的关键信息 ---------- */
  const pf = data.profile || {};
  const cat = f.category || '';
  const isIndex = /^指数/.test(cat) || f.type === 'index';
  const isBond = /^债券/.test(cat) || f.type === 'bond';
  const isMoney = /货币/.test(cat) || f.type === 'money';
  const isQdii = /QDII|海外|国际|全球/.test(cat) || f.type === 'qdii';
  const MK = { hk: '港股', us: '美股', sh: 'A股', sz: 'A股' };
  const asOfText = pf.asOf ? `截至 ${esc(pf.asOf)}` : '';

  const holdingRow = (i, it, market) => `
    <div class="kv">
      <span class="k">${i + 1}. ${esc(it.name)}${market && market !== 'sh' && market !== 'sz' ? ` <span class="tag">${MK[market] || ''}</span>` : ''}
        <span class="muted" style="font-weight:400">${esc(it.code)}</span></span>
      <span>${Number(it.weight).toFixed(2)}%${fmtWan(it.marketValue) ? ' · ' + fmtWan(it.marketValue) : ''}</span>
    </div>`;

  const indexCard =
    isIndex && (f.indexName || f.indexCode)
      ? `<div class="card">
        <div class="card-title">跟踪指数</div>
        <div class="kv"><span class="k">指数名称</span><span>${esc(f.indexName || '--')}</span></div>
        ${f.indexCode ? `<div class="kv"><span class="k">指数代码</span><span>${esc(f.indexCode)}</span></div>` : ''}
        <div class="muted" style="font-size:12px;margin-top:6px">
          被动指数基金：不靠基金经理选股，净值跟着${esc(f.indexName || '标的指数')}走，
          重点看<b>跟踪误差</b>、<b>规模</b>和<b>费率</b>，下面的重仓${
            pf.stocks && pf.stocks.length ? '股' : '债券'
          }即指数主要成分。
        </div>
      </div>`
      : '';

  const stocksCard =
    pf.stocks && pf.stocks.length
      ? `<div class="card">
        <div class="card-title">十大重仓股<span class="spacer"></span>
          <span class="muted" style="font-weight:400;font-size:12px">${asOfText} · 合计 ${
          pf.stockPercent ? pf.stockPercent.toFixed(2) + '%' : '--'
        }</span></div>
        ${pf.stocks.map((it, i) => holdingRow(i, it, it.market)).join('')}
        <div class="muted" style="font-size:12px;margin-top:6px">
          前十大合计占净值 ${pf.stockPercent ? pf.stockPercent.toFixed(2) + '%' : '--'}，
          ${
            typeof pf.stockPercent === 'number' && pf.stockPercent >= 50
              ? '持股集中，单只标的波动对净值影响大。'
              : '持股相对分散。'
          }
          ${isQdii ? ' 含海外标的，净值披露通常比 A 股晚 1~2 天。' : ''}
        </div>
      </div>`
      : '';

  // 股票和债券都有数据时：债券型 / 混合型两类都展示；指数 / 股票型只在没有股票持仓时展示债券（避免噪音）
  const showBonds =
    pf.bonds &&
    pf.bonds.length &&
    (!pf.stocks || !pf.stocks.length || isBond || f.type === 'bond' || f.type === 'hybrid');
  const bondsCard = showBonds
    ? `<div class="card">
        <div class="card-title">重仓债券<span class="spacer"></span>
          <span class="muted" style="font-weight:400;font-size:12px">${asOfText} · 合计 ${
          pf.bondPercent ? pf.bondPercent.toFixed(2) + '%' : '--'
        }</span></div>
        ${pf.bonds.map((it, i) => holdingRow(i, it, 'bond')).join('')}
        <div class="muted" style="font-size:12px;margin-top:6px">
          ${
            isIndex
              ? '债券指数基金：上面的重仓债券即指数成分券，' +
                '重点看<b>久期</b>（决定对利率的敏感度）、<b>信用等级</b>与<b>跟踪误差</b>。'
              : '债券型基金重点看<b>久期</b>、<b>信用等级</b>与<b>杠杆</b>；信用债占比高时波动会明显大于利率债。'
          }
          ${
            typeof pf.bondPercent === 'number' && pf.bondPercent > 100
              ? ` 前十大合计 ${pf.bondPercent.toFixed(2)}% 超过 100%，说明<b>加了杠杆</b>（债券基金的常态操作）。`
              : ''
          }
        </div>
      </div>`
      : '';

  /* 股票、债券都取不到时的兜底，避免右侧出现空白卡片 */
  const noHoldingCard =
    !isMoney && !(pf.stocks && pf.stocks.length) && !showBonds
      ? `<div class="card">
        <div class="card-title">持仓明细</div>
        <div class="empty" style="padding:12px">
          暂时取不到这只基金的持仓披露
          <div class="muted" style="font-size:12px;margin-top:6px">
            季报 / 半年报披露后才会更新；货币基金不披露个券明细。可在
            <a href="https://fundf10.eastmoney.com/ccmx_${esc(code)}.html" target="_blank" rel="noopener noreferrer">基金档案</a>
            查看原始持仓。
          </div>
        </div>
      </div>`
      : '';

  const subjectCard =
    f.subjects && f.subjects.length
      ? `<div class="card">
        <div class="card-title">关联板块 / 主题</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${f.subjects
            .map(
              (s) =>
                `<span class="tag" style="font-size:12px">${esc(s.name)}${
                  typeof s.pct1m === 'number' ? ` <span class="${pctClass(s.pct1m)}">${pct(s.pct1m)}</span>` : ''
                }</span>`
            )
            .join('')}
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">板块后的百分比为该板块近 1 月涨跌，方便判断基金近期受哪个主题驱动。</div>
      </div>`
      : '';

  const moneyCard = isMoney
    ? `<div class="card">
        <div class="card-title">货币基金怎么看</div>
        <div class="muted" style="font-size:12px">
          货币基金不披露重仓股债明细，重点看<b>7 日年化收益率</b>、<b>万份收益</b>、<b>规模</b>与<b>赎回速度</b>；
          本工具暂不展示 7 日年化，请以基金公司公告为准。
        </div>
      </div>`
    : '';

  const profileCards = `${indexCard}${stocksCard}${bondsCard}${noHoldingCard}${subjectCard}${moneyCard}`;

  const info = `
    <div class="card">
      <div class="card-title">基金档案</div>
      <div class="kv"><span class="k">基金类型</span><span>${esc(f.category || f.type || '--')}</span></div>
      ${
        f.indexName
          ? `<div class="kv"><span class="k">跟踪指数</span><span>${esc(f.indexName)}</span></div>`
          : ''
      }
      <div class="kv"><span class="k">基金公司</span><span>${esc(f.company || '--')}</span></div>
      <div class="kv"><span class="k">基金经理</span><span>${esc(f.manager || '--')}</span></div>
      <div class="kv"><span class="k">成立时间</span><span>${esc(f.established || '--')}</span></div>
      <div class="kv"><span class="k">基金规模</span><span>${esc(fmtScale(f.scale))}</span></div>
    </div>`;

  const inYard = Number(data.adoption && data.adoption.costPrice) > 0 && Number(data.adoption && data.adoption.shares) > 0;
  const holding = data.adopted
    ? `
    <div class="card">
      <div class="card-title">我的持仓<span class="spacer"></span>
        <button class="btn ghost small" data-act="edit">编辑</button></div>
      ${
        inYard
          ? ''
          : `<div class="yard-gate">
              <span>🐣 还没设置持仓：这只鸡现在只在自选里观察，<b>填好成本价与份额后才会进鸡舍</b>。</span>
              <button class="btn small" data-act="edit">设置持仓</button>
            </div>`
      }
      <div class="grid-3">
        <div class="stat"><div class="v">${fmtAmount(data.adoption.costPrice, s.settings, 4)}</div><div class="k">成本价</div></div>
        <div class="stat"><div class="v">${data.adoption.shares ?? '--'}</div><div class="k">份额</div></div>
        <div class="stat"><div class="v">${fmtAmount(m.marketValue, s.settings, 0)}</div><div class="k">市值</div></div>
      </div>
      <div class="kv" style="margin-top:8px"><span class="k">持仓盈亏</span>
        <span class="${pctClass(m.profit)}">${m.profit === null ? '--' : fmtAmount(m.profit, s.settings)}（${
        m.profitRate === null ? '--' : pct(m.profitRate, 1)
      }）</span></div>
      <div class="kv"><span class="k">持有天数</span><span>${data.adoption.holdingDays} 天</span></div>
      <div class="grid-2" style="margin-top:10px">
        <button class="btn ghost small" data-act="add-trade">记录一笔买入/卖出</button>
        <button class="btn ghost small" data-act="release">放归这只鸡</button>
      </div>
      ${
        (data.trades || []).length
          ? `<div style="margin-top:10px">${data.trades
              .slice(0, 5)
              .map(
                (t) =>
                  `<div class="kv"><span class="k">${esc(t.date)} ${t.type === 'buy' ? '买入' : '卖出'}</span><span>${money(
                    t.price,
                    4
                  )} × ${t.shares}</span></div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`
    : '';

  // 买入 / 卖出提醒：到价后鸡舍卡片上会亮角标
  const alertsCard = `
    <div class="card" data-alerts-card>
      <div class="card-title">🔔 买入 / 卖出提醒
        <span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">
          <span data-alert-count>${((data && data.alerts) || []).length}</span>/6
        </span>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">
        较的是实时估值：跌到买入价、涨到卖出价就算到达，鸡舍里这只鸡的卡片会亮起角标。
      </div>
      <div data-alerts-body>${alertsInner()}</div>
    </div>`;

  // 持仓盈亏走势：只在有份额与成本、且历史足够画线时出现
  pnlHandle = null;
  let pnlCard = '';
  if (inYard && data.adopted && pnlPoints().length > 1) {
    pnlHandle = buildPnlChart();
    pnlCard = `
    <div class="card">
      <div class="card-title">持仓盈亏走势
        <span class="spacer"></span>
        <div class="seg chart-seg">
          ${[30, 60, 180, 9999]
            .map(
              (r) =>
                `<button data-prange="${r}" class="${pnlRange === r ? 'active' : ''}">${
                  r === 9999 ? '全部' : r + '天'
                }</button>`
            )
            .join('')}
        </div>
      </div>
      <div data-pnl-slot>${
        pnlHandle.items.length > 1 ? pnlHandle.html : PNL_EMPTY
      }</div>
      <div class="muted" style="font-size:12px;margin-top:8px">
        按历史净值 × 当时的份额与成本还原${(data.trades || []).length ? '，买卖记录按日回放' : ''}；曲线末端为实时估值。
      </div>
    </div>`;
  }

  const reports = `
    <div class="card">
      <div class="card-title">研究报告<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">${(data.reports || []).length} 份</span>
      </div>
      <div class="grid-3" style="margin-bottom:10px">
        <button class="btn small" data-act="upload">新增报告</button>
        <button class="btn ghost small" data-act="link-report">关联已有</button>
        <button class="btn ghost small" data-act="prompt">AI 提示词</button>
      </div>
      ${
        data.reports && data.reports.length
          ? data.reports.map(reportItemHtml).join('')
          : `<div class="empty" style="padding:14px">还没有关联的报告<br/>可新增一份，或从「报告」库中关联已有报告</div>`
      }
      <div class="ai-note" style="margin-top:10px">
        AI 解析结果由模型生成，可能存在偏差，仅供参考，不构成投资建议。请以原文为准。
      </div>
    </div>`;

  const notes = `
    <div class="card">
      <div class="card-title">投研心得<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">${(data.notes || []).length} 条</span>
      </div>
      <div class="grid-2" style="margin-bottom:10px">
        <button class="btn small" data-act="add-note">写一条心得</button>
        <button class="btn ghost small" data-act="feed-with">用报告/心得加餐</button>
      </div>
      ${
        data.notes && data.notes.length
          ? data.notes.map(noteItemHtml).join('')
          : `<div class="empty" style="padding:14px">还没有心得记录<br/>写下一条：为什么持有、看到了什么变化、守住了哪条纪律</div>`
      }
      <div class="muted" style="font-size:12px;margin-top:8px">
        喂食与安抚留下的心得都会汇总到这里，形成这只鸡的投研时间线。
      </div>
    </div>`;

  // 桌面端左右分栏：主栏放走势/持仓/报告/心得，右栏放类型关键信息与基金档案
  return `<div class="detail-split">
      <div class="detail-main">${header}${chart}${holding}${alertsCard}${pnlCard}${reports}${notes}</div>
      <div class="detail-side">${profileCards}${info}</div>
    </div>
    <div class="disclaimer">数据来源：第三方公开接口，可能存在延迟或误差。<br/>本工具仅供个人学习研究，不构成投资建议。</div>`;
}

const NOTE_KIND = { feed: '加餐素材', mood: '心态笔记', note: '投资心得', review: '复盘' };

function noteItemHtml(n) {
  return `<div class="note-item" data-note="${esc(n.id)}">
    <div style="display:flex;gap:8px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="note-text">${esc(n.content)}</div>
        <div class="muted" style="font-size:11px;margin-top:4px">
          <span class="tag">${esc(NOTE_KIND[n.kind] || n.kind)}</span>
          ${esc(String(n.createdAt || '').replace('T', ' ').slice(0, 16))}
        </div>
      </div>
      <button class="btn ghost small" data-delnote="${esc(n.id)}">删除</button>
    </div>
  </div>`;
}

function reportItemHtml(r) {
  const excerpt = reportExcerpt(r, 140);
  return `<div class="report-item" data-report="${esc(r.id)}">
    <div style="display:flex;gap:8px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="ri-title">${esc(r.title)}</div>
        <div class="muted" style="font-size:12px">
          ${esc(r.reportDate || '')}${
    { html: ' · HTML', markdown: ' · Markdown', text: ' · 文本', file: ' · 文件' }[r.contentType || ''] || ''
  }
        </div>
        ${excerpt ? `<div class="ri-excerpt">${esc(excerpt)}</div>` : ''}
        ${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
      <div style="display:flex;gap:6px">
        ${
          r.contentType === 'html'
            ? `<a class="btn small" href="api/v1/reports/${encodeURIComponent(
                r.id
              )}/raw" target="_blank" rel="noopener">全屏打开</a>`
            : `<button class="btn ghost small" data-viewr="${esc(r.id)}">查看</button>`
        }
        <button class="btn ghost small" data-del="${esc(r.id)}">删除</button>
      </div>
    </div>
  </div>`;
}

export async function mount(r) {
  root = r;
  startLive(r);

  const slot = r.querySelector('[data-chart-slot]');
  if (chartHandle && chartHandle.bind) chartHandle.bind(slot || r);

  // 切换区间：只重画图表，不整页重渲染、不重新请求接口
  r.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      const next = Number(b.getAttribute('data-range'));
      if (next === range) return;
      range = next;
      r.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('active', x === b));
      chartHandle = buildChart();
      if (!slot) return;
      slot.innerHTML =
        chartHandle.items.length > 1 ? chartHandle.html : '<div class="empty" style="padding:12px">暂无净值数据</div>';
      if (chartHandle.bind) chartHandle.bind(slot);
    };
  });

  // 持仓盈亏走势：绑定指针提示 + 独立的区间切换
  const pnlSlot = r.querySelector('[data-pnl-slot]');
  if (pnlHandle && pnlHandle.bind) pnlHandle.bind(pnlSlot || r);
  r.querySelectorAll('[data-prange]').forEach((b) => {
    b.onclick = () => {
      const next = Number(b.getAttribute('data-prange'));
      if (next === pnlRange) return;
      pnlRange = next;
      r.querySelectorAll('[data-prange]').forEach((x) => x.classList.toggle('active', x === b));
      pnlHandle = buildPnlChart();
      if (!pnlSlot) return;
      pnlSlot.innerHTML = pnlHandle.items.length > 1 ? pnlHandle.html : PNL_EMPTY;
      if (pnlHandle.bind) pnlHandle.bind(pnlSlot);
    };
  });

  /* 买入 / 卖出提醒：增删后只重绘这张卡片，不整页刷新 */
  const alertsCardEl = r.querySelector('[data-alerts-card]');
  if (alertsCardEl) {
    const body = alertsCardEl.querySelector('[data-alerts-body]');
    const countEl = alertsCardEl.querySelector('[data-alert-count]');
    const bindAlerts = () => {
      body.querySelectorAll('[data-alert-type]').forEach((b) => {
        b.onclick = () => {
          alertType = b.getAttribute('data-alert-type');
          drawAlerts();
        };
      });
      const input = body.querySelector('[data-alert-price]');
      const addBtn = body.querySelector('[data-alert-add]');
      if (addBtn) {
        addBtn.onclick = async () => {
          const v = Number(input && input.value);
          if (!Number.isFinite(v) || v <= 0) {
            toast('先填一个大于 0 的预期价');
            return;
          }
          addBtn.disabled = true;
          try {
            const out = await Api.addAlert(code, { type: alertType, price: v });
            data.alerts = out.alerts || [];
            if (out.current) data.quote = { ...(data.quote || {}), estimate: out.current };
            toast(alertType === 'buy' ? '买入提醒已设置' : '卖出提醒已设置');
            drawAlerts();
          } catch (err) {
            toast((err.payload && err.payload.message) || '设置失败，稍后再试');
            addBtn.disabled = false;
          }
        };
      }
      body.querySelectorAll('[data-alert-del]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-alert-del');
          try {
            await Api.delAlert(code, id);
            data.alerts = ((data && data.alerts) || []).filter((x) => x.id !== id);
            drawAlerts();
          } catch (e) {
            toast('删除失败，稍后再试');
          }
        };
      });
    };
    const drawAlerts = () => {
      body.innerHTML = alertsInner();
      if (countEl) countEl.textContent = ((data && data.alerts) || []).length;
      bindAlerts();
    };
    bindAlerts();
  }

  const chickenId = data.chicken ? data.chicken.id : '';
  const nickname = (data.adoption && data.adoption.nickname) || (data.fund && data.fund.name) || code;
  const afterInteract = (out) => {
    if (out && out.newAchievements?.length) showAchievements(out.newAchievements);
    rerender();
  };

  const feedBtn = r.querySelector('[data-act="feed"]');
  if (feedBtn)
    feedBtn.onclick = () => {
      if (feedBtn.disabled) return;
      feedModal({ id: chickenId, fundCode: code, nickname }, afterInteract);
    };
  const patBtn = r.querySelector('[data-act="pat"]');
  if (patBtn)
    patBtn.onclick = () => {
      if (patBtn.disabled) return;
      patModal({ id: chickenId, fundCode: code, nickname }, afterInteract);
    };

  const addNoteBtn = r.querySelector('[data-act="add-note"]');
  if (addNoteBtn) addNoteBtn.onclick = () => noteModal(code, () => rerender());

  const feedWith = r.querySelector('[data-act="feed-with"]');
  if (feedWith)
    feedWith.onclick = () => {
      if (!data.chicken) return toast('先领养这只基金，才能给它加餐');
      feedModal({ id: chickenId, fundCode: code, nickname }, afterInteract);
    };

  r.querySelectorAll('[data-delnote]').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute('data-delnote');
      confirmBox('删除这条心得？', '删除后不可恢复。', async () => {
        try {
          await Api.delNote(id);
          toast('已删除');
          rerender();
        } catch (e) {
          toast('删除失败：' + e.message);
        }
      });
    };
  });

  const adoptHere = r.querySelector('[data-act="adopt-here"]');
  if (adoptHere)
    adoptHere.onclick = async () => {
      try {
        const out = await Api.adopt({ code });
        toast('领养成功');
        if (out.newAchievements?.length) showAchievements(out.newAchievements);
        rerender();
      } catch (e) {
        toast('领养失败：' + e.message);
      }
    };

  const openEdit = () => {
    const a = data.adoption;
    modal(
      '编辑持仓',
      () => `
        <div class="field"><label>昵称</label><input class="input" id="ed-nick" value="${esc(a.nickname || '')}"></div>
        <div class="field"><label>成本价</label><input class="input" id="ed-cost" type="number" step="0.0001" value="${a.costPrice ?? ''}"></div>
        <div class="field"><label>份额</label><input class="input" id="ed-shares" type="number" step="0.01" value="${a.shares ?? ''}"></div>
        <div class="field"><label>首次买入日期</label><input class="input" id="ed-date" type="date" value="${esc(a.firstBuyDate || '')}"></div>
        <div class="muted" style="font-size:12px;margin-top:-6px">成本价与份额都填了才算建仓，这只鸡才会进鸡舍。</div>
        <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>保存</button></div>`,
      (body, close) => {
        body.querySelector('[data-no]').onclick = close;
        body.querySelector('[data-ok]').onclick = async () => {
          await Api.updateFund(code, {
            nickname: body.querySelector('#ed-nick').value,
            costPrice: body.querySelector('#ed-cost').value,
            shares: body.querySelector('#ed-shares').value,
            firstBuyDate: body.querySelector('#ed-date').value || null,
          });
          close();
          toast('已保存');
          rerender();
        };
      }
    );
  };
  r.querySelectorAll('[data-act="edit"]').forEach((b) => {
    b.onclick = openEdit;
  });

  const tradeBtn = r.querySelector('[data-act="add-trade"]');
  if (tradeBtn)
    tradeBtn.onclick = () => {
      modal(
        '记录一笔交易',
        () => `
        <div class="grid-2">
          <div class="field"><label>日期</label><input class="input" id="tr-date" type="date" value="${new Date()
            .toISOString()
            .slice(0, 10)}"></div>
          <div class="field"><label>类型</label><select class="input" id="tr-type"><option value="buy">买入</option><option value="sell">卖出</option></select></div>
          <div class="field"><label>成交价</label><input class="input" id="tr-price" type="number" step="0.0001"></div>
          <div class="field"><label>份额</label><input class="input" id="tr-shares" type="number" step="0.01"></div>
        </div>
        <div class="muted" style="font-size:12px">记录后会自动按移动加权更新成本价与份额</div>
        <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>保存</button></div>`,
        (body, close) => {
          body.querySelector('[data-no]').onclick = close;
          body.querySelector('[data-ok]').onclick = async () => {
            const price = body.querySelector('#tr-price').value;
            const shares = body.querySelector('#tr-shares').value;
            if (!price || !shares) return toast('请填写成交价与份额');
            await Api.addTrade(code, {
              date: body.querySelector('#tr-date').value,
              type: body.querySelector('#tr-type').value,
              price,
              shares,
            });
            close();
            toast('已记录');
            rerender();
          };
        }
      );
    };

  const relBtn = r.querySelector('[data-act="release"]');
  if (relBtn)
    relBtn.onclick = () => {
      confirmBox('放归这只鸡？', '30 天内可再次领养恢复（成长记录保留）。', async () => {
        await Api.release(code);
        toast('已放归');
        location.hash = '#/funds';
      });
    };

  const upBtn = r.querySelector('[data-act="upload"]');
  if (upBtn) upBtn.onclick = () => uploadModal(code, () => rerender());

  const lkBtn = r.querySelector('[data-act="link-report"]');
  if (lkBtn) lkBtn.onclick = () => linkReportModal(code, () => rerender());

  const prBtn = r.querySelector('[data-act="prompt"]');
  if (prBtn)
    prBtn.onclick = () => {
      let fmt = 'html';
      const cache = {};
      const load = async () => {
        if (cache[fmt]) return cache[fmt];
        cache[fmt] = await Api.aiPrompt(code, fmt);
        return cache[fmt];
      };
      modal(
        '给 AI 的调用提示词',
        () => `
          <div class="muted" style="font-size:13px">
            复制给任意 AI 助手（ChatGPT / 元宝 / Claude…），它会检索资料、生成
            <b>HTML 报告</b>并调用养基场开放接口写入本基金。
          </div>
          <div class="seg" id="pm-fmt" style="margin:10px 0">
            <button data-pfmt="html" class="active">HTML 格式（推荐）</button>
            <button data-pfmt="markdown">Markdown 格式</button>
          </div>
          <pre class="prompt-box" id="pm-text">正在生成提示词…</pre>
          <details style="margin-top:10px">
            <summary style="cursor:pointer;font-size:13px">查看开放接口清单</summary>
            <pre class="prompt-box" id="pm-endpoints" style="margin-top:8px"></pre>
          </details>
          <div class="ai-note">提示词中的 <b>{API_KEY}</b> 请替换为「我的 → 开发者 API Key」生成的密钥（fa_ 前缀）。</div>
          <div class="modal-actions">
            <button class="btn" data-copy>复制提示词</button>
            <button class="btn ghost" data-close>关闭</button>
          </div>`,
        (body, close) => {
          const fill = async () => {
            const box = body.querySelector('#pm-text');
            box.textContent = '正在生成提示词…';
            try {
              const r2 = await load();
              box.textContent = r2.prompt;
              body.querySelector('#pm-endpoints').textContent =
                `${r2.base || ''}/api/v1\n\n` + (r2.endpoints || []).map((e) => '· ' + e).join('\n');
            } catch (e) {
              box.textContent = '生成失败：' + e.message;
            }
          };
          body.querySelectorAll('#pm-fmt [data-pfmt]').forEach((b) => {
            b.onclick = () => {
              fmt = b.getAttribute('data-pfmt');
              body
                .querySelectorAll('#pm-fmt [data-pfmt]')
                .forEach((x) => x.classList.toggle('active', x === b));
              fill();
            };
          });
          body.querySelector('[data-close]').onclick = close;
          body.querySelector('[data-copy]').onclick = async () => {
            try {
              await copyText(body.querySelector('#pm-text').textContent);
              toast('已复制，发给你的 AI 助手即可');
            } catch (e) {
              toast('复制失败，请手动选择文本');
            }
          };
          fill();
        }
      );
    };

  r.querySelectorAll('[data-viewr]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      location.hash =
        '#/report/' + encodeURIComponent(b.getAttribute('data-viewr')) + '?from=fund/' + encodeURIComponent(code);
    };
  });

  r.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.getAttribute('data-del');
      confirmBox('删除报告？', '删除后无法恢复。', async () => {
        await Api.delReport(id);
        toast('已删除');
        rerender();
      });
    };
  });
}
