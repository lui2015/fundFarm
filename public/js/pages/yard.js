import { Api } from '../api.js';
import { chickenSVG, eventEmoji, yardBgClass, yardBgFx } from '../chicken.js';
import { esc, pct, pctClass, fmtAmount, money, fmtTime, toast, modal } from '../util.js';
import { getState } from '../app.js';
import { feedModal, patModal } from './care.js';
import { startLive } from '../live.js';
import { weatherArt } from '../weather.js';

let data = null;
let root = null;

/** 鸡舍排序：默认（自定义顺序）/ 仓位 / 收益率 / 今日涨跌 / 名称 */
const SORT_KEYS = ['default', 'weight', 'profitRate', 'todayPct', 'name'];
let sortKey = (() => {
  try {
    const v = localStorage.getItem('ff.yardSort');
    return SORT_KEYS.includes(v) ? v : 'default';
  } catch (err) {
    return 'default';
  }
})();

/** 鸡舍类型筛选：全部 / 股票型 / 指数型 …（只列出鸡舍里真实存在的类型） */
const TYPE_LABELS = [
  ['equity', '股票型'],
  ['index', '指数型'],
  ['hybrid', '混合型'],
  ['bond', '债券型'],
  ['money', '货币型'],
  ['qdii', 'QDII'],
  ['fof', 'FOF'],
  ['other', '其他'],
];
let typeKey = (() => {
  try {
    const v = localStorage.getItem('ff.yardType') || '';
    return TYPE_LABELS.some(([k]) => k === v) ? v : '';
  } catch (err) {
    return '';
  }
})();

/** 当前鸡舍里各类型的只数（用于下拉里的「指数型 3」） */
function typeOptions() {
  const items = (data && data.items) || [];
  const counts = {};
  items.forEach((it) => {
    const k = it.type || 'other';
    counts[k] = (counts[k] || 0) + 1;
  });
  return TYPE_LABELS.filter(([k]) => counts[k]).map(([k, label]) => [k, `${label} ${counts[k]}`]);
}

/**
 * 类型筛选只切换卡片的 display，不重渲染、不重新请求，
 * 排序结果与卡片上的点击 / 喂食 / 抚摸事件都不受影响。
 */
function applyTypeFilter(r) {
  const items = (data && data.items) || [];
  const rec = new Map(items.map((it) => [it.fundCode, it.type || 'other']));
  let shown = 0;
  r.querySelectorAll('.chicken-card[data-code]').forEach((el) => {
    const t = rec.get(el.getAttribute('data-code')) || 'other';
    const ok = !typeKey || t === typeKey;
    el.style.display = ok ? '' : 'none';
    if (ok) shown++;
  });
  const cnt = r.querySelector('[data-yard-count]');
  if (cnt) cnt.textContent = typeKey ? `共 ${shown} / ${items.length} 只` : `共 ${items.length} 只`;
}

/**
 * 排序只重排已有卡片节点（appendChild），不重新渲染、不重新请求，
 * 这样卡片上的点击 / 喂食 / 抚摸事件全部保留。
 */
function resortCards(r) {
  const grid = r.querySelector('.chicken-grid');
  if (!grid || !data) return;
  const list = data.items || [];
  const order = new Map(list.map((it, i) => [it.fundCode, i]));
  const rec = new Map(list.map((it) => [it.fundCode, it]));
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : -Infinity);
  const cmp = {
    default: (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    weight: (a, b) => num(rec.get(b)?.marketValue) - num(rec.get(a)?.marketValue),
    profitRate: (a, b) => num(rec.get(b)?.profitRate) - num(rec.get(a)?.profitRate),
    todayPct: (a, b) => num(rec.get(b)?.todayPct) - num(rec.get(a)?.todayPct),
    name: (a, b) =>
      String(rec.get(a)?.nickname || '').localeCompare(String(rec.get(b)?.nickname || ''), 'zh-CN'),
  };
  const fn = cmp[sortKey] || cmp.default;
  [...grid.children]
    .filter((el) => el.classList.contains('chicken-card'))
    .sort((x, y) => fn(x.getAttribute('data-code'), y.getAttribute('data-code')))
    .forEach((el) => grid.appendChild(el));
}

