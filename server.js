/*
 * سجل حوالات P2P — خادم محلي
 * يعمل بـ Node.js فقط بدون أي حزم خارجية.
 * البيانات والمفاتيح تُحفظ محليًا داخل مجلد data/ على هذا الجهاز فقط،
 * والخادم يستمع على 127.0.0.1 حصرًا (غير مرئي لبقية الشبكة).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// عند النشر تُضبط PORT من البيئة ونستمع على كل الواجهات؛ محليًا نبقى على 127.0.0.1 فقط.
const PORT = Number(process.env.PORT) || 3131;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const MAX_BODY = 8 * 1024 * 1024;

/* ===================== طبقة التخزين (مزدوجة) =====================
 * محليًا: ملفات JSON داخل data/.
 * عند النشر: قاعدة Supabase عبر واجهة REST (بدون أي مكتبة) — إذا ضُبط SUPABASE_URL.
 * كلاهما يخزّن ثلاثة مفاتيح: orders / transfers / config.
 */
const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
// مسار ملف لأي مفتاح تخزين (orders__p2p, transfers__p3p, config…)
const kvFile = (key) => path.join(DATA_DIR, String(key).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');

// ===== حسابان: p2p و p3p — كلٌّ بمفاتيحه وبياناته =====
const ACCOUNTS = ['p2p', 'p3p'];
const ACCOUNT_NAMES = { p2p: 'حوالات P2P', p3p: 'حوالات P3P' };
function newAccount() {
  return { apiKey: '', apiSecret: '', baseUrl: 'https://api.binance.com', rangeHours: 720, lastSync: null };
}
const DEFAULT_CONFIG = { active: 'p2p', accounts: { p2p: newAccount(), p3p: newAccount() }, auth: {} };
// الحساب النشط الحالي (مفاتيحه ومداه)
const AC = () => (config.accounts[config.active] || (config.accounts[config.active] = newAccount()));

/* ===== سستمٌ لحسابٍ واحد =====
 * متغيّر البيئة ACCOUNT=p2p أو p3p يقفل هذه النسخة على حسابٍ واحد: مفاتيحه
 * ومخازنه وإعداداته وحده، بلا زرّ تبديل. سستمان على قاعدةٍ واحدة كانا يتبادلان
 * الحساب النشط تحت بعضهما فتتسرّب عمليات حسابٍ إلى الآخر؛ والقفلُ يجعل ذلك
 * مستحيلًا بنيةً لا برمجةً: النسخةُ لا تعرف إلا حسابها. بلا المتغيّر يبقى
 * السلوك القديم (حسابان وزرّ تبديل) للتشغيل المحلي. */
const LOCKED = ACCOUNTS.includes(process.env.ACCOUNT) ? process.env.ACCOUNT : null;
const CONFIG_KEY = LOCKED ? 'config__' + LOCKED : 'config';
const sysKey = (k) => (LOCKED ? k + '__' + LOCKED : k); // مفاتيح السستم لا الحساب: الحصّة وسجل الدخول

if (!USE_SUPABASE) fs.mkdirSync(DATA_DIR, { recursive: true });

async function sbGet(key, fallback) {
  const url = SB_URL + '/rest/v1/kv?key=eq.' + encodeURIComponent(key) + '&select=value';
  const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
  if (!r.ok) throw new Error('Supabase read ' + r.status);
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0] && rows[0].value != null) ? rows[0].value : fallback;
}
async function sbSet(key, value) {
  const r = await fetch(SB_URL + '/rest/v1/kv', {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error('Supabase write ' + r.status + ' ' + (await r.text().catch(() => '')));
}

async function loadStore(key, fallback) {
  if (USE_SUPABASE) {
    try { return await sbGet(key, fallback); }
    catch (e) { console.error('تعذّر القراءة من Supabase:', e.message); return fallback; }
  }
  try { return JSON.parse(fs.readFileSync(kvFile(key), 'utf8')); } catch { return fallback; }
}
async function saveStore(key, obj) {
  if (USE_SUPABASE) { await sbSet(key, obj); return; }
  const file = kvFile(key);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

/** الحالة في الذاكرة (تُملأ من التخزين عند الإقلاع في initStore) — للحساب النشط */
let orders = {};       // الطلبات مفهرسة برقم الطلب
let transfers = {};    // الإيداع/السحب مفهرسة بمعرّف فريد
let config = Object.assign({}, DEFAULT_CONFIG);

/* ===== الحفظ مع دمج (سستمان على قاعدة واحدة) =====
 * كل نسخة من الخادم تحمل السجل في ذاكرتها منذ الإقلاع وتكتبه كاملًا عند الحفظ؛
 * فالنسخة ذات الذاكرة الأقدم كانت تمحو ما جلبته النسخة الأخرى — «عمليات تختفي»
 * (نفس علّة وضع الصيانة سابقًا). قبل كل حفظ نقرأ المخزَّن وندمج ما ليس في
 * ذاكرتنا، ثم نكتب. الحذف والمسح يمرّان بلا دمج وإلا عاد المحذوف من المخزَّن.
 */
/* حقولُ التعليق (ملاحظة/إشاري/سعر/مبلغ/تسمية/مرساة/أرشفة/تثبيت) يكتبها المستخدم
 * صفًّا صفًّا وتُحفظ فورًا، فالمخزَّن أحدثُ منها في ذاكرة أي نسخةٍ لم تكتبها
 * بنفسها. كان الدمج يحمي وجودَ الصفّ لا محتواه: نسخةٌ حفظت ذاكرتها القديمة
 * فأعادت أسعارًا مُعدَّلة إلى ما قبل تعديلها. فعند الدمج تُؤخذ هذه الحقول من
 * المخزَّن — إلا ما عدّلته هذه النسخةُ ولمّا تحفظه بعد (dirty)، فهو الأحدث. */
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
        if (!(id in mem)) { mem[id] = v; continue; }
        if (dirty.has(key + ':' + id) || !v || typeof v !== 'object' || !mem[id]) continue;
        for (const f of ANNOT) { if (v[f] != null) mem[id][f] = v[f]; else delete mem[id][f]; }
      }
    }
    await applyGrave(key, mem);
  } catch (e) { console.error('merge ' + key + ': ' + e.message); }
}

/* ===== مقابرُ المحذوف =====
 * الدمج أعلاه يحمي ما أُضيف، لكنه لا يحمي ما حُذف: نسخةٌ أخرى تحمل الصفَّ في
 * ذاكرتها منذ إقلاعها تُعيده عند أول حفظٍ لها كأنّ الحذف لم يقع (هكذا عادت
 * حوالاتٌ أُخرجت من حسابٍ إلى حسابها). فنقيّد كل حذفٍ في مقبرة المخزن، ويُسقط
 * الدمجُ والتحميلُ كلَّ مقبور — إلا ما أرجعته المنصةُ في هذه الجلسة، فالدليل
 * الطازج أقوى من المقبرة ويُخرجه منها. */
const GRAVE_MAX = 20000;
const fresh = new Set();          // «key:id» لما أرجعته المنصة في هذه الجلسة
const storeKeyOf = new WeakMap(); // مخزنٌ في الذاكرة ← مفتاحه (لغير الحساب النشط)
async function graveOf(key) {
  try { const g = await loadStore('gone__' + key, null); return Array.isArray(g) ? g.map(String) : []; }
  catch { return []; }
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
/** يُسقط المقبورَ من الذاكرة، ويُخرج من المقبرة ما عاد بدليلٍ طازج */
async function applyGrave(key, mem) {
  const g = await graveOf(key);
  if (!g.length) return;
  const back = [];
  for (const id of g) {
    if (fresh.has(key + ':' + id)) { if (id in mem) back.push(id); continue; }
    delete mem[id];
  }
  if (back.length) await unbury(key, back);
}
// الحفظ مفصول لكل حساب: orders__p2p / transfers__p3p …
async function saveOrders(opts) {
  if (!opts || opts.merge !== false) await mergeFromStore('orders__' + config.active, orders);
  await saveStore('orders__' + config.active, orders);
  clearDirty('orders__' + config.active);
}
async function saveTransfers(opts) {
  if (!opts || opts.merge !== false) await mergeFromStore('transfers__' + config.active, transfers);
  await saveStore('transfers__' + config.active, transfers);
  clearDirty('transfers__' + config.active);
}

/* ===== وضع الصيانة: مفتاح تخزين مستقل لكل سستم (نطاق) =====
 * لا يُخزَّن داخل config، لأن config يُقرأ مرّة واحدة عند الإقلاع ويُكتب كاملًا عند كل حفظ؛
 * فلو عملت نسخة ثانية من الخادم (سستم ثاني) على نفس القاعدة، تكتب نسختها القديمة فوق الصيانة وتُلغيها.
 * والمفتاح مربوط بنطاق السستم، حتى يمكن إيقاف سستم وترك الثاني شغّالًا رغم اشتراكهما في القاعدة.
 * القراءة دائمًا من القاعدة مباشرة، والكتابة على هذا المفتاح فقط.
 */
const MAINT_DEFAULT = { on: false, message: '', link: '' };
// اسم السستم = النطاق الذي وصل عليه الطلب (p2p-1-3zpk.onrender.com …)
const systemOf = (req) => String((req && req.headers && req.headers.host) || 'local').toLowerCase();
const maintKey = (req) => 'maintenance__' + systemOf(req).replace(/[^a-z0-9]+/g, '_');
async function loadMaintenance(req) {
  const system = systemOf(req);
  try {
    const m = await loadStore(maintKey(req), null);
    if (m && typeof m === 'object') {
      return { on: !!m.on, message: String(m.message || ''), link: String(m.link || ''), system };
    }
  } catch (e) { console.error('maintenance read: ' + e.message); }
  return Object.assign({}, MAINT_DEFAULT, { system });
}

/* ===== حصّة المزامنة للمستخدمين (غير المسؤول) =====
 * المسؤول يزامن بلا حد. «مستخدم» و«مستخدم 2» لكلٍّ منهما عدد مرات في اليوم يحدّده المسؤول.
 * العدّاد في مفتاح تخزين مستقل يُقرأ طازجًا عند كل طلب، حتى لا يكتب سستمٌ فوق عدّاد الآخر،
 * والحصّة مشتركة بين السستمين لأن الحظر يقع على الحساب في المنصة لا على السستم.
 */
const SYNC_QUOTA_DEFAULT = 3;
const SYNC_USAGE_KEY = sysKey('syncusage'); // لكل سستم حصّته
/* ===== اليوم المحاسبي =====
 * لا يُقفل اليوم منتصف الليل بل الساعة الثانية ليلًا بتوقيت ليبيا (UTC+2)،
 * فالعمل يمتدّ إلى ما بعد منتصف الليل وحسابُه على يومه لا على اليوم التالي.
 * فما وقع قبل الثانية ليلًا يُحسب على اليوم السابق. */
const TZ_OFFSET_H = 2;      // ليبيا UTC+2 (بلا توقيت صيفي)
const DAY_CLOSE_H = 2;      // الإقفال الساعة ٢ ليلًا محليًا
const DAY_SHIFT_MS = (TZ_OFFSET_H - DAY_CLOSE_H) * 3600000;
const dayKey = (ms) => new Date((ms || Date.now()) + DAY_SHIFT_MS).toISOString().slice(0, 10);
/** بداية اليوم المحاسبي «YYYY-MM-DD» بالتوقيت العالمي */
const dayStartMs = (y, mo, d) => Date.UTC(y, mo - 1, d, 0, 0, 0) - DAY_SHIFT_MS;
const syncDayKey = () => dayKey();
const syncQuotaValue = () => {
  const n = Number(config.syncQuota);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 500) : SYNC_QUOTA_DEFAULT;
};
async function loadSyncUsage() {
  const day = syncDayKey();
  try {
    const u = await loadStore(SYNC_USAGE_KEY, null);
    if (u && typeof u === 'object' && u.day === day && u.used && typeof u.used === 'object') {
      return { day, used: Object.assign({}, u.used) };
    }
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

/* ===== لقطات الرصيد اليومية: ما يُثبِّت عمود «الباقي من USDT» تلقائيًا =====
 * لكل يومٍ آخرُ قراءةٍ لرصيد USDT (الفوري + التمويل معًا). ما إن يدخل يومٌ جديد
 * حتى تُغلق قراءةُ أمس وتصير ثابتة إلى الأبد، فلا تتحرّك أرقام الأيام الماضية
 * مهما دخل من عمليات. تُقرأ طازجة وتُدمج قبل الحفظ، فلا يمحو سستمٌ لقطات الآخر.
 */
const SNAP_KEEP_DAYS = 200;
const snapKey = () => 'balsnap__' + config.active;
async function loadBalSnaps() {
  try {
    const s = await loadStore(snapKey(), null);
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  } catch (e) { console.error('balsnap read: ' + e.message); }
  return {};
}
async function saveBalSnap(bal, at) {
  const s = await loadBalSnaps();
  const day = dayKey(at);
  // آخر قراءة في اليوم هي المعتمدة: كلّما تأخّرت كانت أقرب لإغلاق اليوم
  if (s[day] && Number(s[day].at) > at) return s;
  s[day] = { bal, at };
  const days = Object.keys(s).sort();
  for (const d of days.slice(0, Math.max(days.length - SNAP_KEEP_DAYS, 0))) delete s[d];
  try { await saveStore(snapKey(), s); } catch (e) { console.error('balsnap save: ' + e.message); }
  return s;
}

/* ===================== المصادقة والصلاحيات ===================== */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
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
const isConfigured = () => !!(config.auth.admin && config.auth.admin.hash);

/** جلسات في الذاكرة: token → { role } (تُمسح عند إعادة تشغيل الخادم) */
const sessions = new Map();
function newToken(role) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, created: Date.now() });
  return token;
}
function roleOf(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  const s = sessions.get(String(token));
  return s ? s.role : null;
}

