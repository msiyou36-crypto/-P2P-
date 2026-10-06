/*
 * المصادقة: كلمات السر تُحفظ مشفّرة بـ scrypt (ملح + تجزئة)، والجلسات في الذاكرة
 * (رمز عشوائي ← الدور) تُمسح عند إعادة تشغيل الخادم. الأدوار: admin، user، user2.
 */
'use strict';

const crypto = require('crypto');

const ROLES = ['admin', 'user', 'user2'];

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

/** {salt, hash} لكلمة سرٍّ جديدة */
function makeCredential(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, cred) {
  if (!cred || !cred.salt || !cred.hash) return false;
  const h = hashPassword(password, cred.salt);
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(cred.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- الجلسات ---------- */
const sessions = new Map();   // token → { role, created }

function newToken(role) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, created: Date.now() });
  return token;
}

/** دور صاحب الطلب من ترويسة X-Auth-Token، أو null */
function roleOf(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  const s = sessions.get(String(token));
  return s ? s.role : null;
}

function dropToken(token) {
  if (token) sessions.delete(String(token));
}

module.exports = { ROLES, makeCredential, verifyPassword, newToken, roleOf, dropToken };
