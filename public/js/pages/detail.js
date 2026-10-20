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
let root = null;
let code = '';
let chartHandle = null;

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

/** 按当前 range 从全量历史里按自然日筛出区间数据 */
function chartSeries() {
  const all = (data && data.history) || [];
  if (!all.length) return [];
  const last = new Date(all[all.length - 1].date + 'T00:00:00');
  const picked =
    range >= 9999
      ? all
      : all.filter((h) => (last - new Date(h.date + 'T00:00:00')) / 86400000 <= range - 1);
  return picked.map((h) => ({ v: h.nav, date: h.date }));
}

/** 生成图表句柄（html + bind + 本区间点数） */
function buildChart() {
  const points = chartSeries();
  const label = `${(data.adoption && data.adoption.nickname) || (data.fund && data.fund.name) || code} 净值走势`;
  const handle = navChart(points, { label });
  return { ...handle, items: points };
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

  /* ---------- 基金健康指标（替代原来的养鸡四维进度条） ---------- */
  const fm = f.metrics || {};
  const RISK_LABEL = ['', 'R1 低风险', 'R2 中低风险', 'R3 中风险', 'R4 中高风险', 'R5 高风险'];
  /**
   * 一条指标：signed=true 表示有正负（收益、夏普），进度条从中线向左右生长；
   * 否则按绝对值从左往右填充（回撤、波动率）。
   */
  const metricBar = (label, text, value, cls, tip, signed) => {
    const v = Number(value) || 0;
    let inner;
    if (signed) {
      const w = Math.min(50, Math.abs(v) * 50);
      const left = v >= 0 ? 50 : 50 - w;
      inner = `<span style="position:absolute;left:${left.toFixed(1)}%;width:${w.toFixed(1)}%"></span>`;
    } else {
      const w = Math.round(Math.max(0, Math.min(1, v)) * 100);
      inner = `<span style="width:${w}%"></span>`;
    }
    return `<div class="bar-row metric" title="${esc(tip)}">
      <span>${label}</span>
      <span class="bar${signed ? ' bi' : ''}${cls ? ' bar-' + cls : ''}">${inner}</span>
      <b class="${cls}">${text}</b>
    </div>`;
  };
  const hasHealth = [fm.syl1n, fm.maxDrawdown, fm.sharpe, fm.volatility].some((v) => typeof v === 'number');
  const riskTag =
    fm.riskLevel && RISK_LABEL[fm.riskLevel]
      ? `<span class="tag">${esc(RISK_LABEL[fm.riskLevel])}</span>`
      : '';
  const healthRows = hasHealth
    ? [
        typeof fm.syl1n === 'number'
          ? metricBar('近1年收益', pct(fm.syl1n), fm.syl1n / 50, fm.syl1n >= 0 ? 'up' : 'down', '近一年净值增长率（±50% 满格）', true)
          : '',
        typeof fm.maxDrawdown === 'number'
          ? metricBar('最大回撤', pct(-Math.abs(fm.maxDrawdown)), Math.abs(fm.maxDrawdown) / 60, 'warn', '近一年最大回撤，越小越稳（60% 满格）')
          : '',
        typeof fm.sharpe === 'number'
          ? metricBar(
              '夏普比率',
              fm.sharpe.toFixed(2),
              fm.sharpe / 3,
              fm.sharpe >= 1 ? 'up' : fm.sharpe < 0 ? 'down' : '',
              '近一年夏普比率，>1 说明风险调整后收益不错',
              true
            )
          : '',
        typeof fm.volatility === 'number'
          ? metricBar(
              '波动率',
              fm.volatility.toFixed(1) + '%',
              fm.volatility / 45,
              fm.volatility >= 30 ? 'down' : fm.volatility >= 20 ? 'warn' : '',
              '近一年年化波动率，越小越稳'
            )
          : '',
      ].join('')
    : '<div class="muted" style="font-size:12px">暂无健康指标数据（第三方接口暂不可用）</div>';
  const healthBlock = `<div style="margin-top:12px">
      <div class="card-title" style="margin:0 0 4px;font-size:13px">基金健康指标
        <span class="spacer"></span>${riskTag}
      </div>
      ${healthRows}
    </div>`;

  const header = `
    <div class="card">
      <div style="display:flex;gap:14px;align-items:center">
        <div style="flex:0 0 110px">${c ? chickenSVG(c, { size: 110, showHungry: true }) : '<div class="empty">未领养</div>'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:17px">${esc(data.adoption?.nickname || f.name || code)}</div>
          <div class="muted" style="font-size:13px">${esc(code)} · ${esc(f.category || f.type || '')} ${esc(f.company || '')}</div>
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
              <div class="chicken-actions" style="margin-top:10px">
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
          重点看<b>跟踪误差</b>、<b>规模</b>和<b>费率</b>，下面的重仓股即指数主要成分。
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

  const bondsCard =
    pf.bonds && pf.bonds.length
      ? `<div class="card">
        <div class="card-title">重仓债券<span class="spacer"></span>
          <span class="muted" style="font-weight:400;font-size:12px">${asOfText} · 合计 ${
          pf.bondPercent ? pf.bondPercent.toFixed(2) + '%' : '--'
        }</span></div>
        ${pf.bonds.map((it, i) => holdingRow(i, it, 'bond')).join('')}
        <div class="muted" style="font-size:12px;margin-top:6px">
          债券型基金重点看<b>久期</b>、<b>信用等级</b>与<b>杠杆</b>；信用债占比高时波动会明显大于利率债。
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

  const profileCards = `${indexCard}${stocksCard}${bondsCard}${subjectCard}${moneyCard}`;

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

  return `${header}${chart}${info}${profileCards}${holding}${reports}${notes}
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
