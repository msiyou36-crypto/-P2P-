/*
 * سجل حوالات P2P — الخادم
 * Node.js فقط بلا أي حزمة خارجية. محليًا يستمع على 127.0.0.1 ويحفظ في data/،
 * وعند النشر يقرأ المنفذ من البيئة ويحفظ في Supabase (انظر lib/store.js).
 *
 * فهرس الملف:
 *   ١. البيئة والحسابات والقفل
 *   ٢. الحالة في الذاكرة، الدمج بين النسخ، مقابر المحذوف
 *   ٣. الصيانة، حصّة المزامنة، لقطات الرصيد، سجل الدخول
 *   ٤. الإقلاع (initStore)
 *   ٥. إدراج الطلبات والحوالات (upsert)
 *   ٦. المزامنة الشاملة، فحص الدخيل، جلب يوم
 *   ٧. خادم HTTP: الملفات الثابتة، المسارات وصلاحياتها
 *   ٨. التشغيل
 *
 * الوحدات: lib/store.js (التخزين)، lib/binance.js (عميل المنصة)، lib/normalize.js
 * (توحيد السجلّات)، lib/auth.js (كلمات السر والجلسات)، lib/xlsxread.js (قراءة Excel/CSV).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./lib/store.js');
const bn = require('./lib/binance.js');
const N = require('./lib/normalize.js');
const auth = require('./lib/auth.js');
const xlsxread = require('./lib/xlsxread.js');

const { loadStore, saveStore } = store;
const { sleep, dayLabel, userError } = bn;
const { num } = N;

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const errMsg = (e, dflt = 'خطأ') => (e && e.message) || dflt;
/** هل المعرّف صفٌّ محفوظ فعلًا؟ (لا يُخدع بـ __proto__ وأخواته من الكائن الأصل) */
const own = (obj, id) => Object.prototype.hasOwnProperty.call(obj, id);

/* ===================== ١. البيئة والحسابات والقفل ===================== */

// عند النشر تُضبط PORT من البيئة ونستمع على كل الواجهات؛ محليًا 127.0.0.1 فقط
// (alwaysdata تمرّر المنفذ والعنوان في ALWAYSDATA_HTTPD_PORT/IP)
const ENV_PORT = process.env.PORT || process.env.ALWAYSDATA_HTTPD_PORT;
const PORT = Number(ENV_PORT) || 3131;
const HOST = process.env.HOST || process.env.ALWAYSDATA_HTTPD_IP || (ENV_PORT ? '0.0.0.0' : '127.0.0.1');
const PUB = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;
// رقم الإصدار من package.json (5.5.0 يُعرض 5.5)، تُظهره الواجهة في شاشة الدخول والقائمة
const APP_VERSION = require('./package.json').version.replace(/\.0$/, '');

/* حسابان ممكنان: p2p وp3p، لكلٍّ مفاتيحه وبياناته. متغيّر البيئة ACCOUNT=p2p|p3p
 * يقفل هذه النسخة على حساب واحد (مخازنه وإعداداته وحده) — وهو وضع النشر. بلا
 * المتغيّر (التشغيل المحلي) يُقرأ الحساب من config.active (لا تبديل من الواجهة:
 * يُغيَّر بتحرير data/config.json). */
const ACCOUNTS = ['p2p', 'p3p'];
const ACCOUNT_NAMES = { p2p: 'حوالات P2P', p3p: 'حوالات P3P' };
const LOCKED = ACCOUNTS.includes(process.env.ACCOUNT) ? process.env.ACCOUNT : null;
const CONFIG_KEY = LOCKED ? 'config__' + LOCKED : 'config';
const sysKey = (k) => (LOCKED ? k + '__' + LOCKED : k);   // مفاتيح السستم (الحصّة وسجل الدخول)

const DEFAULT_BASE_URL = 'https://api.binance.com';
const RANGE_DEFAULT_H = 720;     // مدى الجلب: ٣٠ يومًا افتراضًا…
const RANGE_MAX_H = 26280;       // …وثلاث سنوات أقصى
const clampRange = (v) => Math.min(Math.max(Number(v) || RANGE_DEFAULT_H, 1), RANGE_MAX_H);
const SYNC_QUOTA_MAX = 500;
const newAccount = () => ({ apiKey: '', apiSecret: '', baseUrl: DEFAULT_BASE_URL, rangeHours: RANGE_DEFAULT_H, lastSync: null });
const DEFAULT_CONFIG = { active: 'p2p', accounts: {}, auth: {}, syncQuota: 3 };

/* ===================== ٢. الحالة في الذاكرة والدمج والمقابر ===================== */

let orders = {};       // الطلبات مفهرسة برقم الطلب
let transfers = {};    // الحوالات مفهرسة بمعرّفها
let config = Object.assign({}, DEFAULT_CONFIG);
const AC = () => (config.accounts[config.active] || (config.accounts[config.active] = newAccount()));
const ordersKey = () => 'orders__' + config.active;
const transfersKey = () => 'transfers__' + config.active;
const trashKey = () => 'trash__' + config.active;   // سلّة آخر حذفٍ من أداة الفحص
const hasKeys = () => !!(AC().apiKey && AC().apiSecret);
const apiBase = () => (AC().baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
const maskKey = (k) => (k ? k.slice(0, 4) + '…' + k.slice(-4) : '');

/* ===== الدمج قبل الحفظ =====
 * كل نسخة من الخادم تحمل السجل في ذاكرتها وتكتبه كاملًا عند الحفظ، فنسخةٌ بذاكرةٍ
 * أقدم كانت تمحو ما جلبته نسخةٌ أخرى. لذا قبل كل حفظ نقرأ المخزَّن وندمج: ما ليس
 * في ذاكرتنا يُضاف، وحقولُ التعليق (يكتبها المستخدم صفًّا صفًّا) تُؤخذ من المخزَّن
 * لأنه الأحدث — إلا ما عدّلته هذه النسخة ولمّا تحفظه (dirty). الحذف والمسح يمرّان
 * بلا دمج وإلا عاد المحذوف من المخزَّن. */
const ANNOT = ['note', 'reference', 'unitPriceOverride', 'totalPriceOverride', 'networkLabelOverride',
  'zeroPoint', 'archived', 'usdtValue', 'balanceAt', 'balAfter'];
const dirty = new Set();   // «key:id» عُدّل هنا ولم يُحفظ بعد
const touch = (key, id) => dirty.add(key + ':' + id);
function clearDirty(key) { for (const k of dirty) if (k.startsWith(key + ':')) dirty.delete(k); }

async function mergeFromStore(key, mem) {
  try {
    const stored = await loadStore(key, null);
    if (stored && typeof stored === 'object') {
      for (const [id, v] of Object.entries(stored)) {
        if (!own(mem, id)) { mem[id] = v; continue; }
        if (dirty.has(key + ':' + id) || !v || typeof v !== 'object' || !mem[id]) continue;
        for (const f of ANNOT) { if (v[f] != null) mem[id][f] = v[f]; else delete mem[id][f]; }
      }
    }
    await applyGrave(key, mem);
  } catch (e) { console.error('merge ' + key + ': ' + e.message); }
}

/* ===== مقابرُ المحذوف =====
 * الدمج يحمي ما أُضيف لا ما حُذف: نسخةٌ أخرى تحمل الصفَّ في ذاكرتها تُعيده عند أول
 * حفظ. فكل حذفٍ يُقيَّد في مقبرة المخزن (gone__<key>)، ويُسقط الدمجُ والتحميلُ كلَّ
 * مقبور — إلا ما أرجعته المنصةُ في هذه الجلسة (fresh)، فالدليل الطازج يُخرجه منها. */
const GRAVE_MAX = 20000;
const fresh = new Set();   // «key:id» لما أرجعته المنصة في هذه الجلسة

/** فشلُ القراءة يُرمى ولا يُعامَل كمقبرةٍ فارغة، وإلا كتبنا فوقها قائمةً ناقصة */
async function graveOf(key) {
  const g = await loadStore('gone__' + key, null);
  return Array.isArray(g) ? g.map(String) : [];
}
async function bury(key, ids) {
  const list = [...ids].map(String);
  if (!list.length) return;
  const g = new Set(await graveOf(key));
  for (const id of list) { g.add(id); fresh.delete(key + ':' + id); }
  await saveStore('gone__' + key, [...g].slice(-GRAVE_MAX));
}
async function unbury(key, ids) {
  const drop = new Set([...ids].map(String));
  if (!drop.size) return;
  const g = await graveOf(key);
  const keep = g.filter((id) => !drop.has(id));
  if (keep.length !== g.length) await saveStore('gone__' + key, keep);
}
async function applyGrave(key, mem) {
  const g = await graveOf(key);
  if (!g.length) return;
  const back = [];
  for (const id of g) {
    if (fresh.has(key + ':' + id)) { if (own(mem, id)) back.push(id); continue; }
    delete mem[id];
  }
  if (back.length) await unbury(key, back);
}

/** الحفظ (مع دمج ما لم يُطلب غيره) */
async function saveOrders(opts) {
  if (!opts || opts.merge !== false) await mergeFromStore(ordersKey(), orders);
  await saveStore(ordersKey(), orders);
  clearDirty(ordersKey());
}
async function saveTransfers(opts) {
  if (!opts || opts.merge !== false) await mergeFromStore(transfersKey(), transfers);
  await saveStore(transfersKey(), transfers);
  clearDirty(transfersKey());
}
async function saveBoth(opts) {
  await saveOrders(opts);
  await saveTransfers(opts);
}
async function saveConfig() { await saveStore(CONFIG_KEY, config); }
async function mergeBoth() {
  await mergeFromStore(ordersKey(), orders);
  await mergeFromStore(transfersKey(), transfers);
}
/** الدفتر تغيّر (حذف/استعادة/أرشفة): المثبَّت من «الباقي» لم يعد صحيحًا. يُرجع عدد ما مُسح */
function clearFrozen() {
  let n = 0;
  for (const rec of [...Object.values(orders), ...Object.values(transfers)]) {
    if (rec.balAfter != null) { delete rec.balAfter; n++; }
  }
  return n;
}

/* ===================== ٣. الصيانة، الحصّة، اللقطات، سجل الدخول ===================== */

/* وضع الصيانة: مفتاح تخزين مستقل لكل نطاق (host) يُقرأ من المخزن مباشرة في كل طلب،
 * فيوقف هذا السستم وحده ويظهر فورًا من أي نسخة. */
const MAINT_DEFAULT = { on: false, message: '', link: '' };
const systemOf = (req) => String((req && req.headers && req.headers.host) || 'local').toLowerCase();
const maintKey = (req) => 'maintenance__' + systemOf(req).replace(/[^a-z0-9]+/g, '_');
async function loadMaintenance(req) {
  const system = systemOf(req);
  try {
    const m = await loadStore(maintKey(req), null);
    if (m && typeof m === 'object') return { on: !!m.on, message: String(m.message || ''), link: String(m.link || ''), system };
  } catch (e) { console.error('maintenance read: ' + e.message); }
  return Object.assign({}, MAINT_DEFAULT, { system });
}

/* حصّة المزامنة: المسؤول بلا حد، و«مستخدم»/«مستخدم 2» بعدد مرات يوميًا يحدّده المسؤول.
 * العدّاد في مفتاح مستقل يُقرأ طازجًا عند كل طلب. */
const SYNC_USAGE_KEY = sysKey('syncusage');
/* اليوم المحاسبي يُقفل الساعة الثانية ليلًا بتوقيت ليبيا (UTC+2) لا منتصف الليل */
const TZ_OFFSET_H = 2;
const DAY_CLOSE_H = 2;
const DAY_SHIFT_MS = (TZ_OFFSET_H - DAY_CLOSE_H) * HOUR_MS;
const dayKey = (ms) => new Date((ms || Date.now()) + DAY_SHIFT_MS).toISOString().slice(0, 10);
const dayStartMs = (y, mo, d) => Date.UTC(y, mo - 1, d, 0, 0, 0) - DAY_SHIFT_MS;
const syncQuotaValue = () => {
  const n = Number(config.syncQuota);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), SYNC_QUOTA_MAX) : DEFAULT_CONFIG.syncQuota;
};
async function loadSyncUsage() {
  const day = dayKey();
  try {
    const u = await loadStore(SYNC_USAGE_KEY, null);
    if (u && typeof u === 'object' && u.day === day && u.used && typeof u.used === 'object') return { day, used: Object.assign({}, u.used) };
  } catch (e) { console.error('sync usage read: ' + e.message); }
  return { day, used: {} };
}
async function syncQuotaFor(role) {
  const quota = syncQuotaValue();
  if (role === 'admin') return { unlimited: true, quota: 0, used: 0, left: null };
  const u = await loadSyncUsage();
  const used = Number(u.used[role] || 0);
  return { unlimited: false, quota, used, left: Math.max(quota - used, 0) };
}
async function bumpSyncUsage(role) {
  const u = await loadSyncUsage();
  u.used[role] = Number(u.used[role] || 0) + 1;
  try { await saveStore(SYNC_USAGE_KEY, u); } catch (e) { console.error('sync usage save: ' + e.message); }
}

