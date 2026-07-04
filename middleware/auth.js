const { Users, Settings } = require('../db');

// 登录校验中间件
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.redirect('/login');
}

// 仅管理员
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'admin') {
    return next();
  }
  return res.status(403).render('error', { message: '权限不足', user: req.session });
}

function isSuperAdminSession(session) {
  const superUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  return !!(session && session.role === 'admin' && session.username === superUsername);
}

// 仅最高管理员（默认 admin 账号）
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.userId && isSuperAdminSession(req.session)) {
    return next();
  }
  return res.status(403).render('error', { message: '仅最高管理员可访问该功能', user: req.session });
}

// 注入当前用户到 res.locals
function injectUser(req, res, next) {
  const isSuperAdmin = isSuperAdminSession(req.session);
  res.locals.user = req.session && req.session.userId ? {
    id: req.session.userId,
    username: req.session.username,
    name: req.session.name,
    role: req.session.role,
    email: req.session.email,
    mustChangePassword: req.session.mustChangePassword,
    isSuperAdmin,
  } : null;
  res.locals.isSuperAdmin = isSuperAdmin;
  res.locals.flash = null;
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
}

function requireProfileComplete(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  if (req.path === '/account' || req.path === '/logout' || req.path === '/health') return next();

  const user = Users.findSessionById(req.session.userId);
  if (!user) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  if (req.session.passwordHash && req.session.passwordHash !== user.password_hash) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  req.session.username = user.username;
  req.session.name = user.name;
  req.session.role = user.role;
  req.session.email = user.email || '';
  req.session.mustChangePassword = !!user.must_change_password;
  req.session.passwordHash = user.password_hash;

  const refreshedSuperAdmin = isSuperAdminSession(req.session);
  res.locals.user = {
    id: req.session.userId,
    username: req.session.username,
    name: req.session.name,
    role: req.session.role,
    email: req.session.email,
    mustChangePassword: req.session.mustChangePassword,
    isSuperAdmin: refreshedSuperAdmin,
  };
  res.locals.isSuperAdmin = refreshedSuperAdmin;

  if (refreshedSuperAdmin) return next();

  const settings = Settings.getAll();
  const emailRequired = (settings.email_required || '0') === '1';
  if (user.must_change_password || (emailRequired && !user.email)) {
    return res.redirect('/account');
  }
  next();
}

// flash 辅助
function flash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, injectUser, requireProfileComplete, flash, isSuperAdminSession };