/** 鸡舍卡片上的「调整持仓」：直接改成本价 / 份额 / 昵称 / 建仓日 */
function positionModal(code, onSaved) {
  const it = (data && data.items ? data.items : []).find((x) => x.fundCode === code);
  if (!it) return;
  modal(
    `调整持仓 · ${it.nickname || code}`,
    () => `
      <div class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">
        改完成本价与份额后，盈亏、仓位、体型和各页统计会立即按新数据重算；
        <b>成本价或份额留空 = 退出鸡舍</b>，回到自选里观察。
      </div>
      <div class="field"><label>昵称</label><input class="input" id="yp-nick" value="${esc(it.nickname || '')}"></div>
      <div class="grid-2">
        <div class="field"><label>成本价</label><input class="input" id="yp-cost" type="number" step="0.0001" inputmode="decimal" value="${
          it.costPrice ?? ''
        }"></div>
        <div class="field"><label>份额</label><input class="input" id="yp-shares" type="number" step="0.01" inputmode="decimal" value="${
          it.shares ?? ''
        }"></div>
      </div>
      <div class="field"><label>首次买入日期</label><input class="input" id="yp-date" type="date" value="${esc(
        it.firstBuyDate || ''
      )}"></div>
      <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>保存</button></div>`,
    (body, close) => {
      body.querySelector('[data-no]').onclick = close;
      body.querySelector('[data-ok]').onclick = async () => {
        const okBtn = body.querySelector('[data-ok]');
        okBtn.disabled = true;
        try {
          await Api.updateFund(code, {
            nickname: body.querySelector('#yp-nick').value,
            costPrice: body.querySelector('#yp-cost').value,
            shares: body.querySelector('#yp-shares').value,
            firstBuyDate: body.querySelector('#yp-date').value || null,
          });
          close();
          toast('持仓已更新');
          if (onSaved) await onSaved();
        } catch (e) {
          okBtn.disabled = false;
          toast('保存失败：' + (e.message || '请稍后重试'));
        }
      };
    }
  );
}

const GI_FLAG = { A股: '🇨🇳', 港股: '🇭🇰', 亚太: '🌏', 美股: '🇺🇸', 欧洲: '🇪🇺', 其他: '🌐' };
let giCache = null;

async function rerender() {
  if (!root) return;
  root.innerHTML = await render();
  await mount(root);
}

