import { Api } from '../api.js';
import { esc, toast, modal, confirmBox, fmtDate, copyText, plainText } from '../util.js';
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

/** 供其他页面（加餐弹窗等）复用：确保已领养基金列表新鲜 */
export async function ensureAdoptions() {
  return loadAdoptions(true);
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

/**
 * 报告正文/解析结果里的文本清理：HTML 报告只保留人可读的纯文本，
 * 列表与详情都只展示「看得懂的内容」，原始标签留给「查看源码」。
 */
export function cleanReportText(r, s) {
  const isHtml = (r && r.contentType) === 'html';
  const t = isHtml ? plainText(s) : String(s || '').replace(/\s+/g, ' ').trim();
  return t;
}

/** 列表用的一段可读摘要（优先 AI 摘要 → 首个要点 → 正文），不展示标签与解析状态 */
export function reportExcerpt(r, max = 140) {
  const p = r.parse || {};
  const cands = [p.summary, (p.keyPoints || [])[0], r.content];
  for (const c of cands) {
    const t = cleanReportText(r, c);
    if (t) return max ? plainText(t, max) : t;
  }
  return '';
}

/* ---------------- 渲染 ---------------- */

export async function render() {
  // 每次都拉最新：从报告详情页返回时能看到删除 / 关联 / 解析后的结果
  data = await Api.reportsAll(buildQs());
  await loadAdoptions();
  const st = data.stats || {};
  const items = data.items || [];

  const chips = [
    { label: '全部', status: '', link: '' },
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
  const typeTag =
    { html: 'HTML', markdown: 'Markdown', text: '文本', file: '文件' }[r.contentType || ''] || '';
  const linkLabel = r.fundCode
    ? `<a href="#/fund/${esc(r.fundCode)}" data-jump="${esc(r.fundCode)}">${esc(r.fundName || r.fundCode)}</a>
       ${r.adopted ? '' : '<span class="tag">未领养</span>'}
       <span class="muted">${esc(r.fundCode)}</span>`
    : '<span class="muted">未关联基金</span>';
  const excerpt = reportExcerpt(r, 140);
  return `<div class="report-item" data-id="${esc(r.id)}">
    <div class="ri-title">${esc(r.title)}</div>
    <div class="muted" style="font-size:12px;margin-top:2px">
      ${linkLabel} · ${esc(fmtDate(r.reportDate))}${typeTag ? ' · <span class="tag">' + typeTag + '</span>' : ''}${
    r.fileName ? ' · ' + esc(r.fileName) : ''
  }
    </div>
    ${excerpt ? `<div class="ri-excerpt">${esc(excerpt)}</div>` : ''}
    ${
      (r.tags || []).length
        ? `<div style="margin-top:4px">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
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
    b.onclick = () => {
      location.hash = '#/report/' + encodeURIComponent(b.getAttribute('data-view')) + '?from=reports';
    };
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
        <button data-mode="api">开放接口</button>
      </div>

      <div id="up-file">
        <div class="field"><label>文件（PDF / MD / TXT / HTML / 图片，≤20MB）</label>
          <input class="input" id="up-input" type="file" accept=".pdf,.md,.markdown,.txt,.csv,.html,.htm,.png,.jpg,.jpeg,.webp">
        </div>
      </div>

      <div id="up-text" style="display:none">
        <div class="field"><label>内容格式</label>
          <select class="input" id="up-ctype">
            <option value="auto">自动识别（推荐）</option>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
            <option value="text">纯文本</option>
          </select>
        </div>
        <div class="field"><label>报告正文</label>
          <textarea class="input" id="up-content" placeholder="粘贴季报、研报，或 AI 生成的 HTML…"></textarea>
        </div>
      </div>

      <div id="up-api" style="display:none">
        <div class="muted" style="font-size:13px">
          把下面的提示词复制给任意 AI 助手（ChatGPT / 元宝 / Claude…），它会检索资料、生成
          <b>HTML 报告</b>并直接调用养基场开放接口写入你的报告库。
        </div>
        <div class="seg" id="up-pfmt" style="margin:10px 0">
          <button data-pfmt="html" class="active">HTML 格式（推荐）</button>
          <button data-pfmt="markdown">Markdown 格式</button>
        </div>
        <pre class="prompt-box" id="up-prompt">正在生成提示词…</pre>
        <div class="grid-2" style="margin-top:10px">
          <button class="btn" id="up-copy">复制提示词</button>
          <button class="btn ghost" id="up-refresh">重新生成</button>
        </div>
        <div class="ai-note">
          提示词中的 <b>{API_KEY}</b> 需替换为你自己的密钥：在「我的 → 开发者 API Key」生成（fa_ 前缀）。
          AI 提交后回到本页刷新即可看到新报告。
        </div>
        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:13px">查看开放接口清单</summary>
          <pre class="prompt-box" id="up-endpoints" style="margin-top:8px"></pre>
        </details>
      </div>

      <div id="up-meta">
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
        <div class="muted" style="font-size:12px;margin-top:8px">解析由大模型完成，结果仅供参考，不构成投资建议。</div>
      </div>`,
    (body, close) => {
      let mode = 'file';
      let promptFmt = 'html';
      let promptKey = '';

      const panels = {
        file: body.querySelector('#up-file'),
        text: body.querySelector('#up-text'),
        api: body.querySelector('#up-api'),
      };
      const meta = body.querySelector('#up-meta');

      const targetCode = () => {
        const manual = body.querySelector('#up-code').value.trim();
        return manual || body.querySelector('#up-fund').value || '';
      };

      const loadPrompt = async (force) => {
        const box = body.querySelector('#up-prompt');
        const code = targetCode();
        const key = code + ':' + promptFmt;
        if (promptKey === key && !force) return;
        box.textContent = '正在生成提示词…';
        try {
          const out = await Api.aiPrompt(code, promptFmt);
          promptKey = key;
          box.textContent = out.prompt;
          const eps = out.endpoints || [];
          body.querySelector('#up-endpoints').textContent =
            `${out.base || ''}/api/v1\n\n` + eps.map((e) => '· ' + e).join('\n');
        } catch (e) {
          box.textContent = '生成失败：' + e.message;
        }
      };

      const setMode = (m) => {
        mode = m;
        body
          .querySelectorAll('.seg button[data-mode]')
          .forEach((x) => x.classList.toggle('active', x.getAttribute('data-mode') === m));
        Object.entries(panels).forEach(([k, el]) => (el.style.display = k === m ? '' : 'none'));
        meta.style.display = m === 'api' ? 'none' : '';
        if (m === 'api') loadPrompt(false);
      };

      body.querySelectorAll('.seg button[data-mode]').forEach((b) => {
        b.onclick = () => setMode(b.getAttribute('data-mode'));
      });

      const onTargetChange = () => {
        if (mode === 'api') loadPrompt(true);
      };
      body.querySelector('#up-code').addEventListener('change', onTargetChange);
      body.querySelector('#up-fund').addEventListener('change', onTargetChange);

      body.querySelectorAll('[data-pfmt]').forEach((b) => {
        b.onclick = () => {
          promptFmt = b.getAttribute('data-pfmt');
          body.querySelectorAll('[data-pfmt]').forEach((x) => x.classList.toggle('active', x === b));
          loadPrompt(true);
        };
      });

      body.querySelector('#up-copy').onclick = async () => {
        try {
          await copyText(body.querySelector('#up-prompt').textContent);
          toast('提示词已复制，粘贴给 AI 即可');
        } catch (e) {
          toast('复制失败，请手动选择文本');
        }
      };
      body.querySelector('#up-refresh').onclick = () => loadPrompt(true);

      body.querySelector('#up-submit').onclick = async () => {
        const isFile = mode === 'file';
        const manual = body.querySelector('#up-code').value.trim();
        if (manual && !/^\d{6}$/.test(manual)) return toast('基金代码需为 6 位数字');
        const fundCode = manual || body.querySelector('#up-fund').value;

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
          const ct = body.querySelector('#up-ctype').value;
          if (ct !== 'auto') form.append('content_type', ct);
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
