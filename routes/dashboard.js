const express = require('express');
const router = express.Router();
const { requireAuth, isSuperAdminSession } = require('../middleware/auth');
const { Submissions, getMondayOf, addDays, canEditCycle, db } = require('../db');
const { homePathForUser } = require('./auth');

// ============== 用户面板 ==============

router.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect(homePathForUser(req.session));
  }
  res.redirect('/login');
});

function normalizeItems(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter(it => it && it.content && String(it.content).trim())
    .map(it => ({
      project_name: (it.project_name || '').trim(),
      content: String(it.content).trim(),
    }));
}

router.get('/dashboard', requireAuth, (req, res) => {
  if (isSuperAdminSession(req.session)) return res.redirect('/admin');

  const weekStart = getMondayOf();
  const weekEnd = addDays(weekStart, 6);
  const editable = canEditCycle(weekStart);

  // 本周工作 + 下周计划 同属一个周期（同一个 weekStart）
  const thisSub = Submissions.getOrCreate(req.session.userId, 'this_week', weekStart);
  const nextSub = Submissions.getOrCreate(req.session.userId, 'next_week', weekStart);

  const thisItems = Submissions.getItems(thisSub.id);
  const nextItems = Submissions.getItems(nextSub.id);

  // 历史
  const history = db.prepare(`
    SELECT
      s.week_start,
      SUM(CASE WHEN s.week_type = 'this_week' THEN (SELECT COUNT(*) FROM work_items w WHERE w.submission_id = s.id) ELSE 0 END) as this_count,
      SUM(CASE WHEN s.week_type = 'next_week' THEN (SELECT COUNT(*) FROM work_items w WHERE w.submission_id = s.id) ELSE 0 END) as next_count,
      MAX(s.updated_at) as updated_at
    FROM submissions s
    WHERE s.user_id = ?
    GROUP BY s.week_start
    ORDER BY s.week_start DESC
  `).all(req.session.userId);

  res.render('dashboard', {
    weekStart,
    weekEnd,
    thisWeek: thisItems,
    nextWeek: nextItems,
    history,
    canEditCycle: editable,
    canSubmit: editable,
    canEditThisWeek: editable,
  });
});

// 单个周期一起保存（本周 + 下周）
router.post('/submit-cycle', requireAuth, (req, res) => {
  if (isSuperAdminSession(req.session)) return res.status(403).send('最高管理员不参与周报填报');

  const { week_start, this_items, next_items } = req.body;
  const currentWeekStart = getMondayOf();

  if (week_start !== currentWeekStart || !canEditCycle(week_start)) {
    return res.status(403).render('error', {
      message: '只能修改本周期内容；上一周期及更早记录仅可查看。',
      user: req.session,
    });
  }

  const thisValid = normalizeItems(this_items);
  const nextValid = normalizeItems(next_items);

  if (thisValid.length === 0 && nextValid.length === 0) {
    return res.status(400).render('error', { message: '请至少添加一条工作内容或计划', user: null });
  }

  const thisSub = Submissions.getOrCreate(req.session.userId, 'this_week', week_start);
  const nextSub = Submissions.getOrCreate(req.session.userId, 'next_week', week_start);
  Submissions.setItems(thisSub.id, thisValid);
  Submissions.setItems(nextSub.id, nextValid);

  req.session.flash = { type: 'success', message: '本周期内容已保存' };
  res.redirect('/dashboard');
});

// 兼容旧的单独提交（如果有其他地方还在用）
router.post('/submit', requireAuth, (req, res) => {
  if (isSuperAdminSession(req.session)) return res.status(403).send('最高管理员不参与周报填报');

  const { week_type, week_start, items } = req.body;
  if (!['this_week', 'next_week'].includes(week_type)) {
    return res.status(400).send('参数错误');
  }

  const currentWeekStart = getMondayOf();
  if (week_start !== currentWeekStart || !canEditCycle(week_start)) {
    return res.status(403).render('error', {
      message: '只能修改本周期内容；上一周期及更早记录仅可查看。',
      user: req.session,
    });
  }

  const valid = normalizeItems(items);
  if (valid.length === 0) {
    return res.status(400).render('error', { message: '请至少添加一条工作内容', user: null });
  }

  const submission = Submissions.getOrCreate(req.session.userId, week_type, week_start);
  Submissions.setItems(submission.id, valid);

  req.session.flash = { type: 'success', message: '保存成功' };
  res.redirect('/dashboard');
});

router.get('/history/:weekStart', requireAuth, (req, res) => {
  const { weekStart } = req.params;
  const rows = db.prepare(`
    SELECT week_type, updated_at FROM submissions
    WHERE user_id = ? AND week_start = ?
  `).all(req.session.userId, weekStart);

  const result = { this_week: null, next_week: null };
  rows.forEach(r => { result[r.week_type] = r.updated_at; });

  const items = db.prepare(`
    SELECT w.*, s.week_type FROM work_items w
    JOIN submissions s ON s.id = w.submission_id
    WHERE s.user_id = ? AND s.week_start = ?
    ORDER BY s.week_type, w.sort_order
  `).all(req.session.userId, weekStart);

  res.json({ items, updated: result });
});

module.exports = router;
