import { Api } from '../api.js';
import { chickenSVG } from '../chicken.js';
import { esc, toast, pct, pctClass } from '../util.js';

let data = null;

/** 分类查询可选排序（与后端 EXPLORE_SORTS 对齐） */
const QUERY_SORTS = [
  ['1nzf', '近1年'],
  ['6yzf', '近6月'],
  ['3yzf', '近3月'],
  ['1yzf', '近1月'],
  ['rzdf', '日涨幅'],
  ['jnzf', '今年来'],
  ['lnzf', '成立来'],
];

const fmtCount = (n) => (n ? Number(n).toLocaleString('zh-CN') + ' 只' : '');

function skeletonChicken(breedKey, name, colors) {
  return chickenSVG(
    {
      breed: breedKey,
      breedName: name,
      level: 3,
      colors,
      state: 'good',
      moodValue: 80,
      satiety: 80,
      health: 80,
      bond: 50,
      progress: 0.5,
      growth: 200,
    },
    { size: 52 }
  );
}

/**
 * 某个类型的展开面板：点「查基金」在行下方就地展开（懒加载 + 排序 + 换一批），
 * 再点一次收起；不再弹窗，避免打断浏览。
 */
function initTypeItem(item, type, closeOthers) {
  const panel = item.querySelector('.type-panel');
  const list = item.querySelector('[data-list]');
  const tip = item.querySelector('[data-tip]');
  const more = item.querySelector('[data-more]');
  let sort = '1nzf';
  let page = 1;
  let loaded = false;

  const rowHtml = (it) => {
    const money = it.sevenDay !== undefined && it.sevenDay !== null;
    const second = money
      ? `七日年化 ${pct(it.sevenDay, 2)}`
      : `日 ${it.dayPct === null ? '--' : pct(it.dayPct)}`;
    const third = it.y1 === null || it.y1 === undefined ? '' : ` · 近1年 ${pct(it.y1, 1)}`;
    return `<div class="fund-row" data-code="${esc(it.code)}" role="button">
      <div class="fr-name">${esc(it.name)}</div>
      <div class="fr-meta">
        <span class="muted">${esc(it.code)}</span>
        <span class="${money ? 'num' : pctClass(it.dayPct)}">${second}</span>${third}
      </div>
    </div>`;
  };

  const bindRows = () => {
    list.querySelectorAll('.fund-row').forEach((el) => {
      el.onclick = () => {
        location.hash = '#/fund/' + el.getAttribute('data-code');
      };
    });
  };

  const paint = (items, append) => {
    const html = items.map(rowHtml).join('');
    if (append) list.insertAdjacentHTML('beforeend', html);
    else
      list.innerHTML = items.length
        ? html
        : `<div class="empty" style="padding:16px">这个类型暂时取不到基金，换个排序试试</div>`;
    bindRows();
  };

  const load = async (reset) => {
    if (reset) page = 1;
    more.disabled = true;
    if (tip) {
      tip.textContent = `${type.name}${type.count ? ' · 共 ' + fmtCount(type.count) : ''}${
        type.categories && type.categories.length ? '（含 ' + type.categories.join(' / ') + '）' : ''
      }`;
    }
    if (reset) list.innerHTML = '<div class="empty" style="padding:16px">加载中…</div>';
    try {
      const r = await Api.explore(`type=${encodeURIComponent(type.ft)}&sort=${sort}&page=${page}&size=20`);
      paint(r.items || [], !reset);
    } catch (err) {
      if (reset) list.innerHTML = `<div class="empty" style="padding:16px">拉取失败：${esc(err.message || '')}</div>`;
      else toast('没有更多了');
    } finally {
      more.disabled = false;
    }
  };

  const setOpen = (open) => {
    item.classList.toggle('open', open);
    panel.hidden = !open;
    const btn = item.querySelector('[data-toggle]');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && !loaded) {
      loaded = true;
      load(true);
    }
  };

  item.querySelector('.type-head').onclick = () => {
    const willOpen = !item.classList.contains('open');
    if (willOpen) closeOthers(item);
    setOpen(willOpen);
  };

  item.querySelectorAll('[data-qs]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      sort = b.getAttribute('data-qs');
      item.querySelectorAll('[data-qs]').forEach((x) => x.classList.toggle('active', x === b));
      load(true);
    };
  });

  more.onclick = (e) => {
    e.stopPropagation();
    page += 1;
    load(false);
  };

  return { item, setOpen };
}