/** سجل الدخول: آخر عمليات الدخول (الدور + الوقت + IP) — يراه المسؤول فقط */
let loginLog = [];
const LOGIN_LOG_MAX = 300;
function recordLogin(role, req) {
  let ip = '';
  try {
    ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || (req.socket && req.socket.remoteAddress) || '';
    ip = ip.replace(/^::ffff:/, '');
  } catch {}
  loginLog.push({ role, time: Date.now(), ip });
  if (loginLog.length > LOGIN_LOG_MAX) loginLog = loginLog.slice(-LOGIN_LOG_MAX);
  // حفظ غير معطِّل للاستجابة (الدخول نادر)
  saveStore(sysKey('loginlog'), loginLog).catch(() => {});
}

/** بيانات حساب معيّن (مع ترحيل مفاتيح p2p القديمة غير المُلاحقة) */
/* ===== الحساب النشط بين عدّة نسخ على قاعدةٍ واحدة =====
 * config يُقرأ مرّةً عند الإقلاع ويُكتب كاملًا، فنسخةٌ ثانية تكتب "active" القديم
 * فوق ما بدّلته الأولى — فينقلب الحساب تحت المستخدم وتُحفظ عملياتُ حسابٍ في
 * آخر. فنقرأه طازجًا قبل كل عملٍ يمسّ بيانات حساب، ونُعيد تحميل البيانات إن
 * تبدّل، كي لا تبقى في الذاكرة صفوفُ حسابٍ ونحن نكتب تحت اسم آخر.
 */
async function refreshActive() {
  if (LOCKED) return false;   // السستم المقفول لا يبدّل حسابه أبدًا
  try {
    const stored = await loadStore(CONFIG_KEY, null);
    const a = stored && stored.active;
    if (ACCOUNTS.includes(a) && a !== config.active) {
      config.active = a;
      orders = await loadAccountData('orders');
      transfers = await loadAccountData('transfers');
      return true;
    }
  } catch (e) { console.error('refreshActive: ' + e.message); }
  return false;
}

/** حفظُ الإعدادات دون أن نمحو حسابًا بدّلته نسخةٌ أخرى */
async function saveConfig() {
  await refreshActive();
  await saveStore(CONFIG_KEY, config);
}

/** مفاتيحُ حسابٍ ما: من إعدادات هذه النسخة، أو — في السستم المقفول — من إعدادات
 *  السستم الآخر للقراءة فقط (إعادةُ الحوالات تسأل الحسابين بمفتاحيهما) */
async function accountKeysFor(id) {
  const own = config.accounts && config.accounts[id];
  if (own && own.apiKey && own.apiSecret) return own;
  if (!LOCKED || id === LOCKED) return null;
  try {
    const c = await loadStore('config__' + id, null);
    const a = c && c.accounts && c.accounts[id];
    if (a && a.apiKey && a.apiSecret) return a;
    const shared = await loadStore('config', null);   // الإعدادات المشتركة قبل الفصل
    const b = shared && shared.accounts && shared.accounts[id];
    return b && b.apiKey && b.apiSecret ? b : null;
  } catch { return null; }
}

async function loadAccountData(kind) {
  let d = await loadStore(kind + '__' + config.active, null);
  if (d == null && config.active === 'p2p') {
    d = await loadStore(kind, {}); // المفتاح القديم قبل نظام الحسابين
    if (d && Object.keys(d).length) { try { await saveStore(kind + '__p2p', d); } catch {} }
  }
  d = d || {};
  await applyGrave(kind + '__' + config.active, d);
  return d;
}

