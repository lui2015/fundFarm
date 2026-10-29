const BASE = 'api/v1';

async function request(path, { method = 'GET', body, form } = {}) {
  const opts = { method, credentials: 'same-origin' };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('ff:unauthorized'));
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'request_failed');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export const Api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
  upload: (p, form) => request(p, { method: 'POST', form }),

  health: () => request('/health'),
  me: () => request('/auth/me'),
  register: (b) => request('/auth/register', { method: 'POST', body: b }),
  login: (b) => request('/auth/login', { method: 'POST', body: b }),
  guest: () => request('/auth/guest', { method: 'POST' }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  yard: () => request('/yard'),
  // 按类型 / 业绩筛选基金
  explore: (qs = '') => request('/explore' + (qs ? '?' + qs : '')),
  // 实时行情（轮询）：codes 为空时返回当前用户全部持仓
  quotes: (codes = []) =>
    request('/quotes?codes=' + (Array.isArray(codes) ? codes.join(',') : String(codes || ''))),
  // 全球大盘指数（分组）
  globalIndices: () => request('/indices/global'),
  funds: (q = '') => request('/funds' + (q ? '?' + q : '')),
  fund: (code) => request('/funds/' + code),
  adopt: (b) => request('/funds', { method: 'POST', body: b }),
  release: (code) => request('/funds/' + code, { method: 'DELETE' }),
  updateFund: (code, b) => request('/funds/' + code, { method: 'PATCH', body: b }),
  // 买入 / 卖出价格提醒
  alerts: (code) => request('/funds/' + code + '/alerts'),
  addAlert: (code, b) => request('/funds/' + code + '/alerts', { method: 'POST', body: b }),
  delAlert: (code, id) => request('/funds/' + code + '/alerts/' + encodeURIComponent(id), { method: 'DELETE' }),
  search: (q) => request('/search?q=' + encodeURIComponent(q)),
  // 喂食 / 安抚必须附投研素材：extra = { note } 或 { report_id }
  interact: (id, action, extra) =>
    request('/chickens/' + id + '/interact', { method: 'POST', body: { action, ...(extra || {}) } }),
  yardAction: (action, body) => request('/yard/' + action, { method: 'POST', body: body || {} }),

  notes: (code = '') => request('/notes' + (code ? '?code=' + encodeURIComponent(code) : '')),
  addNote: (b) => request('/notes', { method: 'POST', body: b }),
  delNote: (id) => request('/notes/' + id, { method: 'DELETE' }),

  groups: () => request('/groups'),
  addGroup: (name) => request('/groups', { method: 'POST', body: { name } }),
  delGroup: (id) => request('/groups/' + id, { method: 'DELETE' }),

  tasks: () => request('/tasks'),
  diary: (date) => request('/diary?date=' + date),
  diaryRange: () => request('/diary/range?days=30'),
  achievements: () => request('/achievements'),
  // 养基等级（按持仓累计收益率定级）
  level: () => request('/me/level'),
  breeds: () => request('/breeds'),
  // 基金类型图鉴（品种 ↔ 真实基金类型 + 数量）
  fundTypes: () => request('/fund-types'),
  tips: () => request('/tips'),
  aiPrompt: (code, format) =>
    request('/ai-prompt?code=' + encodeURIComponent(code || '') + (format ? '&format=' + format : '')),

  reports: (code) => request('/funds/' + code + '/reports'),
  reportsAll: (qs = '') => request('/reports' + (qs ? '?' + qs : '')),
  createReport: (form) => request('/reports', { method: 'POST', form }),
  updateReport: (id, patch) => request('/reports/' + id, { method: 'PATCH', body: patch }),
  report: (id) => request('/reports/' + id),
  delReport: (id) => request('/reports/' + id, { method: 'DELETE' }),
  reparse: (id) => request('/reports/' + id + '/reparse', { method: 'POST' }),

  changePassword: (b) => request('/me/password', { method: 'POST', body: b }),
  adminOverview: () => request('/admin/overview'),
  settings: (patch) => request('/me/settings', { method: 'POST', body: patch }),
  keys: () => request('/me/keys'),
  addKey: (name) => request('/me/keys', { method: 'POST', body: { name } }),
  delKey: (id) => request('/me/keys/' + id, { method: 'DELETE' }),
  addTrade: (code, b) => request('/funds/' + code + '/trades', { method: 'POST', body: b }),
};