/**
 * 把同站的其他小工具（求一基等）以「全屏浮层 + iframe」的方式嵌进来，
 * 不跳出养基场，也保留「新窗口打开」作为兜底入口。
 */
function embedExternal(url, title) {
  const mask = document.createElement('div');
  mask.className = 'embed-mask';
  mask.innerHTML = `
    <div class="embed-panel">
      <div class="embed-head">
        <b>${esc(title)}</b>
        <span class="spacer"></span>
        <a class="btn ghost small" href="${esc(url)}" target="_blank" rel="noopener">新窗口打开</a>
        <button class="btn ghost small" data-embed-close>关闭</button>
      </div>
      <iframe class="embed-frame" src="${esc(url)}" title="${esc(title)}" loading="lazy"></iframe>
    </div>`;
  document.body.appendChild(mask);
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  };
  mask.querySelector('[data-embed-close]').onclick = close;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', onKey);
}

export async function render() {
  const [achs, tips, fundTypes] = await Promise.all([
    Api.achievements(),
    Api.tips(),
    Api.fundTypes().catch(() => ({ types: [] })),
  ]);
  const types = (fundTypes && fundTypes.types) || [];
  data = { achs, tips, types };

  const typeRows = types
    .map((t) => {
      return `<div class="type-item" data-type-key="${esc(t.key)}">
        <div class="breed-row type-head" role="button" tabindex="0" aria-expanded="false" title="展开 ${esc(t.name)} 基金列表">
          <div class="mini-chicken" style="width:56px;height:56px;flex-basis:56px">${skeletonChicken(
            t.breed.key,
            t.breed.name,
            t.breed.colors
          )}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700">${esc(t.name)}
              <span class="muted" style="font-weight:400;font-size:12px">${fmtCount(t.count)}</span>
            </div>
            <div class="muted" style="font-size:13px">对应品种：${esc(t.breed.name)} · ${esc(t.breed.desc)}</div>
            <div class="type-chips">${(t.categories || [])
              .map((c) => `<span class="chip mini">${esc(c)}</span>`)
              .join('')}</div>
          </div>
          <button class="btn ghost small type-toggle" data-toggle aria-expanded="false">查基金<b class="chev">▾</b></button>
        </div>
        <div class="type-panel" hidden>
          <div class="chip-row type-sorts">${QUERY_SORTS.map(
            ([k, label]) => `<button class="chip ${k === '1nzf' ? 'active' : ''}" data-qs="${k}">${label}</button>`
          ).join('')}</div>
          <div class="muted type-tip" data-tip></div>
          <div class="fund-list type-list" data-list style="max-height:48vh;overflow:auto">
            <div class="empty" style="padding:16px">展开后加载…</div>
          </div>
          <div class="type-panel-foot">
            <span class="muted" style="font-size:12px">点任意一只进入详情页，可直接领养</span>
            <button class="btn ghost small" data-more>换一批</button>
          </div>
        </div>
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
      <div class="card-title">🐔 基金类型图鉴
        <button class="btn ghost small" data-act="embed-qr" title="求一基：随机抽取一只基金看看">🎲 求一基</button>
        <span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">按基金类型自动匹配鸡品种</span></div>
      ${typeRows || '<div class="empty" style="padding:16px">类型数据暂时取不到，稍后再试</div>'}
      <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.6">
        类型取自东财基金分类（FTYPE）；点「查基金」在该行下方就地展开列表（可切排序 / 换一批），再点一次收起。
      </div>
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
  `;
}

export async function mount(r) {
  const qrBtn = r.querySelector('[data-act="embed-qr"]');
  if (qrBtn)
    qrBtn.onclick = () => embedExternal('https://www.luliming.xyz/fundRecommend/', '🎲 求一基 · 随机基金推荐');

  r.querySelectorAll('.ach').forEach((el) => {
    el.onclick = () => {
      if (el.classList.contains('locked')) toast('还没解锁，继续养鸡吧');
    };
  });

  const types = (data && data.types) || [];
  const items = [];
  const closeOthers = (keep) => {
    items.forEach((it) => {
      if (it.item !== keep) it.setOpen(false);
    });
  };
  r.querySelectorAll('.type-item').forEach((el) => {
    const key = el.getAttribute('data-type-key');
    const type = types.find((t) => t.key === key);
    if (!type) return;
    items.push(initTypeItem(el, type, closeOthers));
  });
}
