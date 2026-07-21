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
const KV_FILES = {
  orders: path.join(DATA_DIR, 'orders.json'),
  transfers: path.join(DATA_DIR, 'transfers.json'),
  config: path.join(DATA_DIR, 'config.json'),
};
const DEFAULT_CONFIG = { apiKey: '', apiSecret: '', baseUrl: 'https://api.binance.com', months: 12, lastSync: null, auth: {} };

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
  try { return JSON.parse(fs.readFileSync(KV_FILES[key], 'utf8')); } catch { return fallback; }
}
async function saveStore(key, obj) {
  if (USE_SUPABASE) { await sbSet(key, obj); return; }
  const file = KV_FILES[key];
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

/** الحالة في الذاكرة (تُملأ من التخزين عند الإقلاع في initStore) */
let orders = {};       // الطلبات مفهرسة برقم الطلب
let transfers = {};    // الإيداع/السحب مفهرسة بمعرّف فريد
let config = Object.assign({}, DEFAULT_CONFIG);

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

/** تحميل البيانات من التخزين عند الإقلاع، وضبط كلمات السر من متغيرات البيئة إن لزم */
async function initStore() {
  orders = await loadStore('orders', {});
  transfers = await loadStore('transfers', {});
  config = Object.assign({}, DEFAULT_CONFIG, await loadStore('config', {}));
  if (!config.auth || typeof config.auth !== 'object') config.auth = {};
  config.auth.admin = config.auth.admin || {};
  config.auth.user = config.auth.user || {};

  // عند النشر: إن لم تُضبط كلمة سر بعد، خذها من متغيرات البيئة (يحمي الرابط العام من أول لحظة)
  let changed = false;
  if (!config.auth.admin.hash && process.env.ADMIN_PASSWORD) {
    config.auth.admin = makeCredential(process.env.ADMIN_PASSWORD);
    changed = true;
  }
  if (!config.auth.user.hash && process.env.USER_PASSWORD) {
    config.auth.user = makeCredential(process.env.USER_PASSWORD);
    changed = true;
  }
  if (changed) { try { await saveStore('config', config); } catch (e) { console.error(e.message); } }
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
  const prev = orders[o.orderNumber];
  if (!prev) { orders[o.orderNumber] = o; return 'added'; }
  // بيانات المنصة أوثق من الإدخال اليدوي، مع الحفاظ على الملاحظة والإشاري (إدخال المستخدم)
  if (prev.note && !o.note) o.note = prev.note;
  if (prev.reference && !o.reference) o.reference = prev.reference;
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

/** إدراج/تحديث حوالة. يُرجع 'added' أو 'updated' أو 'same' */
function upsertTransfer(t) {
  if (!t.id || t.id === 'D' || t.id === 'W') return 'same';
  const has = Object.prototype.hasOwnProperty.call(transfers, t.id);
  const prev = has ? transfers[t.id] : null;
  if (!prev) { transfers[t.id] = t; return 'added'; }
  // الحفاظ على إدخال المستخدم (الملاحظة والإشاري) عند إعادة المزامنة
  if (prev.note && !t.note) t.note = prev.note;
  if (prev.reference && !t.reference) t.reference = prev.reference;
  const changed = JSON.stringify(prev) !== JSON.stringify(t);
  transfers[t.id] = t;
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
  if (!r.ok) throw userError('استجابة غير متوقعة من المنصة (HTTP ' + r.status + ')');
  const j = await r.json();
  return Number(j.serverTime) - Date.now();
}

async function signedGet(base, endpoint, params, offset, method = 'GET') {
  const qs = new URLSearchParams({});
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set('recvWindow', '30000');
  qs.set('timestamp', String(Date.now() + offset));
  const signature = crypto.createHmac('sha256', config.apiSecret).update(qs.toString()).digest('hex');
  const url = base + endpoint + '?' + qs.toString() + '&signature=' + signature;

  let r;
  try {
    r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': config.apiKey }, signal: AbortSignal.timeout(30000) });
  } catch {
    throw userError('انقطع الاتصال أثناء الجلب — أعد المحاولة');
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    const code = j && typeof j.code === 'number' ? j.code : null;
    if (code === -2014 || code === -2015) throw userError('المنصة رفضت مفتاح API — تأكّد من صحة المفتاح ومن تفعيل صلاحية «إتاحة القراءة»');
    if (code === -1022) throw userError('التوقيع غير صحيح — تأكّد من المفتاح السري (Secret Key)');
    if (code === -1021) throw userError('فرق توقيت بين جهازك والمنصة — أعد المحاولة، وإن تكرر اضبط ساعة الجهاز');
    if (r.status === 429 || r.status === 418) throw userError('تم تجاوز حد الطلبات مؤقتًا — انتظر دقيقة ثم أعد المحاولة');
    if (r.status === 451 || r.status === 403) throw userError('الوصول محجوب من هذه المنطقة — جرّب VPN أو غيّر عنوان الخادم من الإعدادات');
    throw userError('خطأ من المنصة: ' + (j && (j.msg || j.message) ? (j.msg || j.message) : 'HTTP ' + r.status));
  }
  if (j && j.success === false) throw userError('خطأ من المنصة: ' + (j.message || j.code || 'غير معروف'));
  return j || {};
}

const dayLabel = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * مزامنة شاملة: طلبات P2P (بيع/شراء) + سجل الإيداع + سجل السحب، على نوافذ زمنية،
 * وتبثّ تقدّم العملية سطرًا-بسطر (NDJSON). أي بيانات جُلبت تُحفظ حتى لو فشلت
 * المزامنة في منتصفها (بفضل كتلة finally) فلا يضيع ما نزل.
 */
async function* syncGenerator() {
  if (!config.apiKey || !config.apiSecret) {
    throw userError('لم يتم حفظ مفتاح API بعد — افتح الإعدادات وأدخل المفتاحين أولًا');
  }
  const base = (config.baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
  yield { msg: 'جارٍ الاتصال بالمنصة والتحقق من التوقيت…', pct: 1 };
  const offset = await timeOffset(base);

  const now = Date.now();
  const months = Math.min(Math.max(Number(config.months) || 12, 1), 36);
  const minStart = now - months * 30 * 86400000;
  const p2pWindows = makeWindows(now, minStart, 29 * 86400000); // C2C: أقصى نافذة 30 يومًا
  const txWindows = makeWindows(now, minStart, 89 * 86400000);  // الإيداع/السحب: أقصى نافذة 90 يومًا

  let added = 0, updated = 0, fetched = 0;
  let depAdded = 0, wdAdded = 0, txUpdated = 0;
  let step = 0;
  const totalSteps = p2pWindows.length * 2 + txWindows.length * 2;
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

    config.lastSync = Date.now();
    Object.assign(result, {
      added, updated, fetched, depAdded, wdAdded, txUpdated,
      total: Object.keys(orders).length,
      totalTx: Object.keys(transfers).length,
      lastSync: config.lastSync,
    });
  } finally {
    // نحفظ ما جُلب حتى الآن مهما حدث (نجاح كامل أو فشل جزئي)
    await saveStore('orders', orders);
    await saveStore('transfers', transfers);
    await saveStore('config', config);
  }
  yield result;
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

    /* ---------- المصادقة ---------- */
    if (p === '/api/auth/status' && req.method === 'GET') {
      sendJSON(res, 200, { configured: isConfigured(), hasUser: !!(config.auth.user && config.auth.user.hash) });
      return;
    }

    if (p === '/api/auth/setup' && req.method === 'POST') {
      if (isConfigured()) { sendJSON(res, 409, { error: 'تم الإعداد مسبقًا — سجّل الدخول' }); return; }
      const body = await readBody(req);
      const ap = String(body.adminPassword || '');
      const up = String(body.userPassword || '');
      if (ap.length < 4) { sendJSON(res, 400, { error: 'كلمة سر المسؤول يجب ألا تقل عن 4 خانات' }); return; }
      config.auth.admin = makeCredential(ap);
      config.auth.user = up ? makeCredential(up) : {};
      await saveStore('config', config);
      const token = newToken('admin');
      sendJSON(res, 200, { ok: true, token, role: 'admin' });
      return;
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const role = body.role === 'admin' ? 'admin' : 'user';
      const cred = role === 'admin' ? config.auth.admin : config.auth.user;
      if (!cred || !cred.hash) { sendJSON(res, 400, { error: role === 'user' ? 'لا يوجد حساب مستخدم — ادخل كمسؤول' : 'لم يتم الإعداد بعد' }); return; }
      if (!verifyPassword(String(body.password || ''), cred)) { sendJSON(res, 401, { error: 'كلمة السر غير صحيحة' }); return; }
      const token = newToken(role);
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
      await saveStore('config', config);
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* ---------- بوابة الصلاحيات ---------- */
    const role = roleOf(req);
    const gate = (list) => list.some((x) => x[0] === req.method && x[1] === p);
    const ADMIN_ROUTES = [
      ['POST', '/api/orders'], ['DELETE', '/api/orders'], ['POST', '/api/orders/bulk'],
      ['POST', '/api/orders/clear'], ['POST', '/api/orders/annotate'],
      ['POST', '/api/transfers/clear'], ['POST', '/api/transfers/annotate'],
      ['POST', '/api/settings'],
    ];
    const LOGIN_ROUTES = [
      ['POST', '/api/sync'], ['GET', '/api/balance'],
      ['GET', '/api/orders'], ['GET', '/api/transfers'], ['GET', '/api/settings'],
    ];
    if (gate(ADMIN_ROUTES) && role !== 'admin') { sendJSON(res, 403, { error: 'هذه العملية للمسؤول فقط' }); return; }
    if (gate(LOGIN_ROUTES) && !role) { sendJSON(res, 401, { error: 'يلزم تسجيل الدخول' }); return; }

    /* ---------- الطلبات ---------- */
    if (p === '/api/orders' && req.method === 'GET') {
      sendJSON(res, 200, { orders: Object.values(orders), lastSync: config.lastSync });
      return;
    }

    if (p === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      const o = normalizeOrder(body, 'manual');
      if (!(o.amount > 0)) { sendJSON(res, 400, { error: 'الكمية مطلوبة ويجب أن تكون أكبر من صفر' }); return; }
      if (!(o.totalPrice > 0)) { sendJSON(res, 400, { error: 'المبلغ مطلوب ويجب أن يكون أكبر من صفر' }); return; }
      const r = upsertOrder(o);
      await saveStore('orders', orders);
      sendJSON(res, 200, { result: r, order: o });
      return;
    }

    if (p === '/api/orders/bulk' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.orders) ? body.orders : [];
      let added = 0, updated = 0, skipped = 0;
      for (const raw of list) {
        const o = normalizeOrder(raw, raw.source === 'binance' ? 'binance' : 'import');
        if (!(o.amount > 0) || !(o.totalPrice > 0)) { skipped++; continue; }
        const r = upsertOrder(o);
        if (r === 'added') added++;
        else if (r === 'updated') updated++;
      }
      await saveStore('orders', orders);
      sendJSON(res, 200, { added, updated, skipped, total: Object.keys(orders).length });
      return;
    }

    if (p === '/api/orders' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      if (!orders[id]) { sendJSON(res, 404, { error: 'الطلب غير موجود' }); return; }
      delete orders[id];
      await saveStore('orders', orders);
      sendJSON(res, 200, { ok: true, total: Object.keys(orders).length });
      return;
    }

    if (p === '/api/orders/clear' && req.method === 'POST') {
      orders = {};
      await saveStore('orders', orders);
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
      await saveStore('orders', orders);
      sendJSON(res, 200, { ok: true, order: o });
      return;
    }

    /* ---------- الإيداع والسحب ---------- */
    if (p === '/api/transfers' && req.method === 'GET') {
      sendJSON(res, 200, { transfers: Object.values(transfers), lastSync: config.lastSync });
      return;
    }

    if (p === '/api/transfers/clear' && req.method === 'POST') {
      transfers = {};
      await saveStore('transfers', transfers);
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
      await saveStore('transfers', transfers);
      sendJSON(res, 200, { ok: true, transfer: t });
      return;
    }

    /* ---------- رصيد محفظة التمويل (جلب مباشر) ---------- */
    if (p === '/api/balance' && req.method === 'GET') {
      if (!config.apiKey || !config.apiSecret) {
        sendJSON(res, 400, { error: 'أدخل مفتاح API من الإعدادات أولًا لعرض الرصيد' });
        return;
      }
      const base = (config.baseUrl || 'https://api.binance.com').replace(/\/+$/, '');
      const offset = await timeOffset(base);
      const assets = await signedGet(base, '/sapi/v1/asset/get-funding-asset', { needBtcValuation: 'true' }, offset, 'POST');
      sendJSON(res, 200, { assets: Array.isArray(assets) ? assets : [], updatedAt: Date.now() });
      return;
    }

    /* ---------- الإعدادات ---------- */
    if (p === '/api/settings' && req.method === 'GET') {
      const k = config.apiKey || '';
      sendJSON(res, 200, {
        apiKeyMasked: k ? k.slice(0, 4) + '…' + k.slice(-4) : '',
        hasSecret: !!config.apiSecret,
        baseUrl: config.baseUrl,
        months: config.months,
        lastSync: config.lastSync,
      });
      return;
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) config.apiKey = body.apiKey.trim();
      if (typeof body.apiSecret === 'string' && body.apiSecret.trim()) config.apiSecret = body.apiSecret.trim();
      if (typeof body.baseUrl === 'string' && /^https:\/\/[\w.-]+$/.test(body.baseUrl.trim().replace(/\/+$/, ''))) {
        config.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
      }
      if (body.months != null) config.months = Math.min(Math.max(Number(body.months) || 12, 1), 36);
      await saveStore('config', config);
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* ---------- المزامنة (بث التقدم NDJSON) ---------- */
    if (p === '/api/sync' && req.method === 'POST') {
      if (syncRunning) { sendJSON(res, 409, { error: 'هناك مزامنة قيد التنفيذ بالفعل' }); return; }
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
    console.log('  ✅ سجل حوالات P2P يعمل الآن' + (USE_SUPABASE ? '  (التخزين: Supabase)' : ''));
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
