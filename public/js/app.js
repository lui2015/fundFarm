import { Api } from './api.js';
import { esc, toast } from './util.js';
import * as Yard from './pages/yard.js';
import * as Funds from './pages/funds.js';
import * as Reports from './pages/reports.js';
import * as Detail from './pages/detail.js';
import * as Discover from './pages/discover.js';
import * as Analysis from './pages/analysis.js';
import * as Me from './pages/me.js';
import * as ReportPage from './pages/report.js';
import { stopLive } from './live.js';

const state = { user: null, settings: {}, route: { name: 'yard', param: '' } };

export function getState() {
  return state;
}

export function setUser(u) {
  state.user = u;
  state.settings = (u && u.settings) || {};
}

// 报告库 / 自选都不再占导航位：入口分别是鸡舍右栏「分析报告 → 查看全部」与「我的鸡舍 → 自选」
const NAV = [
  { key: 'yard', hash: '#/yard', icon: '🏠', label: '鸡舍' },
  { key: 'discover', hash: '#/discover', icon: '🏅', label: '发现' },
  { key: 'analysis', hash: '#/analysis', icon: '📈', label: '分析' },
  { key: 'me', hash: '#/me', icon: '🙋', label: '我的' },
];

function parseHash() {
  const h = (location.hash || '').replace(/^#/, '').split('?')[0]; // 去掉 ?from=... 之类的查询串
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'yard', param: '' };
  if (parts[0] === 'fund') return { name: 'fund', param: parts[1] || '' };
  if (parts[0] === 'report') return { name: 'report', param: parts[1] || '' };
  if (['yard', 'funds', 'reports', 'discover', 'analysis', 'me'].includes(parts[0]))
    return { name: parts[0], param: '' };
  return { name: 'yard', param: '' };
}

function navKey(name) {
  // 自选 / 基金详情 / 报告库 / 报告详情都是鸡舍下的子页面，导航高亮回鸡舍
  if (['funds', 'fund', 'reports', 'report'].includes(name)) return 'yard';
  return name;
}

function shellHtml(active) {
  return `
    <aside class="sidebar">
      <div class="brand">养基场</div>
      ${NAV.map(
        (n) =>
          `<button data-nav="${n.hash}" class="${active === n.key ? 'active' : ''}"><span>${n.icon}</span><span>${n.label}</span></button>`
      ).join('')}
      <div class="side-foot">
        饲料 ${state.user ? state.user.feed : 0} ·
        <a href="#" data-act="logout">退出</a>
        <div style="margin-top:6px">数据来自第三方公开接口<br/>仅供参考，不构成投资建议</div>
      </div>
    </aside>
    <header class="topbar">
      <h1>养基场</h1>
      <span class="spacer"></span>
      <span class="chip">🌾 饲料 ${state.user ? state.user.feed : 0}</span>
    </header>
    <main class="content" id="page"></main>
    <nav class="nav">
      ${NAV.map(
        (n) =>
          `<button data-nav="${n.hash}" class="${active === n.key ? 'active' : ''}"><span class="nav-icon">${n.icon}</span><span>${n.label}</span></button>`
      ).join('')}
    </nav>`;
}

function bindShell(root) {
  root.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      location.hash = b.getAttribute('data-nav');
    };
  });
  const lo = root.querySelector('[data-act="logout"]');
  if (lo) {
    lo.onclick = async (e) => {
      e.preventDefault();
      await Api.logout().catch(() => {});
      state.user = null;
      location.hash = '#/yard';
      route();
    };
  }
}

function authHtml() {
  return `
    <div class="auth-wrap">
      <div class="auth-hero">
        <div class="logo">🐔</div>
        <h1>养基场</h1>
        <p>领养一只鸡，就是持有一只基金</p>
      </div>
      <div class="card">
        <div class="seg" style="margin-bottom:12px">
          <button data-tab="login" class="active">登录</button>
          <button data-tab="register">注册</button>
        </div>
        <div id="auth-form">
          <div class="field"><label>用户名</label><input class="input" id="au-name" autocomplete="username" placeholder="字母/数字/下划线" /></div>
          <div class="field"><label>密码</label><input class="input" id="au-pass" type="password" autocomplete="current-password" placeholder="至少 6 位" /></div>
          <button class="btn block" id="au-submit">登录</button>
          <button class="btn ghost block" id="au-guest" style="margin-top:8px">先随便逛逛（游客模式）</button>
        </div>
      </div>
      <div class="disclaimer">数据来自第三方公开接口，可能存在延迟或误差；<br/>本工具仅供个人学习研究，不构成投资建议。</div>
    </div>`;
}

function bindAuth(root) {
  let mode = 'login';
  const form = root.querySelector('#auth-form');
  const tabBtns = root.querySelectorAll('.seg button');
  tabBtns.forEach((b) => {
    b.onclick = () => {
      mode = b.getAttribute('data-tab');
      tabBtns.forEach((x) => x.classList.toggle('active', x === b));
      root.querySelector('#au-submit').textContent = mode === 'login' ? '登录' : '注册';
    };
  });
  root.querySelector('#au-submit').onclick = async () => {
    const username = root.querySelector('#au-name').value.trim();
    const password = root.querySelector('#au-pass').value;
    if (!username || !password) return toast('请填写用户名和密码');
    try {
      const r = mode === 'login' ? await Api.login({ username, password }) : await Api.register({ username, password });
      setUser(r.user);
      route();
      toast(`欢迎回来，${esc(r.user.nickname)}`);
    } catch (e) {
      toast(mode === 'login' ? '用户名或密码不正确' : '注册失败：' + (e.message === 'username_taken' ? '用户名已存在' : e.message));
    }
  };
  root.querySelector('#au-guest').onclick = async () => {
    try {
      const r = await Api.guest();
      setUser(r.user);
      route();
      toast('已进入游客模式，可随时在「我的」中退出');
    } catch (e) {
      toast('进入失败：' + e.message);
    }
  };
}

const PAGES = {
  yard: Yard,
  funds: Funds,
  reports: Reports,
  fund: Detail,
  report: ReportPage,
  discover: Discover,
  analysis: Analysis,
  me: Me,
};

export function refresh() {
  route();
}

async function route() {
  const app = document.getElementById('app');
  const r = parseHash();
  state.route = r;
  stopLive();

  if (!state.user) {
    app.classList.add('auth-mode');
    app.innerHTML = authHtml();
    bindAuth(app);
    return;
  }

  app.classList.remove('auth-mode');
  app.innerHTML = shellHtml(navKey(r.name));
  bindShell(app);
  const page = document.getElementById('page');
  const mod = PAGES[r.name] || Yard;
  page.innerHTML = `<div class="empty"><span class="big">🐣</span>加载中…</div>`;
  try {
    const html = await mod.render(r.param);
    page.innerHTML = html;
    if (mod.mount) await mod.mount(page, r.param);
  } catch (e) {
    page.innerHTML = `<div class="empty"><span class="big">😵</span>加载失败：${esc(e.message || e)}</div>`;
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function boot() {
  try {
    const r = await Api.me();
    if (r.user) setUser(r.user);
  } catch (e) {
    /* 未登录 */
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('ff:unauthorized', () => {
    state.user = null;
    route();
  });
  if (!location.hash) location.hash = '#/yard';
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
