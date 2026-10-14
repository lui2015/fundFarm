import { Api } from '../api.js';
import { chickenSVG } from '../chicken.js';
import { esc, toast, modal } from '../util.js';

let data = null;

export async function render() {
  const [breeds, achs, tips] = await Promise.all([Api.breeds(), Api.achievements(), Api.tips()]);
  data = { breeds, achs, tips };

  const breedRows = breeds.breeds
    .map((b) => {
      const c = { breed: b.key, breedName: b.name, level: 3, colors: b.colors, state: 'good', moodValue: 80, satiety: 80, health: 80, bond: 50, progress: 0.5, growth: 200 };
      return `<div class="breed-row">
        <div class="mini-chicken" style="width:56px;height:56px;flex-basis:56px">${chickenSVG(c, { size: 52 })}</div>
        <div style="flex:1">
          <div style="font-weight:700">${esc(b.name)}</div>
          <div class="muted" style="font-size:13px">${esc(b.desc)}</div>
        </div>
        <div class="muted" style="font-size:12px">${esc(b.key)}</div>
      </div>`;
    })
    .join('');

  const achHtml = achs.items
    .map(
      (a) => `<div class="ach ${a.unlocked ? '' : 'locked'}" ${a.unlocked ? '' : 'title="未解锁"'}>
        <div class="medal">${a.unlocked ? '🏅' : '🔒'}</div>
        <div class="t">${esc(a.name)}</div>
        <div class="d">${esc(a.desc)}</div>
        ${
          a.progress
            ? `<div class="bar-row"><span class="bar"><span style="width:${Math.min(
                100,
                Math.round((a.progress.current / a.progress.target) * 100)
              )}%"></span></span><b>${a.progress.current}/${a.progress.target}</b></div>`
            : `<div class="tag" style="margin-top:6px">+${a.reward} 饲料</div>`
        }
      </div>`
    )
    .join('');

  const tipsHtml = tips.tips.map((t) => `<div class="tl-item">• ${esc(t)}</div>`).join('');

  return `
    <div class="card">
      <div class="card-title">🐔 品种图鉴<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">按基金类型自动匹配</span></div>
      ${breedRows}
    </div>

    <div class="card">
      <div class="card-title">🏅 成就墙<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">${achs.unlocked}/${achs.total}</span></div>
      <div class="ach-grid">${achHtml}</div>
    </div>

    <div class="card">
      <div class="card-title">💡 养基小贴士</div>
      <div class="timeline">${tipsHtml}</div>
    </div>

    <div class="card">
      <div class="card-title">📜 等级体系</div>
      ${breeds.levels
        .map(
          (l) =>
            `<div class="kv"><span class="k">Lv.${l.level} ${esc(l.name)}</span><span>成长值 ${l.need}</span></div>`
        )
        .join('')}
      <div class="muted" style="font-size:12px;margin-top:8px">
        成长值来自每日行情事件、互动、签到与任务。<b>等级只与陪伴时长和照料投入有关，与收益率无关。</b>
      </div>
    </div>`;
}

export async function mount(r) {
  r.querySelectorAll('.ach').forEach((el) => {
    el.onclick = () => {
      if (el.classList.contains('locked')) toast('还没解锁，继续养鸡吧');
    };
  });
}