/** تحميل الإعدادات وبيانات الحساب النشط عند الإقلاع + ترحيل + ضبط كلمات السر من البيئة */
async function initStore() {
  let c = await loadStore(CONFIG_KEY, null);
  /* أول إقلاعٍ مقفول: إعداداتُ هذا الحساب وكلماتُ السر تُنسخ من الإعدادات المشتركة
     القديمة مرّةً واحدة، ثم يمضي السستم بمفتاحه المستقل ولا يمسّ المشترك بعدها */
  if (c == null && LOCKED) {
    const shared = (await loadStore('config', null)) || {};
    c = {
      active: LOCKED,
      accounts: { [LOCKED]: (shared.accounts || {})[LOCKED] || {} },
      auth: shared.auth || {},
      syncQuota: shared.syncQuota,
    };
    console.log('سستم «' + ACCOUNT_NAMES[LOCKED] + '» يبدأ بإعداداته المستقلة (منسوخة من المشتركة)');
  }
  c = c || {};
  config = Object.assign({}, DEFAULT_CONFIG, c);

  // ترحيل من الحساب الواحد القديم → accounts.p2p
  if (!config.accounts || typeof config.accounts !== 'object') config.accounts = {};
  if (!config.accounts.p2p) {
    config.accounts.p2p = {
      apiKey: c.apiKey || '', apiSecret: c.apiSecret || '',
      baseUrl: c.baseUrl || 'https://api.binance.com', months: c.months || 12, lastSync: c.lastSync || null,
    };
  }
  config.accounts.p2p = Object.assign(newAccount(), config.accounts.p2p);
  config.accounts.p3p = Object.assign(newAccount(), config.accounts.p3p || {});
  // ترحيل مدى الجلب: من «months» القديمة (بالأشهر) → «rangeHours» (بالساعات)
  for (const id of ACCOUNTS) {
    const a = config.accounts[id];
    if (a && a.months != null) { a.rangeHours = Math.round(Number(a.months) * 720) || 720; delete a.months; }
  }
  config.active = LOCKED || (config.active === 'p3p' ? 'p3p' : 'p2p');
  // السستم المقفول لا يحمل إلا حسابه، فلا تُكتب مفاتيح الحساب الآخر في إعداداته
  if (LOCKED) for (const id of ACCOUNTS) if (id !== LOCKED) delete config.accounts[id];
  ['apiKey', 'apiSecret', 'baseUrl', 'months', 'lastSync'].forEach((k) => delete config[k]);

  // وضع الصيانة انتقل لمفاتيح مستقلة لكل سستم — يُحذف من config نهائيًا
  delete config.maintenance;

  // عدد مرات المزامنة المسموحة يوميًا لكل مستخدم غير مسؤول
  if (config.syncQuota == null) config.syncQuota = SYNC_QUOTA_DEFAULT;

  // المصادقة + ضبط كلمات السر من البيئة عند أول تشغيل
  if (!config.auth || typeof config.auth !== 'object') config.auth = {};
  config.auth.admin = config.auth.admin || {};
  config.auth.user = config.auth.user || {};
  config.auth.user2 = config.auth.user2 || {};
  if (!config.auth.admin.hash && process.env.ADMIN_PASSWORD) config.auth.admin = makeCredential(process.env.ADMIN_PASSWORD);
  if (!config.auth.user.hash && process.env.USER_PASSWORD) config.auth.user = makeCredential(process.env.USER_PASSWORD);
  if (!config.auth.user2.hash && process.env.USER2_PASSWORD) config.auth.user2 = makeCredential(process.env.USER2_PASSWORD);

  try { await saveStore(CONFIG_KEY, config); } catch (e) { console.error(e.message); }

  const savedLog = await loadStore(sysKey('loginlog'), []);
  loginLog = Array.isArray(savedLog) ? savedLog : [];

  orders = await loadAccountData('orders');
  transfers = await loadAccountData('transfers');

  /* إصلاح بيانات لمرة واحدة: عمليتا P2P نُفِّذتا عبر رصيد الحساب الفوري ولا
     تُرجعهما واجهة Binance (listUserOrderHistory) إطلاقًا رغم أن نوافذ المزامنة
     غطّت وقتيهما مرارًا — القيم منقولة من تفاصيل الطلب في تطبيق Binance نفسه.
     المفتاح هو رقم الطلب الحقيقي: لو أرجعتها المنصة يومًا تُحدَّث ولا تتكرر. */
  if (config.active === 'p2p') {
    let seeded = false;
    if (!orders['22916843477495025664']) {
      orders['22916843477495025664'] = {
        orderNumber: '22916843477495025664',
        tradeType: 'SELL', asset: 'USDT', fiat: 'SDG', fiatSymbol: 'ج.س',
        amount: 179.06, takerAmount: 179.06, totalPrice: 1051344, unitPrice: 5871.35,
        commission: 0.06, counterPart: 'Rania76', orderStatus: 'COMPLETED',
        advertisementRole: '', createTime: Date.UTC(2026, 7, 1, 12, 15, 23),
        note: '', reference: '', source: 'binance',
      };
      seeded = true;
    }
    /* خمس عمليات بيع أخرى بعد الطلب أعلاه مباشرةً لا تُرجعها المنصة كذلك.
       كل القيم منقولة حرفيًا من شاشة «تفاصيل الطلب» في تطبيق Binance: رقم
       الطلب والكمية والرسوم والسعر والمبلغ بالجنيه ووقت الإنشاء ولقب المشتري.
       مجموع كمياتها 886.04 USDT يطابق العجز المرصود بالضبط. */
    const MISSING_SELLS = [
      { n: '22916845583096152064', rel: 238.71, price: 5863.01, sdg: 1399601, h: 14, m: 23, s: 45, who: 'ZEZOO0098' },
      { n: '22916845909626912768', rel: 170.57, price: 5863.00, sdg: 1000090, h: 14, m: 25, s: 3,  who: 'Rania76' },
      { n: '22916851014434566144', rel: 171.34, price: 5866.00, sdg: 1005107, h: 14, m: 45, s: 20, who: 'PRESTIGE_STORE' },
      { n: '22916844005940060160', rel: 160.20, price: 5871.33, sdg: 940604,  h: 14, m: 17, s: 29, who: 'AHMED ALIi' },
      { n: '22916851747372740608', rel: 144.92, price: 5867.00, sdg: 850274,  h: 14, m: 48, s: 15, who: 'Abdostor' },
    ];
    for (const o of MISSING_SELLS) {
      // إزالة النسخة التقديرية السابقة (معرّف P2P-xxxx) بعد وصول البيانات الحقيقية
      const est = 'P2P-' + o.n.slice(-4);
      if (orders[est]) { delete orders[est]; seeded = true; }
      if (orders[o.n]) continue;
      orders[o.n] = {
        orderNumber: o.n,
        tradeType: 'SELL', asset: 'USDT', fiat: 'SDG', fiatSymbol: 'ج.س',
        amount: o.rel, takerAmount: o.rel,
        totalPrice: o.sdg, unitPrice: o.price,
        commission: 0.06, counterPart: o.who, orderStatus: 'COMPLETED',
        advertisementRole: '',
        createTime: Date.UTC(2026, 7, 1, o.h - 2, o.m, o.s), // التطبيق بتوقيت السودان (UTC+2)
        note: '', reference: '', source: 'binance',
      };
      seeded = true;
    }

    const stale1184 = orders['22916831805419741184'];
    if (stale1184 && stale1184.orderStatus === 'TRADING') {
      // إشعار Binance: أُلغي تلقائيًا لأن المشتري لم يدفع في الوقت المحدد
      stale1184.orderStatus = 'CANCELLED_BY_SYSTEM';
      seeded = true;
    }
    // بلا دمج: الذاكرة هنا نسخةُ المخزَّن للتوّ، والدمج يُعيد النسخ المحذوفة
    if (seeded) { try { await saveOrders({ merge: false }); } catch (e) { console.error(e.message); } }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function normalizeOrder(raw, source) {
  // العمولة الحقيقية لعمليات P2P = الفرق بين amount و takerAmount؛
  // لأن حقل commission في واجهة Binance يرجع «0» غالبًا للـ P2P.
  const amt = num(raw.amount);
  const takerAmt = num(raw.takerAmount);
  const feeFromDiff = (takerAmt > 0 && Math.abs(amt - takerAmt) < amt * 0.05) ? Math.abs(amt - takerAmt) : 0;
  const o = {
    orderNumber: String(raw.orderNumber || '').trim(),
    tradeType: String(raw.tradeType).toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    asset: String(raw.asset || 'USDT').trim() || 'USDT',
    fiat: String(raw.fiat || '').trim(),
    fiatSymbol: String(raw.fiatSymbol || raw.fiat || '').trim(),
    amount: amt,
    takerAmount: takerAmt,
    totalPrice: num(raw.totalPrice),
    unitPrice: num(raw.unitPrice),
    commission: Math.max(num(raw.commission), feeFromDiff),
    counterPart: String(raw.counterPartNickName || raw.counterPart || '').trim(),
    orderStatus: String(raw.orderStatus || 'COMPLETED').toUpperCase(),
    advertisementRole: String(raw.advertisementRole || ''),
    createTime: Number(raw.createTime) || Date.now(),
    note: String(raw.note || ''),
    reference: String(raw.reference || ''),
    source: source,
  };
  if (!o.orderNumber) o.orderNumber = 'M' + o.createTime + Math.floor(Math.random() * 1000);
  if (!o.unitPrice && o.amount > 0) o.unitPrice = o.totalPrice / o.amount;
  if (!o.totalPrice && o.amount > 0 && o.unitPrice > 0) o.totalPrice = o.amount * o.unitPrice;
  return o;
}

/** إدراج/تحديث طلب. يُرجع 'added' أو 'updated' أو 'same' */
function upsertOrder(o) {
  if (o.source === 'binance') fresh.add('orders__' + config.active + ':' + o.orderNumber);
  const prev = orders[o.orderNumber];
  if (!prev) { orders[o.orderNumber] = o; return 'added'; }
  // بيانات المنصة أوثق من الإدخال اليدوي، مع الحفاظ على الملاحظة والإشاري وتعديلات السعر/المبلغ (إدخال المستخدم)
  if (prev.note && !o.note) o.note = prev.note;
  if (prev.reference && !o.reference) o.reference = prev.reference;
  if (prev.unitPriceOverride != null) o.unitPriceOverride = prev.unitPriceOverride;
  if (prev.totalPriceOverride != null) o.totalPriceOverride = prev.totalPriceOverride;
  if (prev.networkLabelOverride != null) o.networkLabelOverride = prev.networkLabelOverride;
  if (prev.zeroPoint) o.zeroPoint = true;
  if (prev.archived) o.archived = true; // الإخفاء من الجدول قرارُ صاحب الدفتر
  if (prev.balanceAt != null) o.balanceAt = prev.balanceAt; // مرساة المستخدم اليدوية
  if (prev.balAfter != null) o.balAfter = prev.balAfter; // الباقي المثبَّت لا تمحوه مزامنة
  if (prev.source === 'binance' && o.source === 'manual') return 'same';
  const changed = JSON.stringify(prev) !== JSON.stringify(o);
  orders[o.orderNumber] = o;
  return changed ? 'updated' : 'same';
}

/* ===================== حوالات الإيداع والسحب ===================== */

/** نوافذ زمنية بطول win تغطّي المدى [minStart, now] */
function makeWindows(now, minStart, win) {
  const windows = [];
  for (let end = now; end > minStart; end -= win) {
    windows.push([Math.max(end - win + 1, minStart), end]);
  }
  return windows;
}

/** المنصة تُرجع وقت السحب نصًّا بتوقيت UTC: "YYYY-MM-DD HH:MM:SS" */
function parseUTC(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

// إيداع: 0 قيد الانتظار، 1 ناجح، 6 مُضاف لا يُسحب، 7 خطأ، 8 بانتظار التأكيد
function depositStatusNorm(code) {
  if (code === 1) return 'COMPLETED';
  if (code === 7) return 'FAILED';
  return 'PENDING';
}
// سحب: 0 إرسال بريد، 1 ملغى، 2 بانتظار الموافقة، 3 مرفوض، 4 قيد المعالجة، 5 فشل، 6 مكتمل
function withdrawStatusNorm(code) {
  if (code === 6) return 'COMPLETED';
  if (code === 1) return 'CANCELLED';
  if (code === 3 || code === 5) return 'FAILED';
  return 'PENDING';
}

/** توحيد سجل الإيداع/السحب في شكل واحد */
function normalizeTransfer(raw, kind) {
  if (kind === 'deposit') {
    const code = Number(raw.status);
    return {
      id: 'D' + String(raw.id || raw.txId || ('' + (raw.insertTime || '') + (raw.amount || ''))),
      kind: 'deposit',
      coin: String(raw.coin || 'USDT').trim() || 'USDT',
      network: String(raw.network || '').trim(),
      amount: num(raw.amount),
      fee: 0,
      status: depositStatusNorm(code),
      statusCode: Number.isFinite(code) ? code : null,
      address: String(raw.address || ''),
      txId: String(raw.txId || ''),
      time: Number(raw.insertTime) || Date.now(),
      completeTime: Number(raw.completeTime) || 0,
      walletType: raw.walletType,
      note: String(raw.note || ''),
      reference: String(raw.reference || ''),
      source: 'binance',
    };
  }
  const code = Number(raw.status);
  return {
    id: 'W' + String(raw.id || raw.txId || ''),
    kind: 'withdraw',
    coin: String(raw.coin || 'USDT').trim() || 'USDT',
    network: String(raw.network || '').trim(),
    amount: num(raw.amount),
    fee: num(raw.transactionFee),
    status: withdrawStatusNorm(code),
    statusCode: Number.isFinite(code) ? code : null,
    address: String(raw.address || ''),
    txId: String(raw.txId || ''),
    time: parseUTC(raw.applyTime),
    completeTime: raw.completeTime ? parseUTC(raw.completeTime) : 0,
    walletType: raw.walletType,
    note: String(raw.note || ''),
    reference: String(raw.reference || ''),
    source: 'binance',
  };
}

/* ===================== عمليات Binance Pay (إرسال/استلام) ===================== */

// نوع المحفظة في Binance Pay: 1 تمويل، 2 فوري، 3 ورقية، 4/6 بطاقة، 5 Earn
// (ترقيم مختلف عن الإيداع/السحب، لذا نحفظ الاسم جاهزًا)
const PAY_WALLET_AR = {
  1: 'محفظة التمويل (Funding)', 2: 'الحساب الفوري (Spot)', 3: 'محفظة العملة الورقية (Fiat)',
  4: 'بطاقة الدفع', 5: 'محفظة Earn', 6: 'بطاقة الدفع',
};

/** توحيد عملية Binance Pay في نفس شكل الحوالة.
 *  المبلغ الموجب = استلام (دخل)، والسالب = إرسال (مصروف). */
function normalizePay(raw) {
  const amt = num(raw.amount);
  const isOut = amt < 0;
  const payer = raw.payerInfo || {};
  const receiver = raw.receiverInfo || {};
  // الطرف الآخر: عند الإرسال هو المستلِم، وعند الاستلام هو المُرسِل
  const other = isOut ? receiver : payer;
  const otherName = String(other.name || other.binanceId || other.accountId || '').trim();
  const tid = String(raw.transactionId || '').trim();
  const wt = Number(raw.walletType);
  return {
    id: 'PAY' + (tid || (raw.transactionTime || '') + '' + raw.amount),
    kind: isOut ? 'pay-out' : 'pay-in',
    coin: String(raw.currency || 'USDT').trim() || 'USDT',
    network: '',
    amount: Math.abs(amt),
    fee: 0,
    status: 'COMPLETED', // النقطة تُرجع العمليات المكتملة فقط
    statusCode: null,
    address: '',
    txId: tid,
    counterPart: otherName,
    orderType: String(raw.orderType || '').trim(),
    time: Number(raw.transactionTime) || Date.now(),
    completeTime: Number(raw.transactionTime) || 0,
    walletType: Number.isFinite(wt) ? wt : null,
    walletName: PAY_WALLET_AR[wt] || '',
    note: '',
    reference: '',
    source: 'binance',
  };
}

/* ============ تداول السوق الفوري (Spot) — شراء/بيع عملة مقابل USDT ============
 * آخر ما بقي من حركة محفظة الفوري غير المجلوبة. نتتبّع جانب الـ USDT فقط:
 * شراء عملة = صرف USDT، وبيعها = دخل USDT. */
function normalizeSpotTrade(raw, symbol) {
  const base = String(symbol).replace(/USDT$/i, '').toUpperCase();
  const isBuy = !!raw.isBuyer; // شراء العملة الأساسية يعني صرف USDT
  const quote = num(raw.quoteQty); // قيمة الصفقة بالـ USDT
  const t = Number(raw.time) || Date.now();
  return {
    id: 'SPT' + String(symbol).toUpperCase() + '-' + String(raw.id),
    kind: isBuy ? 'spot-buy' : 'spot-sell',
    coin: 'USDT',
    network: base, // العملة المقابلة تظهر في عمود العملة/الشبكة
    amount: quote,
    // العمولة لا تُخصم إلا إن كانت بالـ USDT نفسه
    fee: String(raw.commissionAsset || '').toUpperCase() === 'USDT' ? num(raw.commission) : 0,
    status: 'COMPLETED', // النقطة تُرجع الصفقات المنفَّذة فقط
    statusCode: null,
    address: '',
    txId: String(raw.orderId || raw.id || ''),
    counterPart: '',
    symbol: String(symbol).toUpperCase(),
    baseQty: num(raw.qty),
    unitPrice: num(raw.price),
    time: t,
    completeTime: t,
    note: '',
    reference: '',
    source: 'binance',
  };
}

/* ===================== عمليات التحويل (Convert) ===================== */

/** توحيد عملية تحويل عملة (مثل USDT → TRX) في شكل الحوالة.
 *  نتتبّع جانب الـ USDT: إن كان USDT مصدرًا فهو مصروف (convert-out)،
 *  وإن كان وجهةً فهو دخل (convert-in). المبلغ المحفوظ هو قيمة الـ USDT. */
function normalizeConvert(raw) {
  const from = String(raw.fromAsset || '').trim().toUpperCase();
  const to = String(raw.toAsset || '').trim().toUpperCase();
  const fromAmt = num(raw.fromAmount);
  const toAmt = num(raw.toAmount);
  const usdtIsFrom = from === 'USDT';
  const usdtIsTo = to === 'USDT';
  const t = Number(raw.createTime) || Date.now();
  const other = usdtIsFrom ? to : from; // العملة المقابلة للـ USDT (تظهر في عمود الشبكة)
  return {
    id: 'CVT' + String(raw.orderId || raw.quoteId || (t + '' + fromAmt)),
    kind: usdtIsTo ? 'convert-in' : 'convert-out',
    coin: (usdtIsFrom || usdtIsTo) ? 'USDT' : from,
    network: (usdtIsFrom || usdtIsTo) ? other : to,
    amount: usdtIsTo ? toAmt : fromAmt, // قيمة الـ USDT (أو المصدر إن لم يكن أيّهما USDT)
    fee: 0,
    status: String(raw.orderStatus || '') === 'SUCCESS' ? 'COMPLETED' : 'PENDING',
    statusCode: null,
    address: '',
    txId: String(raw.orderId || ''),
    counterPart: '',
    fromAsset: from,
    fromAmount: fromAmt,
    toAsset: to,
    toAmount: toAmt,
    time: t,
    completeTime: t,
    note: '',
    reference: '',
    source: 'binance',
  };
}

/** إدراج/تحديث حوالة. يُرجع 'added' أو 'updated' أو 'same'.
 *  map: مخزنُ حسابٍ بعينه؛ وبدونه مخزنُ الحساب النشط. */
function upsertTransfer(t, map = transfers) {
  if (!t.id || t.id === 'D' || t.id === 'W') return 'same';
  if (t.source === 'binance') fresh.add((storeKeyOf.get(map) || ('transfers__' + config.active)) + ':' + t.id);
  const has = Object.prototype.hasOwnProperty.call(map, t.id);
  const prev = has ? map[t.id] : null;
  if (!prev) { map[t.id] = t; return 'added'; }
  // الحفاظ على إدخال المستخدم (الملاحظة والإشاري وتعديلات السعر/المبلغ) عند إعادة المزامنة
  if (prev.note && !t.note) t.note = prev.note;
  if (prev.reference && !t.reference) t.reference = prev.reference;
  if (prev.unitPriceOverride != null) t.unitPriceOverride = prev.unitPriceOverride;
  if (prev.totalPriceOverride != null) t.totalPriceOverride = prev.totalPriceOverride;
  if (prev.networkLabelOverride != null) t.networkLabelOverride = prev.networkLabelOverride;
  if (prev.zeroPoint) t.zeroPoint = true;
  if (prev.archived) t.archived = true; // الإخفاء من الجدول قرارُ صاحب الدفتر
  if (prev.usdtValue != null) t.usdtValue = prev.usdtValue; // تقويمُ عمليةٍ بعملة أخرى
  if (prev.balanceAt != null) t.balanceAt = prev.balanceAt; // مرساة المستخدم اليدوية
  if (prev.balAfter != null) t.balAfter = prev.balAfter; // الباقي المثبَّت لا تمحوه مزامنة
  const changed = JSON.stringify(prev) !== JSON.stringify(t);
  map[t.id] = t;
  return changed ? 'updated' : 'same';
}

/* ============================ عميل Binance ============================ */

function userError(message) { const e = new Error(message); e.isUser = true; return e; }

async function timeOffset(base) {
  let r;
  try {
    r = await fetch(base + '/api/v3/time', { signal: AbortSignal.timeout(15000) });
  } catch {
    throw userError('تعذّر الاتصال بالمنصة — تحقّق من الإنترنت، أو جرّب تغيير عنوان الخادم من الإعدادات');
  }
  if (r.status === 451 || r.status === 403) {
    throw userError('الوصول إلى المنصة محجوب من هذه المنطقة (HTTP ' + r.status + ') — جرّب VPN أو غيّر عنوان الخادم من الإعدادات');
  }
  if (r.status === 429 || r.status === 418) {
    throw userError('المنصة حظرت الطلبات مؤقتًا بسبب كثرتها (HTTP ' + r.status + ') — أوقف المزامنة وانتظر ٣٠ دقيقة على الأقل قبل إعادة المحاولة، ولا تكرّر الضغط فالتكرار يُطيل الحظر');
  }
  if (!r.ok) throw userError('استجابة غير متوقعة من المنصة (HTTP ' + r.status + ')');
  const j = await r.json();
  return Number(j.serverTime) - Date.now();
}

/** acct: حسابٌ بعينه بمفاتيحه (إعادةُ الحوالات إلى أصحابها تسأل الحسابين معًا)؛
 *  وبدونه الحسابُ النشط كالمعتاد. */
async function signedGet(base, endpoint, params, offset, method = 'GET', acct = null) {
  const ac = acct || AC();
  const qs = new URLSearchParams({});
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set('recvWindow', '30000');
  qs.set('timestamp', String(Date.now() + offset));
  const signature = crypto.createHmac('sha256', ac.apiSecret).update(qs.toString()).digest('hex');
  const url = base + endpoint + '?' + qs.toString() + '&signature=' + signature;

  let r;
  try {
    r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': ac.apiKey }, signal: AbortSignal.timeout(30000) });
  } catch {
    throw userError('انقطع الاتصال أثناء الجلب — أعد المحاولة');
  }
  /* المنصة تُخبرنا في كل ردٍّ بما استهلكناه من حدّ الدقيقة. قراءتُه تُغني عن
     التخمين: نتمهّل قبل بلوغ الحدّ بدل أن نصطدم به فنُحظر (انظر coolIfHeavy). */
  const uw = Number(r.headers.get('x-sapi-used-uid-weight-1m'));
  if (Number.isFinite(uw) && uw > 0) lastUidWeight = uw;
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    const code = j && typeof j.code === 'number' ? j.code : null;
    if (code === -2014 || code === -2015) throw userError('المنصة رفضت مفتاح API — تأكّد من صحة المفتاح ومن تفعيل صلاحية «إتاحة القراءة»');
    if (code === -1022) throw userError('التوقيع غير صحيح — تأكّد من المفتاح السري (Secret Key)');
    if (code === -1021) throw userError('فرق توقيت بين جهازك والمنصة — أعد المحاولة، وإن تكرر اضبط ساعة الجهاز');
    if (r.status === 429 || r.status === 418) throw userError('المنصة حظرت الطلبات مؤقتًا بسبب كثرتها (HTTP ' + r.status + ') — أوقف المزامنة وانتظر ٣٠ دقيقة على الأقل، ولا تكرّر الضغط فالتكرار يُطيل الحظر');
    if (r.status === 451 || r.status === 403) throw userError('الوصول محجوب من هذه المنطقة — جرّب VPN أو غيّر عنوان الخادم من الإعدادات');
    throw userError('خطأ من المنصة: ' + (j && (j.msg || j.message) ? (j.msg || j.message) : 'HTTP ' + r.status));
  }
  if (j && j.success === false) throw userError('خطأ من المنصة: ' + (j.message || j.code || 'غير معروف'));
  return j || {};
}

const dayLabel = (ms) => new Date(ms).toISOString().slice(0, 10);

/* حدُّ نقطة Binance Pay: ١٠٠ سجلًّا للطلب بلا ترقيم صفحات، فالشطرُ الزمني هو
   الوسيلة الوحيدة لتجاوزه. والسقفُ يمنع نافذةً مزدحمة من إطالة المزامنة بلا نهاية. */
const PAY_PAGE = 100;
/* حدُّ الوزن على حساب المستخدم ١٨٠٠٠٠ في الدقيقة لكل نقطة، ووزنُ نقطة Pay ٣٠٠٠
 * — أي ستون طلبًا في الدقيقة سقفًا مطلقًا. كان الفاصل ثانيةً واحدة (ستون
 * بالضبط) وفي «اجلب يومًا» نصفَ ثانية (ضعف الحدّ)، فكان كل تجاوزٍ يُنتج 429 ثم
 * حظرًا 418 على العنوان — ولهذا كانت كل نسخةٍ جديدة تُحظر فور أول مزامنة، مهما
 * تبدّلت المنطقة. نمشي الآن على ثلث الحدّ، ونتمهّل إن اقتربت ترويسةُ الوزن منه.
 */
const PAY_WEIGHT = 3000;
const UID_LIMIT = 180000;
const PAY_GAP_MS = 3000;     // عشرون طلبًا في الدقيقة — ثلث الحدّ
const PAY_MAX_CALLS = 24;    // ٧٢٠٠٠ وزنًا سقفًا، دون نصف الحدّ
let lastUidWeight = 0;       // آخر ما أبلغت به المنصة من استهلاك الدقيقة

/** تمهّلٌ قبل بلوغ حدّ الدقيقة: ندع الدقيقة تدور بدل أن نصطدم بالحدّ */
async function coolIfHeavy(cost) {
  if (lastUidWeight && lastUidWeight + cost > UID_LIMIT * 0.6) {
    await sleep(25000);
    lastUidWeight = 0;
  }
}

/**
 * مزامنة شاملة: طلبات P2P (بيع/شراء) + سجل الإيداع + سجل السحب، على نوافذ زمنية،
 * وتبثّ تقدّم العملية سطرًا-بسطر (NDJSON). أي بيانات جُلبت تُحفظ حتى لو فشلت
 * المزامنة في منتصفها (بفضل كتلة finally) فلا يضيع ما نزل.
 */
async function* syncGenerator() {
  await refreshActive();   // قد تكون نسخةٌ أخرى بدّلت الحساب
  if (!AC().apiKey || !AC().apiSecret) {
    throw userError('لم يتم حفظ مفتاح API بعد — افتح الإعدادات وأدخل المفتاحين أولًا');
  }
  const base = (AC().baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
  yield { msg: 'جارٍ الاتصال بالمنصة والتحقق من التوقيت…', pct: 1 };
  // دمج ما كتبه السستم الآخر (على نفس القاعدة) قبل الجلب، حتى لا نمحوه عند الحفظ
  await mergeFromStore('orders__' + config.active, orders);
  await mergeFromStore('transfers__' + config.active, transfers);
  const offset = await timeOffset(base);

  const now = Date.now();
  const rangeHours = Math.min(Math.max(Number(AC().rangeHours) || 720, 1), 26280); // من ساعة إلى 3 سنوات
  const minStart = now - rangeHours * 3600000;
  const p2pWindows = makeWindows(now, minStart, 29 * 86400000); // C2C: أقصى نافذة 30 يومًا
  const txWindows = makeWindows(now, minStart, 89 * 86400000);  // الإيداع/السحب: أقصى نافذة 90 يومًا
  const convertWindows = makeWindows(now, minStart, 29 * 86400000); // Convert: أقصى نافذة 30 يومًا

  let added = 0, updated = 0, fetched = 0;
  let depAdded = 0, wdAdded = 0, payAdded = 0, cvtAdded = 0, sptAdded = 0, txUpdated = 0;
  let step = 0;
  const totalSteps = p2pWindows.length * 2 + txWindows.length * 3 + convertWindows.length + 4;
  const prog = (msg) => { step++; return { msg, pct: Math.min(1 + Math.round((step / totalSteps) * 96), 97) }; };

  const result = { done: true };
  try {
    /* ---- طلبات P2P (بيع ثم شراء) ---- */
    for (const tradeType of ['SELL', 'BUY']) {
      const label = tradeType === 'SELL' ? 'مبيعات' : 'مشتريات';
      for (const [s, e] of p2pWindows) {
        yield prog(`جلب ${label} P2P: ${dayLabel(s)} ← ${dayLabel(e)}`);
        let page = 1;
        for (;;) {
          const j = await signedGet(base, '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
            { tradeType, startTimestamp: s, endTimestamp: e, page, rows: 100 }, offset);
          const rows = Array.isArray(j.data) ? j.data : [];
          for (const raw of rows) {
            const r = upsertOrder(normalizeOrder(raw, 'binance'));
            if (r === 'added') added++;
            else if (r === 'updated') updated++;
          }
          fetched += rows.length;
          if (rows.length < 100 || page >= 60) break;
          page++;
          await sleep(250);
        }
        await sleep(200);
      }
    }

    /* ---- سجل الإيداع ---- */
    for (const [s, e] of txWindows) {
      yield prog(`جلب الإيداعات: ${dayLabel(s)} ← ${dayLabel(e)}`);
      let off = 0;
      for (;;) {
        const arr = await signedGet(base, '/sapi/v1/capital/deposit/hisrec',
          { startTime: s, endTime: e, offset: off, limit: 1000 }, offset);
        const rows = Array.isArray(arr) ? arr : [];
        for (const raw of rows) {
          const r = upsertTransfer(normalizeTransfer(raw, 'deposit'));
          if (r === 'added') depAdded++;
          else if (r === 'updated') txUpdated++;
        }
        if (rows.length < 1000) break;
        off += 1000;
        await sleep(300);
      }
      await sleep(300);
    }

    /* ---- سجل السحب ---- */
    for (const [s, e] of txWindows) {
      yield prog(`جلب عمليات السحب: ${dayLabel(s)} ← ${dayLabel(e)}`);
      let off = 0;
      for (;;) {
        const arr = await signedGet(base, '/sapi/v1/capital/withdraw/history',
          { startTime: s, endTime: e, offset: off, limit: 1000 }, offset);
        await coolIfHeavy(18000); // وزن سجل السحب ١٨٠٠٠: عشرة طلبات في الدقيقة
        const rows = Array.isArray(arr) ? arr : [];
        for (const raw of rows) {
          const r = upsertTransfer(normalizeTransfer(raw, 'withdraw'));
          if (r === 'added') wdAdded++;
          else if (r === 'updated') txUpdated++;
        }
        if (rows.length < 1000) break;
        off += 1000;
        await sleep(400);
      }
      await sleep(400);
    }

    /* ---- عمليات Binance Pay (إرسال/استلام) ----
       نقطة /sapi/v1/pay/transactions: الحد الأقصى للفترة 90 يومًا، وأقصى 100 سجل
       لكل طلب ولا ترقيم صفحات لها، ووزنها على حساب المستخدم (UID) 3000 وهو ضمن الحد.
       نغلّفها بـ try/catch حتى لا يوقف فشلُها (صلاحية/منطقة) بقيةَ المزامنة. */
    try {
      for (const [ws, we] of txWindows) {
        yield prog(`جلب عمليات Binance Pay: ${dayLabel(ws)} ← ${dayLabel(we)}`);
        /* نافذةٌ عادت ممتلئة (١٠٠ سجلًّا) معناها أن ما زاد سقط صامتًا — ولا
           ترقيم صفحات نطلب به البقية. وسقوطُ عملية دخلٍ واحدة يجعل عمود
           «الباقي من USDT» ينزل تحت الصفر بلا سببٍ ظاهر، فتضيع أرقام ما بعدها.
           لذلك نشطر النافذة الممتلئة نصفين ونعيد السؤال، حتى تعود ناقصةً
           فنعلم يقينًا أننا استوعبنا كل ما فيها. */
        const parts = [[ws, we]];
        let calls = 0;
        while (parts.length && calls < PAY_MAX_CALLS) {
          const [s, e] = parts.pop();
          calls++;
          const j = await signedGet(base, '/sapi/v1/pay/transactions',
            { startTime: s, endTime: e, limit: PAY_PAGE }, offset);
          const rows = Array.isArray(j.data) ? j.data : [];
          for (const raw of rows) {
            const r = upsertTransfer(normalizePay(raw));
            if (r === 'added') payAdded++;
            else if (r === 'updated') txUpdated++;
          }
          // نافذة دقيقة واحدة لا تُشطر أكثر — لو امتلأت فالسقوط أصغر من أن نلاحقه
          if (rows.length >= PAY_PAGE && e - s > 60000) {
            const mid = Math.floor((s + e) / 2);
            parts.push([mid + 1, e], [s, mid]);
            yield prog(`تكثيف Binance Pay (${dayLabel(s)} ← ${dayLabel(e)}): السجل ممتلئ، نشطر الفترة`);
          }
          await sleep(PAY_GAP_MS);
          await coolIfHeavy(PAY_WEIGHT);
        }
        if (parts.length) {
          yield { msg: '⚠ عمليات Binance Pay كثيرة جدًّا في هذه الفترة — جُلب أقصى ما يسمح به الحد، وقد تبقى عمليات لم تصل.', pct: 97 };
        }
      }
    } catch (err) {
      // فشل غير قاتل — نُبلّغ المستخدم ونكمل بما جُلب
      yield { msg: 'تعذّر جلب عمليات Binance Pay (تم تخطّيها): ' + (err && err.message ? err.message : 'خطأ'), pct: 97 };
    }

    /* ---- سجل التحويل (Convert: مثل USDT → TRX) ----
       نقطة /sapi/v1/convert/tradeFlow: أقصى نافذة 30 يومًا، حتى 1000 سجل،
       ووزنها على حساب المستخدم (UID) ضمن الحد. نغلّفها بـ try/catch حتى
       لا يوقف فشلُها بقيةَ المزامنة. */
    try {
      for (const [s, e] of convertWindows) {
        yield prog(`جلب سجل التحويل (Convert): ${dayLabel(s)} ← ${dayLabel(e)}`);
        const j = await signedGet(base, '/sapi/v1/convert/tradeFlow',
          { startTime: s, endTime: e, limit: 1000 }, offset);
        const rows = Array.isArray(j.list) ? j.list : [];
        for (const raw of rows) {
          const r = upsertTransfer(normalizeConvert(raw));
          if (r === 'added') cvtAdded++;
          else if (r === 'updated') txUpdated++;
        }
        await sleep(1000);
      }
    } catch (err) {
      yield { msg: 'تعذّر جلب سجل التحويل Convert (تم تخطّيها): ' + (err && err.message ? err.message : 'خطأ'), pct: 97 };
    }

    /* ---- تداول السوق الفوري (Spot) ----
       /api/v3/myTrades تلزمها «symbol»، ومداها الزمني محدود بـ٢٤ ساعة؛ لكن
       بدون تحديد وقت تُرجع أحدث ١٠٠٠ صفقة دفعةً واحدة — طلبٌ واحد لكل زوج.
       الأزواج تُستنتج من العملات التي مرّت فعلًا على الحساب (بلا تخمين واسع). */
    try {
      const bases = new Set();
      for (const t of Object.values(transfers)) {
        for (const a of [t.coin, t.network, t.fromAsset, t.toAsset]) {
          const s = String(a || '').trim().toUpperCase();
          if (s && s !== 'USDT' && /^[A-Z0-9]{2,10}$/.test(s)) bases.add(s);
        }
      }
      const symbols = [...bases].slice(0, 8).map((b) => b + 'USDT');
      for (const symbol of symbols) {
        yield prog(`جلب تداول السوق الفوري: ${symbol}`);
        try {
          const arr = await signedGet(base, '/api/v3/myTrades', { symbol, limit: 1000 }, offset);
          for (const raw of (Array.isArray(arr) ? arr : [])) {
            const r = upsertTransfer(normalizeSpotTrade(raw, symbol));
            if (r === 'added') sptAdded++;
            else if (r === 'updated') txUpdated++;
          }
        } catch (e) {
          // زوج غير موجود أو بلا صلاحية — نتخطّاه ونكمل البقية
          if (!/-1121|Invalid symbol/i.test(e.message || '')) throw e;
        }
        await sleep(400);
      }
    } catch (err) {
      yield { msg: 'تعذّر جلب تداول السوق الفوري (تم تخطّيه): ' + (err && err.message ? err.message : 'خطأ'), pct: 97 };
    }

    AC().lastSync = Date.now();
    Object.assign(result, {
      added, updated, fetched, depAdded, wdAdded, payAdded, cvtAdded, sptAdded, txUpdated,
      total: Object.keys(orders).length,
      totalTx: Object.keys(transfers).length,
      lastSync: AC().lastSync,
    });
  } finally {
    // نحفظ ما جُلب حتى الآن مهما حدث (نجاح كامل أو فشل جزئي)
    await saveOrders();
    await saveTransfers();
    await saveConfig();
  }
  yield result;
}

/* ===== إعادة كل حوالة إلى حسابها الصحيح =====
   تسرّبت حوالاتٌ بين الحسابين (مزامنةٌ حُفظت تحت الحساب الخطأ قبل إصلاح السباق)
   فصارت الواحدة في المخزنين وتُحسب مرّتين. البرنامج لا يملك أن يحزر صاحبها،
   لكن المنصة تملك: مفتاحُ كل حساب لا يُرجع إلا حوالاته. فنسأل كلَّ حساب عن
   الفترة التي تقع فيها الحوالات المشتركة، ونُبقي كل حوالة حيث أرجعتها المنصة
   ونحذف نسختها من الحساب الآخر. ما أرجعه الحسابان معًا يبقى فيهما (Pay بين
   حسابيك: معرّفٌ واحد للمُرسِل والمستلِم)، وما لم يُرجعه أحدٌ يُترك كما هو
   ويُذكر في التقرير — لا نحذف على الظنّ. */
const TX_GROUP = {
  deposit: 'deposit', withdraw: 'withdraw', 'pay-in': 'pay', 'pay-out': 'pay',
  'convert-in': 'convert', 'convert-out': 'convert', 'spot-buy': 'spot', 'spot-sell': 'spot',
};
const RECON_PAD_MS = 86400000; // يومٌ قبل أقدم حوالة وبعد أحدثها

async function* reconcileGenerator() {
  await refreshActive();
  const active = config.active;
  const other = ACCOUNTS.find((a) => a !== active) || 'p2p';
  yield { msg: 'جارٍ قراءة الحسابين…', pct: 1 };

  /* المخزنان طازجَين: النشط من الذاكرة بعد دمج ما كتبته نسخةٌ أخرى، والآخر من
     القاعدة. نمسك المخزنين بمتغيّرين محلّيين ونحفظهما بمفتاحيهما الصريحين، لا عبر
     «الحساب النشط»: نسخةٌ أخرى قد تبدّله أثناء الجلب فيذهب الحفظ إلى غير مخزنه. */
  const mem = transfers, ordMem = orders;
  await mergeFromStore('transfers__' + active, mem);
  let far = await loadStore('transfers__' + other, null);
  if (far == null && other === 'p2p') far = await loadStore('transfers', null);
  far = far || {};
  await applyGrave('transfers__' + other, far);
  storeKeyOf.set(mem, 'transfers__' + active);
  storeKeyOf.set(far, 'transfers__' + other);
  const stores = { [active]: mem, [other]: far };
  const touched = { p2p: false, p3p: false }; // حسابٌ تغيّرت حوالاته المحسوبة
  const deleted = { p2p: new Set(), p3p: new Set() };

  /* أداةُ الأرشفة السابقة أُلغيت: ما أرشفته يعود أولًا، فنعمل على الحال الأصلية */
  const restored = { p2p: 0, p3p: 0 };
  for (const a of ACCOUNTS) {
    const last = (await loadStore('dupesundo__' + a, null)) || {};
    for (const id of (Array.isArray(last.ids) ? last.ids : [])) {
      const t = stores[a][id];
      if (t && t.archived) { delete t.archived; restored[a]++; touched[a] = true; touch('transfers__' + a, id); }
    }
  }

  // ما ثبت من قبلُ أنه للحسابين معًا لا يُسأل عنه ثانيةً
  let sharedOk = [];
  try { const s = await loadStore('sharedtx', null); if (Array.isArray(s)) sharedOk = s; } catch {}
  const okSet = new Set(sharedOk);
  const ids = Object.keys(stores.p2p).filter((id) => stores.p3p[id] && !okSet.has(id));
  const report = {
    done: true, dupes: ids.length, moved: { p2p: 0, p3p: 0 }, shared: 0, unresolved: 0,
    byKind: { p2p: {}, p3p: {}, shared: {}, unresolved: {} }, reasons: {}, noKeys: [],
    restored, sample: [],
  };
  const bump = (bag, k) => { bag[k] = (bag[k] || 0) + 1; };

  // نطاقُ كل مجموعة من الحوالات المشتركة نفسها — لا نجلب أكثر مما يلزم
  const span = {};
  const spotSymbols = new Set();
  for (const id of ids) {
    const t = stores.p2p[id];
    const g = TX_GROUP[t.kind];
    if (!g) continue;
    const s = span[g] || (span[g] = { min: Infinity, max: -Infinity });
    s.min = Math.min(s.min, t.time || 0);
    s.max = Math.max(s.max, t.time || 0);
    if (g === 'spot' && t.symbol) spotSymbols.add(String(t.symbol).toUpperCase());
  }
  const found = { p2p: new Map(), p3p: new Map() };
  const complete = { p2p: {}, p3p: {} };
  const wins = (g, win) => span[g] ? makeWindows(span[g].max + RECON_PAD_MS, span[g].min - RECON_PAD_MS, win) : [];
  const DAY89 = 89 * 86400000, DAY29 = 29 * 86400000;
  const plan = {
    deposit: wins('deposit', DAY89), withdraw: wins('withdraw', DAY89),
    pay: wins('pay', DAY89), convert: wins('convert', DAY29),
    spot: span.spot ? [...spotSymbols] : [],
  };
  const perAcct = Object.values(plan).reduce((n, w) => n + w.length, 0);
  const totalSteps = Math.max(perAcct * ACCOUNTS.length, 1);
  let step = 0;
  const prog = (msg) => { step++; return { msg, pct: Math.min(2 + Math.round((step / totalSteps) * 94), 97) }; };
  // ما لا فائدة من المضيّ بعده: حظرٌ (والتكرار يُطيله)، أو مفتاحٌ مرفوض، أو منطقةٌ محجوبة
  const fatal = (e) => /HTTP 4(18|29)|حظر|محجوب|مفتاح API|التوقيع/.test(e && e.message || '');

  try {
    if (ids.length) {
      for (const a of ACCOUNTS) {
        const ac = await accountKeysFor(a);
        const name = ACCOUNT_NAMES[a];
        if (!ac || !ac.apiKey || !ac.apiSecret) {
          report.noKeys.push(a);
          yield { msg: `⚠ «${name}» بلا مفتاح API — لن يُسأل عن حوالاته`, pct: null };
          step += perAcct;
          continue;
        }
        const base = (ac.baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
        yield { msg: `جارٍ الاتصال بالمنصة بمفتاح «${name}»…`, pct: null };
        const offset = await timeOffset(base);
        const F = found[a];
        const done = complete[a];

        /* ---- الإيداع ---- */
        try {
          for (const [s, e] of plan.deposit) {
            yield prog(`«${name}»: الإيداعات ${dayLabel(s)} ← ${dayLabel(e)}`);
            let off = 0;
            for (;;) {
              const arr = await signedGet(base, '/sapi/v1/capital/deposit/hisrec',
                { startTime: s, endTime: e, offset: off, limit: 1000 }, offset, 'GET', ac);
              const rows = Array.isArray(arr) ? arr : [];
              for (const raw of rows) { const t = normalizeTransfer(raw, 'deposit'); F.set(t.id, t); }
              if (rows.length < 1000) break;
              off += 1000;
              await sleep(300);
            }
            await sleep(300);
          }
          done.deposit = true;
        } catch (e) { if (fatal(e)) throw e; yield { msg: `⚠ «${name}»: تعذّر جلب الإيداعات — ${e.message}`, pct: null }; }

        /* ---- السحب ---- */
        try {
          for (const [s, e] of plan.withdraw) {
            yield prog(`«${name}»: السحوبات ${dayLabel(s)} ← ${dayLabel(e)}`);
            let off = 0;
            for (;;) {
              const arr = await signedGet(base, '/sapi/v1/capital/withdraw/history',
                { startTime: s, endTime: e, offset: off, limit: 1000 }, offset, 'GET', ac);
              await coolIfHeavy(18000);
              const rows = Array.isArray(arr) ? arr : [];
              for (const raw of rows) { const t = normalizeTransfer(raw, 'withdraw'); F.set(t.id, t); }
              if (rows.length < 1000) break;
              off += 1000;
              await sleep(400);
            }
            await sleep(400);
          }
          done.withdraw = true;
        } catch (e) { if (fatal(e)) throw e; yield { msg: `⚠ «${name}»: تعذّر جلب السحوبات — ${e.message}`, pct: null }; }

        /* ---- Binance Pay: مئةٌ للطلب بلا ترقيم، فالنافذة الممتلئة تُشطر ---- */
        try {
          let capped = false;
          for (const [ws, we] of plan.pay) {
            yield prog(`«${name}»: Binance Pay ${dayLabel(ws)} ← ${dayLabel(we)}`);
            const parts = [[ws, we]];
            let calls = 0;
            while (parts.length && calls < PAY_MAX_CALLS) {
              const [s, e] = parts.pop();
              calls++;
              const j = await signedGet(base, '/sapi/v1/pay/transactions',
                { startTime: s, endTime: e, limit: PAY_PAGE }, offset, 'GET', ac);
              const rows = Array.isArray(j.data) ? j.data : [];
              for (const raw of rows) { const t = normalizePay(raw); F.set(t.id, t); }
              if (rows.length >= PAY_PAGE && e - s > 60000) {
                const mid = Math.floor((s + e) / 2);
                parts.push([mid + 1, e], [s, mid]);
              }
              await sleep(PAY_GAP_MS);
              await coolIfHeavy(PAY_WEIGHT);
            }
            if (parts.length) capped = true;
          }
          done.pay = !capped;
          if (capped) yield { msg: `⚠ «${name}»: عمليات Pay أكثر مما يسمح به الحدّ في مرّة — ما لم يصل يُترك كما هو`, pct: null };
        } catch (e) { if (fatal(e)) throw e; yield { msg: `⚠ «${name}»: تعذّر جلب Binance Pay — ${e.message}`, pct: null }; }

        /* ---- التحويل Convert ---- */
        try {
          for (const [s, e] of plan.convert) {
            yield prog(`«${name}»: التحويل Convert ${dayLabel(s)} ← ${dayLabel(e)}`);
            const j = await signedGet(base, '/sapi/v1/convert/tradeFlow',
              { startTime: s, endTime: e, limit: 1000 }, offset, 'GET', ac);
            for (const raw of (Array.isArray(j.list) ? j.list : [])) { const t = normalizeConvert(raw); F.set(t.id, t); }
            await sleep(1000);
          }
          done.convert = true;
        } catch (e) { if (fatal(e)) throw e; yield { msg: `⚠ «${name}»: تعذّر جلب التحويل — ${e.message}`, pct: null }; }

        /* ---- السوق الفوري: أحدث ألف صفقة لكل زوج ---- */
        for (const symbol of plan.spot) {
          yield prog(`«${name}»: السوق الفوري ${symbol}`);
          try {
            const arr = await signedGet(base, '/api/v3/myTrades', { symbol, limit: 1000 }, offset, 'GET', ac);
            for (const raw of (Array.isArray(arr) ? arr : [])) { const t = normalizeSpotTrade(raw, symbol); F.set(t.id, t); }
          } catch (e) { if (fatal(e)) throw e; }
          await sleep(400);
        }
      }

      /* ---- الحكم: حوالةً حوالة ---- */
      yield { msg: 'جارٍ إعادة كل حوالة إلى حسابها…', pct: 98 };
      const CARRY = ['note', 'reference', 'unitPriceOverride', 'totalPriceOverride', 'networkLabelOverride', 'usdtValue'];
      const sharedIds = [];
      const settle = (id, owner) => {
        const loser = owner === 'p2p' ? 'p3p' : 'p2p';
        const mine = stores[owner][id];
        const theirs = stores[loser][id];
        // ما كتبه المستخدم على النسخة الخاطئة يلحق بالصحيحة إن كانت فارغة
        for (const f of CARRY) {
          const v = theirs[f];
          if (v != null && v !== '' && (mine[f] == null || mine[f] === '')) mine[f] = v;
        }
        upsertTransfer(found[owner].get(id), stores[owner]); // ما أرجعته المنصة الآن أصدق مما تسرّب
        touch('transfers__' + owner, id); // ما لحق بها هنا أحدثُ من المخزَّن
        delete stores[loser][id];
        deleted[loser].add(id);
        touched[loser] = true;
        report.moved[owner]++;
        bump(report.byKind[owner], stores[owner][id].kind);
      };
      for (const id of ids) {
        const t = stores.p2p[id];
        const g = TX_GROUP[t.kind];
        const inA = found.p2p.has(id), inB = found.p3p.has(id);
        let reason = null;
        if (!g) reason = 'kind';
        else if (inA && inB) {
          for (const a of ACCOUNTS) upsertTransfer(found[a].get(id), stores[a]);
          sharedIds.push(id);
          report.shared++;
          bump(report.byKind.shared, t.kind);
          continue;
        } else if (inA || inB) {
          const owner = inA ? 'p2p' : 'p3p';
          const rival = inA ? 'p3p' : 'p2p';
          // Pay قد تكون للطرفين معًا، فلا نحذفها من الآخر قبل أن يُسأل ويكتمل جوابه
          if (g === 'pay' && !complete[rival].pay) reason = 'pay-unsure';
          else { settle(id, owner); continue; }
        } else reason = 'none';
        report.unresolved++;
        bump(report.byKind.unresolved, t.kind);
        bump(report.reasons, reason);
        if (report.sample.length < 10) report.sample.push({ id, kind: t.kind, amount: t.amount, coin: t.coin, time: t.time, reason });
      }

      /* المحذوف يُقبر في حسابه حتى لا تُعيده نسخةٌ أخرى، ويُخرج من مقبرة الحساب
         الذي بقي فيه (قد يكون نُقل منه يومًا) */
      for (const a of ACCOUNTS) {
        const l = a === 'p2p' ? 'p3p' : 'p2p';
        await bury('transfers__' + l, deleted[l]);
        await unbury('transfers__' + a, [...deleted[l], ...sharedIds]);
      }
      if (sharedIds.length) {
        try { await saveStore('sharedtx', [...new Set([...sharedOk, ...sharedIds])].slice(-GRAVE_MAX)); } catch {}
      }
    }

    /* «الباقي» المثبَّت على الطلبات حُسب والحوالةُ محسوبةٌ مرّتين، فيُمحى في كل
       حسابٍ تغيّر ليُعاد حسابه صحيحًا (كما تفعل «إعادة حساب الباقي»). الحوالات
       تُمحى في الحفظ أدناه بعد الدمج، وإلّا أعادها الدمجُ من المخزَّن. */
    for (const a of ACCOUNTS) {
      if (!touched[a]) continue;
      if (a === active) {
        await mergeFromStore('orders__' + active, ordMem);
        for (const o of Object.values(ordMem)) if (o.balAfter != null) delete o.balAfter;
        await saveStore('orders__' + active, ordMem);
        clearDirty('orders__' + active);
      } else {
        const oo = (await loadStore('orders__' + other, null)) || {};
        let n = 0;
        for (const o of Object.values(oo)) if (o.balAfter != null) { delete o.balAfter; n++; }
        if (n) await saveStore('orders__' + other, oo);
      }
    }
  } finally {
    /* الحفظ مهما حدث (فما أُرجع من الأرشيف لا يضيع): دمجٌ يضمّ ما كتبته نسخةٌ
       أخرى أثناء الجلب، ثم إعادةُ الحذف حتى لا يُعيد الدمجُ ما حذفناه، ثم محوُ
       المثبَّت في الحساب المتغيّر، ثم الكتابة بالمفتاح الصريح */
    for (const [a, key, store] of [[active, 'transfers__' + active, mem], [other, 'transfers__' + other, far]]) {
      await mergeFromStore(key, store);
      for (const id of deleted[a]) delete store[id];
      if (touched[a]) for (const t of Object.values(store)) if (t && t.balAfter != null) delete t.balAfter;
      await saveStore(key, store);
      clearDirty(key);
    }
    for (const a of ACCOUNTS) { try { await saveStore('dupesundo__' + a, { at: Date.now(), ids: [] }); } catch {} }
  }
  report.activeName = ACCOUNT_NAMES[active];
  report.names = ACCOUNT_NAMES;
  yield report;
}

/* ============================ خادم HTTP ============================ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('غير موجود'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

let syncRunning = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      serveStatic(res, p);
      return;
    }

    /* ---------- حالة الصيانة (عامة للقراءة) ---------- */
    if (p === '/api/maintenance' && req.method === 'GET') {
      // تُقرأ من القاعدة في كل مرة، فأي تغيير من أي نسخة من الخادم يظهر فورًا
      sendJSON(res, 200, await loadMaintenance(req));
      return;
    }

    /* ---------- المصادقة ---------- */
    if (p === '/api/auth/status' && req.method === 'GET') {
      sendJSON(res, 200, {
        configured: isConfigured(),
        hasUser: !!(config.auth.user && config.auth.user.hash),
        hasUser2: !!(config.auth.user2 && config.auth.user2.hash),
      });
      return;
    }

    if (p === '/api/auth/setup' && req.method === 'POST') {
      if (isConfigured()) { sendJSON(res, 409, { error: 'تم الإعداد مسبقًا — سجّل الدخول' }); return; }
      const body = await readBody(req);
      const ap = String(body.adminPassword || '');
      const up = String(body.userPassword || '');
      const up2 = String(body.user2Password || '');
      if (ap.length < 4) { sendJSON(res, 400, { error: 'كلمة سر المسؤول يجب ألا تقل عن 4 خانات' }); return; }
      config.auth.admin = makeCredential(ap);
      config.auth.user = up ? makeCredential(up) : {};
      config.auth.user2 = up2 ? makeCredential(up2) : {};
      await saveConfig();
      const token = newToken('admin');
      recordLogin('admin', req);
      sendJSON(res, 200, { ok: true, token, role: 'admin' });
      return;
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const role = ['admin', 'user', 'user2'].includes(body.role) ? body.role : 'user';
      const cred = config.auth[role];
      if (!cred || !cred.hash) {
        const msg = role === 'admin' ? 'لم يتم الإعداد بعد'
          : (role === 'user2' ? 'لا يوجد حساب «مستخدم 2» — عيّنه من «تغيير كلمات السر»' : 'لا يوجد حساب مستخدم — ادخل كمسؤول');
        sendJSON(res, 400, { error: msg }); return;
      }
      if (!verifyPassword(String(body.password || ''), cred)) { sendJSON(res, 401, { error: 'كلمة السر غير صحيحة' }); return; }
      const token = newToken(role);
      recordLogin(role, req);
      sendJSON(res, 200, { ok: true, token, role });
      return;
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const token = req.headers['x-auth-token'];
      if (token) sessions.delete(String(token));
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (p === '/api/auth/password' && req.method === 'POST') {
      if (roleOf(req) !== 'admin') { sendJSON(res, 403, { error: 'هذه العملية للمسؤول فقط' }); return; }
      const body = await readBody(req);
      if (typeof body.adminPassword === 'string' && body.adminPassword) {
        if (body.adminPassword.length < 4) { sendJSON(res, 400, { error: 'كلمة سر المسؤول قصيرة جدًا' }); return; }
        config.auth.admin = makeCredential(body.adminPassword);
      }
      if (typeof body.userPassword === 'string') {
        config.auth.user = body.userPassword ? makeCredential(body.userPassword) : {};
      }
      if (typeof body.user2Password === 'string') {
        config.auth.user2 = body.user2Password ? makeCredential(body.user2Password) : {};
      }
      await saveConfig();
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* ---------- بوابة الصلاحيات ---------- */
    const role = roleOf(req);
    const gate = (list) => list.some((x) => x[0] === req.method && x[1] === p);
    // للمسؤول فقط
    const ADMIN_ROUTES = [
      ['POST', '/api/orders'], ['DELETE', '/api/orders'], ['POST', '/api/orders/bulk'],
      ['POST', '/api/orders/clear'], ['POST', '/api/transfers/clear'],
      ['POST', '/api/settings'], ['GET', '/api/auth/log'],
      ['POST', '/api/maintenance'], ['GET', '/api/diag/p2p'], ['POST', '/api/sync/day'],
      ['POST', '/api/record/move'],
      ['GET', '/api/transfers/dupes'], ['POST', '/api/transfers/reconcile'],
    ];
    // للمسؤول و«مستخدم 2»: الإشاري والملاحظة والسعر والمبلغ (تصحيحُ صفٍّ واحد)
    const ANNOTATE_ROUTES = [
      ['POST', '/api/orders/annotate'], ['POST', '/api/transfers/annotate'],
    ];
    // لأي مستخدم مسجّل دخوله
    const LOGIN_ROUTES = [
      ['POST', '/api/sync'], ['GET', '/api/sync/quota'],
      ['GET', '/api/balance'], ['GET', '/api/balance/snapshots'],
      // الإلغاء متاحٌ لكل داخل: لا يمحو بيانات، بل أرقامًا مشتقّة تُحسب فورًا
      // من جديد — والإصلاح الذاتي يحتاجه أيًّا كان الدور الذي فتح النظام
      ['POST', '/api/balance/freeze'], ['POST', '/api/balance/unfreeze'],
      ['GET', '/api/orders'], ['GET', '/api/transfers'], ['GET', '/api/settings'],
      ['GET', '/api/account'], ['POST', '/api/account'],
    ];
    if (gate(ADMIN_ROUTES) && role !== 'admin') { sendJSON(res, 403, { error: 'هذه العملية للمسؤول فقط' }); return; }
    if (gate(ANNOTATE_ROUTES) && role !== 'admin' && role !== 'user2') { sendJSON(res, 403, { error: 'لا تملك صلاحية التعديل في السجل' }); return; }
    if (gate(LOGIN_ROUTES) && !role) { sendJSON(res, 401, { error: 'يلزم تسجيل الدخول' }); return; }

    /* ---------- ضبط وضع الصيانة (للمسؤول فقط) ---------- */
    if (p === '/api/maintenance' && req.method === 'POST') {
      const body = await readBody(req);
      const m = await loadMaintenance(req);
      if (typeof body.on === 'boolean') m.on = body.on;
      if (typeof body.message === 'string') m.message = body.message.slice(0, 2000);
      if (typeof body.link === 'string') m.link = body.link.slice(0, 1000);
      // يُوقف هذا السستم فقط (النطاق الحالي)، والسستم الثاني يبقى شغّالًا
      await saveStore(maintKey(req), m);
      sendJSON(res, 200, { ok: true, maintenance: m });
      return;
    }

    /* ---------- فحص المزامنة: ما تُرجعه المنصة فعلًا مقابل ما هو محفوظ ----------
       يفصل السببين نهائيًا: إن ظهرت العملية هنا ولم تُحفظ فالخلل عندنا،
       وإن لم تظهر أصلًا فالمنصة لا تُرجعها لهذا المفتاح. (للمسؤول فقط) */
    if (p === '/api/diag/p2p' && req.method === 'GET') {
      if (!AC().apiKey || !AC().apiSecret) {
        sendJSON(res, 400, { error: 'أدخل مفتاح API من الإعدادات أولًا' });
        return;
      }
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 3, 1), 29);
      const base = (AC().baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
      const offset = await timeOffset(base);
      const end = Date.now();
      const start = end - days * 86400000;
      const list = [];
      for (const tradeType of ['SELL', 'BUY']) {
        let page = 1;
        for (;;) {
          const j = await signedGet(base, '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
            { tradeType, startTimestamp: start, endTimestamp: end, page, rows: 100 }, offset);
          const rows = Array.isArray(j.data) ? j.data : [];
          for (const r of rows) {
            const n = String(r.orderNumber || '').trim();
            list.push({
              orderNumber: n,
              tail: n.slice(-4),
              tradeType: String(r.tradeType || ''),
              amount: num(r.amount),
              totalPrice: num(r.totalPrice),
              status: String(r.orderStatus || ''),
              time: Number(r.createTime) || 0,
              stored: Object.prototype.hasOwnProperty.call(orders, n),
            });
          }
          if (rows.length < 100 || page >= 60) break;
          page++;
          await sleep(250);
        }
        await sleep(250);
      }
      list.sort((a, b) => b.time - a.time);
      // ما هو محفوظ عندنا في نفس الفترة ولم تُرجعه المنصة (مُدخل يدويًا أو مزروع)
      const fromApi = new Set(list.map((x) => x.orderNumber));
      const onlyOurs = Object.values(orders)
        .filter((o) => o.createTime >= start && o.createTime <= end && !fromApi.has(o.orderNumber))
        .map((o) => ({
          orderNumber: o.orderNumber, tail: String(o.orderNumber).slice(-4),
          tradeType: o.tradeType, amount: o.amount, totalPrice: o.totalPrice,
          status: o.orderStatus, time: o.createTime, source: o.source,
        }))
        .sort((a, b) => b.time - a.time);
      sendJSON(res, 200, {
        days, from: start, to: end,
        fromPlatform: list,
        notStored: list.filter((x) => !x.stored).length,
        onlyOurs,
        storedTotal: Object.keys(orders).length,
      });
      return;
    }

    /* ---------- سجل الدخول (للمسؤول فقط) ---------- */
    if (p === '/api/auth/log' && req.method === 'GET') {
      sendJSON(res, 200, { events: loginLog.slice().reverse() });
      return;
    }

    /* ---------- الطلبات ---------- */
    if (p === '/api/orders' && req.method === 'GET') {
      sendJSON(res, 200, { orders: Object.values(orders), lastSync: AC().lastSync });
      return;
    }

    if (p === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      const o = normalizeOrder(body, 'manual');
      if (!(o.amount > 0)) { sendJSON(res, 400, { error: 'الكمية مطلوبة ويجب أن تكون أكبر من صفر' }); return; }
      if (!(o.totalPrice > 0)) { sendJSON(res, 400, { error: 'المبلغ مطلوب ويجب أن يكون أكبر من صفر' }); return; }
      const r = upsertOrder(o);
      await saveOrders();
      sendJSON(res, 200, { result: r, order: o });
      return;
    }

    if (p === '/api/orders/bulk' && req.method === 'POST') {
      await refreshActive();   // الاستيراد يقع في الحساب المفتوح فعلًا لا المحفوظ في الذاكرة
      const body = await readBody(req);
      const list = Array.isArray(body.orders) ? body.orders : [];
      let added = 0, updated = 0, skipped = 0;
      for (const raw of list) {
        const o = normalizeOrder(raw, raw.source === 'binance' ? 'binance' : 'import');
        if (!(o.amount > 0) || !(o.totalPrice > 0)) { skipped++; continue; }
        const r = upsertOrder(o);
        if (r === 'added') added++;
        else if (r === 'updated') updated++;
        if (r !== 'same') touch('orders__' + config.active, o.orderNumber); // ما جاء في الملف أحدثُ من المخزَّن
      }
      await saveOrders();
      sendJSON(res, 200, { added, updated, skipped, total: Object.keys(orders).length });
      return;
    }

    if (p === '/api/orders' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      if (!orders[id]) { sendJSON(res, 404, { error: 'الطلب غير موجود' }); return; }
      await mergeFromStore('orders__' + config.active, orders); // الدمج أولًا، فالحفظ هنا بلا دمج
      delete orders[id];
      await bury('orders__' + config.active, [id]); // ولا يعود من ذاكرة نسخةٍ أخرى
      await saveOrders({ merge: false }); // بلا دمج حتى لا يعود المحذوف من المخزَّن
      sendJSON(res, 200, { ok: true, total: Object.keys(orders).length });
      return;
    }

    if (p === '/api/orders/clear' && req.method === 'POST') {
      orders = {};
      await saveOrders({ merge: false }); // مسحٌ مقصود — بلا دمج
      sendJSON(res, 200, { ok: true });
      return;
    }

    // تحديث الإشاري/الملاحظة لطلب (يبقى بعد المزامنة)
    if (p === '/api/orders/annotate' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!Object.prototype.hasOwnProperty.call(orders, id)) { sendJSON(res, 404, { error: 'الطلب غير موجود' }); return; }
      const o = orders[id];
      if (typeof body.note === 'string') o.note = body.note.slice(0, 2000);
      if (typeof body.reference === 'string') o.reference = body.reference.slice(0, 2000);
      // تعديل يدوي للسعر/المبلغ يبقى بعد المزامنة ('' يعني إلغاء التعديل والرجوع لقيمة المنصة)
      if ('unitPrice' in body) {
        const s = String(body.unitPrice).trim();
        if (s === '') delete o.unitPriceOverride;
        else { const v = Number(s); if (Number.isFinite(v) && v >= 0) o.unitPriceOverride = v; }
      }
      if ('totalPrice' in body) {
        const s = String(body.totalPrice).trim();
        if (s === '') delete o.totalPriceOverride;
        else { const v = Number(s); if (Number.isFinite(v) && v >= 0) o.totalPriceOverride = v; }
      }
      /* مرساة الرصيد وتسمية الشبكة تمسّان الدفتر كلّه لا صفًّا واحدًا، فتبقيان
         للمسؤول. الواجهة تُخفيهما عن «مستخدم 2» أصلًا، وهذا يجعل الخادم يُلزمهما. */
      const mayAll = role === 'admin';
      if (mayAll && 'networkLabel' in body) {
        const s = String(body.networkLabel).trim();
        if (s === '') delete o.networkLabelOverride;
        else o.networkLabelOverride = s.slice(0, 40);
      }
      // علامة «الرصيد صفر بعد هذه العملية»: يعرفها المستخدم ولا تعرفها المنصة،
      // وعليها يُثبَّت عمود «الباقي» فتظهر ما بعدها بقيمها الحقيقية
      /* الأرشفة إخفاءٌ من الجدول لا محوٌ من الدفتر: تبقى العملية محسوبةً في
         «الباقي» لأن المال تحرّك فعلًا، ومَن أراد المحو فالحذف موجود. */
      if (mayAll && 'archived' in body) {
        if (body.archived) o.archived = true; else delete o.archived;
      }
      if (mayAll && 'zeroPoint' in body) {
        if (body.zeroPoint) o.zeroPoint = true; else delete o.zeroPoint;
      }
      if (mayAll && 'balanceAt' in body) {
        const v = Number(body.balanceAt);
        if (body.balanceAt == null || !Number.isFinite(v) || v < 0) { delete o.balanceAt; delete o.zeroPoint; }
        else { o.balanceAt = Math.round(v * 1e8) / 1e8; delete o.zeroPoint; }
      }
      touch('orders__' + config.active, id); // ما عُدّل هنا أحدثُ من المخزَّن حتى يُحفظ
      await saveOrders();
      sendJSON(res, 200, { ok: true, order: o });
      return;
    }

    /* ---------- الإيداع والسحب ---------- */
    if (p === '/api/transfers' && req.method === 'GET') {
      sendJSON(res, 200, { transfers: Object.values(transfers), lastSync: AC().lastSync });
      return;
    }

    if (p === '/api/transfers/clear' && req.method === 'POST') {
      transfers = {};
      await saveTransfers({ merge: false }); // مسحٌ مقصود — بلا دمج
      sendJSON(res, 200, { ok: true });
      return;
    }

    // تحديث الإشاري/الملاحظة لحوالة (يبقى بعد المزامنة)
    if (p === '/api/transfers/annotate' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!Object.prototype.hasOwnProperty.call(transfers, id)) { sendJSON(res, 404, { error: 'الحوالة غير موجودة' }); return; }
      const t = transfers[id];
      if (typeof body.note === 'string') t.note = body.note.slice(0, 2000);
      if (typeof body.reference === 'string') t.reference = body.reference.slice(0, 2000);
      if ('unitPrice' in body) {
        const s = String(body.unitPrice).trim();
        if (s === '') delete t.unitPriceOverride;
        else { const v = Number(s); if (Number.isFinite(v) && v >= 0) t.unitPriceOverride = v; }
      }
      if ('totalPrice' in body) {
        const s = String(body.totalPrice).trim();
        if (s === '') delete t.totalPriceOverride;
        else { const v = Number(s); if (Number.isFinite(v) && v >= 0) t.totalPriceOverride = v; }
      }
      /* مرساة الرصيد وتسمية الشبكة تمسّان الدفتر كلّه لا صفًّا واحدًا، فتبقيان
         للمسؤول. الواجهة تُخفيهما عن «مستخدم 2» أصلًا، وهذا يجعل الخادم يُلزمهما. */
      const mayAll = role === 'admin';
      if (mayAll && 'networkLabel' in body) {
        const s = String(body.networkLabel).trim();
        if (s === '') delete t.networkLabelOverride;
        else t.networkLabelOverride = s.slice(0, 40);
      }
      // علامة «الرصيد صفر بعد هذه العملية» (انظر التعليق في annotate الطلبات)
      /* عمليةٌ بعملةٍ غير USDT لا تدخل حساب «الباقي» لأن USDT لم يتحرّك. لكن قد
         يريد صاحب الدفتر احتسابها بقيمتها بالـUSDT — فيكتبها هنا، وتُعامل
         عندئذٍ معاملة USDT بمقدارها هذا (الرسوم داخلةٌ فيه، فلا تُضاف ثانية). */
      if (mayAll && 'usdtValue' in body) {
        const v = Number(body.usdtValue);
        if (body.usdtValue == null || String(body.usdtValue).trim() === '' || !Number.isFinite(v) || v < 0) delete t.usdtValue;
        else t.usdtValue = Math.round(v * 1e8) / 1e8;
      }
      /* الأرشفة إخفاءٌ من الجدول لا محوٌ من الدفتر: تبقى العملية محسوبةً في
         «الباقي» لأن المال تحرّك فعلًا، ومَن أراد المحو فالحذف موجود. */
      if (mayAll && 'archived' in body) {
        if (body.archived) t.archived = true; else delete t.archived;
      }
      if (mayAll && 'zeroPoint' in body) {
        if (body.zeroPoint) t.zeroPoint = true; else delete t.zeroPoint;
      }
      if (mayAll && 'balanceAt' in body) {
        const v = Number(body.balanceAt);
        if (body.balanceAt == null || !Number.isFinite(v) || v < 0) { delete t.balanceAt; delete t.zeroPoint; }
        else { t.balanceAt = Math.round(v * 1e8) / 1e8; delete t.zeroPoint; }
      }
      touch('transfers__' + config.active, id); // ما عُدّل هنا أحدثُ من المخزَّن حتى يُحفظ
      await saveTransfers();
      sendJSON(res, 200, { ok: true, transfer: t });
      return;
    }

    /* ---------- رصيد محفظة التمويل (جلب مباشر) ---------- */
    if (p === '/api/balance' && req.method === 'GET') {
      if (!AC().apiKey || !AC().apiSecret) {
        sendJSON(res, 400, { error: 'أدخل مفتاح API من الإعدادات أولًا لعرض الرصيد' });
        return;
      }
      const base = (AC().baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
      const offset = await timeOffset(base);
      const funding = await signedGet(base, '/sapi/v1/asset/get-funding-asset', { needBtcValuation: 'true' }, offset, 'POST');
      // الحساب الفوري (Spot): نجمعه مع التمويل لأن التحويل بينهما لا يغيّر ما نملكه فعلًا.
      // فشلُه غير قاتل — نعرض التمويل وحده بدل أن نُفشل الطلب كله.
      let spot = [];
      let spotError = '';
      try {
        spot = await signedGet(base, '/sapi/v3/asset/getUserAsset', {}, offset, 'POST');
      } catch (e) { spotError = e.message || 'تعذّر الجلب'; console.error('spot balance: ' + spotError); }

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
      /* لا نسجّل لقطةً إلا إذا وصلت المحفظتان معًا: رقمُ التمويل وحده ناقصٌ،
         ولقطةٌ ناقصة تصير أساسًا خاطئًا يثبّت عليه عمودُ «الباقي» كل صفوف اليوم. */
      let snapshots = null;
      if (!spotError) {
        try { snapshots = await saveBalSnap(usdtTotal(funding) + usdtTotal(spot), now); }
        catch (e) { console.error('balsnap: ' + e.message); }
      }
      sendJSON(res, 200, {
        assets: [...merged.values()],
        spotIncluded: !spotError,
        spotError,
        usdtFunding: usdtTotal(funding),
        usdtSpot: usdtTotal(spot),
        snapshots: snapshots || await loadBalSnaps(),
        updatedAt: now,
      });
      return;
    }

    /* ---------- جلب يومٍ واحد بعينه (إصلاح موضعي) ----------
       المزامنة الكاملة تسأل المنصة عشرات الأسئلة فتُرهق الحصّة وتقرّب الحظر،
       ومَن ينقصه يومٌ واحد لا يحتاجها. هنا نسأل عن ذلك اليوم وحده — ستة طلبات
       تغطّي كل الأنواع — ثم نُبلّغ بما وجدناه وما كان جديدًا. (للمسؤول) */
    if (p === '/api/sync/day' && req.method === 'POST') {
      if (!AC().apiKey || !AC().apiSecret) {
        sendJSON(res, 400, { error: 'أدخل مفتاح API من الإعدادات أولًا' });
        return;
      }
      const body = await readBody(req);
      await refreshActive();
      const m = String(body.day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) { sendJSON(res, 400, { error: 'حدّد اليوم بصيغة YYYY-MM-DD' }); return; }
      // حدود اليوم المحاسبي: من الثانية ليلًا إلى الثانية ليلًا — نفس ما يعرضه الجدول
      const s = dayStartMs(+m[1], +m[2], +m[3]);
      const e = s + 86400000 - 1;
      if (s > Date.now()) { sendJSON(res, 400, { error: 'هذا اليوم لم يأتِ بعد' }); return; }
      const base = (AC().baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
      const offset = await timeOffset(base);
      await mergeFromStore('orders__' + config.active, orders);
      await mergeFromStore('transfers__' + config.active, transfers);

      const found = { p2p: 0, deposit: 0, withdraw: 0, pay: 0, convert: 0 };
      const added = { p2p: 0, deposit: 0, withdraw: 0, pay: 0, convert: 0 };
      const skipped = [];
      const rowsOf = (j, key) => (Array.isArray(j) ? j : (Array.isArray(j && j[key]) ? j[key] : []));
      const take = (kind, list, norm, isOrder) => {
        for (const raw of list) {
          found[kind]++;
          const r = isOrder ? upsertOrder(norm(raw)) : upsertTransfer(norm(raw));
          if (r === 'added') added[kind]++;
        }
      };
      try {
        for (const tradeType of ['SELL', 'BUY']) {
          let page = 1;
          for (;;) {
            const j = await signedGet(base, '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
              { tradeType, startTimestamp: s, endTimestamp: e, page, rows: 100 }, offset);
            const rows = rowsOf(j, 'data');
            take('p2p', rows, (raw) => normalizeOrder(raw, 'binance'), true);
            if (rows.length < 100 || page >= 20) break;
            page++;
            await sleep(250);
          }
          await sleep(250);
        }
        take('deposit', rowsOf(await signedGet(base, '/sapi/v1/capital/deposit/hisrec',
          { startTime: s, endTime: e, offset: 0, limit: 1000 }, offset)), (raw) => normalizeTransfer(raw, 'deposit'), false);
        await sleep(300);
        take('withdraw', rowsOf(await signedGet(base, '/sapi/v1/capital/withdraw/history',
          { startTime: s, endTime: e, offset: 0, limit: 1000 }, offset)), (raw) => normalizeTransfer(raw, 'withdraw'), false);
        await sleep(300);
      } catch (err) {
        sendJSON(res, 502, { error: err && err.message ? err.message : 'تعذّر سؤال المنصة' });
        return;
      }
      // النوعان التاليان قد يُمنعان بصلاحية المفتاح أو المنطقة — فشلهما لا يُفشل الباقي
      for (const [kind, path, key, norm] of [
        ['pay', '/sapi/v1/pay/transactions', 'data', normalizePay],
        ['convert', '/sapi/v1/convert/tradeFlow', 'list', normalizeConvert],
      ]) {
        try {
          if (kind === 'pay') {
            /* نفس حدّ المئة بلا ترقيم صفحات (انظر المزامنة الشاملة): يومٌ مزدحم
               يمتلئ فيسقط باقيه صامتًا، فنشطر اليوم زمنيًّا حتى تعود ناقصة. */
            const parts = [[s, e]];
            let calls = 0;
            while (parts.length && calls < PAY_MAX_CALLS) {
              const [ps, pe] = parts.pop();
              calls++;
              const rows = rowsOf(await signedGet(base, path,
                { startTime: ps, endTime: pe, limit: PAY_PAGE }, offset), key);
              take(kind, rows, norm, false);
              if (rows.length >= PAY_PAGE && pe - ps > 60000) {
                const mid = Math.floor((ps + pe) / 2);
                parts.push([mid + 1, pe], [ps, mid]);
              }
              await sleep(PAY_GAP_MS);
              await coolIfHeavy(PAY_WEIGHT);
            }
            if (parts.length) skipped.push('pay: عمليات كثيرة جدًّا في هذا اليوم — قد تبقى عمليات لم تصل');
          } else {
            const j = await signedGet(base, path, { startTime: s, endTime: e, limit: 1000 }, offset);
            take(kind, rowsOf(j, key), norm, false);
            await sleep(500);
          }
        } catch (err) { skipped.push(kind + ': ' + (err && err.message ? err.message : 'خطأ')); }
      }
      try { await saveOrders(); await saveTransfers(); } catch (err) { console.error(err.message); }
      const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      // المحفوظ فعلًا في ذلك اليوم — به نفرّق: أهي لم تصل، أم وصلت والجدول يخفيها؟
      const inDay = (t) => t >= s && t <= e;
      const stored = Object.values(orders).filter((o) => inDay(o.createTime)).length
        + Object.values(transfers).filter((t) => inDay(t.time)).length;
      sendJSON(res, 200, {
        ok: true, day: body.day, from: s, to: e, found, added, skipped,
        total: sum(found), totalAdded: sum(added), stored,
      });
      return;
    }

    /* ---------- لقطات الرصيد اليومية (تُقرأ بلا اتصال بالمنصة) ---------- */
    if (p === '/api/balance/snapshots' && req.method === 'GET') {
      sendJSON(res, 200, { snapshots: await loadBalSnaps() });
      return;
    }

    /* ---------- تثبيت «الباقي من USDT» على العمليات المكتملة ----------
       العملية متى اكتملت صار باقيها رقمًا نهائيًا يُكتب على الصفّ نفسه، فلا
       يعود يُحسب ولا يتحرّك مهما دخل بعده من عمليات أو تغيّر رصيد المحفظة.
       أول قيمة تُكتب هي النهائية — الكتابةُ فوقها ممنوعة، وإلا عاد يتحرّك. */
    if (p === '/api/balance/freeze' && req.method === 'POST') {
      const body = await readBody(req);
      let n = 0;
      const put = (store, id, v) => {
        const rec = store[id];
        if (!rec || rec.balAfter != null) return;
        const x = Number(v);
        if (!Number.isFinite(x)) return;
        rec.balAfter = Math.round(x * 1e8) / 1e8;
        touch((store === orders ? 'orders__' : 'transfers__') + config.active, id);
        n++;
      };
      for (const [id, v] of Object.entries(body.orders || {})) put(orders, id, v);
      for (const [id, v] of Object.entries(body.transfers || {})) put(transfers, id, v);
      if (n) { await saveOrders(); await saveTransfers(); }
      sendJSON(res, 200, { ok: true, frozen: n });
      return;
    }

    /* إلغاء التثبيت وإعادة الحساب من الصفر (للمسؤول): مخرجٌ إن ثُبِّتت أرقام
       خاطئة يومًا — كأن يُثبَّت العمود قبل وصول عملية ناقصة من المنصة. */
    if (p === '/api/balance/unfreeze' && req.method === 'POST') {
      // ادمج أولًا حتى تشمل الإزالةُ ما كتبه السستم الآخر، فالحفظ هنا بلا دمج
      await mergeFromStore('orders__' + config.active, orders);
      await mergeFromStore('transfers__' + config.active, transfers);
      let n = 0;
      for (const o of Object.values(orders)) if (o.balAfter != null) { delete o.balAfter; n++; }
      for (const t of Object.values(transfers)) if (t.balAfter != null) { delete t.balAfter; n++; }
      await saveOrders({ merge: false });
      await saveTransfers({ merge: false });
      sendJSON(res, 200, { ok: true, cleared: n });
      return;
    }

    /* ---------- الحسابات (P2P / P3P) ---------- */
    if (p === '/api/account' && req.method === 'GET') {
      await refreshActive();   // تعرض الواجهة الحسابَ الحقيقي لا نسخةً قديمة
      sendJSON(res, 200, {
        active: config.active,
        locked: !!LOCKED,        // سستمٌ لحسابٍ واحد: لا زرّ تبديل
        accounts: (LOCKED ? [LOCKED] : ACCOUNTS).map((id) => ({
          id, name: ACCOUNT_NAMES[id],
          hasKey: !!(config.accounts[id] && config.accounts[id].apiKey && config.accounts[id].apiSecret),
          lastSync: config.accounts[id] ? config.accounts[id].lastSync : null,
        })),
      });
      return;
    }

    if (p === '/api/account' && req.method === 'POST') {
      if (LOCKED) {
        sendJSON(res, 400, { error: 'هذا السستم مخصّص لـ«' + ACCOUNT_NAMES[LOCKED] + '» وحده — الحساب الآخر له رابطه الخاص' });
        return;
      }
      const body = await readBody(req);
      const target = ACCOUNTS.includes(body.active) ? body.active : 'p2p';
      /* التبديل أثناء مزامنةٍ جارية يُسلّم عملياتِ حسابٍ إلى حسابٍ آخر: المزامنة
         تكتب في الذاكرة ثم تحفظ تحت config.active — وقد تبدّل تحتها. فنمنعه. */
      if (syncRunning && target !== config.active) {
        sendJSON(res, 409, { error: 'هناك مزامنة قيد التنفيذ — انتظر انتهاءها قبل تبديل الحساب، وإلّا حُفظت عملياتها في الحساب الخطأ' });
        return;
      }
      if (target !== config.active) {
        await saveOrders();       // احفظ بيانات الحساب الحالي احتياطًا
        await saveTransfers();
        config.active = target;
        await saveStore('config', config);
        orders = await loadAccountData('orders');
        transfers = await loadAccountData('transfers');
      }
      sendJSON(res, 200, { ok: true, active: config.active, name: ACCOUNT_NAMES[config.active] });
      return;
    }

    /* ---------- حوالات مسجّلة في الحسابين معًا (للمسؤول) ----------
       حوالةُ المحفظة معرّفها فريدٌ في Binance، فلا تكون في حسابين إلا أن تكون
       تسرّبت من أحدهما إلى الآخر. نعرضها هنا، ونؤرشفها في الحساب المفتوح وحده
       بأمرٍ منفصل — أرشفةً لا حذفًا، فتخرج من الجدول والحساب وتبقى قابلة للرجوع. */
    if (p === '/api/transfers/dupes' && req.method === 'GET') {
      await refreshActive();
      const other = ACCOUNTS.find((a) => a !== config.active) || 'p2p';
      let far = {};
      try {
        far = await loadStore('transfers__' + other, null);
        // قبل نظام الحسابين كان مخزن p2p بلا لاحقة؛ لا نكتب شيئًا هنا، نقرأ فقط
        if (far == null && other === 'p2p') far = await loadStore('transfers', null);
        far = far || {};
      } catch (e) { sendJSON(res, 500, { error: 'تعذّر قراءة الحساب الآخر: ' + e.message }); return; }
      // ما أثبتت المنصةُ أنه للحسابين معًا (Pay بين حسابيك) ليس تسرّبًا، فلا يُعدّ
      let sharedOk = [];
      try { const s = await loadStore('sharedtx', null); if (Array.isArray(s)) sharedOk = s; } catch {}
      const okSet = new Set(sharedOk);
      const dupes = Object.values(transfers).filter((t) => t && far[t.id] && !okSet.has(t.id));
      const by = {};
      let span = null;
      for (const t of dupes) {
        by[t.kind] = (by[t.kind] || 0) + 1;
        span = span ? [Math.min(span[0], t.time), Math.max(span[1], t.time)] : [t.time, t.time];
      }
      sendJSON(res, 200, {
        account: config.active, accountName: ACCOUNT_NAMES[config.active],
        otherName: ACCOUNT_NAMES[other], names: ACCOUNT_NAMES, count: dupes.length, byKind: by,
        sharedKnown: Object.values(transfers).filter((t) => t && far[t.id] && okSet.has(t.id)).length,
        from: span ? span[0] : null, to: span ? span[1] : null,
        keys: { p2p: !!(await accountKeysFor('p2p')), p3p: !!(await accountKeysFor('p3p')) },
      });
      return;
    }

    /* ---------- إعادة كل حوالة إلى حسابها الصحيح (بث التقدم NDJSON) ---------- */
    if (p === '/api/transfers/reconcile' && req.method === 'POST') {
      if (syncRunning) { sendJSON(res, 409, { error: 'هناك مزامنة قيد التنفيذ — انتظر انتهاءها' }); return; }
      syncRunning = true;   // يمنع المزامنة وتبديلَ الحساب حتى ننتهي
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      try {
        for await (const ev of reconcileGenerator()) res.write(JSON.stringify(ev) + '\n');
      } catch (e) {
        res.write(JSON.stringify({ error: e.isUser ? e.message : 'خطأ غير متوقع: ' + e.message }) + '\n');
      } finally {
        syncRunning = false;
        res.end();
      }
      return;
    }

    /* ---------- نقل عملية إلى الحساب الآخر (للمسؤول) ----------
       تقع العملية في الحساب الخطأ إن استُورد ملفٌ والحسابُ غير المقصود مفتوح،
       أو بُدِّل الحساب أثناء مزامنة. فبدل الحذف وإعادة الإدخال: ننقلها كما هي
       بكل تعليقاتها. نُضيفها إلى مخزن الحساب الآخر أولًا، فإن فشل لم نحذف. */
    if (p === '/api/record/move' && req.method === 'POST') {
      const body = await readBody(req);
      const isTx = body.kind === 'transfer';
      const id = String(body.id || '');
      const mem = isTx ? transfers : orders;
      if (!Object.prototype.hasOwnProperty.call(mem, id)) { sendJSON(res, 404, { error: 'العملية غير موجودة' }); return; }
      const other = ACCOUNTS.find((a) => a !== config.active) || 'p2p';
      const base = isTx ? 'transfers__' : 'orders__';
      const rec = mem[id];
      try {
        const dst = (await loadStore(base + other, null)) || {};
        if (dst[id]) { sendJSON(res, 409, { error: 'العملية موجودة في الحساب الآخر أصلًا' }); return; }
        dst[id] = rec;
        await saveStore(base + other, dst);
        await unbury(base + other, [id]); // قد تكون نُقلت من هناك يومًا فقُبرت فيه
      } catch (e) {
        sendJSON(res, 500, { error: 'تعذّر النقل: ' + e.message });
        return;
      }
      // الدمج أولًا كي يشمل الحذفُ ما كتبه السستم الآخر، ثم الحفظ بلا دمج
      await mergeFromStore(base + config.active, mem);
      delete mem[id];
      await bury(base + config.active, [id]); // ولا تعود من ذاكرة نسخةٍ أخرى
      if (isTx) await saveTransfers({ merge: false }); else await saveOrders({ merge: false });
      sendJSON(res, 200, { ok: true, movedTo: other, name: ACCOUNT_NAMES[other] });
      return;
    }

    /* ---------- الإعدادات ---------- */
    if (p === '/api/settings' && req.method === 'GET') {
      const k = AC().apiKey || '';
      sendJSON(res, 200, {
        apiKeyMasked: k ? k.slice(0, 4) + '…' + k.slice(-4) : '',
        hasSecret: !!AC().apiSecret,
        baseUrl: AC().baseUrl,
        rangeHours: AC().rangeHours,
        syncQuota: syncQuotaValue(),
        lastSync: AC().lastSync,
      });
      return;
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) AC().apiKey = body.apiKey.trim();
      if (typeof body.apiSecret === 'string' && body.apiSecret.trim()) AC().apiSecret = body.apiSecret.trim();
      if (typeof body.baseUrl === 'string' && /^https:\/\/[\w.-]+$/.test(body.baseUrl.trim().replace(/\/+$/, ''))) {
        AC().baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
      }
      if (body.rangeHours != null) AC().rangeHours = Math.min(Math.max(Number(body.rangeHours) || 720, 1), 26280);
      if (body.syncQuota != null) config.syncQuota = Math.min(Math.max(Math.floor(Number(body.syncQuota)) || 0, 0), 500);
      await saveConfig();
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* ---------- رصيد مرات المزامنة المتبقية لهذا الدور اليوم ---------- */
    if (p === '/api/sync/quota' && req.method === 'GET') {
      sendJSON(res, 200, await syncQuotaFor(role));
      return;
    }

    /* ---------- المزامنة (بث التقدم NDJSON) ---------- */
    if (p === '/api/sync' && req.method === 'POST') {
      // الحصّة تُفحص قبل أي شيء: المسؤول بلا حد، وغيره بعدد مرات يوميًا
      const q = await syncQuotaFor(role);
      if (!q.unlimited && q.left <= 0) {
        sendJSON(res, 429, {
          error: q.quota === 0
            ? 'المزامنة غير مسموحة لحسابك — راجع المسؤول'
            : `انتهى عدد مرات المزامنة اليوم (${q.quota}) — جرّب بكرة أو راجع المسؤول`,
          quota: q.quota, used: q.used, left: 0,
        });
        return;
      }
      if (syncRunning) { sendJSON(res, 409, { error: 'هناك مزامنة قيد التنفيذ بالفعل' }); return; }
      // خلل في الإعداد ليس محاولة مزامنة — لا يُحسب من حصّة المستخدم
      if (!AC().apiKey || !AC().apiSecret) {
        sendJSON(res, 400, { error: 'لم يتم حفظ مفتاح API بعد — افتح الإعدادات وأدخل المفتاحين أولًا' });
        return;
      }
      if (!q.unlimited) await bumpSyncUsage(role);
      syncRunning = true;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      try {
        for await (const ev of syncGenerator()) {
          res.write(JSON.stringify(ev) + '\n');
        }
      } catch (e) {
        res.write(JSON.stringify({ error: e.isUser ? e.message : 'خطأ غير متوقع: ' + e.message }) + '\n');
      } finally {
        syncRunning = false;
        res.end();
      }
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    try { sendJSON(res, 500, { error: e.isUser ? e.message : 'خطأ داخلي: ' + e.message }); } catch {}
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  يبدو أن النظام يعمل بالفعل — افتح المتصفح على: http://' + HOST + ':' + PORT);
    if (process.argv.includes('--open')) {
      execFile('cmd', ['/c', 'start', '', 'http://' + HOST + ':' + PORT]);
    }
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error('تعذّر تشغيل الخادم:', e.message);
    process.exit(1);
  }
});

initStore().then(() => {
  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log('');
    console.log('  ✅ سجل ' + (LOCKED ? ACCOUNT_NAMES[LOCKED] + ' (سستم مقفول على هذا الحساب)' : 'حوالات P2P') + ' يعمل الآن' + (USE_SUPABASE ? '  (التخزين: Supabase)' : ''));
    console.log('  العنوان: http://' + shownHost + ':' + PORT);
    console.log('  لإيقاف النظام أغلق هذه النافذة أو اضغط Ctrl+C');
    console.log('');
    if (process.argv.includes('--open')) {
      execFile('cmd', ['/c', 'start', '', 'http://127.0.0.1:' + PORT]);
    }
  });
}).catch((e) => {
  console.error('تعذّر تحميل التخزين عند الإقلاع:', e.message);
  process.exit(1);
});
