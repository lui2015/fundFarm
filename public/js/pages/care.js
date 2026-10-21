import { Api } from '../api.js';
import { esc, toast, modal } from '../util.js';

/**
 * 照料弹窗：喂食 / 安抚都必须附一份投研素材（报告或心得），
 * 目的是让「养鸡」留下真实的投研记录，而不是点一下就完事。
 */

const NOTE_MIN = { feed: 20, pat: 10, note: 10 };

const TEMPLATES = {
  feed: ['季报解读：', '持仓变化：', '基金经理观点：', '估值与性价比：', '费率与规模：'],
  pat: ['今天为什么我不慌：', '我守住了哪条纪律：', '这次下跌对组合意味着：'],
  note: ['买入/持有的理由：', '我看到的行业变化：', '我的操作纪律：', '复盘：做对与做错：'],
};

const PLACEHOLDER = {
  feed: '写下这份报告/这次研究的要点，例如：2026Q2 季报换手率下降，重仓白酒占比回落…',
  pat: '写一句此刻的心态，例如：跌了 1.3%，但持仓基本面没变，按纪律不动作…',
  note: '记录一条投研心得，例如：定投不要因为短期下跌中断…',
};

function charCount(s) {
  return [...String(s || '')].length;
}

function chipRow(kind) {
  return `<div class="chip-row">${TEMPLATES[kind]
    .map((t) => `<button type="button" class="chip" data-tpl="${esc(t)}">${esc(t.replace('：', ''))}</button>`)
    .join('')}</div>`;
}

function reportRowHtml(r) {
  return `<div class="list-row" data-rep="${esc(r.id)}">
    <div class="lr-main">
      <div class="lr-name">${esc(r.title)}</div>
      <div class="lr-sub">${esc(r.reportDate || '')} · ${
    { html: 'HTML', markdown: 'Markdown', text: '文本', file: '文件' }[r.contentType || ''] || '文本'
  }</div>
    </div>
    <div class="lr-right"><span class="tag">选择</span></div>
  </div>`;
}

/**
 * 加餐弹窗
 * @param {{id?:string,nickname?:string,fundCode?:string,all?:boolean}} target
 */
