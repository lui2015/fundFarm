import { Api } from '../api.js';
import { esc, toast, modal, confirmBox, copyText, fmtDate, fmtAmount, pct, pctClass } from '../util.js';
import { getState, setUser, refresh } from '../app.js';

let keys = [];
let achievements = { items: [], unlocked: 0, total: 0 };

export async function render() {
  const s = getState();
  const u = s.user || {};
  const st = s.settings || {};
  const [k, ach, lv] = await Promise.all([
    Api.keys(),
    Api.achievements().catch(() => ({ items: [], unlocked: 0, total: 0 })),
    Api.level().catch(() => null),
  ]);
  keys = k.items || [];
  achievements = ach || { items: [], unlocked: 0, total: 0 };
  const lvl = lv && lv.level ? lv.level : null;
  const tiers = (lv && lv.tiers) || [];

  const unlockedList = (achievements.items || [])
    .filter((a) => a.unlocked)
    .sort((a, b) => String(b.unlockedAt || '').localeCompare(String(a.unlockedAt || '')));
  // 服务端存的是 UTC ISO，这里换算成本地自然日判断「今日解锁」
  const localDay = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const todayStr = localDay(new Date().toISOString());
  const achCard = `
    <div class="card">
      <div class="card-title">🏅 我的成就<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">已解锁 ${achievements.unlocked || 0} / ${
    achievements.total || 0
  }</span></div>
      ${
        unlockedList.length
          ? `<div class="ach-grid">${unlockedList
              .slice(0, 6)
              .map(
                (a) => `<div class="ach">
                  <div class="medal">🏅</div>
                  <div class="t">${esc(a.name)}${localDay(a.unlockedAt) === todayStr ? ' <span class="tag">今日</span>' : ''}</div>
                  <div class="d">${esc(a.desc)}</div>
                  ${a.unlockedAt ? `<div class="muted" style="font-size:11px;margin-top:4px">${esc(fmtDate(a.unlockedAt))} 解锁</div>` : ''}
                </div>`
              )
              .join('')}</div>
             ${
               unlockedList.length > 6
                 ? `<div class="muted" style="font-size:12px;margin-top:8px">还有 ${unlockedList.length - 6} 个成就已解锁，去成就墙看全部</div>`
                 : ''
             }`
          : `<div class="empty" style="padding:14px">还没有解锁成就<br/>养鸡、写心得、传报告都能解锁，饲料也会一起到账</div>`
      }
      <button class="btn ghost block" data-act="ach-wall" style="margin-top:10px">成就墙（含未解锁进度）</button>
    </div>
  `;

  /* ---------- 养基等级：按持仓累计收益率定级 ---------- */
  const levelCard = `
    <div class="card level-card">
      <div class="card-title">🎖 养基等级<span class="spacer"></span>
        <span class="muted" style="font-weight:400;font-size:12px">按持仓累计收益率</span></div>
      ${
        lvl
          ? `<div class="lv-head">
              <div class="lv-emoji">${lvl.emoji}</div>
              <div style="flex:1;min-width:0">
                <div class="lv-name">${esc(lvl.name)}
                  <span class="muted" style="font-weight:400;font-size:12px">Lv.${lvl.level}/${lvl.total}</span></div>
                <div class="muted" style="font-size:12px">${esc(lvl.desc)}</div>
              </div>
              <div class="lv-rate ${pctClass(lvl.profitRate)}">${pct(lvl.profitRate, 1)}</div>
            </div>
            <div class="bar-row lv-bar"><span>进度</span>
              <span class="bar"><span style="width:${lvl.progress}%"></span></span>
              <b>${lvl.progress}%</b></div>
            <div class="muted lv-note">${
              lvl.next
                ? `距离「${esc(lvl.next.name)}」还差 ${lvl.next.need.toFixed(1)} 个百分点`
                : '已经是最高等级，稳住就是胜利'
            }</div>
            <div class="muted lv-note">
              持仓 ${lv.positions} 只${lv.priced < lv.positions ? `（${lv.positions - lv.priced} 只暂无净值）` : ''} ·
              成本 ${fmtAmount(lv.cost, st, 0)} · 市值 ${fmtAmount(lv.marketValue, st, 0)} ·
              盈亏 <b class="${pctClass(lv.profitRate)}">${fmtAmount(lv.profit, st, 0)}</b>
            </div>
            <div class="lv-ladder">${tiers
              .map((t) => `<span class="lv-step ${t.key === lvl.key ? 'on' : ''}">${t.emoji} ${esc(t.name)}</span>`)
              .join('')}</div>`
          : `<div class="empty" style="padding:12px">还没有建仓<br/>在「自选」里填好成本价与份额，就会按收益率评级</div>`
      }
    </div>`;

  return `
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:40px">🙋</div>
        <div style="flex:1">
          <div style="font-weight:800;font-size:17px">${esc(u.nickname || '农场主')}${
    u.isAdmin ? '<span class="tag">管理员</span>' : ''
  }${lvl ? `<span class="tag lv-tag">${lvl.emoji} ${esc(lvl.name)}</span>` : ''}</div>
          <div class="muted" style="font-size:13px">
            ${u.anonymous ? '游客模式（数据已保存在本机浏览器会话）' : esc(u.username || '')}
            · 加入于 ${esc(fmtDate(u.createdAt))}
          </div>
        </div>
      </div>
      <div class="grid-3" style="margin-top:12px">
        <div class="stat"><div class="v">${u.feed ?? 0}</div><div class="k">饲料（经验）</div></div>
        <div class="stat"><div class="v">${achievements.unlocked ?? 0}</div><div class="k">已解锁成就</div></div>
        <div class="stat"><div class="v">${u.totalInteract ?? 0}</div><div class="k">累计互动</div></div>
      </div>
      <div class="muted" style="font-size:12px;line-height:1.6;margin-top:10px">
        饲料就是经验值，只能靠真实产出获得：<b>上传报告 +20</b>、<b>写心得 +8</b>。
        签到已下线，喂食也不再消耗饲料。
      </div>
    </div>

    ${levelCard}

    ${achCard}

    <div class="card">
      <div class="card-title">⚙️ 偏好设置</div>
      ${toggle('hideAmount', '隐藏金额', '只显示涨跌幅，不显示金额', st.hideAmount)}
      ${toggle('hideProfit', '隐藏累计盈亏', '列表与首页不展示盈亏金额', st.hideProfit)}
      ${toggle('reduceMotion', '减弱动效', '关闭鸡的动画，省电更安静', st.reduceMotion)}
      ${toggle('remindDrop', '涨跌提醒', '单只基金日内涨跌超过 3% 时提示', st.remindDrop)}
      ${toggle('remindHungry', '饥饿提醒', '有鸡饿了的提示', st.remindHungry)}
    </div>

    <div class="card">
      <div class="card-title">🔐 账号安全</div>
      <button class="btn ghost block" data-act="changepw">${u.anonymous ? '设置登录密码' : '修改密码'}</button>
      <div class="muted" style="font-size:12px;margin-top:8px">
        ${
          u.anonymous
            ? '当前是游客模式，设置密码后即可用账号登录，已有数据会保留'
            : '密码使用 bcrypt 加密存储，建议定期更换'
        }
      </div>
    </div>

    ${
      u.isAdmin
        ? `<div class="card">
      <div class="card-title">🛠 站点管理</div>
      <button class="btn ghost block" data-act="admin">查看运营概览</button>
      <div class="muted" style="font-size:12px;margin-top:8px">仅管理员可见：账号数、鸡数、报告数与数据源成功率</div>
    </div>`
        : ''
    }

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
      <div class="grid-3 export-grid">
        <button class="btn ghost small" data-act="export-json">导出全部（JSON）</button>
        <button class="btn ghost small" data-act="export-csv">导出自选（CSV）</button>
        <button class="btn ghost small" data-act="export-holdings">导出持仓（CSV）</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">
        自选、分组、报告与成就保存在服务端数据库，每日自动备份。持仓明细含最新净值、市值、浮动盈亏与收益率，可直接用 Excel 打开。
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
  const achWall = r.querySelector('[data-act="ach-wall"]');
  if (achWall)
    achWall.onclick = () => {
      location.hash = '#/discover';
    };

  r.querySelectorAll('[data-set]').forEach((el) => {
    el.onchange = async () => {
      const patch = { [el.getAttribute('data-set')]: el.checked };
      const out = await Api.settings(patch);
      setUser({ ...getState().user, settings: out.settings });
      toast('已保存');
    };
  });

  const cpBtn = r.querySelector('[data-act="changepw"]');
  if (cpBtn)
    cpBtn.onclick = () => {
      const u = getState().user || {};
      modal(
        u.anonymous ? '设置登录密码' : '修改密码',
        () => `
        ${u.anonymous ? '' : '<div class="field"><label>当前密码</label><input class="input" id="pw-old" type="password"></div>'}
        <div class="field"><label>新密码（至少 6 位）</label><input class="input" id="pw-new" type="password"></div>
        <div class="field"><label>确认新密码</label><input class="input" id="pw-new2" type="password"></div>
        <div class="modal-actions"><button class="btn ghost" data-no>取消</button><button class="btn" data-ok>保存</button></div>`,
        (body, close) => {
          body.querySelector('[data-no]').onclick = close;
          body.querySelector('[data-ok]').onclick = async () => {
            const np = body.querySelector('#pw-new').value;
            const np2 = body.querySelector('#pw-new2').value;
            if (np.length < 6) return toast('新密码至少 6 位');
            if (np !== np2) return toast('两次输入不一致');
            try {
              await Api.changePassword({
                oldPassword: u.anonymous ? '' : body.querySelector('#pw-old').value,
                newPassword: np,
              });
              close();
              toast('密码已更新，下次可用新密码登录');
              const cur = getState().user;
              if (cur) cur.anonymous = false;
              refresh();
            } catch (e) {
              toast(e.message === 'bad_old_password' ? '当前密码不正确' : '保存失败：' + e.message);
            }
          };
        }
      );
    };

  const adBtn = r.querySelector('[data-act="admin"]');
  if (adBtn)
    adBtn.onclick = async () => {
      try {
        const d = await Api.adminOverview();
        const row = (k, v) => `<div class="kv"><span class="k">${k}</span><span>${v}</span></div>`;
        modal(
          '运营概览',
          () => `
          ${row('账号总数', d.users)}
          ${row('管理员 / 游客', `${d.admins} / ${d.guests}`)}
          ${row('在养基金（鸡）', d.adoptions)}
          ${row('研究报告', d.reports)}
          ${row('成就解锁次数', d.achievementsUnlocked)}
          ${row('今日事件', d.todayEvents)}
          ${row('行情成功率', d.dataSource.estimateSuccessRate === null ? '暂无' : Math.round(d.dataSource.estimateSuccessRate * 100) + '%')}
          ${row('大盘成功率', d.dataSource.indexSuccessRate === null ? '暂无' : Math.round(d.dataSource.indexSuccessRate * 100) + '%')}
          ${row('AI 解析', d.ai.configured ? '已配置' : '未配置（本地摘要）')}
          <div class="modal-actions"><button class="btn" data-close>关闭</button></div>`,
          (body, close) => {
            body.querySelector('[data-close]').onclick = close;
          }
        );
      } catch (e) {
        toast(e.message === 'forbidden' ? '仅管理员可查看' : '获取失败：' + e.message);
      }
    };

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
  r.querySelector('[data-act="export-holdings"]').onclick = () => {
    window.open('api/v1/me/export?format=holdings', '_blank');
  };

  r.querySelector('[data-act="logout"]').onclick = () => {
    confirmBox('退出登录？', '退出后需要使用账号重新登录。', async () => {
      await Api.logout().catch(() => {});
      location.href = location.pathname;
      location.reload();
    });
  };
}