export async function render() {
  const s = getState();
  // 等级与「我的」页同源（/me/level 按本地净值算），避免两处口径不一致
  const [yardData, lv] = await Promise.all([Api.yard(), Api.level().catch(() => null)]);
  data = yardData;
  const lvl = lv && lv.level ? lv.level : null;
  const w = data.weather || {};
  const idx = w.index;
  const sum = data.summary || {};
  const hasHolding = sum.marketValue !== null && sum.cost !== null;

  // 天气条里的一句闲话：填补右侧空白，也让首屏更有情绪
  const W_TIPS = {
    sunny: '阳光正好，鸡在院子里撒欢',
    cloudy: '云层有点厚，正适合躺着看鸡',
    overcast: '天有点阴，顺手给自己泡杯茶',
    rain: '下雨了，鸡都躲进窝里，别慌',
    storm: '雷雨天，账户和心情都先放一边',
  };
  const wTip = W_TIPS[w.key] || W_TIPS.cloudy;

  const weatherCard = `
    <div class="weather-bar ${esc(w.key || 'cloudy')}">
      ${weatherArt(w.key)}
      <div class="w-label">
        <div class="w-num">${esc(w.label || '多云')}</div>
        <div class="w-tip">${esc(wTip)}</div>
      </div>
      <div class="w-meta">
        <button class="idx-btn" data-act="global-indices" title="查看全球大盘指数">
          ${
            idx
              ? `<span data-live-index>${esc(idx.name)} <span class="${pctClass(idx.pct)}">${pct(idx.pct)}</span></span>`
              : '<span>大盘数据暂不可用</span>'
          }
          <span class="idx-more">🌍 全球</span>
        </button>
        <span class="w-sep">·</span>
        <span class="w-sum">鸡舍今日<span data-live-summary="updown">${
          sum.total ? ` ${sum.up} 涨 ${sum.down} 跌` : '空空如也'
        }</span></span>
      </div>
      <div class="w-pnl">
        <div class="w-main w-pnl-top">今日总盈亏 <span class="live-tag" data-live-state>实时</span>
          <button class="live-refresh" data-live-refresh title="立即刷新">↻</button></div>
        <div class="w-num ${pctClass(sum.todayPct)}" data-live-summary="todayPct">${sum.todayPct === null ? '--' : pct(sum.todayPct)}</div>
        <div class="w-main w-time" data-live-time>更新于 --:--:--</div>
      </div>
    </div>`;

  const levelChip = lvl
    ? `<span class="lv-chip" title="养基等级 Lv.${lvl.level}/${lvl.total}：${
        lvl.next ? `距「${esc(lvl.next.name)}」还差 ${lvl.next.need.toFixed(1)} 个百分点` : '已是最高等级'
      }">${lvl.emoji} ${esc(lvl.name)}</span>`
    : '';

  const summaryCard = `
    <div class="card">
      <div class="card-title">今日概况<span class="spacer"></span>${levelChip}
        <span class="muted" style="font-weight:400;font-size:12px">${data.date}</span></div>
      <div class="grid-4">
        <div class="stat"><div class="v ${pctClass(sum.todayPct)}" data-live-summary="todayPct">${sum.todayPct === null ? '--' : pct(sum.todayPct)}</div><div class="k">今日估算</div></div>
        <div class="stat"><div class="v ${pctClass(sum.todayProfit)}" data-live-summary="todayProfit">${sum.todayProfit === null || sum.todayProfit === undefined ? '--' : fmtAmount(sum.todayProfit, s.settings, 0)}</div><div class="k">今日盈亏</div></div>
        <div class="stat"><div class="v" data-live-summary="marketValue">${hasHolding ? fmtAmount(sum.marketValue, s.settings, 0) : '--'}</div><div class="k">持仓市值</div></div>
        <div class="stat"><div class="v ${pctClass(sum.profit)}" data-live-summary="profit">${sum.profit === null ? '--' : fmtAmount(sum.profit, s.settings, 0)}</div><div class="k">累计盈亏</div></div>
      </div>
      ${
        hasHolding
          ? `<div class="bar-row"><span>收益率</span><span class="bar"><span style="width:${Math.min(
              Math.abs(sum.profitRate || 0),
              100
            )}%;background:${(sum.profitRate || 0) >= 0 ? 'var(--up)' : 'var(--down)'}"></span></span><b>${pct(sum.profitRate, 1)}</b></div>
            ${
              lvl
                ? `<div class="muted lv-hint">养基等级 Lv.${lvl.level} · ${lvl.emoji} ${esc(lvl.name)}${
                    lvl.next ? `，距「${esc(lvl.next.name)}」还差 ${lvl.next.need.toFixed(1)} 个百分点` : '（已满级）'
                  }</div>`
                : ''
            }`
          : `<div class="muted" style="margin-top:8px;font-size:13px">填写成本价与份额后，这里会显示你的真实盈亏</div>`
      }
    </div>`;

  const doneCount = (data.tasks || []).filter((t) => t.done).length;
  const tasksHtml = `
    <div class="card">
      <div class="card-title">今日待办<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">${
          data.tasks.length ? `${doneCount}/${data.tasks.length} 完成` : '完成得饲料'
        }</span></div>
      ${
        data.tasks.length
          ? data.tasks
              .map(
                (t) => `<button class="todo-row ${t.done ? 'done' : ''}" data-task="${esc(t.code)}">
                  <span class="todo-box">${t.done ? '✓' : '○'}</span>
                  <span class="todo-main">
                    <b>${esc(t.name)}</b>
                    <small>${esc(t.desc)}</small>
                  </span>
                  <span class="todo-right">
                    ${t.done ? '<span class="tag">已完成</span>' : '<span class="tag">待完成</span>'}
                    ${!t.done && t.progress > 0 ? `<small>${t.progress}/${t.target}</small>` : ''}
                  </span>
                </button>`
              )
              .join('')
          : `<div class="empty" style="padding:12px">今天没有待办，去逛逛吧</div>`
      }
      ${
        data.tasks.length
          ? `<div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">
              点任意一条直接去做；喂食 / 安抚必须附一份报告或一条心得，上传报告（+20）与写心得（+8）会涨饲料。
            </div>`
          : ''
      }
    </div>`;

  // 持仓盈亏：金额 + 收益率，如 -15,833.00（-32.9%）
  const profitText = (it) => {
    if (it.profit === null || it.profit === undefined) return '--';
    const amount = fmtAmount(it.profit, s.settings, 2);
    if (amount === '***') return amount; // 金额隐藏模式下不暴露收益率
    const sign = it.profit > 0 ? '+' : '';
    const rate =
      it.profitRate === null || it.profitRate === undefined ? '' : `（${pct(it.profitRate, 1)}）`;
    return `${sign}${amount}${rate}`;
  };

  // 仓位占比 = 单只市值 / 鸡舍总市值
  const totalMV = (data.summary && data.summary.marketValue) || 0;
  const chickenCards = data.items
    .map((it) => {
      const c = it.chicken || {};
      const ev = (data.events || []).find((e) => e.fundCode === it.fundCode);
      const weight =
        totalMV > 0 && typeof it.marketValue === 'number' && it.marketValue > 0
          ? Math.min(100, (it.marketValue / totalMV) * 100)
          : null;
      return `<div class="chicken-card ${c.sick ? 'rain' : ''}" data-code="${esc(it.fundCode)}">
        <span class="badge-state">${c.sick ? '🌧️' : c.hungry ? '🍚' : ev ? eventEmoji(ev.type) : ''}</span>
        <div class="yard-bg ${yardBgClass(c && c.build)}">${yardBgFx(c && c.build)}${chickenSVG(c, {
          size: 96,
          event: ev && ev.type,
          showHungry: true,
        })}</div>
        <div class="name" title="${esc(it.nickname)}">${esc(it.nickname)}</div>
        <div class="sub" title="${esc(c.breedName || '')}${c.look && c.look.name ? '·' + esc(c.look.name) : ''}">${esc(it.fundCode)} · ${esc(it.category || c.breedName || '')}</div>
        <div class="pct ${pctClass(it.todayPct)}" data-live-pct="${esc(it.fundCode)}">${pct(it.todayPct)}</div>
        <div class="profit-line" title="持仓盈亏 ${profitText(it)}">
          <span>盈亏</span>
          <b class="${pctClass(it.profitRate)}">${profitText(it)}</b>
          <span class="build-tag ${it.profitRate < 0 ? 'down' : it.profitRate > 0 ? 'up' : ''}">${esc(
        (c.build && c.build.label) || '匀称'
      )}</span>
        </div>
        <div class="bar-row pos-row" title="持仓市值 ${fmtAmount(
          it.marketValue,
          s.settings,
          0
        )} · 占鸡舍 ${weight === null ? '--' : weight.toFixed(1) + '%'}">
          <span>仓位</span>
          <span class="bar"><span style="width:${weight === null ? 0 : weight.toFixed(1)}%"></span></span>
          <b>${weight === null ? '--' : weight.toFixed(1) + '%'}</b>
        </div>
        <div class="chicken-actions">
          <button class="btn ghost small" data-act="edit-pos" data-code="${esc(it.fundCode)}" title="调整持仓：成本价 / 份额 / 昵称 / 建仓日" aria-label="调整持仓">🌾</button>
          <button class="btn ghost small" data-act="pat" data-id="${esc(c.id)}" ${
        c.canPat ? '' : 'disabled'
      } title="抚摸：需写一句 ≥10 字心态笔记">🤲</button>
        </div>
      </div>`;
    })
    .join('');

  const watchingHint = data.watching
    ? `<div class="yard-gate">
        <span>🐣 自选里还有 <b>${data.watching}</b> 只基金没设置持仓，它们还在舍外观察，<b>填好成本价与份额后才会进鸡舍</b>。</span>
        <button class="btn ghost small" data-go-watch>去设置</button>
      </div>`
    : '';

  const typeOpts = typeOptions();
  if (typeKey && !typeOpts.some(([k]) => k === typeKey)) typeKey = '';

  const chickenCard = `
    <div class="card">
      <div class="card-title">我的鸡舍<span class="spacer"></span>
        <span class="muted" data-yard-count style="font-weight:400;font-size:12px">共 ${data.items.length} 只</span>
      </div>
      ${
        data.items.length
          ? `<div class="yard-tools">
              ${
                typeOpts.length > 1
                  ? `<label class="yard-sort" title="只看某个基金类型">
                      <span class="muted">类型</span>
                      <select data-yard-type>
                        <option value="">全部</option>
                        ${typeOpts
                          .map(([k, label]) => `<option value="${k}" ${typeKey === k ? 'selected' : ''}>${label}</option>`)
                          .join('')}
                      </select>
                    </label>`
                  : ''
              }
              <label class="yard-sort" title="按仓位 / 收益率 / 今日涨跌排序">
                <span class="muted">排序</span>
                <select data-yard-sort>
                  ${[
                    ['default', '默认'],
                    ['weight', '仓位'],
                    ['profitRate', '收益率'],
                    ['todayPct', '今日涨跌'],
                    ['name', '名称'],
                  ]
                    .map(([k, label]) => `<option value="${k}" ${sortKey === k ? 'selected' : ''}>${label}</option>`)
                    .join('')}
                </select>
              </label>
            </div>`
          : ''
      }
      ${
        data.items.length
          ? `<div class="chicken-grid">${chickenCards}</div>`
          : `<div class="empty"><span class="big">🐣</span>鸡舍里还没有鸡<br/>${
              data.watching
                ? `自选里已有 ${data.watching} 只基金，设置持仓后才会入舍`
                : '去「自选」领养第一只基金鸡吧'
            }</div>`
      }
      ${watchingHint}
    </div>`;

  const eventsHtml = `
    <div class="card">
      <div class="card-title">今日动态</div>
      ${
        data.events.length
          ? `<div class="timeline">${data.events
              .map(
                (e) => `<div class="tl-item">
                  <div>${esc(e.name)} ${esc(e.text || '')}
                    <span class="${pctClass(e.pct)} num">${pct(e.pct)}</span></div>
                </div>`
              )
              .join('')}</div>`
          : `<div class="empty" style="padding:12px">今天还没有动态</div>`
      }
    </div>`;

  const reminders = (data.reminders || [])
    .map((r) => `<div class="report-item" data-code="${esc((r.codes || [])[0] || '')}">${esc(r.text)}</div>`)
    .join('');

  const remindersHtml = reminders
    ? `<div class="card"><div class="card-title">🔔 提醒</div>${reminders}</div>`
    : '';

  return `
    ${weatherCard}
    <div class="pc-split">
      <div>
        ${summaryCard}
        ${chickenCard}
      </div>
      <div class="side-col">
        ${tasksHtml}
        ${remindersHtml}
        ${eventsHtml}
      </div>
    </div>
    <div class="disclaimer">净值估算来自第三方公开接口，可能存在延迟或误差；本工具不构成投资建议。<br/>鸡的等级只与陪伴时长和照料投入有关，与收益率无关。</div>`;
}