export function feedModal(target, onDone) {
  const isAll = !!target.all;
  const minLen = NOTE_MIN.feed;
  const fundCode = target.fundCode || '';
  let mode = 'note';
  let picked = null;
  let reports = [];

  modal(
    isAll ? '用一份投研素材喂全场' : `给 ${target.nickname || fundCode} 加餐`,
    () => `
      <div class="muted" style="font-size:13px">
        喂食需要附一份<b>投研素材</b>：上传 / 选择一份报告，或写下一条 ≥${minLen} 字的投资心得。
        素材会记进这只鸡的投研时间线，成长加成也更高（报告 +5 / 心得 +3）。
        ${isAll ? '<br/>一次喂全场的成长加成会递减。' : ''}
      </div>
      <div class="seg" id="cm-mode" style="margin:10px 0">
        <button data-mode="note" class="active">写投资心得</button>
        <button data-mode="report">用一份报告</button>
      </div>

      <div id="cm-note">
        ${chipRow('feed')}
        <div class="field"><textarea class="input" id="cm-text" rows="4" placeholder="${esc(
          PLACEHOLDER.feed
        )}"></textarea></div>
        <div class="counter"><span id="cm-count">0</span> / ${minLen} 字</div>
      </div>

      <div id="cm-report" style="display:none">
        <div id="cm-list"><div class="muted" style="font-size:13px;padding:6px 0">正在加载报告…</div></div>
        <button class="btn ghost block" id="cm-upload" style="margin-top:8px">＋ 上传一份新报告</button>
        <div class="muted" style="font-size:12px;margin-top:6px">
          报告可以直接用「开放接口」让 AI 写一份 HTML 报告，或手动上传 PDF / MD / HTML。
        </div>
      </div>

      <div class="grid-2" style="margin-top:12px">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="cm-ok">确认加餐</button>
      </div>`,
    (body, close) => {
      const notePanel = body.querySelector('#cm-note');
      const repPanel = body.querySelector('#cm-report');
      const ta = body.querySelector('#cm-text');
      const counter = body.querySelector('#cm-count');
      const okBtn = body.querySelector('#cm-ok');

      const refreshCounter = () => {
        const n = charCount(ta.value.trim());
        counter.textContent = n;
        counter.style.color = n >= minLen ? 'var(--ok, #2BA471)' : '';
      };
      ta.oninput = refreshCounter;
      refreshCounter();

      body.querySelectorAll('[data-tpl]').forEach((b) => {
        b.onclick = () => {
          const tpl = b.getAttribute('data-tpl');
          ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + tpl;
          ta.focus();
          refreshCounter();
        };
      });

      const loadReports = async () => {
        const box = body.querySelector('#cm-list');
        if (!fundCode) {
          box.innerHTML =
            '<div class="muted" style="font-size:13px;padding:6px 0">全场加餐请先上传一份报告，或在任意基金下选择报告</div>';
          return;
        }
        try {
          const out = await Api.reports(fundCode);
          reports = out.items || [];
          box.innerHTML = reports.length
            ? reports.map(reportRowHtml).join('')
            : '<div class="empty" style="padding:10px">这只基金还没有报告<br/>点下面按钮上传一份</div>';
          box.querySelectorAll('[data-rep]').forEach((el) => {
            el.onclick = () => {
              picked = el.getAttribute('data-rep');
              box.querySelectorAll('[data-rep]').forEach((x) => x.classList.toggle('picked', x === el));
            };
          });
        } catch (e) {
          box.innerHTML = '<div class="muted" style="padding:6px 0">报告加载失败：' + esc(e.message) + '</div>';
        }
      };

      const setMode = (m) => {
        mode = m;
        body.querySelectorAll('#cm-mode [data-mode]').forEach((x) =>
          x.classList.toggle('active', x.getAttribute('data-mode') === m)
        );
        notePanel.style.display = m === 'note' ? '' : 'none';
        repPanel.style.display = m === 'report' ? '' : 'none';
      };

      body.querySelectorAll('#cm-mode [data-mode]').forEach((b) => {
        b.onclick = () => {
          setMode(b.getAttribute('data-mode'));
          if (mode === 'report' && !reports.length) loadReports();
        };
      });

      body.querySelector('#cm-upload').onclick = async () => {
        const { uploadModal, ensureAdoptions } = await import('./reports.js');
        await ensureAdoptions().catch(() => null);
        uploadModal(fundCode, (report) => {
          if (report && report.id) {
            picked = report.id;
            setMode('report');
            loadReports();
          }
        });
      };

      body.querySelector('[data-close]').onclick = close;

      const payload = () => (mode === 'note' ? { note: ta.value.trim() } : { report_id: picked });

      okBtn.onclick = async () => {
        if (mode === 'note' && charCount(ta.value.trim()) < minLen) {
          return toast(`投资心得至少 ${minLen} 字，写下来才算真的研究过`);
        }
        if (mode === 'report' && !picked) return toast('请先选择一份报告，或上传新的报告');
        okBtn.disabled = true;
        try {
          let out;
          if (isAll) out = await Api.yardAction('feed-all', payload());
          else out = await Api.interact(target.id, 'feed', payload());
          close();
          toast(
            isAll
              ? out.fed
                ? `用同一份素材喂了 ${out.fed} 只鸡`
                : out.cooling
                ? '它们刚吃过，还在冷却中；素材已记入时间线'
                : '大家都不饿，素材已记入时间线'
              : out.text || '加餐完成'
          );
          if (onDone) onDone(out);
        } catch (e) {
          okBtn.disabled = false;
          if (e.message === 'need_material') toast(`投资心得至少 ${e.payload?.minLen || minLen} 字`);
          else if (e.message === 'bad_report') toast('这份报告不存在或不属于你');
          else if (e.message === 'cooldown') toast(`它正在休息，${e.payload?.leftMin || ''} 分钟后再来`);
          else if (e.message === 'no_feed') toast('饲料（经验）不足：上传报告或写心得都能涨');
          else toast('加餐失败：' + e.message);
        }
      };
    }
  );
}

