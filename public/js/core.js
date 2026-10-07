/* سجل حوالات P2P — الواجهة (بلا أي مكتبة)
 * الملفات تُحمَّل بالترتيب في index.html وتتشارك النطاق العام:
 *   core.js     الحالة، التنسيق، الثوابت، الاتصال بالخادم، النوافذ والتنبيهات   (هذا الملف)
 *   balance.js  عمود «الباقي من USDT»: السلسلة والمراسي والتثبيت، وبطاقة الرصيد
 *   session.js  الدخول والأدوار، تحميل البيانات، سمة السستم، وضع الصيانة
 *   filters.js  اليوم المحاسبي والفلاتر وبناء الجدول الموحّد
 *   charts.js   بطاقات الأرقام والرسوم البيانية
 *   table.js    صفّ الجدول وخاناته القابلة للتحرير ونوافذ التفاصيل
 *   views.js    شكل عرض العمليات (جدول، يومي، بطاقات، مربعات) والصفحات والفرز
 *   sync.js     المزامنة وقفل الحظر وقراءة البثّ
 *   tools.js    أدوات المسؤول: الفحص، جلب يوم، الاستعادة، الإضافة، الاستيراد/التصدير، الإعدادات
 *   main.js     ربط الأحداث والبداية
 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const SVGNS = 'http://www.w3.org/2000/svg';

/* ============================ الحالة ============================ */

const state = {
  auth: { role: null, token: null },
  orders: [],         // كل الطلبات كما جاءت من الخادم (الأحدث أولًا)
  transfers: [],      // كل الحوالات (بلا التحويل الداخلي بين الفوري والتمويل)
  filtered: [],       // طلبات P2P بعد الفلترة
  filteredTx: [],     // حوالات بعد الفلترة
  ledger: [],         // القائمة الموحّدة للجدول
  // عمود «الباقي من USDT» (تملؤه computeBalanceMap)
  balMap: null,       // معرّف الصف → الباقي بعده
  balGap: 0,          // مقدار الحركة الناقصة من السجل
  balGapAt: 0,        // وقت المرساة — العملية الناقصة وقعت بعده
  balGapOut: true,    // هل الناقص حركة خرج (بيع/سحب) أم دخل (إيداع/شراء)
  balNeedsWallet: false, // العمود فارغ لأن الرصيد لم يُجلب ولا مرساة
  balAnchorOld: false, // المرساة الوحيدة أقدم من نافذة الحساب
  balFloating: false, // العمود مثبَّت على الرصيد الحالي فيتغيّر مع كل عملية جديدة
  balSettledTo: 0,    // حدُّ ما يصلح تثبيته (أكّدته قراءةُ رصيد)
  balFrozenBroken: false, // أرقامٌ مثبَّتة لا يفسّرها الدفتر → تُصلَّح تلقائيًا
  balSnaps: [],       // لقطات الرصيد اليومية
  balAbsurd: null,    // عملية بكمية غير معقولة تُفسد العمود
  balBroke: false,    // السلسلة نزلت تحت الصفر: دخلٌ لم يصل
  balBrokeAt: 0,
  balBrokeMissing: 0,
  balBrokeRows: 0,
  balance: null,      // ردّ /api/balance
  balanceLoading: false,
  balanceError: null,
  settings: { apiKeyMasked: '', hasSecret: false, baseUrl: '', rangeHours: 720, syncQuota: 3, lastSync: null, lastSyncBy: {} },
  syncQuota: { unlimited: true, quota: 0, used: 0, left: null },
  account: { active: 'p2p', name: 'حوالات P2P', list: [], locked: false },
  themeAccent: '#f0b90b',
  filters: { range: '1', from: null, to: null, type: 'all', status: 'all', fiat: 'all', q: '' },
  sort: { key: '_t', dir: -1 },
  page: 1,
  view: 'table',      // شكل عرض العمليات: table | daily | cards | tiles (يُحفظ في المتصفح)
  detailsOrder: null,
  importRows: null,
  showArchive: false, // عرض المؤرشَف وحده بدل الجدول العادي (للمسؤول)
  syncing: false,
};
const PAGE_SIZE = 50;

/* ============================ تنسيق ============================ */

