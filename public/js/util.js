export function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function pct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%';
}

export function pctClass(v) {
  if (v === null || v === undefined) return 'flat';
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

export function money(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  const n = Number(v);
  return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function maskAmount(settings) {
  return !!settings.hideAmount;
}

export function fmtAmount(v, settings, digits = 2) {
  if (v === null || v === undefined) return '--';
  if (maskAmount(settings)) return '***';
  return money(v, digits);
}

export function fmtDate(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

export function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s).slice(11, 16);
  return d.toTimeString().slice(0, 5);
}

export function toast(msg, ms = 2000) {
  const wrap = document.getElementById('toast');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'toast';
  div.innerHTML = msg;
  wrap.appendChild(div);
  setTimeout(() => div.remove(), ms);
}

/** 底部弹出面板：render(root) 返回 HTML，onMount(root, close) 绑定事件 */
export function modal(title, render, onMount) {
  const root = document.getElementById('modal');
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="modal-body"></div></div>`;
  const close = () => {
    wrap.remove();
    if (!root.children.length) root.innerHTML = '';
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  const body = wrap.querySelector('.modal-body');
  body.innerHTML = render() || '';
  root.appendChild(wrap);
  if (onMount) onMount(body, close);
  return close;
}

export function confirmBox(title, text, onOk) {
  modal(
    title,
    () => `<p style="margin:0 0 4px">${esc(text)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-act="no">取消</button>
        <button class="btn warn" data-act="yes">确定</button>
      </div>`,
    (body, close) => {
      body.querySelector('[data-act="no"]').onclick = close;
      body.querySelector('[data-act="yes"]').onclick = () => {
        close();
        onOk && onOk();
      };
    }
  );
}

/**
 * 把 HTML（或带标签的富文本）转成用户能读的纯文本：
 * 去掉 script/style、标签与常见实体，压缩空白，可截断。
 */
export function plainText(s, max = 0) {
  let t = String(s || '');
  t = t.replace(/<head[\s\S]*?<\/head>/gi, ' '); // head 里只有 title/meta/style，不是给人看的内容
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]*>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  t = t
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && [...t].length > max) t = [...t].slice(0, max).join('') + '…';
  return t;
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
  return Promise.resolve();
}

export function sparkline(points, { width = 320, height = 90, color = '#4CAF50' } = {}) {
  if (!points || points.length < 2) return '';
  const vals = points.map((p) => Number(p.v)).filter((v) => !Number.isNaN(v));
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const y = (v) => height - 8 - ((v - min) / span) * (height - 16);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${y(Number(p.v)).toFixed(1)}`).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}22" />
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}
