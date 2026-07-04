require('dotenv').config();
const { APP_TIME_ZONE } = require('./services/timezone');
const express = require('express');
const session = require('express-session');
const path = require('path');

const { canSubmit } = require('./db');
const { injectUser, requireProfileComplete } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const { startReminderScheduler } = require('./services/reminder');
const SQLiteSessionStore = require('./services/sqliteSessionStore');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 15;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteSessionStore({ ttlMs: SESSION_TTL_MS }),
  secret: process.env.SESSION_SECRET || 'weekly-report-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS },
}));

app.use(injectUser);

// 注入 canSubmit 到所有视图
app.use((req, res, next) => {
  res.locals.canSubmitGlobal = canSubmit();
  next();
});

app.use(authRoutes);
app.use(requireProfileComplete);
app.use(dashboardRoutes);
app.use(adminRoutes);

app.get('/health', (req, res) => res.send('OK'));

// 404
app.use((req, res) => {
  res.status(404).render('error', { message: '页面未找到', user: null });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: '服务器错误: ' + err.message, user: null });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 周报收集工具已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   局域网访问: http://<本机IP>:${PORT}`);
  console.log(`   程序时区: ${APP_TIME_ZONE}`);
  console.log(`   默认管理员: admin / admin123\n`);
  startReminderScheduler();
});
