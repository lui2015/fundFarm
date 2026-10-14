import { Api } from '../api.js';
import { esc, toast, modal, confirmBox, copyText, fmtDate } from '../util.js';
import { getState, setUser, refresh } from '../app.js';
import { showAchievements } from './yard.js';

let keys = [];

export async function render() {
  const s = getState();
  const u = s.user || {};
  const st = s.settings || {};
  const k = await Api.keys();
  keys = k.items || [];

  return `
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:40px">🙋</div>
        <div style="flex:1">
          <div style="font-weight:800;font-size:17px">${esc(u.nickname || '农场主')}</div>
          <div class="muted" style="font-size:13px">
            ${u.anonymous ? '游客模式（数据已保存在本机浏览器会话）' : esc(u.username || '')}
            · 加入于 ${esc(fmtDate(u.createdAt))}
          </div>
        </div>
      </div>
      <div class="grid-3" style="margin-top:12px">
        <div class="stat"><div class="v">${u.feed ?? 0}</div><div class="k">饲料</div></div>
        <div class="stat"><div class="v">${u.checkinStreak ?? 0}</div><div class="k">连续签到</div></div>
        <div class="stat"><div class="v">${u.totalInteract ?? 0}</div><div class="k">累计互动</div></div>
      </div>
      <button class="btn block" data-act="checkin" style="margin-top:12px">🌾 每日签到（+5 饲料）</button>
    </div>

    <div class="card">
      <div class="card-title">⚙️ 偏好设置</div>
      ${toggle('hideAmount', '隐藏金额', '只显示涨跌幅，不显示金额', st.hideAmount)}
      ${toggle('hideProfit', '隐藏累计盈亏', '列表与首页不展示盈亏金额', st.hideProfit)}
      ${toggle('reduceMotion', '减弱动效', '关闭鸡的动画，省电更安静', st.reduceMotion)}
      ${toggle('remindDrop', '涨跌提醒', '单只基金日内涨跌超过 3% 时提示', st.remindDrop)}
      ${toggle('remindHungry', '饥饿提醒', '有鸡饿了的提示', st.remindHungry)}
    </div>

    <div class="card">
      <div class="card-title">🔑 开发者 API Key<span class="spacer"></span>
        <button class="btn ghost small" data-act="newkey">新建</button></div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">
        用于让 AI 助手调用接口上传/读取报告。密钥只显示一次，请妥善保存。
      </div>
      ${
        keys.length
          ? keys
              .map(
                (k) =>
                  `<div class="kv"><span class="k">${esc(k.name)} · ${esc(k.prefix)}… ${
                    k.revoked ? '（已吊销）' : ''
                  }</span><span><button class="btn ghost small" data-delkey="${esc(k.id)}">吊销</button></span></div>`
              )
              .join('')
          : '<div class="empty" style="padding:10px">还没有 API Key</div>'
      }
      <button class="btn ghost block" data-act="capabilities" style="margin-top:10px">查看 AI 可调用接口说明</button>
    </div>

    <div class="card">
      <div class="card-title">📦 数据</div>
      <div class="grid-2">
        <button class="btn ghost small" data-act="export-json">导出全部（JSON）</button>
        <button class="btn ghost small" data-act="export-csv">导出自选（CSV）</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">
        自选、分组、报告与成就保存在服务端数据库，每日自动备份。
      </div>
    </div>

    <div class="card">
      <div class="card-title">ℹ️ 关于</div>
      <div class="muted" style="font-size:13px">
        养基场 v1.0 · 游戏化基金自选管理工具。<br/>
        领养一只鸡 = 持有一只基金；涨跌会变成产蛋与掉毛。
      </div>
      <button class="btn ghost block" data-act="logout" style="margin-top:10px">退出登录</button>
    </div>

    <div class="disclaimer">
      数据来自第三方公开接口，可能存在延迟或误差；<br/>
      本工具仅供个人学习研究，不构成投资建议，不提供任何买入/卖出建议。
    </div>`;
}

