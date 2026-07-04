const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { Users, Settings, canSubmit } = require('../db');
const { requireAuth, isSuperAdminSession } = require('../middleware/auth');

function needsAccountSetup(user, settings = Settings.getAll()) {
  if (user && user.username === (process.env.DEFAULT_ADMIN_USERNAME || 'admin')) return false;
  return !!(user && (user.must_change_password || ((settings.email_required || '0') === '1' && !user.email)));
}

function homePathForUser(user) {
  const superUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  if (user && user.role === 'admin' && user.username === superUsername) return '/admin';
  return '/dashboard';
}

router.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect(homePathForUser(req.session));
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '请输入账号和密码' });
  }

  const user = Users.findByUsername(username.trim());
  if (!user) {
    return res.render('login', { error: '账号或密码错误' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.render('login', { error: '账号或密码错误' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.name = user.name;
  req.session.role = user.role;
  req.session.email = user.email || '';
  req.session.mustChangePassword = !!user.must_change_password;
  req.session.passwordHash = user.password_hash;

  // 注入 canSubmit 到 session 视图使用
  res.locals.canSubmit = canSubmit();

  if (needsAccountSetup(user)) {
    return res.redirect('/account');
  }

  res.redirect(homePathForUser(user));
});

router.get('/account', requireAuth, (req, res) => {
  if (isSuperAdminSession(req.session)) return res.redirect('/admin');
  const currentUser = Users.findById(req.session.userId);
  const settings = Settings.getAll();
  res.render('account', {
    currentUser,
    emailRequired: (settings.email_required || '0') === '1',
    forceSetup: needsAccountSetup(currentUser, settings),
    error: null,
  });
});

router.post('/account', requireAuth, async (req, res) => {
  if (isSuperAdminSession(req.session)) return res.redirect('/admin');
  const currentUser = Users.findById(req.session.userId);
  const settings = Settings.getAll();
  const emailRequired = (settings.email_required || '0') === '1';
  const forceSetup = needsAccountSetup(currentUser, settings);
  const { email = '', current_password = '', new_password = '', confirm_password = '' } = req.body;
  const trimmedEmail = String(email).trim();

  function renderError(message) {
    return res.status(400).render('account', {
      currentUser: { ...currentUser, email: trimmedEmail },
      emailRequired,
      forceSetup,
      error: message,
    });
  }

  if (emailRequired && !trimmedEmail) {
    return renderError('请先绑定邮箱');
  }
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return renderError('邮箱格式不正确');
  }

  let passwordHash = null;
  const wantsPasswordChange = !!new_password || !!confirm_password || currentUser.must_change_password;
  if (wantsPasswordChange) {
    if (!new_password || new_password.length < 6) {
      return renderError('新密码长度至少 6 位');
    }
    if (new_password !== confirm_password) {
      return renderError('两次输入的新密码不一致');
    }

    const fullUser = Users.findByUsername(req.session.username);
    if (!currentUser.must_change_password) {
      const ok = await bcrypt.compare(current_password, fullUser.password_hash);
      if (!ok) return renderError('当前密码不正确');
    }
    passwordHash = await bcrypt.hash(new_password, 10);
  }

  Users.updateProfile(req.session.userId, trimmedEmail, passwordHash);
  req.session.email = trimmedEmail;
  req.session.mustChangePassword = false;
  if (passwordHash) req.session.passwordHash = passwordHash;
  req.session.flash = { type: 'success', message: '账号设置已保存' };

  res.redirect(homePathForUser(req.session));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
module.exports.needsAccountSetup = needsAccountSetup;
module.exports.homePathForUser = homePathForUser;
