'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE,
  phone         TEXT UNIQUE,
  email         TEXT UNIQUE,
  pass_hash     TEXT,
  nickname      TEXT NOT NULL DEFAULT '农场主',
  anonymous     INTEGER NOT NULL DEFAULT 0,
  feed          INTEGER NOT NULL DEFAULT 20,
  last_checkin  TEXT,
  checkin_streak INTEGER NOT NULL DEFAULT 0,
  total_interact INTEGER NOT NULL DEFAULT 0,
  last_adopt_at TEXT,
  settings      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  last_used_at TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS funds (
  code        TEXT PRIMARY KEY,
  name        TEXT,
  type        TEXT,
  company     TEXT,
  manager     TEXT,
  established TEXT,
  scale       TEXT,
  cached_at   TEXT
);

CREATE TABLE IF NOT EXISTS nav_history (
  code    TEXT NOT NULL,
  date    TEXT NOT NULL,
  nav     REAL,
  acc_nav REAL,
  pct     REAL,
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id);

CREATE TABLE IF NOT EXISTS adoptions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  fund_code      TEXT NOT NULL,
  nickname       TEXT,
  group_id       TEXT,
  cost_price     REAL,
  shares         REAL,
  first_buy_date TEXT,
  adopted_at     TEXT NOT NULL,
  released_at    TEXT,
  sort           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adoptions_user ON adoptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adoptions_active ON adoptions(user_id, fund_code) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  adoption_id TEXT NOT NULL,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL,
  price       REAL,
  shares      REAL,
  amount      REAL
);
CREATE INDEX IF NOT EXISTS idx_trades_adoption ON trades(adoption_id);