/* لقطات الرصيد اليومية: آخر قراءة لرصيد USDT في كل يوم (الفوري + التمويل). بها تُثبَّت
 * أرقام الأيام الماضية في عمود «الباقي» تلقائيًا (انظر computeBalanceMap في الواجهة). */
const SNAP_KEEP_DAYS = 200;
const snapKey = () => 'balsnap__' + config.active;
async function readBalSnaps() {
  const s = await loadStore(snapKey(), null);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
/** للعرض: فشلُ القراءة يُرجع لا شيء */
async function loadBalSnaps() {
  try { return await readBalSnaps(); } catch (e) { console.error('balsnap read: ' + e.message); return {}; }
}
async function saveBalSnap(bal, at) {
  const s = await readBalSnaps();   // فشلُ القراءة يُرمى: لا نكتب فوق لقطاتٍ لم نقرأها
  const day = dayKey(at);
  if (s[day] && Number(s[day].at) > at) return s;   // آخر قراءة في اليوم هي المعتمدة
  s[day] = { bal, at };
  const days = Object.keys(s).sort();
  for (const d of days.slice(0, Math.max(days.length - SNAP_KEEP_DAYS, 0))) delete s[d];
  try { await saveStore(snapKey(), s); } catch (e) { console.error('balsnap save: ' + e.message); }
  return s;
}

/* سجل الدخول (للمسؤول): الدور والوقت وIP لكل دخول، ومعه كل ما يُثقل على المنصة —
 * مزامنة (sync) وفحص (scan) وجلب يوم (day) — بمن شغّله ومتى، فيُفسَّر أي حظر. */
let loginLog = [];
const LOGIN_LOG_MAX = 300;
function clientIp(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '');
}
function logEvent(role, req, kind = 'login', kinds = null) {
  const ev = { role, time: Date.now(), ip: clientIp(req) };
  if (kind !== 'login') ev.kind = kind;
  if (kinds) ev.kinds = kinds;   // مزامنةٌ لبعض الأنواع: أيّها
  loginLog.push(ev);
  if (loginLog.length > LOGIN_LOG_MAX) loginLog = loginLog.slice(-LOGIN_LOG_MAX);
  saveStore(sysKey('loginlog'), loginLog).catch(() => {});
}

/* محاولات الدخول الخاطئة لكل عنوان: بعد عشرٍ متتالية يُقفل الدخول منه ربع ساعة،
 * فلا تُخمَّن كلمات السر بالتكرار. العدّاد في الذاكرة ويُصفَّر بالدخول الصحيح. */
const LOGIN_FAILS_MAX = 10;
const LOGIN_LOCK_MS = 15 * 60000;
const loginFails = new Map();   // ip → { n, until }
const loginLockLeft = (ip) => { const f = loginFails.get(ip); return f ? Math.max(0, f.until - Date.now()) : 0; };
function noteLoginFail(ip) {
  if (loginFails.size > 5000) loginFails.clear();
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  if (++f.n >= LOGIN_FAILS_MAX) { f.n = 0; f.until = Date.now() + LOGIN_LOCK_MS; }
  loginFails.set(ip, f);
}

/* ===================== ٤. الإقلاع ===================== */

async function loadAccountData(key) {
  const d = (await loadStore(key, null)) || {};
  await applyGrave(key, d);
  return d;
}

/* كلمات السر من البيئة تُضبط ما دام المسؤول بلا كلمةٍ محفوظة: أول تشغيل، أو بعد حذف
 * حقل auth من الإعدادات لاستعادة الدخول. بعدها لا تُقرأ — فالمستخدم الذي حذفه المسؤول
 * لا يعود بإعادة التشغيل. */
const ENV_PASSWORDS = { admin: 'ADMIN_PASSWORD', user: 'USER_PASSWORD', user2: 'USER2_PASSWORD' };

/** تحميل الإعدادات وبيانات الحساب. فشلُ قراءة المخزن يُوقف الإقلاع ولا يُكتب فوقه شيء */
async function initStore() {
  const c = (await loadStore(CONFIG_KEY, null)) || {};
  config = Object.assign({}, DEFAULT_CONFIG, c);
  if (!config.accounts || typeof config.accounts !== 'object') config.accounts = {};
  config.active = LOCKED || (config.active === 'p3p' ? 'p3p' : 'p2p');
  for (const id of ACCOUNTS) {
    if (LOCKED && id !== LOCKED) { delete config.accounts[id]; continue; }   // السستم المقفول لا يحمل إلا حسابه
    config.accounts[id] = Object.assign(newAccount(), config.accounts[id] || {});
  }
  if (config.syncQuota == null) config.syncQuota = DEFAULT_CONFIG.syncQuota;

  if (!config.auth || typeof config.auth !== 'object') config.auth = {};
  for (const role of auth.ROLES) config.auth[role] = config.auth[role] || {};
  if (!config.auth.admin.hash) {
    for (const role of auth.ROLES) {
      const pw = process.env[ENV_PASSWORDS[role]];
      if (pw && !config.auth[role].hash) config.auth[role] = auth.makeCredential(pw);
    }
  }
  try { await saveConfig(); } catch (e) { console.error(e.message); }

  const savedLog = await loadStore(sysKey('loginlog'), []);
  loginLog = Array.isArray(savedLog) ? savedLog : [];

  orders = await loadAccountData(ordersKey());
  transfers = await loadAccountData(transfersKey());
}

/* ===================== ٥. إدراج الطلبات والحوالات ===================== */