const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nfp = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });   // سعر الصرف: خانتان
const fmt2 = (n) => nf2.format(n || 0);
const fmt0 = (n) => nf0.format(n || 0);
const fmt2p = (n) => nfp.format(n || 0);
const pad2 = (n) => String(n).padStart(2, '0');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function fmtDT(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDTsec(ms) { return fmtDT(ms) + ':' + pad2(new Date(ms).getSeconds()); }
function compactNum(v) {
  if (v >= 1e6) return nf2.format(v / 1e6) + 'M';
  if (v >= 1e4) return nf0.format(v / 1e3) + 'K';
  return nf0.format(v);
}

// العمولة = ما تُرجعه المنصة فقط (الخادم يحسبها من فرق amount/takerAmount)
const effComm = (o) => (o.commission > 0 ? o.commission : 0);
// كمية USDT شاملة العمولة (= «عبر العملات الرقمية» في Binance)
const grossUSDT = (o) => (o.amount || 0) + effComm(o);
// السعر والمبلغ الفعّالان: تعديل المستخدم إن وُجد، وإلا قيمة المنصة
const effUnitPrice = (o) => (o.unitPriceOverride != null ? o.unitPriceOverride : (o.unitPrice || 0));
const effTotalPrice = (o) => (o.totalPriceOverride != null ? o.totalPriceOverride : (o.totalPrice || 0));

/* ============================ ثوابت العرض ============================ */

const TYPE_INFO = {
  SELL: { ar: 'بيع', color: 'var(--sell)' },
  BUY: { ar: 'شراء', color: 'var(--buy)' },
};
const STATUS_INFO = {
  COMPLETED: { ar: 'مكتمل', color: 'var(--good)' },
  CANCELLED: { ar: 'ملغى', color: 'var(--muted)' },
  CANCELLED_BY_SYSTEM: { ar: 'ملغى تلقائيًا', color: 'var(--muted)' },
  IN_APPEAL: { ar: 'تحكيم', color: 'var(--serious)' },
  TRADING: { ar: 'جارٍ التنفيذ', color: 'var(--warn)' },
  BUYER_PAYED: { ar: 'بانتظار التأكيد', color: 'var(--warn)' },
  PENDING: { ar: 'قيد الانتظار', color: 'var(--warn)' },
  DISTRIBUTING: { ar: 'جارٍ التحويل', color: 'var(--warn)' },
};
const statusInfo = (s) => STATUS_INFO[s] || { ar: s, color: 'var(--warn)' };
const SOURCE_AR = { binance: 'من المنصة', manual: 'إدخال يدوي', import: 'مستورد' };
const isCancelled = (s) => s === 'CANCELLED' || s === 'CANCELLED_BY_SYSTEM';

const TX_KIND = {
  deposit: { ar: 'إيداع', color: 'var(--good)' },
  withdraw: { ar: 'سحب', color: 'var(--critical)' },
  'pay-out': { ar: 'إرسال Pay', color: 'var(--critical)' },
  'pay-in': { ar: 'استلام Pay', color: 'var(--good)' },
  'convert-out': { ar: 'تحويل (USDT→)', color: 'var(--critical)' },
  'convert-in': { ar: 'تحويل (→USDT)', color: 'var(--good)' },
  'spot-buy': { ar: 'شراء فوري', color: 'var(--critical)' },
  'spot-sell': { ar: 'بيع فوري', color: 'var(--good)' },
};
const txKindAr = (k) => (TX_KIND[k] ? TX_KIND[k].ar : k);
const isPayKind = (k) => k === 'pay-out' || k === 'pay-in';
const isConvertKind = (k) => k === 'convert-out' || k === 'convert-in';
const isSpotKind = (k) => k === 'spot-buy' || k === 'spot-sell';
// التحويل بين الفوري والتمويل ليس عمليةً ولا يؤثر على «الباقي»؛ قد تبقى صفوف منه من مزامنة قديمة
const isInternalKind = (k) => k === 'internal-out' || k === 'internal-in';
const TX_STATUS = {
  COMPLETED: { ar: 'مكتمل', color: 'var(--good)' },
  PENDING: { ar: 'قيد المعالجة', color: 'var(--warn)' },
  FAILED: { ar: 'فاشل/مرفوض', color: 'var(--critical)' },
  CANCELLED: { ar: 'ملغى', color: 'var(--muted)' },
};
const txStatusInfo = (s) => TX_STATUS[s] || { ar: s, color: 'var(--warn)' };

/* ===== عمليةٌ واحدة كما تُعرض (طلب P2P أو حوالة) — للجدول والبطاقات والمربعات ===== */
const typeInfoOf = (it, isP2P) => (isP2P ? TYPE_INFO[it.tradeType] : (TX_KIND[it.kind] || { ar: it.kind, color: 'var(--muted)' }));
const statusOf = (it, isP2P) => (isP2P ? statusInfo(it.orderStatus) : txStatusInfo(it.status));
/** قيمتها كما تدخل الدفتر: P2P شاملةً العمولة، والحوالة بتقويمها اليدوي بالـUSDT إن وُجد */
const usdtOf = (it, isP2P) => (isP2P ? grossUSDT(it) : (it.usdtValue != null ? it.usdtValue : (it.amount || 0)));
const unitOf = (it, isP2P) => (isP2P || it.usdtValue != null ? 'USDT' : (it.coin || 'USDT'));
const opId = (it, isP2P) => (isP2P ? it.orderNumber : (it.txId || it.id));
/** ملغاةٌ أو فاشلة: تُخفَّف في البطاقات (المعلّقة تبقى ظاهرة لأنها تنتظر انتباهك) */
const isVoid = (it, isP2P) => (isP2P ? isCancelled(it.orderStatus) : (it.status === 'CANCELLED' || it.status === 'FAILED'));
const WALLET_AR = { 0: 'الحساب الفوري (Spot)', 1: 'محفظة التمويل (Funding)' };
const shortId = (s) => { s = String(s || ''); return s.length > 18 ? s.slice(0, 10) + '…' + s.slice(-6) : s; };
// معرّفات المنصة عشرون رقمًا: أربعةٌ من كل طرف تكفي للتمييز في الجدول، والكامل في التلميح والتفاصيل
const tinyId = (s) => { s = String(s || ''); return s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : s; };

const ROLE_NAMES = { admin: 'مسؤول', user: 'مستخدم', user2: 'مستخدم 2' };
const ROLE_ICONS = { admin: '👑', user: '👁️', user2: '✏️' };
const canEdit = () => state.auth.role === 'admin';
// «مستخدم 2» يكتب الإشاري والملاحظة والسعر والمبلغ (تصحيحاتُ صفٍّ واحد)؛ ما يمسّ الدفتر كلّه للمسؤول
const canAnnotate = () => state.auth.role === 'admin' || state.auth.role === 'user2';

/* العملات المحلية */
const FIAT_INFO = {
  SDG: { sym: 'ج.س', name: 'جنيه سوداني' },
  EGP: { sym: 'ج.م', name: 'جنيه مصري' },
  SAR: { sym: 'ر.س', name: 'ريال سعودي' },
  AED: { sym: 'د.إ', name: 'درهم إماراتي' },
  USD: { sym: '$', name: 'دولار' },
};
const SYM_TO_CODE = { 'ج.س': 'SDG', 'ج.م': 'EGP', 'ر.س': 'SAR', 'د.إ': 'AED', '$': 'USD' };
function fiatCode(o) {
  const f = String(o.fiat || '').trim();
  if (FIAT_INFO[f.toUpperCase()]) return f.toUpperCase();
  const s = String(o.fiatSymbol || o.fiat || '').trim();
  return SYM_TO_CODE[s] || f.toUpperCase() || s || '';
}
function fiatSymOf(o) {
  const c = fiatCode(o);
  if (FIAT_INFO[c]) return FIAT_INFO[c].sym;
  return String(o.fiatSymbol || o.fiat || '').trim() || 'العملة';
}
const fiatName = (code) => (FIAT_INFO[code] && `${FIAT_INFO[code].name} (${FIAT_INFO[code].sym})`) || code;
const symForCode = (code) => (FIAT_INFO[code] && FIAT_INFO[code].sym) || code;
function dominantFiat(list) {
  const count = {};
  let best = '', bestN = 0;
  for (const o of list) {
    const c = fiatCode(o);
    if (!c) continue;
    count[c] = (count[c] || 0) + 1;
    if (count[c] > bestN) { bestN = count[c]; best = c; }
  }
  return best;
}
function distinctFiats(list) {
  const set = new Set();
  for (const o of list) { const c = fiatCode(o); if (c) set.add(c); }
  return Array.from(set);
}
// عملة Pay المُدخلة يدويًا في عمود «العملة/الشبكة»
function payFiatCode(t) {
  const lbl = String(t.networkLabelOverride || '').trim();
  if (!lbl) return '';
  if (FIAT_INFO[lbl.toUpperCase()]) return lbl.toUpperCase();
  return SYM_TO_CODE[lbl] || '';
}
// عملية Pay إرسال تُعامَل كبيع إن أُدخل لها مبلغ محلي وعملة محلية معروفة
const isPaySale = (t) => t.kind === 'pay-out' && t.status === 'COMPLETED' && t.totalPriceOverride != null && !!payFiatCode(t);

/* ============================ أيقونات ============================
 * أيقونات خطّية (SVG بمقاس 24 وخطّ 2) بدل الرموز التعبيرية، فتأخذ لون النص ومقاسه وتبدو
 * واحدةً على كل جهاز. svgIcon(name) يُرجع عنصرًا جاهزًا. */
const ICONS = {
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  up: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  down: '<path d="M17 7 7 17"/><path d="M17 17H7V7"/>',
  cash: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  trend: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  in: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
  out: '<path d="m18 9-6-6-6 6"/><path d="M12 3v14"/><path d="M5 21h14"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};
function svgIcon(name) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic');
  s.innerHTML = ICONS[name] || '';
  return s;
}

/* ============================ عناصر صغيرة ============================ */

function chip(text, color) {
  const span = document.createElement('span');
  span.className = 'chip';
  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.style.background = color;
  span.append(dot, document.createTextNode(text));
  return span;
}
function tdText(tr, text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  tr.append(td);
  return td;
}
function diagLine(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}
/** صفّ «مفتاح: قيمة» في نوافذ التفاصيل؛ opts.copy زرّ نسخ، opts.hint سطر شرح */
function detailRow(key, value, opts = {}) {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'v';
  if (value instanceof Node) v.append(value); else v.textContent = value;
  if (opts.copy) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'نسخ';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(opts.copy); btn.textContent = 'تم ✓'; setTimeout(() => (btn.textContent = 'نسخ'), 1200); }
      catch { toast('تعذّر النسخ', 'err'); }
    });
    v.append(btn);
  }
  if (opts.hint) {
    const h = document.createElement('span');
    h.className = 'detail-hint';
    h.textContent = opts.hint;
    v.append(h);
  }
  row.append(k, v);
  return row;
}

