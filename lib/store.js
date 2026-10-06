/*
 * طبقة التخزين (مفتاح ← قيمة JSON) بوجهين:
 *   - محليًا: ملف JSON لكل مفتاح داخل مجلد data/ (أو DATA_DIR من البيئة).
 *   - عند النشر: جدول kv في Supabase عبر واجهة REST — بلا أي مكتبة — إذا ضُبط
 *     SUPABASE_URL وSUPABASE_KEY.
 * المفاتيح المستعملة في النظام (X = p2p أو p3p):
 *   orders__X, transfers__X          الطلبات والحوالات مفهرسةً بمعرّفها
 *   config__X (أو config محليًا)     الإعدادات والمفاتيح وكلمات السر المشفّرة
 *   gone__orders__X, gone__transfers__X   مقابر المحذوف (انظر server.js)
 *   balsnap__X, trash__X, loginlog__X, syncusage__X, maintenance__<host>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';

if (!USE_SUPABASE) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- Supabase (REST على جدول kv) ---------- */
const SB_HEADERS = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
const sbBase = () => SB_URL + '/rest/v1/kv';

async function sbGet(key, fallback) {
  const r = await fetch(sbBase() + '?key=eq.' + encodeURIComponent(key) + '&select=value', { headers: SB_HEADERS });
  if (!r.ok) throw new Error('Supabase read ' + r.status);
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0] && rows[0].value != null) ? rows[0].value : fallback;
}
async function sbSet(key, value) {
  const r = await fetch(sbBase(), {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, SB_HEADERS),
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error('Supabase write ' + r.status + ' ' + (await r.text().catch(() => '')));
}
async function sbList() {
  const r = await fetch(sbBase() + '?select=key&limit=10000', { headers: SB_HEADERS });
  if (!r.ok) throw new Error('Supabase list ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) ? rows.map((x) => String(x.key)) : [];
}
async function sbDelete(key) {
  const r = await fetch(sbBase() + '?key=eq.' + encodeURIComponent(key), { method: 'DELETE', headers: SB_HEADERS });
  if (!r.ok) throw new Error('Supabase delete ' + r.status);
}

/* ---------- الواجهة الموحّدة ---------- */
const kvFile = (key) => path.join(DATA_DIR, String(key).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');

/** يقرأ قيمة المفتاح، أو fallback إن لم يوجد (أو تعذّرت القراءة من Supabase) */
async function loadStore(key, fallback) {
  if (USE_SUPABASE) {
    try { return await sbGet(key, fallback); }
    catch (e) { console.error('تعذّر القراءة من Supabase:', e.message); return fallback; }
  }
  try { return JSON.parse(fs.readFileSync(kvFile(key), 'utf8')); } catch { return fallback; }
}

/** يكتب القيمة كاملةً (محليًا: كتابة ذرّية عبر ملف مؤقت ثم إعادة تسمية) */
async function saveStore(key, obj) {
  if (USE_SUPABASE) { await sbSet(key, obj); return; }
  const file = kvFile(key);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

/** كل مفاتيح المخزن */
async function listStoreKeys() {
  if (USE_SUPABASE) return sbList();
  return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

async function deleteStore(key) {
  if (USE_SUPABASE) { await sbDelete(key); return; }
  try { fs.unlinkSync(kvFile(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = { DATA_DIR, USE_SUPABASE, loadStore, saveStore, listStoreKeys, deleteStore };