export async function mount(r) {
  root = r;
  startLive(r);

  r.querySelectorAll('[data-go-watch]').forEach((b) => {
    b.onclick = () => {
      location.hash = '#/funds';
    };
  });

  r.querySelectorAll('[data-act="global-indices"]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      globalIndicesModal();
    };
  });

  r.querySelectorAll('.chicken-card').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('button')) return;
      location.hash = '#/fund/' + el.getAttribute('data-code');
    };
  });

  /* 类型筛选：只切 display，与排序互不干扰 */
  const typeSel = r.querySelector('[data-yard-type]');
  if (typeSel) {
    typeSel.value = typeKey;
    typeSel.onchange = () => {
      typeKey = typeSel.value;
      try {
        localStorage.setItem('ff.yardType', typeKey);
      } catch (err) {
        /* 隐私模式下忽略 */
      }
      applyTypeFilter(r);
    };
  }
  if (typeKey) applyTypeFilter(r);

  /* 排序：只重排 DOM，事件与滚动位置都不受影响 */
  const sortSel = r.querySelector('[data-yard-sort]');
  if (sortSel) {
    sortSel.value = sortKey;
    sortSel.onchange = () => {
      sortKey = sortSel.value;
      try {
        localStorage.setItem('ff.yardSort', sortKey);
      } catch (err) {
        /* 隐私模式下忽略 */
      }
      resortCards(r);
    };
    if (sortKey !== 'default') resortCards(r);
  }

  const afterInteract = async (out) => {
    if ((out.newAchievements || []).length) showAchievements(out.newAchievements);
    if (getState().user && typeof out.feedLeft === 'number') getState().user.feed = out.feedLeft;
    await rerender();
  };

  r.querySelectorAll('[data-act="edit-pos"]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      positionModal(b.getAttribute('data-code'), rerender);
    };
  });

  r.querySelectorAll('[data-act="feed"], [data-act="pat"]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      if (b.disabled) return;
      const id = b.getAttribute('data-id');
      const card = b.closest('.chicken-card');
      const target = { id, fundCode: card ? card.getAttribute('data-code') : '', nickname: '' };
      const item = (data.items || []).find((it) => it.chicken && it.chicken.id === id);
      if (item) target.nickname = item.nickname;
      if (b.getAttribute('data-act') === 'feed') {
        feedModal(target, async (out) => {
          if (getState().user) getState().user.feed = Math.max(0, (getState().user.feed || 0) - 1);
          await afterInteract(out);
        });
      } else {
        patModal(target, afterInteract);
      }
    };
  });

  /* 今日待办：点一条直接跳到对应动作，不再是只能看的清单 */
  const firstChicken = (list) => (list || []).find((it) => it.chicken);
  const hungriest = () =>
    (data.items || [])
      .filter((it) => it.chicken)
      .sort((a, b) => (a.chicken.satiety ?? 100) - (b.chicken.satiety ?? 100))[0];
  const biggestLoser = () =>
    (data.items || [])
      .filter((it) => it.chicken)
      .sort((a, b) => (a.todayPct ?? 0) - (b.todayPct ?? 0))[0];

  const runTask = (code) => {
    const toFeed = (it) => ({
      id: it.chicken.id,
      fundCode: it.fundCode,
      nickname: it.nickname,
    });
    if (code === 'feed_3') {
      const it = hungriest() || firstChicken(data.items);
      if (!it) return toast('鸡舍里还没有鸡，先设置持仓');
      feedModal(toFeed(it), async (out) => {
        if (getState().user) getState().user.feed = Math.max(0, (getState().user.feed || 0) - 1);
        await afterInteract(out);
      });
      return;
    }
    if (code === 'pat_sad') {
      const it = biggestLoser() || firstChicken(data.items);
      if (!it) return toast('鸡舍里还没有鸡，先设置持仓');
      patModal(toFeed(it), afterInteract);
      return;
    }
    if (code === 'check_yard') {
      const it = biggestLoser() || firstChicken(data.items);
      location.hash = it ? '#/fund/' + it.fundCode : '#/funds';
      return;
    }
    if (code === 'add_fund') {
      location.hash = '#/funds';
      return;
    }
    if (code === 'read_report' || code === 'report_1') {
      location.hash = '#/reports';
      return;
    }
    if (code === 'note_1') {
      const it = firstChicken(data.items);
      location.hash = it ? '#/fund/' + it.fundCode : '#/funds';
      return;
    }
    toast('这条待办暂时没有快捷入口');
  };

  r.querySelectorAll('[data-task]').forEach((b) => {
    b.onclick = () => runTask(b.getAttribute('data-task'));
  });

  r.querySelectorAll('.report-item[data-code]').forEach((el) => {
    el.onclick = () => {
      const code = el.getAttribute('data-code');
      if (code) location.hash = '#/fund/' + code;
    };
  });
}