/* ============================ الاتصال بالخادم ============================ */

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers);
  if (state.auth.token) opts.headers['X-Auth-Token'] = state.auth.token;
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { handleUnauthorized(); throw new Error(j.error || 'انتهت الجلسة — سجّل الدخول من جديد'); }
  if (!r.ok) throw new Error(j.error || 'خطأ في الاتصال بالخادم');
  return j;
}
const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** يقرأ بثّ NDJSON (المزامنة والفحص) سطرًا سطرًا ويستدعي onEvent لكل حدث */
async function readNdjson(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      onEvent(ev);
    }
  }
}
/** يبدأ بثًّا (POST) ويُرجع الردّ بعد التحقق من الجلسة والحالة */
async function openStream(path, body) {
  const headers = {};
  if (state.auth.token) headers['X-Auth-Token'] = state.auth.token;
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: 'POST', headers, body: body != null ? JSON.stringify(body) : undefined });
  if (res.status === 401) { handleUnauthorized(); throw new Error('انتهت الجلسة — سجّل الدخول'); }
  if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'تعذّر البدء'); }
  return res;
}

/* ============================ النوافذ والتنبيهات ============================ */

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function closeAllModals() { $$('.backdrop').forEach((b) => b.classList.add('hidden')); }

let confirmAction = null;
function openConfirm(message, onYes) {
  $('#confirmMsg').textContent = message;
  confirmAction = onYes;
  openModal('#mConfirm');
}

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}
