const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { APP_TIME_ZONE, formatBeijingDateTime } = require('./services/timezone');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email TEXT NOT NULL DEFAULT '',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_type TEXT NOT NULL,
    week_start TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, week_type, week_start)
  );

  CREATE TABLE IF NOT EXISTS work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT UNIQUE NOT NULL,
    week_range TEXT NOT NULL DEFAULT '',
    this_week_summary TEXT NOT NULL DEFAULT '[]',
    next_week_summary TEXT NOT NULL DEFAULT '[]',
    ai_raw TEXT NOT NULL DEFAULT '',
    provider_name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    files_json TEXT NOT NULL DEFAULT '[]',
    generated_by INTEGER,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired_at INTEGER NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name);
  if (!columns.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

ensureColumn('users', 'email', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');

// 默认设置
const defaultSettings = {
  deadline_enabled: '0',           // 旧设置保留兼容；当前按“本周期可编辑、历史周期只读”控制
  deadline_time: '12:00',
  ai_base_url: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  ai_api_key: process.env.AI_API_KEY || '',
  ai_model: process.env.AI_MODEL || 'gpt-4o-mini',
  ai_providers: '[]',
  ai_prompt: `你是周报汇总助手。请基于以下员工的本周工作内容，整理成结构化的周报。\n\n要求：\n1. 按员工分组\n2. 提炼关键成果\n3. 合并类似工作内容\n4. 输出 Markdown 格式\n\n员工本周工作：\n{{submissions}}`,
  ai_export_prompt: `请把以下员工提交内容汇总成“部门整体口径”的项目周报，不要按人员分组，不要出现员工姓名。\n请只输出 JSON，格式为：{"this_week":["项目A，本周开展……工作，同时完成……工作"],"next_week":["项目A，下周计划……"]}。\n要求：\n1. 按项目合并，同一个项目只能输出一条；项目名称相似度 80% 以上时也按同一项目处理；多人提交同一或相似项目时，把不同工作合并在同一条里。\n2. 不要给项目名称添加 []、【】 等括号。\n3. 不要把同一个项目拆成“一是、二是、三是”。例如“江西天然气档案管理系统建设项目，开展天然气集团人员培训工作，同时开展江西省投资燃气有限公司档案数字化调研工作，并协助沟通试用系统”必须作为一条完整内容。\n4. 每条以“项目名称，工作内容”格式输出，不写序号，系统会自动展示序号。\n5. this_week 与 next_week 分别输出 5-15 条；内容不足时可少于 5 条。\n6. 语言正式、简洁，适合直接放入部门周报和统计表。\n\n周期：{{week_range}}\n\n本周工作原始内容：\n{{this_week}}\n\n下周计划原始内容：\n{{next_week}}`,
  email_required: '0',
  reminder_enabled: '0',
  reminder_day: '5',
  reminder_time: '09:00',
  reminder_interval_minutes: '60',
  reminder_last_sent_at: '',
  smtp_host: '',
  smtp_port: '465',
  smtp_secure: '1',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) {
  insertSetting.run(k, v);
}

db.prepare(`
  UPDATE settings
  SET value = ?
  WHERE key = 'ai_export_prompt'
    AND (
      value LIKE '%展示模板如下%'
      OR value LIKE '%每条不要写序号%'
      OR value LIKE '%项目A，本周开展%'
      OR value LIKE '%[项目A]%'
      OR value LIKE '%[项目名称]%'
      OR value LIKE '%每条以“[项目名称]%'
      OR value LIKE '%本周工作条目1%'
      OR value LIKE '%合并重复或相近事项%'
    )
`).run(defaultSettings.ai_export_prompt);

// 创建默认管理员
const adminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
const adminName = process.env.DEFAULT_ADMIN_NAME || '管理员';

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(adminPassword, 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(adminUsername, hash, adminName, 'admin', formatBeijingDateTime());
  console.log(`已创建默认管理员账号: ${adminUsername} / ${adminPassword}`);
}

// ============== 查询封装 ==============

const Users = {
  all: () => db.prepare('SELECT id, username, name, role, email, must_change_password, created_at FROM users ORDER BY id ASC').all(),
  findById: (id) => db.prepare('SELECT id, username, name, role, email, must_change_password FROM users WHERE id = ?').get(id),
  findSessionById: (id) => db.prepare('SELECT id, username, name, role, email, must_change_password, password_hash FROM users WHERE id = ?').get(id),
  findByUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
  create: (username, passwordHash, name, role = 'user') => db.prepare(
    'INSERT INTO users (username, password_hash, name, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, passwordHash, name, role, 1, formatBeijingDateTime()),
  updatePassword: (id, passwordHash) => db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?'
  ).run(passwordHash, id),
  resetPassword: (id, passwordHash) => db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?'
  ).run(passwordHash, id),
  updateEmail: (id, email) => db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || '', id),
  updateRole: (id, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id),
  updateProfile: (id, email, passwordHash = null) => {
    if (passwordHash) {
      return db.prepare('UPDATE users SET email = ?, password_hash = ?, must_change_password = 0 WHERE id = ?').run(email || '', passwordHash, id);
    }
    return db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || '', id);
  },
  setMustChangePassword: (id, mustChange = 1) => db.prepare(
    'UPDATE users SET must_change_password = ? WHERE id = ?'
  ).run(mustChange ? 1 : 0, id),
  updateName: (id, name) => db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id),
  delete: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
  count: () => db.prepare('SELECT COUNT(*) as c FROM users').get().c,
};