function giRowHtml(it) {
  const t = it.time ? String(it.time).replace(/^\d{4}-/, '') : '';
  const chg = it.change === null || it.change === undefined ? '' : `${it.change > 0 ? '+' : ''}${money(it.change)} · `;
  return `<div class="gi-row">
    <div class="gi-main">
      <div class="gi-name">${esc(it.name)}</div>
      ${t ? `<div class="gi-time">${esc(t)}</div>` : ''}
    </div>
    <div class="gi-right">
      <div class="gi-val">${money(it.price)}</div>
      <div class="gi-delta ${pctClass(it.pct)}">${chg}${pct(it.pct)}</div>
    </div>
  </div>`;
}

function giHtml(g) {
  const groups = (g && g.groups) || [];
  if (!groups.length) return `<div class="empty" style="padding:16px">暂时取不到全球行情，稍后再试试</div>`;
  return groups
    .map(
      (gr) => `<div class="gi-group">
        <div class="gi-title">${GI_FLAG[gr.region] || '🌐'} ${esc(gr.region)}</div>
        ${gr.items.map(giRowHtml).join('')}
      </div>`
    )
    .join('');
}

/** 全球大盘指数面板：首页天气栏的大盘点位点击打开 */
export function globalIndicesModal() {
  modal(
    '全球大盘指数',
    () => `
      <div class="gi-tip muted" style="font-size:12px"></div>
      <div class="gi-body">${giCache ? giHtml(giCache) : '<div class="empty" style="padding:16px">正在拉取全球行情…</div>'}</div>
      <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.5">
        行情来自第三方公开接口，盘中可能有延迟，非交易时段显示的是最近一次收盘。
      </div>
      <div class="modal-actions">
        <button class="btn ghost small" data-refresh>刷新</button>
        <button class="btn small" data-close>关闭</button>
      </div>`,
    (body, close) => {
      const paint = (g) => {
        const b = body.querySelector('.gi-body');
        if (b) b.innerHTML = giHtml(g);
        const tip = body.querySelector('.gi-tip');
        if (tip)
          tip.textContent = g && g.updatedAt
            ? `更新于 ${fmtTime(g.updatedAt)}${g.stale ? '（离线缓存）' : ''}`
            : '';
      };
      const load = async () => {
        const btn = body.querySelector('[data-refresh]');
        if (btn) btn.classList.add('loading');
        try {
          giCache = await Api.globalIndices();
          paint(giCache);
        } catch (err) {
          const b = body.querySelector('.gi-body');
          if (b) b.innerHTML = `<div class="empty" style="padding:16px">拉取失败：${esc(err.message || '未知错误')}</div>`;
        } finally {
          if (btn) btn.classList.remove('loading');
        }
      };
      body.querySelector('[data-close]').onclick = close;
      body.querySelector('[data-refresh]').onclick = load;
      load();
    }
  );
}

export function showAchievements(list) {
  if (!list || !list.length) return;
  modal(
    '解锁新成就',
    () =>
      `<div class="ach-grid">${list
        .map((a) => `<div class="ach"><div class="medal">🏅</div><div class="t">${esc(a.name)}</div><div class="d">${esc(a.desc)}</div><div class="tag" style="margin-top:6px">+${a.reward} 饲料</div></div>`)
        .join('')}</div>
       <div class="modal-actions"><button class="btn" data-close>太棒了</button></div>`,
    (body, close) => {
      body.querySelector('[data-close]').onclick = close;
    }
  );
}
