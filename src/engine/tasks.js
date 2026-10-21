'use strict';

const db = require('../db');
const { today, nowISO, id: gid } = require('../util');

const DAILY_COUNT = 3;

/**
 * 按 用户+日期 做确定性抽取，保证同一天刷新页面任务不变。
 * exclude：已抽到的任务（补位时避免重复）；offset：让补位的抽取位置接着往下走。
 */
function pickDailyTasks(userId, { exclude = [], count = DAILY_COUNT, offset = 0 } = {}) {
  const all = db.prepare('SELECT * FROM tasks').all().filter((t) => !exclude.includes(t.code));
  if (!all.length || count <= 0) return [];
  const seed = (userId + today()).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const pool = [...all];
  const picked = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const k = i + offset;
    const idx = (seed * (k + 7) + k * 13) % pool.length;
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function ensureDaily(userId) {
  const date = today();
  const q = () => db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND date = ?').all(userId, date);
  const existing = q();
  // 任务池调整（比如下线了某个任务）后，当天可能不足 3 条，这里补位到 3 条
  if (existing.length < DAILY_COUNT) {
    const picked = pickDailyTasks(userId, {
      exclude: existing.map((r) => r.task_code),
      count: DAILY_COUNT - existing.length,
      offset: existing.length,
    });
    if (picked.length) {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO user_tasks (id, user_id, task_code, date, progress, done, rewarded) VALUES (?, ?, ?, ?, 0, 0, 0)'
      );
      db.transaction(() => {
        for (const t of picked) insert.run(gid('ut'), userId, t.code, date);
      })();
    }
  }
  return hydrate(q());
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