/** ما كتبه المستخدم على الصفّ (حقول ANNOT) يبقى بعد إعادة الجلب؛ والنصّ الجديد غير
 *  الفارغ (من ملف استيراد) يغلب القديم */
function keepAnnotations(prev, rec) {
  for (const f of ANNOT) {
    if (f === 'note' || f === 'reference') { if (prev[f] && !rec[f]) rec[f] = prev[f]; }
    else if (prev[f] != null) rec[f] = prev[f];
  }
}

/** إدراج/تحديث طلب → 'added' | 'updated' | 'same'. بيانات المنصة أوثق من اليدوي */
function upsertOrder(o) {
  if (o.source === 'binance') fresh.add(ordersKey() + ':' + o.orderNumber);
  const prev = own(orders, o.orderNumber) ? orders[o.orderNumber] : null;
  if (!prev) { orders[o.orderNumber] = o; return 'added'; }
  keepAnnotations(prev, o);
  if (prev.source === 'binance' && o.source === 'manual') return 'same';
  const changed = JSON.stringify(prev) !== JSON.stringify(o);
  orders[o.orderNumber] = o;
  return changed ? 'updated' : 'same';
}

/** إدراج/تحديث حوالة → 'added' | 'updated' | 'same' */
function upsertTransfer(t) {
  // معرّفٌ فارغ (D أو W وحدهما من normalizeTransfer): سجلٌّ بلا هوية لا يُحفظ
  if (!t.id || t.id === 'D' || t.id === 'W') return 'same';
  if (t.source === 'binance') fresh.add(transfersKey() + ':' + t.id);
  const prev = own(transfers, t.id) ? transfers[t.id] : null;
  if (!prev) { transfers[t.id] = t; return 'added'; }
  keepAnnotations(prev, t);
  const changed = JSON.stringify(prev) !== JSON.stringify(t);
  transfers[t.id] = t;
  return changed ? 'updated' : 'same';
}

/* ===================== ٦. المزامنة والفحص وجلب يوم ===================== */

const NO_KEY = 'لم يتم حفظ مفتاح API بعد — افتح الإعدادات وأدخل المفتاحين أولًا';
let syncRunning = false;   // مزامنةٌ أو فحصٌ أو جلبُ يومٍ واحد في كل مرة

/** سياق الاتصال بالمنصة للحساب النشط (يتحقّق من التوقيت أولًا) */
async function binanceCtx() {
  if (!hasKeys()) throw userError(NO_KEY);
  const base = apiBase();
  return { base, offset: await bn.timeOffset(base), creds: AC() };
}

/* أقصى نوافذ تقبلها المنصة: ٣٠ يومًا لطلبات P2P والتحويل، ٩٠ يومًا للإيداع/السحب/Pay */
const WIN_30 = 29 * DAY_MS;
const WIN_90 = 89 * DAY_MS;

/* رصيد طلبات P2P لكل عملية (يتقاسمه البيع والشراء وكل النوافذ) */
const C2C_BUDGET = { sync: 300, scan: 300, day: 60, diag: 40 };
const SPOT_MAX_SYMBOLS = 8;

const EP_DEPOSIT = '/sapi/v1/capital/deposit/hisrec';
const EP_WITHDRAW = '/sapi/v1/capital/withdraw/history';
const EP_CONVERT = '/sapi/v1/convert/tradeFlow';

/** الإيداع أو السحب في [s, e] بترقيم offset (ألف سجل للطلب)؛ onRaw لكل سجل */
async function fetchDepWd(ctx, kind, s, e, onRaw) {
  const gap = kind === 'deposit' ? 300 : 400;
  for (let off = 0; ; off += 1000) {
    const arr = await bn.signedGet(ctx, kind === 'deposit' ? EP_DEPOSIT : EP_WITHDRAW, { startTime: s, endTime: e, offset: off, limit: 1000 });
    if (kind === 'withdraw') await bn.coolIfHeavy(18000);   // وزن سجل السحب ١٨٠٠٠: عشرة طلبات في الدقيقة
    const rows = Array.isArray(arr) ? arr : [];
    for (const raw of rows) onRaw(raw);
    if (rows.length < 1000) break;
    await sleep(gap);
  }
  await sleep(gap);
}

/** سجل التحويل (Convert) في [s, e]: طلبٌ واحد يكفي النافذة؛ onRaw لكل سجل */
async function fetchConvert(ctx, s, e, onRaw) {
  const j = await bn.signedGet(ctx, EP_CONVERT, { startTime: s, endTime: e, limit: 1000 });
  for (const raw of (Array.isArray(j.list) ? j.list : [])) onRaw(raw);
}

/* أنواع المزامنة: يختار المستخدم منها ما يشاء (الكل افتراضًا)، ولكلٍّ وقتُ آخر مزامنةٍ له
 * (lastSyncBy). ترتيب الجلب لا يهمّ: كل سجلٍّ يُحفظ بمعرّفه ويُعرض بتاريخه في المنصة، فما
 * يُجلب لاحقًا يقع في مكانه من الجدول ومن سلسلة «الباقي». */
const SYNC_KINDS = ['p2p', 'deposit', 'withdraw', 'pay', 'convert', 'spot'];
/** وقت آخر مزامنة لكل نوع؛ قبل الاختيار كانت كل مزامنةٍ تشمل الكل، فيُشتقّ من lastSync */
const lastSyncByOf = (a) => a.lastSyncBy || Object.fromEntries(SYNC_KINDS.map((k) => [k, a.lastSync || null]));

/**
 * المزامنة: الأنواع المختارة (kinds) من طلبات P2P والإيداع والسحب وPay والتحويل والسوق
 * الفوري، على نوافذ زمنية، وتبثّ تقدّمها سطرًا سطرًا (NDJSON). ما جُلب يُحفظ ولو فشلت
 * في منتصفها، ويُختم وقتُ كل نوعٍ اكتمل.
 */
async function* syncGenerator(kinds = SYNC_KINDS) {
  const want = new Set(kinds);
  yield { msg: 'جارٍ الاتصال بالمنصة والتحقق من التوقيت…', pct: 1 };
  await mergeBoth();   // دمج ما كتبته نسخةٌ أخرى قبل الجلب حتى لا نمحوه عند الحفظ
  const ctx = await binanceCtx();

  const now = Date.now();
  const minStart = now - clampRange(AC().rangeHours) * HOUR_MS;
  const win30 = bn.makeWindows(now, minStart, WIN_30);   // P2P والتحويل
  const win90 = bn.makeWindows(now, minStart, WIN_90);   // الإيداع والسحب وPay

  let added = 0, updated = 0;
  let depAdded = 0, wdAdded = 0, payAdded = 0, cvtAdded = 0, sptAdded = 0;
  let step = 0;
  const steps = { p2p: win30.length * 2, deposit: win90.length, withdraw: win90.length, pay: win90.length, convert: win30.length, spot: SPOT_MAX_SYMBOLS };
  const totalSteps = Math.max(kinds.reduce((s, k) => s + steps[k], 0), 1);
  const prog = (msg) => { step++; return { msg, pct: Math.min(1 + Math.round((step / totalSteps) * 96), 97) }; };
  const warn = (msg) => ({ msg, pct: null, warn: true });
  const countTx = (r, onAdd) => { if (r === 'added') onAdd(); };
  // فشلُ Pay أو التحويل أو الفوري يُتخطّى (صلاحيةٌ أو منطقة)، إلا حظرَ المنصة: يُوقف المزامنة كلّها
  const skipUnlessBan = (err, what) => { if (bn.banLeft() > 0) throw err; return warn(`تعذّر جلب ${what} (تم تخطّيه): ${errMsg(err)}`); };
  const done = [];   // الأنواع التي اكتملت — يُختم وقتها ولو فشل ما بعدها

  const result = { done: true };
  try {
    /* ---- طلبات P2P (بيع ثم شراء) — رصيدٌ واحد للمزامنة كلها ---- */
    if (want.has('p2p')) {
      const c2cBudget = { left: C2C_BUDGET.sync };
      for (const tradeType of ['SELL', 'BUY']) {
        const label = tradeType === 'SELL' ? 'مبيعات' : 'مشتريات';
        for (const [s, e] of win30) {
          yield prog(`جلب ${label} P2P: ${dayLabel(s)} ← ${dayLabel(e)}`);
          const got = await bn.fetchC2C(ctx, tradeType, s, e, (raw) => {
            const r = upsertOrder(N.normalizeOrder(raw, 'binance'));
            if (r === 'added') added++; else if (r === 'updated') updated++;
          }, c2cBudget);
          if (got.truncated) yield warn(`${label} P2P ${dayLabel(s)} ← ${dayLabel(e)}: ${bn.c2cWarn(got)}`);
        }
      }
      done.push('p2p');
    }

    /* ---- الإيداع والسحب ---- */
    for (const [kind, label] of [['deposit', 'الإيداعات'], ['withdraw', 'عمليات السحب']]) {
      if (!want.has(kind)) continue;
      for (const [s, e] of win90) {
        yield prog(`جلب ${label}: ${dayLabel(s)} ← ${dayLabel(e)}`);
        await fetchDepWd(ctx, kind, s, e, (raw) => countTx(upsertTransfer(N.normalizeTransfer(raw, kind)), () => (kind === 'deposit' ? depAdded++ : wdAdded++)));
      }
      done.push(kind);
    }

    /* ---- Binance Pay ---- */
    if (want.has('pay')) {
      try {
        for (const [ws, we] of win90) {
          yield prog(`جلب عمليات Binance Pay: ${dayLabel(ws)} ← ${dayLabel(we)}`);
          const got = await bn.fetchPay(ctx, ws, we, (raw) => countTx(upsertTransfer(N.normalizePay(raw)), () => payAdded++));
          if (got.capped) yield warn('عمليات Binance Pay كثيرة جدًّا في هذه الفترة — جُلب أقصى ما يسمح به الحد، وقد تبقى عمليات لم تصل.');
        }
        done.push('pay');
      } catch (err) { yield skipUnlessBan(err, 'عمليات Binance Pay'); }
    }

    /* ---- التحويل بين العملات (Convert) ---- */
    if (want.has('convert')) {
      try {
        for (const [s, e] of win30) {
          yield prog(`جلب سجل التحويل (Convert): ${dayLabel(s)} ← ${dayLabel(e)}`);
          await fetchConvert(ctx, s, e, (raw) => countTx(upsertTransfer(N.normalizeConvert(raw)), () => cvtAdded++));
          await sleep(1000);
        }
        done.push('convert');
      } catch (err) { yield skipUnlessBan(err, 'سجل التحويل Convert'); }
    }

    /* ---- السوق الفوري: /api/v3/myTrades تلزمها symbol، فنستنتج الأزواج من العملات
         التي مرّت على الحساب فعلًا؛ وبلا وقتٍ تُرجع أحدث ألف صفقة دفعةً واحدة ---- */
    if (want.has('spot')) {
      try {
        const bases = new Set();
        for (const t of Object.values(transfers)) {
          for (const a of [t.coin, t.network, t.fromAsset, t.toAsset]) {
            const s = String(a || '').trim().toUpperCase();
            if (s && s !== 'USDT' && /^[A-Z0-9]{2,10}$/.test(s)) bases.add(s);
          }
        }
        for (const symbol of [...bases].slice(0, SPOT_MAX_SYMBOLS).map((b) => b + 'USDT')) {
          yield prog(`جلب تداول السوق الفوري: ${symbol}`);
          try {
            const arr = await bn.signedGet(ctx, '/api/v3/myTrades', { symbol, limit: 1000 });
            for (const raw of (Array.isArray(arr) ? arr : [])) countTx(upsertTransfer(N.normalizeSpotTrade(raw, symbol)), () => sptAdded++);
          } catch (e) {
            if (!/-1121|Invalid symbol/i.test(e.message || '')) throw e;   // زوج غير موجود: نتخطّاه
          }
          await sleep(400);
        }
        done.push('spot');
      } catch (err) { yield skipUnlessBan(err, 'تداول السوق الفوري'); }
    }

    Object.assign(result, { kinds: done, added, updated, depAdded, wdAdded, payAdded, cvtAdded, sptAdded });
  } finally {
    if (done.length) {
      const t = Date.now();
      const by = Object.assign({}, lastSyncByOf(AC()));
      for (const k of done) by[k] = t;
      AC().lastSyncBy = by;
      AC().lastSync = t;
    }
    await saveBoth();
    await saveConfig();
  }
  yield result;
}