CREATE TABLE IF NOT EXISTS chickens (
  id               TEXT PRIMARY KEY,
  adoption_id      TEXT NOT NULL UNIQUE,
  breed            TEXT NOT NULL DEFAULT 'hybrid',
  level            INTEGER NOT NULL DEFAULT 1,
  growth           INTEGER NOT NULL DEFAULT 0,
  satiety          INTEGER NOT NULL DEFAULT 70,
  mood             INTEGER NOT NULL DEFAULT 70,
  health           INTEGER NOT NULL DEFAULT 80,
  bond             INTEGER NOT NULL DEFAULT 10,
  eggs             INTEGER NOT NULL DEFAULT 0,
  golden_eggs      INTEGER NOT NULL DEFAULT 0,
  feathers         INTEGER NOT NULL DEFAULT 0,
  streak_up        INTEGER NOT NULL DEFAULT 0,
  streak_down      INTEGER NOT NULL DEFAULT 0,
  sick             INTEGER NOT NULL DEFAULT 0,
  min_profit       REAL NOT NULL DEFAULT 0,
  cooldowns        TEXT NOT NULL DEFAULT '{}',
  last_event_date  TEXT,
  last_interact_at TEXT,
  last_decay_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_events (
  id           TEXT PRIMARY KEY,
  adoption_id  TEXT NOT NULL,
  date         TEXT NOT NULL,
  pct          REAL,
  event_type   TEXT NOT NULL,
  text         TEXT,
  growth_delta INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (adoption_id, date)
);
CREATE INDEX IF NOT EXISTS idx_events_adoption ON daily_events(adoption_id);

CREATE TABLE IF NOT EXISTS diary (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  adoption_id TEXT,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_user ON diary(user_id, date);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  adoption_id TEXT,
  fund_code   TEXT NOT NULL,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user',
  report_date TEXT,
  tags        TEXT NOT NULL DEFAULT '',
  file_name   TEXT,
  file_path   TEXT,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  content     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_fund ON reports(fund_code);

CREATE TABLE IF NOT EXISTS report_parses (
  report_id  TEXT PRIMARY KEY,
  summary    TEXT,
  key_points TEXT,
  risks      TEXT,
  sentiment  TEXT,
  rating     TEXT,
  confidence REAL,
  model      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS achievements (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  desc      TEXT NOT NULL,
  category  TEXT NOT NULL,
  condition TEXT NOT NULL,
  reward    INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id     TEXT NOT NULL,
  code        TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS tasks (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  desc   TEXT NOT NULL,
  target INTEGER NOT NULL DEFAULT 1,
  reward INTEGER NOT NULL DEFAULT 3,
  growth INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS user_tasks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  task_code  TEXT NOT NULL,
  date       TEXT NOT NULL,
  progress   INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  rewarded   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, task_code, date)
);

CREATE TABLE IF NOT EXISTS feed_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 投资心得 / 投研笔记：喂食与安抚必须附上素材，让互动留下真实的思考轨迹
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  adoption_id TEXT,
  fund_code   TEXT,
  kind        TEXT NOT NULL DEFAULT 'note',
  content     TEXT NOT NULL,
  report_id   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_fund ON notes(user_id, fund_code);
`);

const ACHIEVEMENTS = [
  ['first_adopt', '初次领养', '领养你的第一只基金鸡', 'adopt', '领养 1 只基金', 10],
  ['yard_10', '鸡舍兴旺', '鸡舍里已经有 10 只鸡了', 'adopt', '领养 10 只基金', 20],
  ['breed_all', '品类齐全', '集齐 5 种基金类型的鸡', 'adopt', '集齐 5 种基金类型', 30],
  ['checkin_7', '七日之约', '连续签到 7 天', 'companion', '连续签到 7 天', 15],
  ['hold_100', '百日守护', '有一只鸡陪伴你超过 100 天', 'companion', '某只鸡持有满 100 天', 25],
  ['hold_365', '周年纪念', '有一只鸡陪伴你超过 365 天', 'companion', '某只鸡持有满 365 天', 50],
  ['storm_together', '风雨同舟', '经历过 -15% 又等到了回本', 'mind', '某只鸡曾浮亏 15% 后回本', 30],
  ['turn_profit', '扭亏为盈', '把一只亏损的鸡养回盈利', 'mind', '某只鸡由亏转盈', 20],
  ['steady_30', '岿然不动', '连续 30 天没有新增领养（不追涨）', 'mind', '连续 30 天未新增领养', 30],
  ['report_1', '好学基民', '上传第一份研究报告', 'research', '上传 1 份报告', 30],
  ['report_10', '报告达人', '累计上传 10 份研究报告', 'research', '上传 10 份报告', 50],
  ['level_3', '成鸡养成', '有一只鸡长到了 Lv.3', 'companion', '某只鸡达到 Lv.3', 20],
  ['level_5', '金鸡报晓', '有一只鸡长成了金鸡 Lv.5', 'companion', '某只鸡达到 Lv.5', 50],
  ['interact_50', '抚摸大师', '累计互动 50 次', 'companion', '累计互动 50 次', 20],
  ['egg_100', '百蛋大户', '鸡舍累计产蛋 100 枚', 'mind', '累计产蛋 100 枚', 30],
  ['night_owl', '夜猫子', '凌晨 1 点后还在看鸡舍', 'egg', '凌晨 1 点后访问鸡舍', 10],
  ['early_bird', '早起鸟', '早上 7 点前完成签到', 'egg', '早上 7 点前签到', 10],
];

const TASKS = [
  ['feed_3', '投研喂食', '给 3 只鸡加餐（每次附一份报告或一条 ≥20 字心得）', 3, 3, 2],
  ['pat_sad', '安慰一下', '给今天跌得最多的鸡写下一条安抚笔记（≥10 字）', 1, 3, 3],
  ['check_yard', '巡视鸡舍', '打开鸡舍，并点开任意一只鸡看持仓详情', 2, 2, 1],
  ['read_report', '读一份报告', '打开任意一份研究报告', 1, 5, 3],
  ['clean_yard', '打扫鸡舍', '先照料所有饿了/打蔫的鸡，再打扫一次鸡舍', 1, 3, 2],
  ['add_fund', '研究一只新基', '领养一只新基金或查看一只观察区的基', 1, 3, 2],
  ['note_1', '写下投资心得', '在任意基金下写一条 ≥20 字的投资心得', 1, 3, 2],
];

/* ---------- 轻量迁移：管理员标记 ---------- */
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}

/* ---------- 轻量迁移：基金实际分类（东财 FTYPE，如「指数型-股票」） ---------- */
const fundCols = db.prepare('PRAGMA table_info(funds)').all().map((c) => c.name);
if (!fundCols.includes('category')) {
  db.exec('ALTER TABLE funds ADD COLUMN category TEXT');
}
if (!fundCols.includes('index_name')) {
  db.exec('ALTER TABLE funds ADD COLUMN index_name TEXT');
}

/* ---------- 轻量迁移：报告内容类型（text / markdown / html / file） ---------- */
const reportCols = db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
if (!reportCols.includes('content_type')) {
  db.exec("ALTER TABLE reports ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'");
}

/* ---------- 默认管理员种子账号 ---------- */
(function ensureAdmin() {
  const bcrypt = require('bcryptjs');
  const username = config.admin.username;
  const password = config.admin.password;
  if (!username || !password) return;

  const row = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(username);
  let adminId;
  if (!row) {
    adminId = 'usr_admin_' + Date.now().toString(36);
    db.prepare(
      'INSERT INTO users (id, username, pass_hash, nickname, anonymous, feed, is_admin, created_at) VALUES (?, ?, ?, ?, 0, 50, 1, ?)'
    ).run(adminId, username, bcrypt.hashSync(password, 10), '农场主', new Date().toISOString());
  } else {
    adminId = row.id;
    if (!row.is_admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(adminId);
  }

  const gCount = db.prepare('SELECT COUNT(*) AS n FROM groups WHERE user_id = ?').get(adminId).n;
  if (!gCount) {
    const ins = db.prepare('INSERT INTO groups (id, user_id, name, sort, is_default) VALUES (?, ?, ?, ?, ?)');
    ins.run('grp_admin_1', adminId, '我的持仓', 0, 1);
    ins.run('grp_admin_2', adminId, '观察区', 1, 0);
  }
})();

const insertAch = db.prepare(
  'INSERT OR IGNORE INTO achievements (code, name, desc, category, condition, reward) VALUES (?, ?, ?, ?, ?, ?)'
);
// 任务用 upsert：改动任务文案/目标数后重启即可生效（不覆盖用户进度）
const upsertTask = db.prepare(
  `INSERT INTO tasks (code, name, desc, target, reward, growth) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET name = excluded.name, desc = excluded.desc,
     target = excluded.target, reward = excluded.reward, growth = excluded.growth`
);
db.transaction(() => {
  for (const a of ACHIEVEMENTS) insertAch.run(...a);
  for (const t of TASKS) upsertTask.run(...t);
})();

module.exports = db;
