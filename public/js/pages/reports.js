import { Api } from '../api.js';
import { esc, toast, modal, confirmBox, fmtDate } from '../util.js';
import { showAchievements } from './yard.js';

let data = null;
let adoptions = [];
const filter = { q: '', status: '', link: '' };
let root = null;
let searchTimer = null;

/* ---------------- 数据 ---------------- */

async function loadAdoptions(force) {
  if (adoptions.length && !force) return adoptions;
  try {
    const f = await Api.funds();
    adoptions = f.items || [];
  } catch (e) {
    adoptions = [];
  }
  return adoptions;
}

function buildQs() {
  const p = new URLSearchParams();
  if (filter.q) p.set('q', filter.q);
  if (filter.status) p.set('status', filter.status);
  if (filter.link) p.set('link', filter.link);
  return p.toString();
}

async function rerender() {
  if (!root) return;
  data = await Api.reportsAll(buildQs());
  root.innerHTML = await render();
  await mount(root);
}

const STATUS_TEXT = {
  done: ['已解析', 'tag'],
  parsing: ['解析中', 'tag'],
  pending: ['待解析', 'tag'],
  failed: ['解析失败', 'tag'],
};

/* ---------------- 渲染 ---------------- */

export async function render() {
  if (!data) data = await Api.reportsAll(buildQs());
  await loadAdoptions();
  const st = data.stats || {};
  const items = data.items || [];

  const chips = [
    { label: '全部', status: '', link: '' },
    { label: '已解析', status: 'done', link: '' },
    { label: '解析中', status: 'parsing', link: '' },
    { label: '未关联', status: '', link: 'none' },
    { label: '已关联', status: '', link: 'linked' },
  ]
    .map(
      (c) =>
        `<button data-fstatus="${c.status}" data-flink="${c.link}" class="${
          filter.status === c.status && filter.link === c.link ? 'active' : ''
        }">${c.label}</button>`
    )
    .join('');

  return `
    <div class="card tight">
      <div class="search-row" style="margin-bottom:8px">
        <div class="ac-wrap">
          <input class="input" id="rp-q" placeholder="搜索报告标题、基金名称或代码" value="${esc(filter.q)}" autocomplete="off">
        </div>
        <button class="btn" id="rp-search">搜索</button>
      </div>
      <div class="tabs">${chips}</div>
    </div>

    <div class="card">
      <div class="card-title">报告库<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">共 ${st.total || 0} 份 · 未关联 ${st.unlinked || 0}</span>
      </div>
      ${
        items.length
          ? items.map(reportCard).join('')
          : `<div class="empty"><span class="big">📄</span>还没有报告<br/>点右下角「新增报告」上传季报、研报，或让 AI 帮你写一份</div>`
      }
      <div class="ai-note" style="margin-top:10px">
        AI 解析结果由模型生成，可能存在偏差，仅供参考，不构成投资建议。请以原文为准。
      </div>
    </div>

    <button class="btn fab" data-act="new">＋ 新增报告</button>`;
}

function reportCard(r) {
  const p = r.parse;
  const st = STATUS_TEXT[r.status] || ['未知', 'tag'];
  const linkLabel = r.fundCode
    ? `<a href="#/fund/${esc(r.fundCode)}" data-jump="${esc(r.fundCode)}">${esc(r.fundName || r.fundCode)}</a>
       ${r.adopted ? '' : '<span class="tag">未领养</span>'}
       <span class="muted">${esc(r.fundCode)}</span>`
    : '<span class="muted">未关联基金</span>';
  return `<div class="report-item" data-id="${esc(r.id)}">
    <div style="display:flex;gap:8px;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="ri-title">${esc(r.title)}</div>
        <div class="muted" style="font-size:12px;margin-top:2px">
          ${linkLabel} · ${esc(fmtDate(r.reportDate))} · ${esc(st[0])}${r.fileName ? ' · ' + esc(r.fileName) : ''}
        </div>
        <div style="margin-top:4px">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>
    </div>
    ${
      p
        ? `<div style="margin-top:8px;font-size:14px">${esc(p.summary || '')}</div>
           ${
             (p.keyPoints || []).length
               ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px">${p.keyPoints
                   .map((k) => `<li>${esc(k)}</li>`)
                   .join('')}</ul>`
               : ''
           }`
        : r.content
        ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(r.content.slice(0, 120))}…</div>`
        : ''
    }
    <div class="rep-actions">
      <button class="btn ghost small" data-view="${esc(r.id)}">查看</button>
      <button class="btn ghost small" data-link="${esc(r.id)}">${r.fundCode ? '更换关联' : '关联基金'}</button>
      <button class="btn ghost small" data-del="${esc(r.id)}">删除</button>
    </div>
  </div>`;
}