/* ===== فحص الدخيل: عملياتٌ محفوظة هنا لا يُرجعها مفتاح هذا الحساب =====
 * المرجع الوحيد ما تُرجعه المنصة لمفتاح هذا السستم في الفترة؛ كل عمليةٍ محفوظة
 * في الفترة ولم تُرجعها مرشَّحةٌ للحذف. تُعرض على المسؤول ويقرّر هو — فالمنصة
 * تُغفل أحيانًا بعض طلبات P2P ولا نحذف على الظنّ. */
async function* foreignScanGenerator(days) {
  yield { msg: 'جارٍ الاتصال بالمنصة…', pct: 1 };
  await mergeBoth();
  const ctx = await binanceCtx();
  const now = Date.now();
  const minStart = now - days * DAY_MS;
  const win30 = bn.makeWindows(now, minStart, WIN_30);   // P2P والتحويل
  const win90 = bn.makeWindows(now, minStart, WIN_90);   // الإيداع والسحب وPay
  const total = Math.max(win30.length * 3 + win90.length * 3, 1);
  let step = 0;
  const prog = (msg) => ({ msg, pct: Math.min(2 + Math.round((++step / total) * 94), 97) });
  // ما يجعل الفحص بلا معنى (حظر، منطقة، مفتاح) يُوقفه؛ وغيره يُسجَّل تحذيرًا ويُكمَل
  const fatal = (e) => /HTTP 4(18|29)|حظر|محجوب|مفتاح API|التوقيع/.test(errMsg(e, ''));
  const seenO = new Set(), seenT = new Set();
  const complete = { deposit: false, withdraw: false, pay: false, convert: false };
  const warnings = [];
  let lastO = 0;   // آخر طلبٍ أرجعته المنصة: ما بعده محفوظٌ هنا ليس من هذا الحساب يقينًا
  const noteT = (t) => seenT.add(t.id);

  const calls = [];   // أثر كل طلب P2P (نافذة/صفحة/صفوف) يُرفق بالتقرير
  const c2cBudget = { left: C2C_BUDGET.scan };
  let truncated = false, windowsIgnored = false;
  for (const tradeType of ['SELL', 'BUY']) {
    for (const [s, e] of win30) {
      yield prog(`طلبات ${tradeType === 'SELL' ? 'البيع' : 'الشراء'}: ${dayLabel(s)} ← ${dayLabel(e)}`);
      const got = await bn.fetchC2C(ctx, tradeType, s, e, (raw) => {
        seenO.add(String(raw.orderNumber));
        lastO = Math.max(lastO, Number(raw.createTime) || 0);
      }, c2cBudget, calls);
      if (got.truncated) truncated = true;
      if (got.windowsIgnored) windowsIgnored = true;
    }
  }
  try {
    for (const [kind, label] of [['deposit', 'الإيداعات'], ['withdraw', 'السحوبات']]) {
      for (const [s, e] of win90) {
        yield prog(`${label}: ${dayLabel(s)} ← ${dayLabel(e)}`);
        await fetchDepWd(ctx, kind, s, e, (raw) => noteT(N.normalizeTransfer(raw, kind)));
      }
      complete[kind] = true;
    }
  } catch (e) { if (fatal(e)) throw e; warnings.push('تعذّر جلب الإيداع/السحب: ' + e.message); }
  try {
    let capped = false;
    for (const [ws, we] of win90) {
      yield prog(`Binance Pay: ${dayLabel(ws)} ← ${dayLabel(we)}`);
      const got = await bn.fetchPay(ctx, ws, we, (raw) => noteT(N.normalizePay(raw)));
      if (got.capped) capped = true;
    }
    complete.pay = !capped;
    if (capped) warnings.push('عمليات Pay أكثر مما يسمح به الحدّ — لم تُفحص كلها');
  } catch (e) { if (fatal(e)) throw e; warnings.push('تعذّر جلب Binance Pay: ' + e.message); }
  try {
    for (const [s, e] of win30) {
      yield prog(`التحويل Convert: ${dayLabel(s)} ← ${dayLabel(e)}`);
      await fetchConvert(ctx, s, e, (raw) => noteT(N.normalizeConvert(raw)));
      await sleep(1000);
    }
    complete.convert = true;
  } catch (e) { if (fatal(e)) throw e; warnings.push('تعذّر جلب التحويل: ' + e.message); }

  const inWin = (t) => t >= minStart && t <= now;
  const foreignOrders = Object.values(orders)
    .filter((o) => o && inWin(o.createTime) && !seenO.has(String(o.orderNumber)))
    .sort((a, b) => b.createTime - a.createTime)
    .map((o) => ({
      id: o.orderNumber, tradeType: o.tradeType, amount: o.amount,
      unitPrice: o.unitPriceOverride != null ? o.unitPriceOverride : o.unitPrice,
      totalPrice: o.totalPriceOverride != null ? o.totalPriceOverride : o.totalPrice,
      fiat: o.fiat, counterPart: o.counterPart, status: o.orderStatus, time: o.createTime, source: o.source,
      note: o.note || '', reference: o.reference || '',
    }));
  const foreignTransfers = Object.values(transfers)
    .filter((t) => t && inWin(t.time) && complete[N.TX_GROUP[t.kind]] && !seenT.has(t.id))   // الفوري لا يُفحص
    .sort((a, b) => b.time - a.time)
    .map((t) => ({ id: t.id, kind: t.kind, amount: t.amount, coin: t.coin, network: t.network, counterPart: t.counterPart || '',
      status: t.status, time: t.time, source: t.source, note: t.note || '', reference: t.reference || '' }));
  yield {
    done: true, days, accountName: ACCOUNT_NAMES[config.active],
    fetched: { orders: seenO.size, transfers: seenT.size }, warnings,
    lastReturned: { order: lastO },
    calls, truncated, windowsIgnored,
    orders: foreignOrders, transfers: foreignTransfers,
  };
}

