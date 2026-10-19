import { Api } from '../api.js';
import { esc, fmtDate, toast, confirmBox } from '../util.js';
import { cleanReportText, chooseFundModal } from './reports.js';

/** 报告详情页（#/report/{id}?from=reports|fund/{code}）：HTML 报告直接整页渲染 */

let data = null;
let root = null;
let id = '';
let from = '';

const TYPE_LABEL = { html: 'HTML', markdown: 'Markdown', text: '文本', file: '文件' };

function fromHash() {
  const q = String(location.hash || '').split('?')[1] || '';
  return new URLSearchParams(q).get('from') || '';
}

function backTarget() {
  if (from === 'reports' || !from) return { hash: '#/reports', label: '报告库' };
  if (from.startsWith('fund/')) return { hash: '#/' + from, label: '基金详情' };
  if (from === 'yard') return { hash: '#/yard', label: '鸡舍' };
  return { hash: '#/reports', label: '报告库' };
}

async function rerender() {
  if (!root) return;
  root.innerHTML = await render();
  await mount(root);
}

export async function render(param) {
  if (param) id = param;
  from = fromHash();
  data = await Api.report(id);
  const r = data.report || {};
  const p = r.parse;
  const isHtml = (r.contentType || '') === 'html';
  const back = backTarget();

  const summary = cleanReportText(r, p && p.summary);
  const points = ((p && p.keyPoints) || []).map((k) => cleanReportText(r, k)).filter(Boolean);
  const risks = ((p && p.risks) || []).map((k) => cleanReportText(r, k)).filter(Boolean);

  const linkLabel = r.fundCode
    ? `<a href="#/fund/${esc(r.fundCode)}">${esc(r.fundName || r.fundCode)}</a> · <span class="muted">${esc(
        r.fundCode
      )}</span>${r.adopted ? '' : ' <span class="tag">未领养</span>'}`
    : '<span class="muted">未关联基金</span>';

  const parseCard =
    p && (summary || points.length || risks.length)
      ? `<div class="card">
          <div class="card-title">AI 解析<span class="spacer"></span>
            <span class="muted" style="font-weight:400;font-size:12px">模型 ${esc(p.model || '')} · 置信度 ${
          p.confidence === null || p.confidence === undefined ? '--' : Math.round(p.confidence * 100) + '%'
        }</span>
          </div>
          ${summary ? `<div class="rep-summary">${esc(summary)}</div>` : ''}
          ${
            points.length
              ? `<div class="rep-block"><b>要点</b><ul>${points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>`
              : ''
          }
          ${
            risks.length
              ? `<div class="rep-block"><b>风险</b><ul>${risks.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>`
              : ''
          }
          <div class="ai-note">AI 解析由模型生成，可能存在偏差，仅供参考，不构成投资建议。请以原文为准。</div>
        </div>`
      : '';

  const body = isHtml
    ? `<div class="card">
        <div class="card-title">报告正文<span class="spacer"></span>
          <a class="btn ghost small" href="api/v1/reports/${encodeURIComponent(id)}/raw" target="_blank" rel="noopener">全屏打开</a>
        </div>
        <iframe class="html-preview full" sandbox title="${esc(r.title || 'HTML 报告')}"
                src="api/v1/reports/${encodeURIComponent(id)}/raw"></iframe>
        <div class="muted" style="font-size:11px;margin-top:6px">
          HTML 报告以沙箱方式渲染：不执行脚本、不加载外部资源
        </div>
        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:13px">查看 HTML 源码</summary>
          <pre class="prompt-box" style="margin-top:8px">${esc(r.content || '')}</pre>
        </details>
      </div>`
    : `<div class="card">
        <div class="card-title">报告正文<span class="spacer"></span>
          ${
            r.fileName
              ? `<a class="btn ghost small" href="api/v1/reports/${encodeURIComponent(
                  id
                )}/download" target="_blank" rel="noopener">下载原文件</a>`
              : ''
          }
        </div>
        <pre class="prompt-box report-doc">${esc(r.content || '（报告没有可读取的文本内容）')}</pre>
      </div>`;

  return `
    <div class="card tight">
      <div class="report-head">
        <button class="btn ghost small" data-back>← ${esc(back.label)}</button>
        <span class="spacer"></span>
        ${
          isHtml
            ? `<a class="btn small" href="api/v1/reports/${encodeURIComponent(id)}/raw" target="_blank" rel="noopener">全屏打开</a>`
            : ''
        }
        <button class="btn ghost small" data-link>${r.fundCode ? '更换关联' : '关联基金'}</button>
        ${r.content ? '<button class="btn ghost small" data-reparse>重新解析</button>' : ''}
        <button class="btn ghost small" data-del>删除</button>
      </div>
      <h2 class="report-detail-title">${esc(r.title || '未命名报告')}</h2>
      <div class="muted" style="font-size:12px;margin-top:4px">
        ${linkLabel} · ${esc(fmtDate(r.reportDate))} · ${esc(TYPE_LABEL[r.contentType || 'text'] || '文本')}${
    r.status === 'parsing' ? ' · 解析中…' : ''
  }${r.fileName ? ' · ' + esc(r.fileName) : ''}
      </div>
      ${
        (r.tags || []).length
          ? `<div style="margin-top:6px">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
          : ''
      }
    </div>
    ${parseCard}
    ${body}
    <div class="disclaimer">数据来源：第三方公开接口，可能存在延迟或误差。<br/>本工具仅供个人学习研究，不构成投资建议。</div>`;
}

export async function mount(r) {
  root = r;
  const r0 = data.report || {};

  r.querySelector('[data-back]').onclick = () => {
    location.hash = backTarget().hash;
  };

  r.querySelector('[data-link]').onclick = () => {
    chooseFundModal(r0.id, () => rerender());
  };

  const rp = r.querySelector('[data-reparse]');
  if (rp)
    rp.onclick = async () => {
      try {
        await Api.reparse(r0.id);
        toast('已重新提交解析');
        setTimeout(rerender, 1200);
      } catch (e) {
        toast('失败：' + e.message);
      }
    };

  r.querySelector('[data-del]').onclick = () => {
    confirmBox('删除这份报告？', '报告文件与解析结果都会删除，操作不可恢复。', async () => {
      try {
        await Api.delReport(r0.id);
        toast('已删除');
        location.hash = backTarget().hash;
      } catch (e) {
        toast('删除失败：' + e.message);
      }
    });
  };
}
