import { Api } from '../api.js';
import { chickenSVG, yardBgClass, yardBgFx } from '../chicken.js';
import { esc, pct, pctClass, fmtAmount, toast, modal, confirmBox } from '../util.js';
import { attachAutocomplete } from '../autocomplete.js';
import { getState } from '../app.js';
import { showAchievements } from './yard.js';
import { startLive } from '../live.js';

let data = null;
let groups = [];
let view = { groupId: 'all', sort: 'adopted', filter: '', type: '', compact: false };
let root = null;

async function load() {
  const qs = new URLSearchParams();
  if (view.groupId !== 'all') qs.set('groupId', view.groupId);
  if (view.sort) qs.set('sort', view.sort);
  if (view.filter) qs.set('filter', view.filter);
  if (view.type) qs.set('type', view.type);
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

  /** 持仓盈亏：金额 + 收益率，如 -15,833.00（-32.9%） */
  const profitText = (it) => {
    if (it.profit === null || it.profit === undefined) return '--';
    const amount = fmtAmount(it.profit, s.settings, 2);
    if (amount === '***') return amount;
    const sign = it.profit > 0 ? '+' : '';
    const rate =
      it.profitRate === null || it.profitRate === undefined ? '' : `（${pct(it.profitRate, 1)}）`;
    return `${sign}${amount}${rate}`;
  };

  const tabs = [
    `<button data-g="all" class="${view.groupId === 'all' ? 'active' : ''}">全部 ${data.total}</button>`,
    ...groups.map(
      (g) => `<button data-g="${esc(g.id)}" class="${view.groupId === g.id ? 'active' : ''}">${esc(g.name)}</button>`
    ),
    `<button data-g="none" class="${view.groupId === 'none' ? 'active' : ''}">未分组</button>`,
  ].join('');

  const FILTERS = [
    ['', '全部'],
    ['in_yard', '已入场（在鸡舍）'],
    ['watching', '未入场（只看）'],
    ['up', '今日上涨'],
    ['down', '今日下跌'],
    ['profit', '持仓盈利'],
    ['loss', '持仓亏损'],
    ['hungry', '饿了'],
  ];

  /** 基金类型（东财 FTYPE 大类，对应 funds.type） */
  const TYPES = [
    ['', '全部类型'],
    ['equity', '股票型'],
    ['index', '指数型'],
    ['hybrid', '混合型'],
    ['bond', '债券型'],
    ['money', '货币型'],
    ['qdii', 'QDII'],
    ['fof', 'FOF'],
    ['other', '其他'],
  ];

  const rows = data.items
    .map((it) => {
      const c = it.chicken || {};
      if (view.compact) {
        return `<div class="list-row" data-code="${esc(it.fundCode)}">
          <div class="lr-main">
            <div class="lr-name" title="${esc(it.nickname)}">${esc(it.nickname)} <span class="muted" style="font-weight:400">${esc(it.fundCode)}</span>${
              it.hasPosition ? '' : ' <span class="tag-watch">未入场</span>'
            }</div>
            <div class="lr-sub">${esc(it.category || c.breedName || '')} · Lv.${c.level || 1} · 持有 ${it.holdingDays} 天${
              c.hungry && it.hasPosition ? ' · 🍚饿了' : ''
            }</div>
          </div>
          <div class="lr-right">
            <div class="num ${pctClass(it.todayPct)}" style="font-weight:700" data-live-pct="${esc(it.fundCode)}">${pct(it.todayPct)}</div>
            <div class="lr-sub num ${pctClass(it.profitRate)}">${it.profitRate === null ? '--' : pct(it.profitRate, 1)}</div>
          </div>
        </div>`;
      }
      return `<div class="chicken-card ${it.hasPosition ? '' : 'watching'}" data-code="${esc(it.fundCode)}">
        ${it.hasPosition ? (c.hungry ? '<span class="badge-state">🍚</span>' : '') : '<span class="badge-state">👀</span>'}
        <div class="yard-bg ${yardBgClass(c && c.build)}">${yardBgFx(c && c.build)}${chickenSVG(c, {
          size: 92,
          showHungry: !!it.hasPosition,
        })}</div>
        <div class="name" title="${esc(it.nickname)}">${esc(it.nickname)}</div>
        <div class="sub" title="${esc(c.breedName || '')}${c.look && c.look.name ? '·' + esc(c.look.name) : ''}">${esc(it.fundCode)} · ${esc(it.category || c.breedName || '')}</div>
        <div class="pct ${pctClass(it.todayPct)}" data-live-pct="${esc(it.fundCode)}">${pct(it.todayPct)}</div>
        ${
          it.hasPosition
            ? `<div class="sub">盈亏 <b class="${pctClass(it.profitRate)}">${profitText(it)}</b> <span class="build-tag ${
                it.profitRate < 0 ? 'down' : it.profitRate > 0 ? 'up' : ''
              }">${esc((c.build && c.build.label) || '匀称')}</span></div>`
            : `<div class="sub">未设置持仓 · 暂不进鸡舍</div>`
        }
        <div class="chicken-actions">
          <button class="btn ${it.hasPosition ? 'ghost ' : ''}small" data-edit="${esc(it.fundCode)}">${
            it.hasPosition ? '编辑' : '设置持仓'
          }</button>
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
      <div class="list-tools">
        <div class="lt-row">
          <select class="input" id="fd-filter" title="筛选条件">
            ${FILTERS.map(
              ([v, t]) => `<option value="${v}" ${view.filter === v ? 'selected' : ''}>${t}</option>`
            ).join('')}
          </select>
          <select class="input" id="fd-type" title="基金类型">
            ${TYPES.map(([v, t]) => `<option value="${v}" ${view.type === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="lt-row">
          <select class="input" id="fd-sort" title="排序方式">
            <option value="adopted" ${view.sort === 'adopted' ? 'selected' : ''}>按领养时间</option>
            <option value="pct" ${view.sort === 'pct' ? 'selected' : ''}>按今日涨跌</option>
            <option value="profitRate" ${view.sort === 'profitRate' ? 'selected' : ''}>按收益率</option>
            <option value="value" ${view.sort === 'value' ? 'selected' : ''}>按市值</option>
          </select>
          <button class="btn ghost small" data-act="toggle-view">${view.compact ? '卡片' : '紧凑'}</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">自选列表<span class="spacer"></span>
        <span class="live-tag" data-live-state>实时</span>
        <button class="live-refresh" data-live-refresh title="立即刷新涨跌幅">↻</button>
        <span class="muted" style="font-weight:400;font-size:12px">${data.count} / ${data.maxAdoptions}</span></div>
      <div class="muted" style="font-size:12px;margin:-2px 0 8px" data-live-time>更新于 --:--:--</div>
      ${
        data.items.length
          ? view.compact
            ? rows
            : `<div class="chicken-grid">${rows}</div>`
          : view.filter || view.type || view.groupId !== 'all'
            ? `<div class="empty"><span class="big">🔍</span>没有符合当前筛选条件的基金<br/>
                 <button class="btn ghost small" data-act="clear-filter" style="margin-top:10px">清除筛选</button></div>`
            : `<div class="empty"><span class="big">🐣</span>这里还没有基金<br/>点击右下角「领养」添加一只</div>`
      }
    </div>

    ${
      data.watching
        ? `<div class="yard-gate gate-bottom">
            <span>🐣 有 <b>${data.watching}</b> 只基金还没设置持仓，只在自选里观察，<b>填好成本价与份额后才会进鸡舍</b>。</span>
          </div>`
        : ''
    }

    <button class="btn fab" data-act="adopt">＋ 领养基金</button>`;
}

export async function mount(r) {
  root = r;
  startLive(r);

  r.querySelectorAll('[data-g]').forEach((b) => {
    b.onclick = () => {
      view.groupId = b.getAttribute('data-g');
      rerender();
    };
  });
  const filterSel = r.querySelector('#fd-filter');
  if (filterSel)
    filterSel.onchange = () => {
      view.filter = filterSel.value;
      rerender();
    };
  const typeSel = r.querySelector('#fd-type');
  if (typeSel)
    typeSel.onchange = () => {
      view.type = typeSel.value;
      rerender();
    };
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
  const cf = r.querySelector('[data-act="clear-filter"]');
  if (cf)
    cf.onclick = () => {
      view.filter = '';
      view.type = '';
      view.groupId = 'all';
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
    (it.hasPosition ? '编辑 ' : '设置持仓 · ') + code,
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
      <div class="field"><label>按类型挑选（点一行即选中）</label>
        <div class="chip-row" id="fd-types">
          ${[
            ['all', '全部'],
            ['zs', '指数'],
            ['gp', '股票'],
            ['hh', '混合'],
            ['zq', '债券'],
            ['qdii', 'QDII'],
            ['fof', 'FOF'],
          ]
            .map(([k, label]) => `<button type="button" class="chip${k === 'all' ? ' active' : ''}" data-type="${k}">${label}</button>`)
            .join('')}
        </div>
        <div class="explore-bar">
          <select class="input" id="fd-xsort">
            <option value="1nzf">按近 1 年收益</option>
            <option value="6yzf">按近 6 月收益</option>
            <option value="3yzf">按近 3 月收益</option>
            <option value="1yzf">按近 1 月收益</option>
            <option value="rzdf">按日涨幅</option>
            <option value="jnzf">按今年来收益</option>
            <option value="lnzf">按成立来收益</option>
          </select>
          <button type="button" class="btn ghost small" id="fd-more">换一批</button>
        </div>
        <div id="fd-list" class="fund-list"><div class="muted" style="padding:10px;font-size:12px">加载中…</div></div>
        <div class="muted" id="fd-explore-tip" style="font-size:12px;margin-top:4px">—</div>
      </div>
      <input type="hidden" id="fd-code">
      <input type="hidden" id="fd-nick">
      <div class="field"><label>分组</label><select class="input" id="fd-group">
        ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}
      </select></div>
      <div class="grid-2">
        <div class="field"><label>成本价（选填）</label><input class="input" id="fd-cost" type="number" step="0.0001"></div>
        <div class="field"><label>份额（选填）</label><input class="input" id="fd-shares" type="number" step="0.01"></div>
      </div>
      <div class="muted" style="font-size:12px;margin:-4px 0 8px">
        成本价与份额都填了才算建仓，这只鸡才会进鸡舍；留空则先放进自选里观察。
      </div>
      <div class="picked-fund" id="fd-picked">未选择基金：从上面列表点一行，或搜索后选中</div>
      <button class="btn block" id="fd-adopt">领养</button>`,
    (body, close) => {
      const qInput = body.querySelector('#fd-q');
      const codeInput = body.querySelector('#fd-code');
      const nickInput = body.querySelector('#fd-nick');
      const resultBox = body.querySelector('#fd-result');

      /* ---------- 按类型 / 业绩筛选基金 ---------- */
      const listBox = body.querySelector('#fd-list');
      const tipBox = body.querySelector('#fd-explore-tip');
      const sortSel = body.querySelector('#fd-xsort');
      const ex = { type: 'all', sort: '1nzf', page: 1, loading: false };
      const fmtP = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '--');

      const pickedBox = body.querySelector('#fd-picked');
      const setPicked = (name, code) => {
        codeInput.value = code;
        // 昵称不再截断（曾经 slice(0,12) 导致「易方达中债7-10年期国」这种断名）；
        // 留空则由服务端显示完整基金名，用户可以之后在「编辑」里自定义
        nickInput.value = '';
        resultBox.innerHTML = `<span class="selected-fund">✓ ${esc(name || code)} ${esc(code)}</span>`;
        if (pickedBox)
          pickedBox.innerHTML = `已选：<b>${esc(name || code)}</b> <span class="muted">${esc(code)}</span>`;
      };

      const pickRow = (btn) => {
        listBox.querySelectorAll('.fund-row').forEach((x) => x.classList.toggle('active', x === btn));
        setPicked(btn.getAttribute('data-name'), btn.getAttribute('data-code'));
      };

      const bindRows = () => {
        listBox.querySelectorAll('.fund-row').forEach((b) => {
          b.onclick = () => pickRow(b);
        });
      };

      const loadExplore = async () => {
        if (ex.loading) return;
        ex.loading = true;
        listBox.innerHTML = '<div class="muted" style="padding:10px;font-size:12px">加载中…</div>';
        try {
          const d = await Api.explore(`type=${ex.type}&sort=${ex.sort}&page=${ex.page}&size=20`);
          const items = d.items || [];
          listBox.innerHTML = items.length
            ? items
                .map(
                  (it) => `<button type="button" class="fund-row" data-code="${esc(it.code)}" data-name="${esc(
                    it.name || ''
                  )}">
                    <div class="fr-name">${esc(it.name || it.code)}</div>
                    <div class="fr-meta">
                      <span>${esc(it.code)}</span>
                      <span>近1年 <b class="${pctClass(it.y1)}">${fmtP(it.y1)}</b></span>
                      <span>近3月 <b class="${pctClass(it.m3)}">${fmtP(it.m3)}</b></span>
                      ${it.estab ? `<span>${esc(it.estab)} 成立</span>` : ''}
                    </div>
                  </button>`
                )
                .join('')
            : '<div class="empty" style="padding:12px">这一类暂时没有数据</div>';
          bindRows();
          const c = d.counts || {};
          tipBox.textContent = `共 ${d.total || 0} 只 · 第 ${d.page || ex.page} 页${
            c.all ? ` · 指数 ${c.zs} / 股票 ${c.gp} / 混合 ${c.hh} / 债券 ${c.zq} / QDII ${c.qdii} / FOF ${c.fof}` : ''
          }`;
        } catch (e) {
          listBox.innerHTML = '<div class="empty" style="padding:12px">加载失败，稍后重试</div>';
          tipBox.textContent = '—';
        } finally {
          ex.loading = false;
        }
      };

      body.querySelectorAll('#fd-types .chip').forEach((chip) => {
        chip.onclick = () => {
          body.querySelectorAll('#fd-types .chip').forEach((x) => x.classList.toggle('active', x === chip));
          ex.type = chip.getAttribute('data-type');
          ex.page = 1;
          loadExplore();
        };
      });
      sortSel.onchange = () => {
        ex.sort = sortSel.value;
        ex.page = 1;
        loadExplore();
      };
      body.querySelector('#fd-more').onclick = () => {
        ex.page += 1;
        loadExplore();
      };
      loadExplore();

      const ac = attachAutocomplete(qInput, {
        fetchItems: async (q) => (await Api.search(q)).items,
        onPick: (it) => {
          setPicked(it.name || it.code, it.code);
          listBox.querySelectorAll('.fund-row').forEach((x) => x.classList.remove('active'));
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
        if (!/^\d{6}$/.test(code)) return toast('先从列表里选一只基金，或在上面搜索选中');
        try {
          const out = await Api.adopt({
            code,
            nickname: body.querySelector('#fd-nick').value,
            groupId: body.querySelector('#fd-group').value || null,
            costPrice: body.querySelector('#fd-cost').value || null,
            shares: body.querySelector('#fd-shares').value || null,
          });
          close();
          const positioned = Number(body.querySelector('#fd-cost').value) > 0 && Number(body.querySelector('#fd-shares').value) > 0;
          toast(
            positioned
              ? `领养成功：${esc(out.fund?.name || code)}（${esc(out.breed)}）`
              : `已加入自选：${esc(out.fund?.name || code)}，设置持仓后才会进鸡舍`
          );
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