/** 安抚弹窗：写一条心态笔记（≥10 字） */
export function patModal(target, onDone) {
  const minLen = NOTE_MIN.pat;
  modal(
    `安抚 ${target.nickname || target.fundCode || ''}`,
    () => `
      <div class="muted" style="font-size:13px">
        抚摸前先写一句 ≥${minLen} 字的心态笔记：它会被记进这只鸡的投研时间线，
        也能帮你在下跌时把想法说清楚（成长 +1，写得越具体越值）。
      </div>
      <div style="margin-top:10px">${chipRow('pat')}</div>
      <div class="field"><textarea class="input" id="pm-text" rows="3" placeholder="${esc(
        PLACEHOLDER.pat
      )}"></textarea></div>
      <div class="counter"><span id="pm-count">0</span> / ${minLen} 字</div>
      <div class="grid-2" style="margin-top:12px">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="pm-ok">确认安抚</button>
      </div>`,
    (body, close) => {
      const ta = body.querySelector('#pm-text');
      const counter = body.querySelector('#pm-count');
      const refresh = () => {
        const n = charCount(ta.value.trim());
        counter.textContent = n;
        counter.style.color = n >= minLen ? 'var(--ok, #2BA471)' : '';
      };
      ta.oninput = refresh;
      refresh();
      body.querySelectorAll('[data-tpl]').forEach((b) => {
        b.onclick = () => {
          ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + b.getAttribute('data-tpl');
          ta.focus();
          refresh();
        };
      });
      body.querySelector('[data-close]').onclick = close;
      body.querySelector('#pm-ok').onclick = async () => {
        if (charCount(ta.value.trim()) < minLen) return toast(`心态笔记至少 ${minLen} 字`);
        try {
          const out = await Api.interact(target.id, 'pat', { note: ta.value.trim() });
          close();
          toast(out.text || '安抚完成');
          if (onDone) onDone(out);
        } catch (e) {
          if (e.message === 'need_material') toast(`心态笔记至少 ${e.payload?.minLen || minLen} 字`);
          else if (e.message === 'cooldown') toast(`它现在很安静，${e.payload?.leftMin || ''} 分钟后再来`);
          else toast('安抚失败：' + e.message);
        }
      };
    }
  );
}

/** 只写心得（不喂食）：用于基金详情页的「投研心得」区 */
export function noteModal(fundCode, onDone) {
  const minLen = NOTE_MIN.note;
  modal(
    '写一条投资心得',
    () => `
      <div class="muted" style="font-size:13px">
        记录一条 ≥${minLen} 字的投研心得${fundCode ? `（${esc(fundCode)}）` : ''}：为什么持有、看到了什么变化、守住了哪条纪律。
        心得会出现在基金详情的投研时间线里。
      </div>
      <div style="margin-top:10px">${chipRow('note')}</div>
      <div class="field"><textarea class="input" id="nm-text" rows="4" placeholder="${esc(
        PLACEHOLDER.note
      )}"></textarea></div>
      <div class="counter"><span id="nm-count">0</span> / ${minLen} 字</div>
      <div class="grid-2" style="margin-top:12px">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="nm-ok">保存心得</button>
      </div>`,
    (body, close) => {
      const ta = body.querySelector('#nm-text');
      const counter = body.querySelector('#nm-count');
      const refresh = () => {
        const n = charCount(ta.value.trim());
        counter.textContent = n;
        counter.style.color = n >= minLen ? 'var(--ok, #2BA471)' : '';
      };
      ta.oninput = refresh;
      refresh();
      body.querySelectorAll('[data-tpl]').forEach((b) => {
        b.onclick = () => {
          ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + b.getAttribute('data-tpl');
          ta.focus();
          refresh();
        };
      });
      body.querySelector('[data-close]').onclick = close;
      body.querySelector('#nm-ok').onclick = async () => {
        if (charCount(ta.value.trim()) < minLen) return toast(`心得至少 ${minLen} 字`);
        try {
          const out = await Api.addNote({ fund_code: fundCode || '', content: ta.value.trim() });
          close();
          toast(out.feedGain ? `心得已保存，+${out.feedGain} 饲料（经验）` : '心得已保存');
          if (onDone) onDone(out);
        } catch (e) {
          toast(e.message === 'note_too_short' ? `心得至少 ${minLen} 字` : '保存失败：' + e.message);
        }
      };
    }
  );
}