/** جلب يومٍ محاسبي واحد بكل أنواعه عدا السوق الفوري (علاجٌ موضعي بلا كلفة المزامنة الكاملة) */
async function fetchOneDay(s, e) {
  const ctx = await binanceCtx();
  await mergeBoth();
  const found = { p2p: 0, deposit: 0, withdraw: 0, pay: 0, convert: 0 };
  const added = { p2p: 0, deposit: 0, withdraw: 0, pay: 0, convert: 0 };
  const skipped = [];
  const take = (kind, rec) => {
    found[kind]++;
    const r = kind === 'p2p' ? upsertOrder(rec) : upsertTransfer(rec);
    if (r === 'added') added[kind]++;
  };
  const c2cBudget = { left: C2C_BUDGET.day };
  for (const tradeType of ['SELL', 'BUY']) {
    const got = await bn.fetchC2C(ctx, tradeType, s, e, (raw) => take('p2p', N.normalizeOrder(raw, 'binance')), c2cBudget);
    if (got.truncated) skipped.push('p2p: ' + bn.c2cWarn(got));
  }
  for (const kind of ['deposit', 'withdraw']) {
    await fetchDepWd(ctx, kind, s, e, (raw) => take(kind, N.normalizeTransfer(raw, kind)));
  }
  // Pay والتحويل قد يُمنعان بصلاحية المفتاح أو المنطقة — فشلهما لا يُفشل الباقي
  try {
    const got = await bn.fetchPay(ctx, s, e, (raw) => take('pay', N.normalizePay(raw)));
    if (got.capped) skipped.push('pay: عمليات كثيرة جدًّا في هذا اليوم — قد تبقى عمليات لم تصل');
  } catch (err) { skipped.push('pay: ' + errMsg(err)); }
  try {
    await fetchConvert(ctx, s, e, (raw) => take('convert', N.normalizeConvert(raw)));
  } catch (err) { skipped.push('convert: ' + errMsg(err)); }
  try { await saveBoth(); } catch (err) { console.error(err.message); }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const inDay = (t) => t >= s && t <= e;
  const stored = Object.values(orders).filter((o) => inDay(o.createTime)).length + Object.values(transfers).filter((t) => inDay(t.time)).length;
  return { found, added, skipped, total: sum(found), totalAdded: sum(added), stored };
}

/* ===================== ٧. خادم HTTP ===================== */

/** خطأٌ في الطلب نفسه: يُعرض نصّه ويُردّ بالحالة المعطاة لا بـ 500 */
const badRequest = (message, status = 400) => Object.assign(userError(message), { status });

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(badRequest('الطلب أكبر من المسموح', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readBody(req) {
  const buf = await readRaw(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw badRequest('الطلب ليس JSON صالحًا'); }
}
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
/** بثّ مولّدٍ سطرًا سطرًا (NDJSON) حتى يكتمل أو يفشل */
async function streamNdjson(res, gen) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  try {
    for await (const ev of gen) res.write(JSON.stringify(ev) + '\n');
  } catch (e) {
    res.write(JSON.stringify({ error: e.isUser ? e.message : 'خطأ غير متوقع: ' + e.message }) + '\n');
  } finally {
    res.end();
  }
}

/* ---------- الملفات الثابتة ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

/* الصفحة تُبنى في الخادم بعنوان السستم وأيقوناته ووسوم Open Graph: معاينةُ الرابط
 * في واتساب تقرأ HTML بلا JavaScript، فتراه بلون السستم الصحيح من أول لحظة. */
const THEME_HTML = {
  p2p: { accent: '8e1f3f', ink: 'fbeef2', suffix: '-p2p' },
  p3p: { accent: 'fb923c', ink: '1a1a19', suffix: '' },
};
function renderIndex(html, req) {
  const acct = LOCKED || config.active;
  const t = THEME_HTML[acct];
  const name = 'سجل ' + ACCOUNT_NAMES[acct];
  // العنوان يدخل الصفحة كما هو، فلا يُقبل منه إلا اسم نطاقٍ ومنفذ
  const fp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = fp === 'http' || fp === 'https' ? fp : (ENV_PORT ? 'https' : 'http');
  const host = /^[\w.-]+(:\d+)?$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
  const origin = proto + '://' + host;
  let out = html
    .replace('<html lang="ar" dir="rtl">', `<html lang="ar" dir="rtl" data-account="${acct}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
    .replace('%23fb923c', '%23' + t.accent).replace('%231a1a19', '%23' + t.ink);
  if (t.suffix) {
    for (const f of ['favicon.ico', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest']) {
      out = out.replace(`href="${f}"`, `href="${f.replace(/\.(\w+)$/, t.suffix + '.$1')}"`);
    }
  }
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${name}">`,
    `<meta property="og:title" content="${name}">`,
    `<meta property="og:description" content="سجل عمليات Binance P2P والإيداع والسحب">`,
    `<meta property="og:url" content="${origin}/">`,
    `<meta property="og:image" content="${origin}/icon-512${t.suffix}.png">`,
    `<meta property="og:image:width" content="512">`,
    `<meta property="og:image:height" content="512">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:image" content="${origin}/icon-512${t.suffix}.png">`,
  ].join('\n');
  return out.replace('<link rel="stylesheet" href="style.css">', og + '\n<link rel="stylesheet" href="style.css">');
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('غير موجود'); return; }
    if (rel === 'index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(renderIndex(buf.toString('utf8'), req));
      return;
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-cache';   // يُتحقّق من حداثتها بعد كل نشر
    res.writeHead(200, headers);
    res.end(buf);
  });
}

/* ---------- المسارات ----------
 * route(method, path, scope, handler). الصلاحية (scope):
 *   public   بلا دخول
 *   login    أي مستخدم مسجّل دخوله (admin / user / user2)
 *   annotate المسؤول و«مستخدم 2»: تصحيحُ صفٍّ واحد (إشاري، ملاحظة، سعر، مبلغ)
 *   admin    المسؤول فقط
 * handler(req, res, ctx) حيث ctx = { url, role, body (دالة تقرأ JSON) }. */
const routes = new Map();
const route = (method, p, scope, handler) => routes.set(method + ' ' + p, { scope, handler });
const deny = (res, status, error) => sendJSON(res, status, { error });
/** يُشغّل عملًا ثقيلًا على المنصة إن لم يكن غيره يعمل (مزامنة، فحص، جلب يوم) */
async function exclusive(res, work) {
  if (syncRunning) return deny(res, 409, 'هناك مزامنة أو فحص قيد التنفيذ — انتظر انتهاءه');
  syncRunning = true;
  try { await work(); } finally { syncRunning = false; }
}

/* --- حالة الصيانة والمصادقة --- */
route('GET', '/api/maintenance', 'public', async (req, res) => sendJSON(res, 200, await loadMaintenance(req)));

route('GET', '/api/auth/status', 'public', (req, res) => sendJSON(res, 200, {
  configured: !!(config.auth.admin && config.auth.admin.hash),
  hasUser: !!(config.auth.user && config.auth.user.hash),
  hasUser2: !!(config.auth.user2 && config.auth.user2.hash),
  account: LOCKED ? { id: LOCKED, name: ACCOUNT_NAMES[LOCKED] } : null,   // شاشة الدخول تأخذ لون السستم قبل الدخول
  version: APP_VERSION,
}));

route('POST', '/api/auth/setup', 'public', async (req, res, c) => {
  if (config.auth.admin && config.auth.admin.hash) return deny(res, 409, 'تم الإعداد مسبقًا — سجّل الدخول');
  const body = await c.body();
  const ap = String(body.adminPassword || ''), up = String(body.userPassword || ''), up2 = String(body.user2Password || '');
  if (ap.length < 4) return deny(res, 400, 'كلمة سر المسؤول يجب ألا تقل عن 4 خانات');
  config.auth.admin = auth.makeCredential(ap);
  config.auth.user = up ? auth.makeCredential(up) : {};
  config.auth.user2 = up2 ? auth.makeCredential(up2) : {};
  await saveConfig();
  logEvent('admin', req);
  sendJSON(res, 200, { ok: true, token: auth.newToken('admin'), role: 'admin' });
});

route('POST', '/api/auth/login', 'public', async (req, res, c) => {
  const ip = clientIp(req);
  const locked = loginLockLeft(ip);
  if (locked) return deny(res, 429, `محاولاتٌ خاطئة كثيرة — حاول بعد ${Math.ceil(locked / 60000)} دقيقة`);
  const body = await c.body();
  const role = auth.ROLES.includes(body.role) ? body.role : 'user';
  const cred = config.auth[role];
  if (!cred || !cred.hash) {
    return deny(res, 400, role === 'admin' ? 'لم يتم الإعداد بعد'
      : (role === 'user2' ? 'لا يوجد حساب «مستخدم 2» — عيّنه من «تغيير كلمات السر»' : 'لا يوجد حساب مستخدم — ادخل كمسؤول'));
  }
  if (!auth.verifyPassword(String(body.password || ''), cred)) { noteLoginFail(ip); return deny(res, 401, 'كلمة السر غير صحيحة'); }
  loginFails.delete(ip);
  logEvent(role, req);
  sendJSON(res, 200, { ok: true, token: auth.newToken(role), role });
});

route('POST', '/api/auth/logout', 'public', (req, res) => { auth.dropToken(req.headers['x-auth-token']); sendJSON(res, 200, { ok: true }); });

route('POST', '/api/auth/password', 'admin', async (req, res, c) => {
  const body = await c.body();
  if (typeof body.adminPassword === 'string' && body.adminPassword) {
    if (body.adminPassword.length < 4) return deny(res, 400, 'كلمة سر المسؤول قصيرة جدًا');
    config.auth.admin = auth.makeCredential(body.adminPassword);
  }
  if (typeof body.userPassword === 'string') config.auth.user = body.userPassword ? auth.makeCredential(body.userPassword) : {};
  if (typeof body.user2Password === 'string') config.auth.user2 = body.user2Password ? auth.makeCredential(body.user2Password) : {};
  await saveConfig();
  sendJSON(res, 200, { ok: true });
});

