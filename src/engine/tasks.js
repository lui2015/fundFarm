'use strict';

const db = require('../db');
const { today, nowISO, id: gid } = require('../util');

function pickDailyTasks(userId) {
  const all = db.prepare('SELECT * FROM tasks').all();
  if (!all.length) return [];
  // 按 用户+日期 做确定性抽取，保证同一天刷新页面任务不变
  const seed = (userId + today()).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const pool = [...all];
  const picked = [];
  for (let i = 0; i < Math.min(3, pool.length); i++) {
    const idx = (seed * (i + 7) + i * 13) % pool.length;
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function ensureDaily(userId) {
  const date = today();
  const existing = db
    .prepare('SELECT * FROM user_tasks WHERE user_id = ? AND date = ?')
    .all(userId, date);
  if (existing.length) return hydrate(existing);
  const picked = pickDailyTasks(userId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO user_tasks (id, user_id, task_code, date, progress, done, rewarded) VALUES (?, ?, ?, ?, 0, 0, 0)'
  );
  db.transaction(() => {
    for (const t of picked) insert.run(gid('ut'), userId, t.code, date);
  })();
  return hydrate(db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND date = ?').all(userId, date));
}

function hydrate(rows) {
  return rows.map((r) => {
    const t = db.prepare('SELECT * FROM tasks WHERE code = ?').get(r.task_code);
    return {
      code: r.task_code,
      name: t?.name || r.task_code,
      desc: t?.desc || '',
      target: t?.target || 1,
      reward: t?.reward || 2,
      growth: t?.growth || 1,
      progress: r.progress,
      done: !!r.done,
      rewarded: !!r.rewarded,
      date: r.date,
    };
  });
}

function list(userId) {
  return ensureDaily(userId);
}

/** 推进任务进度；达标则标记完成并即时发放饲料奖励 */
function bump(userId, code, delta = 1) {
  const date = today();
  const row = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_code = ? AND date = ?').get(userId, code, date);
  if (!row || row.done) return null;
  const t = db.prepare('SELECT * FROM tasks WHERE code = ?').get(code);
  const progress = Math.min(row.progress + delta, t?.target || 1);
  const done = progress >= (t?.target || 1) ? 1 : 0;
  db.prepare('UPDATE user_tasks SET progress = ?, done = ? WHERE id = ?').run(progress, done, row.id);
  if (done && !row.rewarded) {
    const reward = t?.reward || 2;
    db.prepare('UPDATE users SET feed = feed + ? WHERE id = ?').run(reward, userId);
    db.prepare('UPDATE user_tasks SET rewarded = 1 WHERE id = ?').run(row.id);
    db.prepare('INSERT INTO feed_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      gid('fl'),
      userId,
      reward,
      '任务：' + (t?.name || code),
      nowISO()
    );
    db.prepare('INSERT INTO diary (id, user_id, adoption_id, date, type, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      gid('dr'),
      userId,
      null,
      date,
      'task',
      `完成每日任务「${t?.name || code}」`,
      nowISO()
    );
    return { code, name: t?.name, reward };
  }
  return null;
}

module.exports = { list, bump, ensureDaily };
