import { Api } from '../api.js';
import { chickenSVG } from '../chicken.js';
import { esc, pct, pctClass, fmtAmount, toast, modal, confirmBox } from '../util.js';
import { attachAutocomplete } from '../autocomplete.js';
import { getState } from '../app.js';
import { showAchievements } from './yard.js';

let data = null;
let groups = [];
let view = { groupId: 'all', sort: 'adopted', filter: '', compact: false };
let root = null;

async function load() {
  const qs = new URLSearchParams();
  if (view.groupId !== 'all') qs.set('groupId', view.groupId);
  if (view.sort) qs.set('sort', view.sort);
  if (view.filter) qs.set('filter', view.filter);
  const [funds, gs] = await Promise.all([Api.funds(qs.toString()), Api.groups()]);
  data = funds;
  groups = gs.items || [];
  return funds;
}

async function rerender() {
  if (!root) return;
  await load();
  root.innerHTML = await render();
  await mount(root);
}

export async function render() {
  const s = getState();
  if (!data) await load();

  const tabs = [
    `<button data-g="all" class="${view.groupId === 'all' ? 'active' : ''}">全部 ${data.total}</button>`,
    ...groups.map(
      (g) => `<button data-g="${esc(g.id)}" class="${view.groupId === g.id ? 'active' : ''}">${esc(g.name)}</button>`
    ),
    `<button data-g="none" class="${view.groupId === 'none' ? 'active' : ''}">未分组</button>`,
  ].join('');

  const filters = [
    ['', '全部'],
    ['up', '今日涨'],
    ['down', '今日跌'],
    ['profit', '盈利'],
    ['loss', '亏损'],
    ['hungry', '饿了'],
  ]
    .map(([v, t]) => `<button data-f="${v}" class="${view.filter === v ? 'active' : ''}">${t}</button>`)
    .join('');

  const rows = data.items
    .map((it) => {
      const c = it.chicken || {};
      if (view.compact) {
        return `<div class="list-row" data-code="${esc(it.fundCode)}">
          <div class="lr-main">
            <div class="lr-name">${esc(it.nickname)} <span class="muted" style="font-weight:400">${esc(it.fundCode)}</span></div>
            <div class="lr-sub">${esc(c.breedName || '')} · Lv.${c.level || 1} · 持有 ${it.holdingDays} 天${c.hungry ? ' · 🍚饿了' : ''}</div>
          </div>
          <div class="lr-right">
            <div class="num ${pctClass(it.todayPct)}" style="font-weight:700">${pct(it.todayPct)}</div>
            <div class="lr-sub num ${pctClass(it.profitRate)}">${it.profitRate === null ? '--' : pct(it.profitRate, 1)}</div>
          </div>
        </div>`;
      }
      return `<div class="chicken-card" data-code="${esc(it.fundCode)}">
        <span class="badge-lv">Lv.${c.level || 1}</span>
        ${c.hungry ? '<span class="badge-state">🍚</span>' : ''}
        <div class="yard-bg">${chickenSVG(c, { size: 92, showHungry: true })}</div>
        <div class="name">${esc(it.nickname)}</div>
        <div class="sub">${esc(it.fundCode)} · ${esc(c.breedName || '')}</div>
        <div class="pct ${pctClass(it.todayPct)}">${pct(it.todayPct)}</div>
        <div class="sub">收益率 <b class="${pctClass(it.profitRate)}">${it.profitRate === null ? '--' : pct(it.profitRate, 1)}</b></div>
        <div class="chicken-actions">
          <button class="btn ghost small" data-edit="${esc(it.fundCode)}">编辑</button>
          <button class="btn ghost small" data-release="${esc(it.fundCode)}">放归</button>
        </div>
      </div>`;
    })
    .join('');

  return `
    <div class="card tight">
      <div class="tabs" style="margin-bottom:8px">${tabs}
        <button data-act="addgroup" class="active" style="background:#fff;color:var(--green-dark)">+ 分组</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div class="tabs" style="flex:1">${filters}</div>
        <select class="input" id="fd-sort" style="width:auto">
          <option value="adopted" ${view.sort === 'adopted' ? 'selected' : ''}>按领养时间</option>
          <option value="pct" ${view.sort === 'pct' ? 'selected' : ''}>按今日涨跌</option>
          <option value="profitRate" ${view.sort === 'profitRate' ? 'selected' : ''}>按收益率</option>
          <option value="value" ${view.sort === 'value' ? 'selected' : ''}>按市值</option>
          <option value="level" ${view.sort === 'level' ? 'selected' : ''}>按成长值</option>
        </select>
        <button class="btn ghost small" data-act="toggle-view">${view.compact ? '卡片' : '紧凑'}</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">自选列表<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">${data.count} / ${data.maxAdoptions}</span></div>
      ${
        data.items.length
          ? view.compact
            ? rows
            : `<div class="chicken-grid">${rows}</div>`
          : `<div class="empty"><span class="big">🐣</span>这里还没有基金<br/>点击右下角「领养」添加一只</div>`
      }
    </div>

    <button class="btn fab" data-act="adopt">＋ 领养基金</button>`;
}

