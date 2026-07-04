const session = require('express-session');
const { db } = require('../db');

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 15;

class SQLiteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.getStmt = db.prepare('SELECT sess, expired_at FROM sessions WHERE sid = ?');
    this.upsertStmt = db.prepare(`
      INSERT INTO sessions (sid, sess, expired_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET
        sess = excluded.sess,
        expired_at = excluded.expired_at
    `);
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.clearExpiredStmt = db.prepare('DELETE FROM sessions WHERE expired_at <= ?');
    this.lengthStmt = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expired_at > ?');
    this.clearExpired();
  }

  getExpiry(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    const expiresAt = cookieExpires ? new Date(cookieExpires).getTime() : Date.now() + this.ttlMs;
    return Number.isFinite(expiresAt) ? expiresAt : Date.now() + this.ttlMs;
  }

  clearExpired() {
    this.clearExpiredStmt.run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expired_at <= Date.now()) {
        this.destroyStmt.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      this.upsertStmt.run(sid, JSON.stringify(sess), this.getExpiry(sess));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  length(callback) {
    try {
      const row = this.lengthStmt.get(Date.now());
      callback(null, row.count);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SQLiteSessionStore;