/* ---------------- 事件 ---------------- */

export async function mount(r) {
  root = r;

  const qInput = r.querySelector('#rp-q');
  const doSearch = () => {
    filter.q = qInput.value.trim();
    rerender();
  };
  r.querySelector('#rp-search').onclick = doSearch;
  qInput.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 400);
  };
  qInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      doSearch();
    }
  };

  r.querySelectorAll('[data-fstatus]').forEach((b) => {
    b.onclick = () => {
      filter.status = b.getAttribute('data-fstatus');
      filter.link = b.getAttribute('data-flink');
      rerender();
    };
  });

  r.querySelector('[data-act="new"]').onclick = () => uploadModal('', () => rerender());

  r.querySelectorAll('[data-jump]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      location.hash = '#/fund/' + a.getAttribute('data-jump');
    };
  });

  r.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => viewModal(b.getAttribute('data-view'), rerender);
  });
  r.querySelectorAll('[data-link]').forEach((b) => {
    b.onclick = () => chooseFundModal(b.getAttribute('data-link'), rerender);
  });
  r.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute('data-del');
      confirmBox('删除这份报告？', '报告文件与解析结果都会删除，操作不可恢复。', async () => {
        try {
          await Api.delReport(id);
          toast('已删除');
          rerender();
        } catch (e) {
          toast('删除失败：' + e.message);
        }
      });
    };
  });
}

/* ---------------- 弹窗：新增 ---------------- */

export function uploadModal(defaultFundCode, onDone) {
  const fundOptions = [
    `<option value="">暂不关联（仅存档）</option>`,
    ...adoptions.map(
      (a) =>
        `<option value="${esc(a.fundCode)}" ${a.fundCode === defaultFundCode ? 'selected' : ''}>${esc(
          a.nickname || a.name
        )} · ${esc(a.fundCode)}</option>`
    ),
  ].join('');

  modal(
    '新增报告',
    () => `
      <div class="field"><label>关联基金</label>
        <select class="input" id="up-fund">${fundOptions}</select>
        ${adoptions.length ? '' : '<div class="muted" style="font-size:12px;margin-top:4px">还没有领养基金，可先到「自选」添加</div>'}
      </div>
      <div class="field"><label>或填写其他基金代码（6 位，选填）</label>
        <input class="input" id="up-code" placeholder="如 005827">
      </div>
      <div class="seg" style="margin-bottom:12px">
        <button data-mode="file" class="active">上传文件</button>
        <button data-mode="text">粘贴文本</button>
      </div>
      <div id="up-file">
        <div class="field"><label>文件（PDF / MD / TXT / 图片，≤20MB）</label>
          <input class="input" id="up-input" type="file" accept=".pdf,.md,.markdown,.txt,.csv,.png,.jpg,.jpeg,.webp">
        </div>
      </div>
      <div id="up-text" style="display:none">
        <div class="field"><label>报告正文</label>
          <textarea class="input" id="up-content" placeholder="粘贴季报、研报内容…"></textarea>
        </div>
      </div>
      <div class="field"><label>标题</label><input class="input" id="up-title" placeholder="如：2026Q2 季报解读"></div>
      <div class="grid-2">
        <div class="field"><label>报告日期</label><input class="input" id="up-date" type="date" value="${new Date()
          .toISOString()
          .slice(0, 10)}"></div>
        <div class="field"><label>标签（逗号分隔）</label><input class="input" id="up-tags" placeholder="季报,AI生成"></div>
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:10px">
        <input type="checkbox" id="up-parse" checked style="width:18px;height:18px"> 上传后用 AI 解析要点
      </label>
      <button class="btn block" id="up-submit">上传</button>
      <div class="muted" style="font-size:12px;margin-top:8px">解析由大模型完成，结果仅供参考，不构成投资建议。</div>`,
    (body, close) => {
      const modeBtns = body.querySelectorAll('.seg button');
      modeBtns.forEach((b) => {
        b.onclick = () => {
          const m = b.getAttribute('data-mode');
          modeBtns.forEach((x) => x.classList.toggle('active', x === b));
          body.querySelector('#up-file').style.display = m === 'file' ? '' : 'none';
          body.querySelector('#up-text').style.display = m === 'text' ? '' : 'none';
        };
      });

      body.querySelector('#up-submit').onclick = async () => {
        const isFile = body.querySelector('#up-file').style.display !== 'none';
        const manual = body.querySelector('#up-code').value.trim();
        const selected = body.querySelector('#up-fund').value;
        if (manual && !/^\d{6}$/.test(manual)) return toast('基金代码需为 6 位数字');
        const fundCode = manual || selected;

        const form = new FormData();
        form.append('fund_code', fundCode);
        form.append('title', body.querySelector('#up-title').value || '未命名报告');
        form.append('report_date', body.querySelector('#up-date').value || '');
        form.append('tags', body.querySelector('#up-tags').value || '');
        form.append('parse', body.querySelector('#up-parse').checked ? 'true' : 'false');
        if (isFile) {
          const file = body.querySelector('#up-input').files[0];
          if (!file) return toast('请选择文件');
          form.append('file', file);
        } else {
          const content = body.querySelector('#up-content').value;
          if (!content.trim()) return toast('请粘贴报告内容');
          form.append('content', content);
          form.append('source', 'text');
        }

        try {
          const out = await Api.createReport(form);
          close();
          toast('上传成功' + (out.report.status === 'parsing' ? '，AI 正在解析' : ''));
          if (out.newAchievements?.length) showAchievements(out.newAchievements);
          if (onDone) onDone(out.report);
        } catch (e) {
          toast(
            e.message === 'file_too_large'
              ? '文件超过 20MB'
              : e.message === 'bad_fund_code'
              ? '基金代码不正确'
              : '上传失败：' + e.message
          );
        }
      };
    }
  );
}

