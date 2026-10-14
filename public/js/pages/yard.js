import { Api } from '../api.js';
import { chickenSVG, eventEmoji } from '../chicken.js';
import { esc, pct, pctClass, fmtAmount, toast, modal } from '../util.js';
import { getState } from '../app.js';
import { feedModal, patModal } from './care.js';

let data = null;
let root = null;

const WICON = { sunny: '☀️', cloudy: '⛅', overcast: '☁️', rain: '🌧️' };

async function rerender() {
  if (!root) return;
  root.innerHTML = await render();
  await mount(root);
}

export async function render() {
  const s = getState();
  data = await Api.yard();
  const w = data.weather || {};
  const idx = w.index;
  const sum = data.summary || {};
  const hasHolding = sum.marketValue !== null && sum.cost !== null;

  const achievementsHtml = (data.newAchievements || [])
    .map((a) => `<div class="ach"><div class="medal">🏅</div><div class="t">${esc(a.name)}</div><div class="d">${esc(a.desc)}</div></div>`)
    .join('');

  const weatherCard = `
    <div class="weather-bar ${esc(w.key || 'cloudy')}">
      <div class="w-icon">${WICON[w.key] || '⛅'}</div>
      <div style="flex:1">
        <div class="w-num">${esc(w.label || '多云')}</div>
        <div class="w-main">
          ${idx ? `${esc(idx.name)} <span class="${pctClass(idx.pct)}">${pct(idx.pct)}</span>` : '大盘数据暂不可用'}
          · 鸡舍今日${sum.total ? ` ${sum.up} 涨 ${sum.down} 跌` : '空空如也'}
        </div>
      </div>
      <div style="text-align:right">
        <div class="w-main">今日总盈亏</div>
        <div class="w-num">${sum.todayPct === null ? '--' : pct(sum.todayPct)}</div>
      </div>
    </div>`;

  const summaryCard = `
    <div class="card">
      <div class="card-title">今日概况<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">${data.date}</span></div>
      <div class="grid-3">
        <div class="stat"><div class="v ${pctClass(sum.todayPct)}">${sum.todayPct === null ? '--' : pct(sum.todayPct)}</div><div class="k">今日估算</div></div>
        <div class="stat"><div class="v">${hasHolding ? fmtAmount(sum.marketValue, s.settings, 0) : '--'}</div><div class="k">持仓市值</div></div>
        <div class="stat"><div class="v ${pctClass(sum.profit)}">${sum.profit === null ? '--' : fmtAmount(sum.profit, s.settings, 0)}</div><div class="k">累计盈亏</div></div>
      </div>
      ${
        hasHolding
          ? `<div class="bar-row"><span>收益率</span><span class="bar"><span style="width:${Math.min(
              Math.abs(sum.profitRate || 0),
              100
            )}%;background:${(sum.profitRate || 0) >= 0 ? 'var(--up)' : 'var(--down)'}"></span></span><b>${pct(sum.profitRate, 1)}</b></div>`
          : `<div class="muted" style="margin-top:8px;font-size:13px">填写成本价与份额后，这里会显示你的真实盈亏</div>`
      }
    </div>`;

  const tasksHtml = `
    <div class="card">
      <div class="card-title">今日任务<span class="spacer"></span><span class="muted" style="font-weight:400;font-size:12px">完成得饲料</span></div>
      ${
        data.tasks.length
          ? data.tasks
              .map(
                (t) => `<div class="list-row" style="cursor:default">
                  <div style="font-size:18px">${t.done ? '✅' : '⬜'}</div>
                  <div class="lr-main">
                    <div class="lr-name">${esc(t.name)}</div>
                    <div class="lr-sub">${esc(t.desc)} · ${t.progress}/${t.target}</div>
                  </div>
                  <div class="lr-right"><span class="tag">+${t.reward} 饲料</span></div>
                </div>`
              )
              .join('')
          : `<div class="empty" style="padding:12px">今天没有任务，去逛逛吧</div>`
      }
      <div class="grid-3" style="margin-top:10px">
        <button class="btn ghost small" data-yact="clean">🧹 打扫</button>
        <button class="btn ghost small" data-yact="music">🎵 音乐</button>
        <button class="btn small" data-yact="feedall">🌾 喂全场</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">
        这里的任务不是点一下就算完成：喂食要附一份报告或一条心得，安抚要写一句心态笔记，
        打扫前得先把饿了 / 打蔫的鸡都照料好。
      </div>
    </div>`;

  const chickenCards = data.items
    .map((it) => {
      const c = it.chicken || {};
      const ev = (data.events || []).find((e) => e.fundCode === it.fundCode);
      return `<div class="chicken-card ${c.sick ? 'rain' : ''}" data-code="${esc(it.fundCode)}">
        <span class="badge-lv">Lv.${c.level || 1} ${esc(c.levelName || '雏鸡')}</span>
        <span class="badge-state">${c.sick ? '🌧️' : c.hungry ? '🍚' : ev ? eventEmoji(ev.type) : ''}</span>
        <div class="yard-bg">${chickenSVG(c, { size: 96, event: ev && ev.type, showHungry: true })}</div>
        <div class="name">${esc(it.nickname)}</div>
        <div class="sub">${esc(it.fundCode)} · ${esc(c.breedName || '')}</div>
        <div class="pct ${pctClass(it.todayPct)}">${pct(it.todayPct)}</div>
        <div class="bar-row"><span>成长</span><span class="bar"><span style="width:${Math.round(
          (c.progress || 0) * 100
        )}%"></span></span><b>${c.growth || 0}</b></div>
        <div class="chicken-actions">
          <button class="btn ghost small" data-act="feed" data-id="${esc(c.id)}" ${
        c.canFeed ? '' : 'disabled'
      } title="喂食：需附一份报告或一条 ≥20 字心得">🌾</button>
          <button class="btn ghost small" data-act="pat" data-id="${esc(c.id)}" ${
        c.canPat ? '' : 'disabled'
      } title="抚摸：需写一句 ≥10 字心态笔记">🤲</button>
        </div>
      </div>`;
    })
    .join('');

  const chickenCard = `
    <div class="card">
      <div class="card-title">我的鸡舍<span class="spacer"></span><span class="muted" style="font-weight:400;font-size:12px">共 ${data.items.length} 只</span></div>
      ${
        data.items.length
          ? `<div class="chicken-grid">${chickenCards}</div>`
          : `<div class="empty"><span class="big">🐣</span>鸡舍还空着<br/>去「自选」领养第一只基金鸡吧</div>`
      }
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
                  <div class="tl-time">成长值 +${e.growthDelta || 0}</div>
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

  const achHtml = achievementsHtml
    ? `<div class="card"><div class="card-title">🎉 新解锁成就</div><div class="ach-grid">${achievementsHtml}</div></div>`
    : '';

  return `
    ${weatherCard}
    ${achHtml}
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

  r.querySelectorAll('.chicken-card').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('button')) return;
      location.hash = '#/fund/' + el.getAttribute('data-code');
    };
  });

  const afterInteract = async (out) => {
    if ((out.newAchievements || []).length) showAchievements(out.newAchievements);
    if (getState().user && typeof out.feedLeft === 'number') getState().user.feed = out.feedLeft;
    await rerender();
  };

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

  r.querySelectorAll('[data-yact]').forEach((b) => {
    b.onclick = async () => {
      const act = b.getAttribute('data-yact');
      if (act === 'feedall') {
        feedModal({ all: true }, afterInteract);
        return;
      }
      try {
        const out = await Api.yardAction(act);
        toast(act === 'clean' ? `打扫干净了，${out.affected} 只鸡健康 +8` : `音乐响起来，${out.affected} 只鸡心情 +10`);
        await rerender();
      } catch (err) {
        if (err.message === 'need_care') {
          const items = (err.payload && err.payload.items) || [];
          modal(
            '鸡舍还不干净',
            () => `
              <p style="margin:0 0 6px">先把这些鸡照料好，再打扫吧：</p>
              ${items
                .map(
                  (it) => `<div class="list-row" data-go="${esc(it.fundCode)}">
                    <div class="lr-main">
                      <div class="lr-name">${esc(it.nickname)}</div>
                      <div class="lr-sub">${esc(it.reason)} · 饱食 ${it.satiety}</div>
                    </div>
                    <div class="lr-right"><span class="tag">去照料</span></div>
                  </div>`
                )
                .join('')}
              <div class="muted" style="font-size:12px;margin-top:8px">
                喂食要附一份报告或一条心得；打蔫的鸡写一句心态笔记就能恢复。
              </div>
              <div class="modal-actions"><button class="btn" data-close>知道了</button></div>`,
            (body, close) => {
              body.querySelector('[data-close]').onclick = close;
              body.querySelectorAll('[data-go]').forEach((el) => {
                el.onclick = () => {
                  close();
                  location.hash = '#/fund/' + el.getAttribute('data-go');
                };
              });
            }
          );
        } else if (err.message === 'cooldown') {
          toast(`${act === 'clean' ? '刚打扫过' : '刚放过音乐'}，${err.payload?.leftMin || ''} 分钟后再来`);
        } else {
          toast('操作失败：' + err.message);
        }
      }
    };
  });

  r.querySelectorAll('.report-item[data-code]').forEach((el) => {
    el.onclick = () => {
      const code = el.getAttribute('data-code');
      if (code) location.hash = '#/fund/' + code;
    };
  });
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
