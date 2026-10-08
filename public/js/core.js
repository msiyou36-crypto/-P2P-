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
  // الشريط العلوي والقائمة
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  // النوافذ والأدوات
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  fileup: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6M15 15l-3-3-3 3"/>',
  sheet: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2M14 13h2M8 17h2M14 17h2"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  idcard: '<rect width="20" height="14" x="2" y="5" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16c.6-1.3 1.7-2 3-2s2.4.7 3 2M14 10h5M14 14h3"/>',
  userx: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5M22 8l-5 5"/>',
  list: '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  undo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',   // سهم الرجوع نحو اليمين: «الوراء» في الواجهة العربية
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  swap: '<path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
  // الأدوار
  crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};
/** أيقونة كل دور (الشارة أعلى الصفحة، وسجل الدخول، ونافذة كلمات السر) */
const ROLE_SVG = { admin: 'crown', user: 'user', user2: 'pencil' };
function svgIcon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  s.innerHTML = ICONS[name] || '';
  return s;
}
/** عناصر الصفحة الثابتة تطلب أيقونتها بالسمة: data-icon في أولها، وdata-icon-end في آخرها */
function decorateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) if (!el.querySelector(':scope > .ic')) el.prepend(svgIcon(el.dataset.icon));
  for (const el of root.querySelectorAll('[data-icon-end]')) if (!el.querySelector(':scope > .ic-end')) el.append(svgIcon(el.dataset.iconEnd, 'ic-end'));
}
/** زرٌّ بأيقونة ونصٍّ في <span>، فيتغيّر نصّه (btn.lbl.textContent) دون أن تضيع أيقونته */
function iconButton(cls, icon, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.lbl = document.createElement('span');
  b.lbl.textContent = text || '';
  b.append(svgIcon(icon), b.lbl);
  return b;
}

/* ============================ حقول النماذج ============================ */

/** منطقة اختيار ملف: نقرٌ يفتح الاختيار، أو سحبُ ملفٍ وإفلاته عليها؛ واسم الملف يظهر فيها */
function wireDropzone(zone, onFile) {
  const input = zone.querySelector('input[type="file"]');
  const shown = () => {
    const f = input.files && input.files[0];
    const name = zone.querySelector('.dz-file');
    zone.classList.toggle('has-file', !!f);
    name.hidden = !f;
    name.textContent = f ? f.name : '';
    if (f && onFile) onFile(f);
  };
  input.addEventListener('change', shown);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    if (e.dataTransfer && e.dataTransfer.files.length) { input.files = e.dataTransfer.files; shown(); }
  });
}
function resetDropzone(zone) {
  zone.querySelector('input[type="file"]').value = '';
  zone.classList.remove('has-file', 'is-over');
  const name = zone.querySelector('.dz-file');
  name.hidden = true;
  name.textContent = '';
}

/** زرّ العين بجانب حقل كلمة السر: يُظهرها ويُخفيها */
function setPwVisible(btn, show) {
  const inp = btn.parentElement.querySelector('input');
  inp.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.textContent = '';
  btn.append(svgIcon(show ? 'eyeoff' : 'eye'));
}
function wirePwToggles(root = document) {
  for (const b of root.querySelectorAll('.pw-toggle')) {
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setPwVisible(b, b.getAttribute('aria-pressed') !== 'true'));
  }
}
/** عند فتح النافذة من جديد تعود كلمات السر مخفيّة */
function hidePasswords(root) { for (const b of root.querySelectorAll('.pw-toggle')) setPwVisible(b, false); }

/* ============================ عناصر صغيرة ============================ */

/** عنصرٌ بفئةٍ ونصّ */
function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
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
/** صفّ «مفتاح: قيمة» في نوافذ التفاصيل؛ opts.copy زرّ نسخ */
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

function openModal(id) {
  $(id).classList.remove('hidden');
  requestAnimationFrame(() => $$(id + ' .modal-body').forEach(updateScrollHint));
}
/* النوافذ بلا شريط تمرير ظاهر: تُصمَّم لتظهر كاملة، فإن زاد محتواها عن الشاشة (الهاتف، أو
   نتيجة فحصٍ طويلة) تلاشى طرفها السفلي إشارةً إلى أن تحته المزيد، ويُمرَّر بالعجلة أو اللمس */
function updateScrollHint(body) {
  body.classList.toggle('has-more', body.scrollTop + body.clientHeight < body.scrollHeight - 4);
}
function wireScrollHints() {
  for (const body of $$('.modal-body')) {
    const upd = () => updateScrollHint(body);
    body.addEventListener('scroll', upd, { passive: true });
    new MutationObserver(() => requestAnimationFrame(upd)).observe(body, { childList: true, subtree: true });
  }
  window.addEventListener('resize', () => $$('.backdrop:not(.hidden) .modal-body').forEach(updateScrollHint));
}
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
