import { Api } from '../api.js';
import { chickenSVG } from '../chicken.js';
import { esc, pct, pctClass, fmtAmount, money, fmtDate, toast, modal, confirmBox, copyText } from '../util.js';
import { getState } from '../app.js';
import { showAchievements } from './yard.js';
import { uploadModal, linkReportModal, reportExcerpt } from './reports.js';
import { feedModal, patModal, noteModal } from './care.js';
import { navChart } from '../chart.js';

let data = null;
let range = 60;
let root = null;
let code = '';
let chartHandle = null;

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

  const header = `
    <div class="card">
      <div style="display:flex;gap:14px;align-items:center">
        <div style="flex:0 0 110px">${c ? chickenSVG(c, { size: 110, showHungry: true }) : '<div class="empty">未领养</div>'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:17px">${esc(data.adoption?.nickname || f.name || code)}</div>
          <div class="muted" style="font-size:13px">${esc(code)} · ${esc(f.type || '')} ${esc(f.company || '')}</div>
          <div style="margin-top:6px;font-size:26px;font-weight:800" class="${pctClass(q.pct ?? m.current?.pct)}">
            ${q.pct !== undefined && q.pct !== null ? pct(q.pct) : '--'}
          </div>
          <div class="muted" style="font-size:12px">
            估算 ${q.estimate ?? '--'} · 净值 ${q.nav ?? '--'} ${q.navDate ? '（' + esc(q.navDate) + '）' : ''}
            ${q.live === false ? ' · 数据可能延迟' : ''}
          </div>
        </div>
      </div>
      ${
        c
          ? `<div style="margin-top:12px">
              <div class="grid-2" style="gap:8px">
                <div class="bar-row"><span>饱食</span><span class="bar"><span style="width:${c.satiety}%"></span></span><b>${c.satiety}</b></div>
                <div class="bar-row"><span>心情</span><span class="bar"><span style="width:${c.moodValue}%"></span></span><b>${c.moodValue}</b></div>
                <div class="bar-row"><span>健康</span><span class="bar"><span style="width:${c.health}%"></span></span><b>${c.health}</b></div>
                <div class="bar-row"><span>亲密</span><span class="bar"><span style="width:${c.bond}%"></span></span><b>${c.bond}</b></div>
              </div>
              <div class="muted" style="font-size:12px;margin-top:6px">
                ${esc(c.breedName)} · ${esc(c.stateLabel)} · 产蛋 ${c.eggs}（金蛋 ${c.goldenEggs}） · 掉毛 ${c.feathers}
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

  const chartData = (data.history || []).slice(-range).map((h) => ({ v: h.nav, date: h.date }));
  chartHandle = navChart(chartData, {
    label: `${(data.adoption && data.adoption.nickname) || f.name || code} 净值走势`,
  });
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
      ${chartData.length > 1 ? chartHandle.html : '<div class="empty" style="padding:12px">暂无净值数据</div>'}
      ${
        data.historyStale
          ? '<div class="muted" style="font-size:12px;text-align:center">历史数据为本地缓存，第三方接口暂不可用</div>'
          : ''
      }
    </div>`;

  const info = `
    <div class="card">
      <div class="card-title">基金档案</div>
      <div class="kv"><span class="k">基金类型</span><span>${esc(f.type || '--')}</span></div>
      <div class="kv"><span class="k">基金公司</span><span>${esc(f.company || '--')}</span></div>
      <div class="kv"><span class="k">基金经理</span><span>${esc(f.manager || '--')}</span></div>
      <div class="kv"><span class="k">成立时间</span><span>${esc(f.established || '--')}</span></div>
      <div class="kv"><span class="k">基金规模</span><span>${esc(f.scale ? f.scale + ' 亿' : '--')}</span></div>
    </div>`;

  const holding = data.adopted
    ? `
    <div class="card">
      <div class="card-title">我的持仓<span class="spacer"></span>
        <button class="btn ghost small" data-act="edit">编辑</button></div>
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

  return `${header}${chart}${info}${holding}${reports}${notes}
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

  if (chartHandle && chartHandle.bind) chartHandle.bind(r);

  r.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = async () => {
      range = Number(b.getAttribute('data-range'));
      root.innerHTML = await render();
      await mount(root);
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

  const editBtn = r.querySelector('[data-act="edit"]');
  if (editBtn)
    editBtn.onclick = () => {
      const a = data.adoption;
      modal(
        '编辑持仓',
        () => `
        <div class="field"><label>昵称</label><input class="input" id="ed-nick" value="${esc(a.nickname || '')}"></div>
        <div class="field"><label>成本价</label><input class="input" id="ed-cost" type="number" step="0.0001" value="${a.costPrice ?? ''}"></div>
        <div class="field"><label>份额</label><input class="input" id="ed-shares" type="number" step="0.01" value="${a.shares ?? ''}"></div>
        <div class="field"><label>首次买入日期</label><input class="input" id="ed-date" type="date" value="${esc(a.firstBuyDate || '')}"></div>
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