route('GET', '/api/auth/log', 'admin', (req, res) => sendJSON(res, 200, { events: loginLog.slice().reverse() }));

route('POST', '/api/maintenance', 'admin', async (req, res, c) => {
  const body = await c.body();
  const m = await loadMaintenance(req);
  if (typeof body.on === 'boolean') m.on = body.on;
  if (typeof body.message === 'string') m.message = body.message.slice(0, 2000);
  if (typeof body.link === 'string') m.link = body.link.slice(0, 1000);
  await saveStore(maintKey(req), m);   // يُوقف هذا السستم (النطاق الحالي) وحده
  sendJSON(res, 200, { ok: true, maintenance: m });
});

/* --- الحساب والإعدادات --- */
route('GET', '/api/account', 'login', (req, res) => sendJSON(res, 200, {
  active: config.active,
  locked: !!LOCKED,
  accounts: [{ id: config.active, name: ACCOUNT_NAMES[config.active] }],
}));

route('GET', '/api/settings', 'login', (req, res) => {
  sendJSON(res, 200, {
    apiKeyMasked: maskKey(AC().apiKey),
    hasSecret: !!AC().apiSecret,
    baseUrl: AC().baseUrl,
    rangeHours: AC().rangeHours,
    syncQuota: syncQuotaValue(),
    lastSync: AC().lastSync,
    lastSyncBy: lastSyncByOf(AC()),
  });
});

route('POST', '/api/settings', 'admin', async (req, res, c) => {
  const body = await c.body();
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) AC().apiKey = body.apiKey.trim();
  if (typeof body.apiSecret === 'string' && body.apiSecret.trim()) AC().apiSecret = body.apiSecret.trim();
  if (typeof body.baseUrl === 'string') {
    const u = body.baseUrl.trim().replace(/\/+$/, '');
    if (/^https:\/\/[\w.-]+$/.test(u)) AC().baseUrl = u;
  }
  if (body.rangeHours != null) AC().rangeHours = clampRange(body.rangeHours);
  if (body.syncQuota != null) config.syncQuota = Math.min(Math.max(Math.floor(Number(body.syncQuota)) || 0, 0), SYNC_QUOTA_MAX);
  await saveConfig();
  sendJSON(res, 200, { ok: true });
});

/* --- الطلبات --- */
route('GET', '/api/orders', 'login', (req, res) => sendJSON(res, 200, { orders: Object.values(orders), lastSync: AC().lastSync }));

