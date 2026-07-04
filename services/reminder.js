const nodemailer = require('nodemailer');
const { Users, Submissions, Settings, getMondayOf, addDays, formatBeijingDateTime } = require('../db');

function parseDateTimeLocal(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hasBothSections(row) {
  const thisItems = row.this_id ? Submissions.getItems(row.this_id) : [];
  const nextItems = row.next_id ? Submissions.getItems(row.next_id) : [];
  return thisItems.length > 0 && nextItems.length > 0;
}

function getMissingUsers(weekStart) {
  const rows = Submissions.getByWeek(weekStart);
  return rows
    .filter(row => !hasBothSections(row))
    .map(row => Users.findById(row.user_id))
    .filter(user => user && user.email);
}

function shouldRun(settings, now = new Date()) {
  if ((settings.reminder_enabled || '0') !== '1') return false;
  const targetDay = Number(settings.reminder_day || 5);
  if (now.getDay() !== targetDay) return false;

  const [hour, minute] = String(settings.reminder_time || '09:00').split(':').map(Number);
  const start = new Date(now);
  start.setHours(hour || 0, minute || 0, 0, 0);
  if (now < start) return false;

  const intervalMinutes = Math.max(Number(settings.reminder_interval_minutes || 60), 10);
  const last = parseDateTimeLocal(settings.reminder_last_sent_at);
  if (!last) return true;
  return now.getTime() - last.getTime() >= intervalMinutes * 60 * 1000;
}

function createTransport(settings) {
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port || 465),
    secure: (settings.smtp_secure || '1') === '1',
    auth: settings.smtp_user || settings.smtp_pass ? {
      user: settings.smtp_user,
      pass: settings.smtp_pass,
    } : undefined,
  });
}

async function sendTestEmail(settings, to) {
  if (!settings.smtp_host || !settings.smtp_from) {
    throw new Error('请先填写 SMTP Host 和发件人');
  }
  if (!to) {
    throw new Error('请填写测试收件人');
  }

  const transporter = createTransport(settings);
  await transporter.sendMail({
    from: settings.smtp_from,
    to,
    subject: '周报系统 SMTP 测试邮件',
    text: '这是一封 SMTP 测试邮件。如果你收到此邮件，说明周报系统邮箱发送配置可用。',
  });
}

async function sendReminderBatch(settings, users, weekStart) {
  if (!users.length) return 0;
  if (!settings.smtp_host || !settings.smtp_from) {
    console.warn('[reminder] SMTP 未配置完整，跳过邮件提醒');
    return 0;
  }

  const weekEnd = addDays(weekStart, 6);
  const transporter = createTransport(settings);
  let sent = 0;

  for (const user of users) {
    await transporter.sendMail({
      from: settings.smtp_from,
      to: user.email,
      subject: `周报填写提醒（${weekStart} 至 ${weekEnd}）`,
      text: `${user.name}，你好：\n\n请及时填写本周期周报（本周工作和下周计划）。如果已经填写完整，可忽略此邮件。\n\n周期：${weekStart} 至 ${weekEnd}\n系统地址：http://localhost:${process.env.PORT || 3000}\n`,
    });
    sent += 1;
  }

  return sent;
}

async function runReminderOnce(now = new Date()) {
  const settings = Settings.getAll();
  if (!shouldRun(settings, now)) return { ok: true, skipped: true };

  const weekStart = getMondayOf(now);
  const missingUsers = getMissingUsers(weekStart);
  const sent = await sendReminderBatch(settings, missingUsers, weekStart);
  Settings.set('reminder_last_sent_at', formatBeijingDateTime(now));
  return { ok: true, sent };
}

function startReminderScheduler() {
  const tick = () => {
    runReminderOnce().catch(err => {
      console.error('[reminder] 邮件提醒失败:', err.message);
    });
  };

  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000);
}

module.exports = {
  startReminderScheduler,
  runReminderOnce,
  sendTestEmail,
};
