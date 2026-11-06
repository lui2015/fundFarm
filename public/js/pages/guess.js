import { Api } from '../api.js';
import { esc, pct, pctClass, toast } from '../util.js';
import { getState } from '../app.js';

/**
 * 猜涨跌：猜下一个交易日的 A股大盘 / 港股大盘 / 我的持仓 方向。
 * 每类每天一次；目标日收盘后自动结算，猜中 +2 饲料、平局 +1；
 * 训练家称号由命中率（≥5 次结算才计入）与持仓收益率共同决定。
 */

let data = null;
let root = null;

const DIR_TXT = { up: '涨 📈', down: '跌 📉' };

function resultBadge(r) {
  if (!r) return '<span class="g-badge pending">待结算</span>';
  if (r === 'win') return '<span class="g-badge win">猜中 ✓</span>';
  if (r === 'draw') return '<span class="g-badge draw">平局</span>';
  return '<span class="g-badge lose">没猜中</span>';
}

function trainerCard() {
  const s = getState();
  const nickname = (s.user && s.user.nickname) || '农场主';
  const lv = data.level || {};
  const hit = lv.hitCounted ? `${lv.hitRate}%` : '暂无（满 5 次结算计入）';
  const rate = lv.profitRate === null || lv.profitRate === undefined ? '--' : pct(lv.profitRate, 1);
  return `
  <div class="card trainer-card">
    <div class="trainer-head">
      <div class="trainer-avatar">🐔</div>
      <div style="flex:1;min-width:0">
        <div class="trainer-name">${esc(nickname)}
          <span class="tag trainer-tag">${lv.emoji || '🌱'} ${esc(lv.name || '见习训练家')}</span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:2px">
          命中率 ${hit} · 持仓收益率 <span class="${pctClass(lv.profitRate)}">${rate}</span> · 连胜 ${data.stats.streak} 次
        </div>
      </div>
      <div class="trainer-score">
        <div class="v">${data.stats.win}<span style="font-size:12px;font-weight:500">/${data.stats.settled}</span></div>
        <div class="k">猜中 / 已结算</div>
      </div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:8px">
      当前称号：${esc(lv.name)} —— ${esc(lv.desc)}${
    lv.next ? `；再进一步就是「${esc(lv.next.name)}」（${esc(lv.next.desc)}）` : '；已是最高称号'
  }
    </div>
  </div>`;
}

function targetCard(t) {
  return `
  <div class="guess-target ${t.dir ? 'done' : ''}">
    <div class="gt-name">${esc(t.name)}</div>
    <div class="muted" style="font-size:12px">目标交易日 ${esc(t.targetDate)}</div>
    ${
      t.dir
        ? `<div class="gt-picked ${t.dir}">你猜了${DIR_TXT[t.dir]}</div><div class="muted" style="font-size:12px">等收盘结算，猜中 +${data.rewardWin} 饲料</div>`
        : `<div class="guess-btns">
            <button class="guess-btn up" data-guess="${esc(t.kind)}" data-dir="up">涨 📈</button>
            <button class="guess-btn down" data-guess="${esc(t.kind)}" data-dir="down">跌 📉</button>
          </div>`
    }
  </div>`;
}

function historyCard() {
  const rows = (data.history || [])
    .map(
      (g) => `
    <div class="g-row">
      <span class="g-kind">${esc(g.kindName)}</span>
      <span class="g-date muted">${esc(g.targetDate)}</span>
      <span class="g-dir ${g.dir}">${DIR_TXT[g.dir] || '--'}</span>
      <span class="spacer"></span>
      <span class="${pctClass(g.pct)}">${g.pct === null || g.pct === undefined ? '--' : pct(g.pct, 2)}</span>
      ${resultBadge(g.result)}
    </div>`
    )
    .join('');
  return `
  <div class="card">
    <div class="card-title">📜 猜涨跌记录<span class="spacer"></span>
      <span class="muted" style="font-weight:400;font-size:12px">最近 ${(data.history || []).length} 条</span></div>
    ${rows || '<div class="empty" style="padding:12px">还没有记录，从上面挑一项猜一把</div>'}
    <div class="muted" style="font-size:12px;margin-top:6px">
      组合涨跌 = 持仓各基金当日涨跌按份额加权；指数涨跌来自真实日 K 收盘价，目标日遇节假日自动顺延。
    </div>
  </div>`;
}

export async function render() {
  data = await Api.guess();
  return `
  <div class="card tight">
    <div class="report-head">
      <button class="btn ghost small" data-back-yard>← 鸡舍</button>
      <span class="spacer"></span>
    </div>
    <div style="margin:2px 0 10px;font-weight:800;font-size:18px">🎲 猜涨跌</div>
  </div>

  ${trainerCard()}

  <div class="card">
    <div class="card-title">今天猜明天（目标 ${esc(data.targetDate)}）<span class="spacer"></span>
      <span class="muted" style="font-weight:400;font-size:12px">猜中 +${data.rewardWin} 饲料</span></div>
    <div class="guess-grid">${data.targets.map(targetCard).join('')}</div>
    <div class="muted" style="font-size:12px;margin-top:8px">
      每个自然日每类限猜一次；目标日收盘后（北京时间 15:30 起）自动结算。
    </div>
  </div>

  ${historyCard()}`;
}

export async function mount(r) {
  root = r;
  const back = r.querySelector('[data-back-yard]');
  if (back) back.onclick = () => (location.hash = '#/yard');

  r.querySelectorAll('[data-guess]').forEach((b) => {
    b.onclick = async () => {
      const kind = b.getAttribute('data-guess');
      const dir = b.getAttribute('data-dir');
      b.disabled = true;
      try {
        await Api.makeGuess({ kind, dir });
        toast(`已押「${dir === 'up' ? '涨' : '跌'}」，祝好运 🐔`);
        await rerender();
      } catch (e) {
        toast((e.payload && e.payload.message) || '下注失败，稍后再试');
        b.disabled = false;
      }
    };
  });
}

async function rerender() {
  if (!root) return;
  root.innerHTML = await render();
  await mount(root);
}