/* ---------------- 弹窗：查看 ---------------- */

export async function viewModal(id, onDone) {
  let r;
  try {
    const out = await Api.report(id);
    r = out.report;
  } catch (e) {
    return toast('加载失败：' + e.message);
  }
  const p = r.parse;
  modal(
    r.title,
    () => `
      <div class="muted" style="font-size:12px">
        ${r.fundCode ? `<a href="#/fund/${esc(r.fundCode)}" data-jump2="${esc(r.fundCode)}">${esc(r.fundName || r.fundCode)}</a> · ${esc(r.fundCode)} · ` : '未关联基金 · '}
        ${esc(fmtDate(r.reportDate))} · ${esc(r.source || '')}${r.fileName ? ' · ' + esc(r.fileName) : ''}
      </div>
      <div style="margin-top:10px">
        ${
          p
            ? `<div style="font-size:14px">${esc(p.summary || '')}</div>
               ${
                 (p.keyPoints || []).length
                   ? `<div style="margin-top:8px"><b>要点</b><ul style="margin:4px 0 0;padding-left:18px;font-size:13px">${p.keyPoints
                       .map((k) => `<li>${esc(k)}</li>`)
                       .join('')}</ul></div>`
                   : ''
               }
               ${
                 (p.risks || []).length
                   ? `<div style="margin-top:8px"><b>风险</b><ul style="margin:4px 0 0;padding-left:18px;font-size:13px">${p.risks
                       .map((k) => `<li>${esc(k)}</li>`)
                       .join('')}</ul></div>`
                   : ''
               }
               <div class="muted" style="font-size:11px;margin-top:6px">模型 ${esc(p.model || '')} · 置信度 ${
                 p.confidence === null || p.confidence === undefined ? '--' : Math.round(p.confidence * 100) + '%'
               }</div>`
            : `<div class="muted" style="font-size:13px">${
                r.status === 'parsing' ? 'AI 解析中，稍后刷新查看' : '暂无解析结果'
              }</div>`
        }
      </div>
      ${
        r.content
          ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px">查看报告原文</summary>
              <pre style="white-space:pre-wrap;font-size:12px;background:#fffdf8;border:1px solid var(--line);border-radius:12px;padding:10px;max-height:32vh;overflow:auto">${esc(
                r.content
              )}</pre></details>`
          : ''
      }
      <div class="modal-actions">
        ${r.content ? '<button class="btn ghost" data-reparse>重新解析</button>' : ''}
        <button class="btn" data-close>关闭</button>
      </div>
      <div class="ai-note">AI 解析仅供参考，不构成投资建议。</div>`,
    (body, close) => {
      body.querySelector('[data-close]').onclick = close;
      const jump = body.querySelector('[data-jump2]');
      if (jump)
        jump.onclick = (e) => {
          e.preventDefault();
          close();
          location.hash = '#/fund/' + jump.getAttribute('data-jump2');
        };
      const rp = body.querySelector('[data-reparse]');
      if (rp)
        rp.onclick = async () => {
          try {
            await Api.reparse(id);
            close();
            toast('已重新提交解析');
            if (onDone) onDone();
          } catch (e) {
            toast('失败：' + e.message);
          }
        };
    }
  );
}

/* ---------------- 弹窗：选择关联基金 ---------------- */

export function chooseFundModal(reportId, onDone) {
  modal(
    '关联到基金',
    () => `
      <div class="muted" style="font-size:12px;margin-bottom:8px">选择一只已领养的基金，或填写其他基金代码</div>
      ${
        adoptions.length
          ? adoptions
              .map(
                (a) => `<div class="list-row" data-pick="${esc(a.fundCode)}">
                  <div class="lr-main">
                    <div class="lr-name">${esc(a.nickname || a.name)}</div>
                    <div class="lr-sub">${esc(a.fundCode)} · ${esc(a.breedName || '')}</div>
                  </div>
                  <div class="lr-right"><span class="tag">选择</span></div>
                </div>`
              )
              .join('')
          : '<div class="empty" style="padding:10px">还没有领养基金</div>'
      }
      <hr style="border:0;border-top:1px solid var(--line);margin:10px 0">
      <div class="search-row">
        <div class="ac-wrap"><input class="input" id="lk-code" placeholder="其他基金代码（6 位）"></div>
        <button class="btn" id="lk-ok">关联</button>
      </div>`,
    (body, close) => {
      const link = async (code) => {
        try {
          await Api.updateReport(reportId, { fund_code: code });
          close();
          toast('已关联到 ' + code);
          if (onDone) onDone();
        } catch (e) {
          toast('关联失败：' + e.message);
        }
      };
      body.querySelectorAll('[data-pick]').forEach((el) => {
        el.onclick = () => link(el.getAttribute('data-pick'));
      });
      body.querySelector('#lk-ok').onclick = () => {
        const code = body.querySelector('#lk-code').value.trim();
        if (!/^\d{6}$/.test(code)) return toast('请输入 6 位基金代码');
        link(code);
      };
    }
  );
}

/* ---------------- 弹窗：把已有报告关联到当前基金 ---------------- */

export async function linkReportModal(targetCode, onDone) {
  let list = [];
  try {
    const out = await Api.reportsAll('');
    list = (out.items || []).filter((r) => r.fundCode !== targetCode);
  } catch (e) {
    return toast('加载失败：' + e.message);
  }
  modal(
    '关联已有报告',
    () =>
      list.length
        ? `<div class="muted" style="font-size:12px;margin-bottom:8px">点击即把该报告关联到当前基金（${esc(
            targetCode
          )}）</div>` +
          list
            .map(
              (r) => `<div class="list-row" data-pick="${esc(r.id)}">
                <div class="lr-main">
                  <div class="lr-name">${esc(r.title)}</div>
                  <div class="lr-sub">${r.fundCode ? esc(r.fundName || r.fundCode) + ' · ' + esc(r.fundCode) : '未关联'} · ${esc(
                fmtDate(r.reportDate)
              )}</div>
                </div>
                <div class="lr-right"><span class="tag">关联</span></div>
              </div>`
            )
            .join('')
        : '<div class="empty" style="padding:14px">没有可关联的报告<br/>先去「报告」页上传一份吧</div>',
    (body, close) => {
      body.querySelectorAll('[data-pick]').forEach((el) => {
        el.onclick = async () => {
          try {
            await Api.updateReport(el.getAttribute('data-pick'), { fund_code: targetCode });
            close();
            toast('已关联到本基金');
            if (onDone) onDone();
          } catch (e) {
            toast('关联失败：' + e.message);
          }
        };
      });
    }
  );
}