function toggle(key, title, desc, value) {
  return `<div class="kv" style="align-items:center">
    <span class="k" style="flex:1">
      <div style="color:var(--ink);font-weight:600">${esc(title)}</div>
      <div style="font-size:12px">${esc(desc)}</div>
    </span>
    <span><input type="checkbox" data-set="${key}" ${value ? 'checked' : ''} style="width:22px;height:22px"></span>
  </div>`;
}

export async function mount(r) {
  r.querySelector('[data-act="checkin"]').onclick = async () => {
    try {
      const out = await Api.checkin();
      const u = getState().user;
      if (u) {
        u.feed += out.gain || 0;
        u.checkinStreak = out.streak;
      }
      toast(`签到成功，获得 ${out.gain} 饲料（连续 ${out.streak} 天）`);
      if (out.newAchievements?.length) showAchievements(out.newAchievements);
      refresh();
    } catch (e) {
      toast(e.message === 'already_checked' ? '今天已经签到过了，明天再来' : '签到失败');
    }
  };

  r.querySelectorAll('[data-set]').forEach((el) => {
    el.onchange = async () => {
      const patch = { [el.getAttribute('data-set')]: el.checked };
      const out = await Api.settings(patch);
      setUser({ ...getState().user, settings: out.settings });
      toast('已保存');
    };
  });

  r.querySelector('[data-act="newkey"]').onclick = () => {
    modal(
      '新建 API Key',
      () => `<div class="field"><label>名称</label><input class="input" id="ak-name" placeholder="如 我的AI助手"></div>
        <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>生成</button></div>`,
      (body, close) => {
        body.querySelector('[data-no]').onclick = close;
        body.querySelector('[data-ok]').onclick = async () => {
          const name = body.querySelector('#ak-name').value || 'default';
          const out = await Api.addKey(name);
          close();
          modal(
            '请保存你的 API Key',
            () => `<div class="muted" style="font-size:13px">只显示这一次，关闭后无法再次查看完整密钥。</div>
              <pre style="white-space:pre-wrap;word-break:break-all;background:#fffdf8;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:12px">${esc(
                out.key.key
              )}</pre>
              <div class="modal-actions"><button class="btn ghost" data-copy>复制</button><button class="btn" data-close>已保存</button></div>`,
            (b2, close2) => {
              b2.querySelector('[data-close]').onclick = close2;
              b2.querySelector('[data-copy]').onclick = () => copyText(out.key.key).then(() => toast('已复制'));
            }
          );
          refresh();
        };
      }
    );
  };

  r.querySelectorAll('[data-delkey]').forEach((b) => {
    b.onclick = async () => {
      await Api.delKey(b.getAttribute('data-delkey'));
      toast('已吊销');
      refresh();
    };
  });

  r.querySelector('[data-act="capabilities"]').onclick = async () => {
    const res = await fetch('api/v1/capabilities').then((x) => x.json()).catch(() => null);
    if (!res) return toast('获取失败');
    modal(
      'AI 可调用接口',
      () => `<pre style="white-space:pre-wrap;font-size:12px;background:#fffdf8;border:1px solid var(--line);border-radius:12px;padding:12px;max-height:50vh;overflow:auto">${esc(
        JSON.stringify(res, null, 2)
      )}</pre>
      <div class="modal-actions"><button class="btn" data-close>关闭</button></div>`,
      (body, close) => {
        body.querySelector('[data-close]').onclick = close;
      }
    );
  };

  r.querySelector('[data-act="export-json"]').onclick = () => {
    window.open('api/v1/me/export', '_blank');
  };
  r.querySelector('[data-act="export-csv"]').onclick = () => {
    window.open('api/v1/me/export?format=csv', '_blank');
  };

  r.querySelector('[data-act="logout"]').onclick = () => {
    confirmBox('退出登录？', '退出后需要使用账号重新登录。', async () => {
      await Api.logout().catch(() => {});
      location.href = location.pathname;
      location.reload();
    });
  };
}