const Settings = {
  getAll: () => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
  },
  get: (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set: (key, value) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value),
  setMany: (obj) => {
    const stmt = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const tx = db.transaction((entries) => {
      entries.forEach(([k, v]) => stmt.run(k, v || ''));
    });
    tx(Object.entries(obj));
  },
};

const Submissions = {
  // 获取或创建某用户某周某类型的提交
  getOrCreate: (userId, weekType, weekStart) => {
    const existing = db.prepare(
      'SELECT * FROM submissions WHERE user_id = ? AND week_type = ? AND week_start = ?'
    ).get(userId, weekType, weekStart);

    if (existing) return existing;

    const now = formatBeijingDateTime();
    const result = db.prepare(
      'INSERT INTO submissions (user_id, week_type, week_start, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, weekType, weekStart, now, now);

    return db.prepare('SELECT * FROM submissions WHERE id = ?').get(result.lastInsertRowid);
  },

  // 获取某提交的所有工作条目
  getItems: (submissionId) => db.prepare(
    'SELECT * FROM work_items WHERE submission_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(submissionId),

  // 重置工作条目（删旧加新）
  setItems: (submissionId, items) => {
    const tx = db.transaction((items) => {
      db.prepare('DELETE FROM work_items WHERE submission_id = ?').run(submissionId);
      const insert = db.prepare(
        'INSERT INTO work_items (submission_id, project_name, content, sort_order) VALUES (?, ?, ?, ?)'
      );
      items.forEach((it, i) => {
        insert.run(submissionId, (it.project_name || '').trim(), it.content.trim(), i);
      });
      db.prepare('UPDATE submissions SET updated_at = ? WHERE id = ?').run(formatBeijingDateTime(), submissionId);
    });
    tx(items);
  },

  // 获取某用户的所有提交
  getByUser: (userId) => db.prepare(`
    SELECT s.*, u.name as user_name
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ?
    ORDER BY s.week_start DESC, s.week_type ASC
  `).all(userId),

  // 获取某周所有用户的提交（含未交）
  getByWeek: (weekStart) => {
    return db.prepare(`
      SELECT
        u.id as user_id, u.name as user_name, u.username as username, u.role as role,
        MAX(CASE WHEN s.week_type='this_week' THEN s.id END) as this_id,
        MAX(CASE WHEN s.week_type='next_week' THEN s.id END) as next_id
      FROM users u
      LEFT JOIN submissions s ON s.user_id = u.id AND s.week_start = ?
      WHERE u.username <> ?
      GROUP BY u.id, u.name, u.username, u.role
      ORDER BY u.id ASC
    `).all(weekStart, adminUsername);
  },

  itemsBySubmissionIds: (ids) => {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM work_items WHERE submission_id IN (${placeholders}) ORDER BY submission_id, sort_order ASC`
    ).all(...ids);
  },
};

const WeeklyReports = {
  getByWeek: (weekStart) => db.prepare(
    'SELECT * FROM weekly_reports WHERE week_start = ?'
  ).get(weekStart),

  upsert: ({ weekStart, weekRange, thisWeekSummary, nextWeekSummary, aiRaw, providerName, model, files, generatedBy }) => {
    const now = formatBeijingDateTime();
    const payload = {
      weekStart,
      weekRange,
      thisWeekSummary: JSON.stringify(thisWeekSummary || []),
      nextWeekSummary: JSON.stringify(nextWeekSummary || []),
      aiRaw: aiRaw || '',
      providerName: providerName || '',
      model: model || '',
      filesJson: JSON.stringify(files || []),
      generatedBy: generatedBy || null,
      now,
    };

    db.prepare(`
      INSERT INTO weekly_reports (
        week_start, week_range, this_week_summary, next_week_summary,
        ai_raw, provider_name, model, files_json, generated_by, created_at, updated_at
      ) VALUES (
        @weekStart, @weekRange, @thisWeekSummary, @nextWeekSummary,
        @aiRaw, @providerName, @model, @filesJson, @generatedBy, @now, @now
      )
      ON CONFLICT(week_start) DO UPDATE SET
        week_range = excluded.week_range,
        this_week_summary = excluded.this_week_summary,
        next_week_summary = excluded.next_week_summary,
        ai_raw = excluded.ai_raw,
        provider_name = excluded.provider_name,
        model = excluded.model,
        files_json = excluded.files_json,
        generated_by = excluded.generated_by,
        updated_at = @now
    `).run(payload);

    return WeeklyReports.getByWeek(weekStart);
  },
};

// 周日期工具
function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateOnly(yyyyMmDd) {
  const [year, month, day] = String(yyyyMmDd).split('-').map(Number);
  if (!year || !month || !day) return null;
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getMondayOf(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // 周一为一周开始
  d.setDate(d.getDate() + diff);
  return formatDateLocal(d); // YYYY-MM-DD
}

function addDays(yyyyMmDd, n) {
  const d = parseDateOnly(yyyyMmDd);
  if (!d) return yyyyMmDd;
  d.setDate(d.getDate() + n);
  return formatDateLocal(d);
}

function isCurrentCycle(weekStart, date = new Date()) {
  return weekStart === getMondayOf(date);
}

// 当前周期（周一至周日）可编辑；历史周期只读。
function canEditCycle(weekStart, date = new Date()) {
  return isCurrentCycle(weekStart, date);
}

// 兼容旧调用点；新逻辑不再使用周五中午截止。
function canSubmit(weekStart = getMondayOf()) {
  return canEditCycle(weekStart);
}

module.exports = {
  db,
  Users,
  Submissions,
  Settings,
  WeeklyReports,
  getMondayOf,
  addDays,
  canEditCycle,
  isCurrentCycle,
  canSubmit,
  APP_TIME_ZONE,
  formatBeijingDateTime,
};