route('POST', '/api/orders', 'admin', async (req, res, c) => {
  const o = N.normalizeOrder(await c.body(), 'manual');
  if (!(o.amount > 0)) return deny(res, 400, 'الكمية مطلوبة ويجب أن تكون أكبر من صفر');
  if (!(o.totalPrice > 0)) return deny(res, 400, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر');
  const r = upsertOrder(o);
  await saveOrders();
  sendJSON(res, 200, { result: r, order: o });
});

/** استيراد دفعة (ملف CSV من الواجهة): الصفّ الموجود يُحدَّث من الملف (status/السعر…) مع حفظ تعليقاته */
route('POST', '/api/orders/bulk', 'admin', async (req, res, c) => {
  const body = await c.body();
  let added = 0, updated = 0, skipped = 0;
  for (const raw of (Array.isArray(body.orders) ? body.orders : [])) {
    const o = N.normalizeOrder(raw, raw.source === 'binance' ? 'binance' : 'import');
    if (!(o.amount > 0) || !(o.totalPrice > 0)) { skipped++; continue; }
    const r = upsertOrder(o);
    if (r === 'added') added++; else if (r === 'updated') updated++;
    if (r !== 'same') touch(ordersKey(), o.orderNumber);
  }
  await saveOrders();
  sendJSON(res, 200, { added, updated, skipped, total: Object.keys(orders).length });
});

route('DELETE', '/api/orders', 'admin', async (req, res, c) => {
  const id = c.url.searchParams.get('id') || '';
  if (!own(orders, id)) return deny(res, 404, 'الطلب غير موجود');
  await mergeFromStore(ordersKey(), orders);
  delete orders[id];
  await bury(ordersKey(), [id]);
  await saveOrders({ merge: false });
  sendJSON(res, 200, { ok: true, total: Object.keys(orders).length });
});

route('POST', '/api/orders/clear', 'admin', async (req, res) => { orders = {}; await saveOrders({ merge: false }); sendJSON(res, 200, { ok: true }); });
route('POST', '/api/transfers/clear', 'admin', async (req, res) => { transfers = {}; await saveTransfers({ merge: false }); sendJSON(res, 200, { ok: true }); });

/* تعليقات الصفّ (تبقى بعد المزامنة). مرساة الرصيد والأرشفة وتسمية الشبكة وتقويم USDT
 * تمسّ الدفتر كلّه فتبقى للمسؤول؛ الواجهة تُخفيها عن «مستخدم 2» والخادم يُلزم ذلك. */
function applyAnnotation(rec, body, isAdmin, isTransfer) {
  if (typeof body.note === 'string') rec.note = body.note.slice(0, 2000);
  if (typeof body.reference === 'string') rec.reference = body.reference.slice(0, 2000);
  for (const [field, over] of [['unitPrice', 'unitPriceOverride'], ['totalPrice', 'totalPriceOverride']]) {
    if (!(field in body)) continue;
    const s = String(body[field]).trim();   // '' يعني إلغاء التعديل والرجوع لقيمة المنصة
    if (s === '') delete rec[over];
    else { const v = Number(s); if (Number.isFinite(v) && v >= 0) rec[over] = v; }
  }
  if (!isAdmin) return;
  if ('networkLabel' in body) {
    const s = String(body.networkLabel).trim();
    if (s === '') delete rec.networkLabelOverride; else rec.networkLabelOverride = s.slice(0, 40);
  }
  if ('archived' in body) { if (body.archived) rec.archived = true; else delete rec.archived; }   // إخفاءٌ من الجدول لا محو
  if ('zeroPoint' in body) { if (body.zeroPoint) rec.zeroPoint = true; else delete rec.zeroPoint; }
  if ('balanceAt' in body) {   // مرساة المستخدم: رصيده الحقيقي بعد هذه العملية
    const v = Number(body.balanceAt);
    if (body.balanceAt == null || !Number.isFinite(v) || v < 0) { delete rec.balanceAt; delete rec.zeroPoint; }
    else { rec.balanceAt = Math.round(v * 1e8) / 1e8; delete rec.zeroPoint; }
  }
  if (isTransfer && 'usdtValue' in body) {   // تقويم عمليةٍ بعملة أخرى بالـUSDT لتدخل «الباقي»
    const v = Number(body.usdtValue);
    if (body.usdtValue == null || String(body.usdtValue).trim() === '' || !Number.isFinite(v) || v < 0) delete rec.usdtValue;
    else rec.usdtValue = Math.round(v * 1e8) / 1e8;
  }
}

route('POST', '/api/orders/annotate', 'annotate', async (req, res, c) => {
  const body = await c.body();
  const id = String(body.id || '');
  if (!own(orders, id)) return deny(res, 404, 'الطلب غير موجود');
  applyAnnotation(orders[id], body, c.role === 'admin', false);
  touch(ordersKey(), id);
  await saveOrders();
  sendJSON(res, 200, { ok: true, order: orders[id] });
});

/* --- الحوالات --- */
route('GET', '/api/transfers', 'login', (req, res) => sendJSON(res, 200, { transfers: Object.values(transfers), lastSync: AC().lastSync }));

route('POST', '/api/transfers/annotate', 'annotate', async (req, res, c) => {
  const body = await c.body();
  const id = String(body.id || '');
  if (!own(transfers, id)) return deny(res, 404, 'الحوالة غير موجودة');
  applyAnnotation(transfers[id], body, c.role === 'admin', true);
  touch(transfersKey(), id);
  await saveTransfers();
  sendJSON(res, 200, { ok: true, transfer: transfers[id] });
});

/* --- الرصيد وعمود «الباقي» --- */
route('GET', '/api/balance', 'login', async (req, res) => {
  if (!hasKeys()) return deny(res, 400, NO_KEY);
  const ctx = await binanceCtx();
  const funding = await bn.signedGet(ctx, '/sapi/v1/asset/get-funding-asset', { needBtcValuation: 'true' }, 'POST');
  // الحساب الفوري يُجمع مع التمويل (التحويل بينهما لا يغيّر ما نملكه)؛ فشلُه غير قاتل
  let spot = [], spotError = '';
  try { spot = await bn.signedGet(ctx, '/sapi/v3/asset/getUserAsset', {}, 'POST'); }
  catch (e) { spotError = e.message || 'تعذّر الجلب'; console.error('spot balance: ' + spotError); }

  const NUMS = ['free', 'locked', 'freeze', 'withdrawing', 'btcValuation'];
  const usdtTotal = (list) => (Array.isArray(list) ? list : [])
    .filter((a) => String(a.asset || '').toUpperCase() === 'USDT')
    .reduce((s, a) => s + num(a.free) + num(a.locked) + num(a.freeze) + num(a.withdrawing), 0);
  const merged = new Map();
  for (const a of [...(Array.isArray(funding) ? funding : []), ...(Array.isArray(spot) ? spot : [])]) {
    const key = String(a.asset || '').toUpperCase();
    if (!key) continue;
    const cur = merged.get(key) || { asset: key };
    for (const f of NUMS) cur[f] = num(cur[f]) + num(a[f]);
    merged.set(key, cur);
  }
  const now = Date.now();
  // لقطةُ اليوم لا تُسجَّل إلا بالمحفظتين معًا: رقمٌ ناقص يصير أساسًا خاطئًا للعمود
  let snapshots = null;
  if (!spotError) {
    try { snapshots = await saveBalSnap(usdtTotal(funding) + usdtTotal(spot), now); }
    catch (e) { console.error('balsnap: ' + e.message); }
  }
  sendJSON(res, 200, {
    assets: [...merged.values()], spotIncluded: !spotError, spotError,
    usdtFunding: usdtTotal(funding), usdtSpot: usdtTotal(spot),
    snapshots: snapshots || await loadBalSnaps(), updatedAt: now,
  });
});

route('GET', '/api/balance/snapshots', 'login', async (req, res) => sendJSON(res, 200, { snapshots: await loadBalSnaps() }));

/* تثبيت «الباقي» على الصفّ: أول قيمة تُكتب نهائية، ولا تُكتب فوقها */
route('POST', '/api/balance/freeze', 'login', async (req, res, c) => {
  const body = await c.body();
  let n = 0;
  const put = (map, key, id, v) => {
    const rec = own(map, id) ? map[id] : null;
    const x = Number(v);
    if (!rec || rec.balAfter != null || !Number.isFinite(x)) return;
    rec.balAfter = Math.round(x * 1e8) / 1e8;
    touch(key, id);
    n++;
  };
  for (const [id, v] of Object.entries(body.orders || {})) put(orders, ordersKey(), id, v);
  for (const [id, v] of Object.entries(body.transfers || {})) put(transfers, transfersKey(), id, v);
  if (n) await saveBoth();
  sendJSON(res, 200, { ok: true, frozen: n });
});

/* إلغاء التثبيت وإعادة الحساب من الصفر (مخرجٌ إن ثُبِّتت أرقام خاطئة) */
route('POST', '/api/balance/unfreeze', 'login', async (req, res) => {
  await mergeBoth();
  const n = clearFrozen();
  await saveBoth({ merge: false });
  sendJSON(res, 200, { ok: true, cleared: n });
});

/* --- المزامنة --- */
route('GET', '/api/sync/quota', 'login', async (req, res, c) => {
  // blockedFor: ثواني الحظر الباقية إن حظرت المنصة العنوان — فيُقفل زر المزامنة عند الجميع
  sendJSON(res, 200, Object.assign(await syncQuotaFor(c.role), { blockedFor: Math.ceil(bn.banLeft() / 1000) }));
});

/* body: { kinds: ['p2p', 'deposit', …] } — ما يُجلب؛ بلا قائمة = الكل */
route('POST', '/api/sync', 'login', async (req, res, c) => {
  if (bn.banLeft() > 0) return deny(res, 429, bn.banMessage(bn.banLeft()));   // أثناء الحظر لا تبدأ ولا تُخصم
  const body = await c.body();
  const kinds = Array.isArray(body.kinds) ? SYNC_KINDS.filter((k) => body.kinds.includes(k)) : SYNC_KINDS.slice();
  if (!kinds.length) return deny(res, 400, 'اختر نوعًا واحدًا على الأقل لتجلبه');
  const q = await syncQuotaFor(c.role);
  if (!q.unlimited && q.left <= 0) {
    return sendJSON(res, 429, {
      error: q.quota === 0 ? 'المزامنة غير مسموحة لحسابك — راجع المسؤول' : `انتهى عدد مرات المزامنة اليوم (${q.quota}) — جرّب بكرة أو راجع المسؤول`,
      quota: q.quota, used: q.used, left: 0,
    });
  }
  if (!hasKeys()) return deny(res, 400, NO_KEY);
  await exclusive(res, async () => {
    if (!q.unlimited) await bumpSyncUsage(c.role);
    logEvent(c.role, req, 'sync', kinds.length < SYNC_KINDS.length ? kinds : null);
    await streamNdjson(res, syncGenerator(kinds));
  });
});

route('POST', '/api/sync/day', 'admin', async (req, res, c) => {
  if (!hasKeys()) return deny(res, 400, NO_KEY);
  const body = await c.body();
  const m = String(body.day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return deny(res, 400, 'حدّد اليوم بصيغة YYYY-MM-DD');
  const s = dayStartMs(+m[1], +m[2], +m[3]);   // حدود اليوم المحاسبي (من الثانية ليلًا)
  const e = s + DAY_MS - 1;
  if (s > Date.now()) return deny(res, 400, 'هذا اليوم لم يأتِ بعد');
  await exclusive(res, async () => {
    logEvent(c.role, req, 'day');
    let r;
    try { r = await fetchOneDay(s, e); }
    catch (err) { return deny(res, 502, errMsg(err, 'تعذّر سؤال المنصة')); }
    sendJSON(res, 200, Object.assign({ ok: true, day: body.day, from: s, to: e }, r));
  });
});

/* --- أدوات الفحص (للمسؤول) --- */

/** ما تُرجعه المنصة فعلًا في آخر N يومًا مقابل المحفوظ: هل العملية لم تصل أم وصلت ولم تُحفظ؟ */
route('GET', '/api/diag/p2p', 'admin', async (req, res, c) => {
  if (!hasKeys()) return deny(res, 400, NO_KEY);
  const days = Math.min(Math.max(Number(c.url.searchParams.get('days')) || 3, 1), 29);
  await exclusive(res, async () => {
    const ctx = await binanceCtx();
    logEvent(c.role, req, 'scan');
    const end = Date.now();
    const start = end - days * DAY_MS;
    const list = [];
    const c2cBudget = { left: C2C_BUDGET.diag };
    const warnings = [];
    for (const tradeType of ['SELL', 'BUY']) {
      const got = await bn.fetchC2C(ctx, tradeType, start, end, (r) => {
        const n = String(r.orderNumber || '').trim();
        list.push({ orderNumber: n, tail: n.slice(-4), tradeType: String(r.tradeType || ''), amount: num(r.amount), totalPrice: num(r.totalPrice),
          status: String(r.orderStatus || ''), time: Number(r.createTime) || 0, stored: own(orders, n) });
      }, c2cBudget);
      if (got.truncated) warnings.push((tradeType === 'SELL' ? 'البيع: ' : 'الشراء: ') + bn.c2cWarn(got));
    }
    list.sort((a, b) => b.time - a.time);
    const fromApi = new Set(list.map((x) => x.orderNumber));
    const onlyOurs = Object.values(orders)
      .filter((o) => o.createTime >= start && o.createTime <= end && !fromApi.has(o.orderNumber))
      .map((o) => ({ orderNumber: o.orderNumber, tail: String(o.orderNumber).slice(-4), tradeType: o.tradeType, amount: o.amount,
        totalPrice: o.totalPrice, status: o.orderStatus, time: o.createTime, source: o.source }))
      .sort((a, b) => b.time - a.time);
    sendJSON(res, 200, { days, fromPlatform: list, onlyOurs, warnings });
  });
});

/** أيُّ حساب Binance يقرأه مفتاح هذا السستم؟ (UID يظهر في تطبيق Binance) */
route('GET', '/api/diag/whoami', 'admin', async (req, res) => {
  if (!hasKeys()) return deny(res, 400, NO_KEY);
  const ctx = await binanceCtx();
  const j = await bn.signedGet(ctx, '/api/v3/account', { omitZeroBalances: 'true' });
  sendJSON(res, 200, { uid: j.uid != null ? String(j.uid) : '', accountType: String(j.accountType || ''), keyMasked: maskKey(AC().apiKey), accountName: ACCOUNT_NAMES[config.active] });
});

route('POST', '/api/diag/foreign-ops', 'admin', async (req, res, c) => {
  const body = await c.body();
  const days = Math.min(Math.max(Math.floor(Number(body.days)) || 45, 1), 400);
  if (!hasKeys()) return deny(res, 400, NO_KEY);
  await exclusive(res, async () => {
    logEvent(c.role, req, 'scan');
    await streamNdjson(res, foreignScanGenerator(days));
  });
});

/** حذف ما اختاره المسؤول من نتيجة الفحص: يُقبر، ويُحفظ في سلّة trash__X للاسترجاع */
route('POST', '/api/diag/foreign-ops/delete', 'admin', async (req, res, c) => {
  const body = await c.body();
  const oIds = (Array.isArray(body.orders) ? body.orders : []).map(String);
  const tIds = (Array.isArray(body.transfers) ? body.transfers : []).map(String);
  await mergeBoth();
  let n = 0;
  const gone = { orders: [], transfers: [] };
  const trash = { orders: {}, transfers: {}, at: Date.now() };
  for (const id of oIds) if (own(orders, id)) { trash.orders[id] = orders[id]; delete orders[id]; gone.orders.push(id); n++; }
  for (const id of tIds) if (own(transfers, id)) { trash.transfers[id] = transfers[id]; delete transfers[id]; gone.transfers.push(id); n++; }
  if (n) {
    try { await saveStore(trashKey(), trash); } catch (e) { console.error('trash: ' + e.message); }
    await bury(ordersKey(), gone.orders);
    await bury(transfersKey(), gone.transfers);
    clearFrozen();
    await saveBoth({ merge: false });
  }
  sendJSON(res, 200, { ok: true, deleted: n, accountName: ACCOUNT_NAMES[config.active] });
});

/** استرجاع آخر حذف (سلّة المحذوف) */
route('POST', '/api/diag/foreign-ops/undo', 'admin', async (req, res) => {
  const trash = (await loadStore(trashKey(), null)) || { orders: {}, transfers: {} };
  await mergeBoth();
  let n = 0;
  const oIds = [], tIds = [];
  for (const [id, o] of Object.entries(trash.orders || {})) if (!own(orders, id)) { orders[id] = o; oIds.push(id); touch(ordersKey(), id); n++; }
  for (const [id, t] of Object.entries(trash.transfers || {})) if (!own(transfers, id)) { transfers[id] = t; tIds.push(id); touch(transfersKey(), id); n++; }
  if (n) {
    await unbury(ordersKey(), oIds);
    await unbury(transfersKey(), tIds);
    clearFrozen();
    await saveBoth({ merge: false });
  }
  await saveStore(trashKey(), { orders: {}, transfers: {}, at: Date.now() });
  sendJSON(res, 200, { ok: true, restored: n, accountName: ACCOUNT_NAMES[config.active] });
});

/* الاستعادة من ملف تصدير (Excel/CSV من النظام): preview يعرض ما ليس في المخزن، وapply يُعيده.
 * ?tz= فرقُ توقيت جهاز المصدِّر عن UTC بالدقائق (getTimezoneOffset): أوقات الملف بتوقيته هو */
route('POST', '/api/restore/preview', 'admin', async (req, res, c) => {
  const buf = await readRaw(req);
  if (!buf.length) return deny(res, 400, 'لم يصل ملف');
  const tzRaw = c.url.searchParams.get('tz');
  const tz = tzRaw == null || tzRaw === '' ? undefined : Number(tzRaw);
  let rows, rec;
  try { rows = (buf[0] === 0x50 && buf[1] === 0x4b) ? xlsxread.parseXlsx(buf) : xlsxread.parseCsv(buf.toString('utf8')); }
  catch (e) { return deny(res, 400, 'تعذّرت قراءة الملف: ' + e.message); }
  try { rec = N.rowsToRecords(rows, tz); } catch (e) { return deny(res, 400, e.message); }
  await mergeBoth();
  sendJSON(res, 200, {
    accountName: ACCOUNT_NAMES[config.active], rows: rows.length - 1,
    inFile: { orders: rec.orders.length, transfers: rec.transfers.length, depwd: rec.depwd },
    missingOrders: rec.orders.filter((o) => !own(orders, o.orderNumber)),
    missingTransfers: rec.transfers.filter((t) => !own(transfers, t.id)),
  });
});

route('POST', '/api/restore/apply', 'admin', async (req, res, c) => {
  const body = await c.body();
  await mergeBoth();
  let n = 0;
  const oIds = [], tIds = [];
  for (const raw of (Array.isArray(body.orders) ? body.orders : [])) {
    const o = N.normalizeOrder(raw, 'import');
    if (!o.orderNumber || own(orders, o.orderNumber)) continue;
    orders[o.orderNumber] = o; oIds.push(o.orderNumber); touch(ordersKey(), o.orderNumber); n++;
  }
  for (const raw of (Array.isArray(body.transfers) ? body.transfers : [])) {
    const id = String(raw.id || '');
    if (!id || own(transfers, id) || !own(N.TX_GROUP, raw.kind)) continue;
    transfers[id] = Object.assign({}, raw, { id, source: 'import', status: String(raw.status || 'COMPLETED') });
    tIds.push(id); touch(transfersKey(), id); n++;
  }
  if (n) {
    await unbury(ordersKey(), oIds);   // ما استُعيد لا يبقى مقبورًا
    await unbury(transfersKey(), tIds);
    clearFrozen();
    await saveBoth({ merge: false });
  }
  sendJSON(res, 200, { ok: true, restored: n, accountName: ACCOUNT_NAMES[config.active] });
});

/* أرشفةُ كل ما قبل تاريخ (أو إرجاعه بـ undo): يخرج من الجدول ومن «الباقي» ويبقى في الأرشيف */
route('POST', '/api/archive/before', 'admin', async (req, res, c) => {
  const body = await c.body();
  const before = Number(body.before);
  if (!Number.isFinite(before) || before <= 0) return deny(res, 400, 'حدّد التاريخ أولًا');
  const undo = !!body.undo;
  await mergeBoth();
  let no = 0, nt = 0;
  for (const [id, o] of Object.entries(orders)) {
    if (!(o.createTime < before) || !!o.archived === !undo) continue;
    if (undo) delete o.archived; else o.archived = true;
    touch(ordersKey(), id); no++;
  }
  for (const [id, t] of Object.entries(transfers)) {
    if (!(t.time < before) || !!t.archived === !undo) continue;
    if (undo) delete t.archived; else t.archived = true;
    touch(transfersKey(), id); nt++;
  }
  if (no + nt) {
    clearFrozen();
    await saveBoth({ merge: false });
  }
  sendJSON(res, 200, { ok: true, orders: no, transfers: nt, undo, accountName: ACCOUNT_NAMES[config.active] });
});

/* بيانات الحساب الآخر في قاعدة هذا السستم (بعد الفصل): تُعرض ثم تُحذف بأمر صريح */
const LEGACY_SHARED = ['orders', 'transfers', 'config', 'loginlog', 'syncusage'];   // مفاتيح ما قبل الفصل، بلا لاحقة
async function foreignKeys() {
  const other = ACCOUNTS.find((a) => a !== LOCKED) || 'p2p';
  const keys = await store.listStoreKeys();
  return { other, keys: keys.filter((k) => k.endsWith('__' + other) || LEGACY_SHARED.includes(k)) };
}
route('GET', '/api/system/foreign', 'admin', async (req, res) => {
  if (!LOCKED) return deny(res, 400, 'هذا الإجراء للسستم المقفول على حسابٍ واحد (متغيّر ACCOUNT)');
  let f;
  try { f = await foreignKeys(); } catch (e) { return deny(res, 500, 'تعذّر قراءة مفاتيح القاعدة: ' + e.message); }
  const items = [];
  for (const k of f.keys) {
    const v = await loadStore(k, null);
    items.push({ key: k, rows: Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 1) });
  }
  sendJSON(res, 200, { otherName: ACCOUNT_NAMES[f.other], count: f.keys.length, items });
});
route('DELETE', '/api/system/foreign', 'admin', async (req, res) => {
  if (!LOCKED) return deny(res, 400, 'هذا الإجراء للسستم المقفول على حسابٍ واحد (متغيّر ACCOUNT)');
  let f;
  try { f = await foreignKeys(); } catch (e) { return deny(res, 500, 'تعذّر قراءة مفاتيح القاعدة: ' + e.message); }
  let n = 0;
  try { for (const k of f.keys) { await store.deleteStore(k); n++; } }
  catch (e) { return deny(res, 500, `تعذّر الحذف بعد ${n} مفتاحًا: ` + e.message); }
  sendJSON(res, 200, { ok: true, deleted: n, otherName: ACCOUNT_NAMES[f.other] });
});

/* ---------- الموزّع ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      serveStatic(req, res, p);
      return;
    }
    const r = routes.get(req.method + ' ' + p);
    if (!r) return deny(res, 404, 'not found');
    const role = auth.roleOf(req);
    if (r.scope === 'admin' && role !== 'admin') return deny(res, 403, 'هذه العملية للمسؤول فقط');
    if (r.scope === 'annotate' && role !== 'admin' && role !== 'user2') return deny(res, 403, 'لا تملك صلاحية التعديل في السجل');
    if (r.scope === 'login' && !role) return deny(res, 401, 'يلزم تسجيل الدخول');
    await r.handler(req, res, { url, role, body: () => readBody(req) });
  } catch (e) {
    try { sendJSON(res, e.status || 500, { error: e.isUser ? e.message : 'خطأ داخلي: ' + e.message }); } catch {}
  }
});

/* ===================== ٨. التشغيل ===================== */

const localUrl = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT;
const openBrowser = () => { if (process.argv.includes('--open')) execFile('cmd', ['/c', 'start', '', localUrl]); };

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('\n  يبدو أن النظام يعمل بالفعل — افتح المتصفح على: ' + localUrl);
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error('تعذّر تشغيل الخادم:', e.message);
    process.exit(1);
  }
});

initStore().then(() => {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  سجل ' + (LOCKED ? ACCOUNT_NAMES[LOCKED] + ' (سستم مقفول على هذا الحساب)' : ACCOUNT_NAMES[config.active]) + ' — الإصدار ' + APP_VERSION + ' — يعمل الآن' + (store.USE_SUPABASE ? '  (التخزين: Supabase)' : ''));
    console.log('  العنوان: ' + localUrl);
    console.log('  لإيقاف النظام أغلق هذه النافذة أو اضغط Ctrl+C');
    console.log('');
    openBrowser();
  });
}).catch((e) => {
  console.error('تعذّر تحميل التخزين عند الإقلاع:', e.message);
  process.exit(1);
});
