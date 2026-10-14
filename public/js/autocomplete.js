import { esc } from './util.js';

const TYPE_LABEL = {
  equity: '股票型',
  index: '指数型',
  hybrid: '混合型',
  bond: '债券型',
  money: '货币型',
  qdii: 'QDII',
  fof: 'FOF',
};

/**
 * 给输入框挂上自动联想补全。
 * @param {HTMLInputElement} input 输入框（需位于 .ac-wrap 容器内）
 * @param {{onPick:(item:object)=>void, fetchItems:(q:string)=>Promise<Array>, delay?:number}} opts
 * @returns {{close:Function, searchNow:Function}}
 */
export function attachAutocomplete(input, { onPick, fetchItems, delay = 250 } = {}) {
  const wrap = input.closest('.ac-wrap') || input.parentElement;
  const list = document.createElement('div');
  list.className = 'ac-list';
  list.setAttribute('role', 'listbox');
  wrap.appendChild(list);

  let items = [];
  let active = -1;
  let seq = 0;
  let timer = null;
  let lastQuery = '';
  let pending = false;

  function close() {
    list.classList.remove('open');
    list.innerHTML = '';
    items = [];
    active = -1;
    pending = false;
  }

  function render() {
    if (pending) {
      list.innerHTML = '<div class="ac-hint">正在联想…</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = `<div class="ac-hint">${
        lastQuery ? '没有匹配的基金，可直接填写 6 位代码' : '输入代码 / 名称 / 拼音首字母试试'
      }</div>`;
      return;
    }
    list.innerHTML = items
      .map(
        (it, i) => `<div class="ac-item ${i === active ? 'active' : ''}" role="option" data-i="${i}">
          <span class="ac-name">${esc(it.name || it.code)}</span>
          ${it.type && TYPE_LABEL[it.type] ? `<span class="tag">${TYPE_LABEL[it.type]}</span>` : ''}
          <span class="ac-code num">${esc(it.code)}</span>
        </div>`
      )
      .join('');
    list.querySelectorAll('.ac-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(Number(el.getAttribute('data-i')));
      });
    });
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    close();
    if (onPick) onPick(it);
  }

  async function run(q) {
    const mine = ++seq;
    pending = true;
    render();
    list.classList.add('open');
    try {
      const res = (await fetchItems(q)) || [];
      if (mine !== seq) return;
      items = res;
      active = res.length ? 0 : -1;
    } catch (e) {
      if (mine !== seq) return;
      items = [];
      active = -1;
    }
    pending = false;
    lastQuery = q;
    render();
    list.classList.add('open');
  }

  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    lastQuery = q;
    clearTimeout(timer);
    seq++; // 使进行中的请求作废
    if (!q) {
      close();
      return;
    }
    timer = setTimeout(() => run(q), delay);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      if (!list.classList.contains('open')) list.classList.add('open');
      active =
        e.key === 'ArrowDown' ? Math.min(active + 1, items.length - 1) : Math.max(active - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      if (list.classList.contains('open') && active >= 0 && items.length) {
        e.preventDefault();
        pick(active);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 150));

  return {
    close,
    searchNow() {
      const q = input.value.trim();
      if (!q) return;
      clearTimeout(timer);
      run(q);
    },
  };
}