export async function mount(r) {
  root = r;

  r.querySelectorAll('[data-g]').forEach((b) => {
    b.onclick = () => {
      view.groupId = b.getAttribute('data-g');
      rerender();
    };
  });
  r.querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => {
      view.filter = b.getAttribute('data-f');
      rerender();
    };
  });
  const sortSel = r.querySelector('#fd-sort');
  if (sortSel)
    sortSel.onchange = () => {
      view.sort = sortSel.value;
      rerender();
    };
  const tv = r.querySelector('[data-act="toggle-view"]');
  if (tv)
    tv.onclick = () => {
      view.compact = !view.compact;
      rerender();
    };

  r.querySelectorAll('.chicken-card[data-code], .list-row[data-code]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('button')) return;
      location.hash = '#/fund/' + el.getAttribute('data-code');
    };
  });

  r.querySelector('[data-act="adopt"]').onclick = adoptModal;
  const ag = r.querySelector('[data-act="addgroup"]');
  if (ag)
    ag.onclick = () => {
      modal(
        '新建分组',
        () => `<div class="field"><label>分组名称</label><input class="input" id="gp-name" placeholder="如 核心宽基" /></div>
          <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>创建</button></div>`,
        (body, close) => {
          body.querySelector('[data-no]').onclick = close;
          body.querySelector('[data-ok]').onclick = async () => {
            const name = body.querySelector('#gp-name').value.trim();
            if (!name) return toast('请输入名称');
            await Api.addGroup(name);
            close();
            toast('分组已创建');
            rerender();
          };
        }
      );
    };

  r.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      editModal(b.getAttribute('data-edit'));
    };
  });
  r.querySelectorAll('[data-release]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const code = b.getAttribute('data-release');
      confirmBox('放归这只鸡？', '30 天内可以在详情页撤销放归，鸡的成长记录会保留。', async () => {
        await Api.release(code);
        toast('已放归');
        rerender();
      });
    };
  });
}

function editModal(code) {
  const it = (data.items || []).find((x) => x.fundCode === code);
  if (!it) return;
  modal(
    '编辑 ' + code,
    () => `
      <div class="field"><label>昵称</label><input class="input" id="ed-nick" value="${esc(it.nickname || '')}"></div>
      <div class="field"><label>分组</label><select class="input" id="ed-group">
        <option value="">未分组</option>
        ${groups.map((g) => `<option value="${esc(g.id)}" ${it.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select></div>
      <div class="field"><label>成本价</label><input class="input" id="ed-cost" type="number" step="0.0001" value="${it.costPrice ?? ''}"></div>
      <div class="field"><label>份额</label><input class="input" id="ed-shares" type="number" step="0.01" value="${it.shares ?? ''}"></div>
      <div class="field"><label>首次买入日期</label><input class="input" id="ed-date" type="date" value="${esc(it.firstBuyDate || '')}"></div>
      <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>保存</button></div>`,
    (body, close) => {
      body.querySelector('[data-no]').onclick = close;
      body.querySelector('[data-ok]').onclick = async () => {
        await Api.updateFund(code, {
          nickname: body.querySelector('#ed-nick').value,
          groupId: body.querySelector('#ed-group').value || null,
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
}

export function adoptModal() {
  modal(
    '领养一只基金鸡',
    () => `
      <div class="field"><label>搜索基金（代码 / 名称 / 拼音首字母）</label>
        <div class="search-row">
          <div class="ac-wrap">
            <input class="input" id="fd-q" placeholder="如 005827 / 易方达蓝筹 / yfdlc" autocomplete="off">
          </div>
          <button class="btn" id="fd-search">搜索</button>
        </div>
        <div id="fd-result" class="muted" style="font-size:13px;margin-top:6px">输入后会自动联想匹配的基金，↑↓ 选择、回车确认</div>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <div class="field"><label>基金代码</label><input class="input" id="fd-code" placeholder="6 位数字"></div>
      <div class="field"><label>昵称（可留空）</label><input class="input" id="fd-nick"></div>
      <div class="field"><label>分组</label><select class="input" id="fd-group">
        ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
      </select></div>
      <div class="grid-2">
        <div class="field"><label>成本价（选填）</label><input class="input" id="fd-cost" type="number" step="0.0001"></div>
        <div class="field"><label>份额（选填）</label><input class="input" id="fd-shares" type="number" step="0.01"></div>
      </div>
      <button class="btn block" id="fd-adopt">领养</button>`,
    (body, close) => {
      const qInput = body.querySelector('#fd-q');
      const codeInput = body.querySelector('#fd-code');
      const nickInput = body.querySelector('#fd-nick');
      const resultBox = body.querySelector('#fd-result');

      const ac = attachAutocomplete(qInput, {
        fetchItems: async (q) => (await Api.search(q)).items,
        onPick: (it) => {
          codeInput.value = it.code;
          if (!nickInput.value.trim()) nickInput.value = (it.name || '').slice(0, 12);
          resultBox.innerHTML = `<span class="selected-fund">✓ ${esc(it.name || it.code)} ${esc(it.code)}</span>`;
        },
      });

      body.querySelector('#fd-search').onclick = () => {
        if (!qInput.value.trim()) {
          qInput.focus();
          toast('先输入代码、名称或拼音首字母');
          return;
        }
        ac.searchNow();
      };
      setTimeout(() => qInput.focus(), 60);
      body.querySelector('#fd-adopt').onclick = async () => {
        const code = body.querySelector('#fd-code').value.trim();
        if (!/^\d{6}$/.test(code)) return toast('请输入 6 位基金代码');
        try {
          const out = await Api.adopt({
            code,
            nickname: body.querySelector('#fd-nick').value,
            groupId: body.querySelector('#fd-group').value || null,
            costPrice: body.querySelector('#fd-cost').value || null,
            shares: body.querySelector('#fd-shares').value || null,
          });
          close();
          toast(`领养成功：${esc(out.fund?.name || code)}（${esc(out.breed)}）`);
          if (out.newAchievements?.length) showAchievements(out.newAchievements);
          const u = getState().user;
          if (u) u.feed += 10;
          await rerender();
        } catch (e) {
          toast(
            { already_adopted: '这只基金已经在鸡舍里了', yard_full: '鸡舍满了，先放归几只吧', bad_fund_code: '基金代码不正确' }[
              e.message
            ] || '领养失败：' + e.message
          );
        }
      };
    }
  );
}
