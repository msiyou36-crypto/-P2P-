/* سجل حوالات P2P — منطق الواجهة (بدون أي مكتبات خارجية) */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const SVGNS = 'http://www.w3.org/2000/svg';

/* ============================ الحالة ============================ */

const state = {
  auth: { role: null, token: null },
  orders: [],
  transfers: [],
  filtered: [],       // طلبات P2P بعد الفلترة
  filteredTx: [],     // حوالات بعد الفلترة
  ledger: [],         // القائمة الموحّدة للجدول
  balance: null,
  balanceLoading: false,
  balanceError: null,
  settings: { apiKeyMasked: '', hasSecret: false, baseUrl: '', months: 12, lastSync: null },
  filters: { range: 'all', from: null, to: null, type: 'all', status: 'all', fiat: 'all', q: '' },
  sort: { key: '_t', dir: -1 },
  page: 1,
  detailsOrder: null,
  importRows: null,
  syncing: false,
};
const PAGE_SIZE = 50;

/* ============================ تنسيق ============================ */

const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt2 = (n) => nf2.format(n || 0);
const fmt0 = (n) => nf0.format(n || 0);
const pad2 = (n) => String(n).padStart(2, '0');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// كمية USDT شاملة العمولة (= «عبر العملات الرقمية» في Binance)
const grossUSDT = (o) => (o.amount || 0) + (o.commission || 0);

function fmtDT(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDTsec(ms) {
  const d = new Date(ms);
  return fmtDT(ms) + ':' + pad2(d.getSeconds());
}
function compactNum(v) {
  if (v >= 1e6) return nf2.format(v / 1e6) + 'M';
  if (v >= 1e4) return nf0.format(v / 1e3) + 'K';
  return nf0.format(v);
}

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

/* أنواع/حالات الإيداع والسحب */
const TX_KIND = {
  deposit: { ar: 'إيداع', color: 'var(--good)' },
  withdraw: { ar: 'سحب', color: 'var(--critical)' },
};
const TX_STATUS = {
  COMPLETED: { ar: 'مكتمل', color: 'var(--good)' },
  PENDING: { ar: 'قيد المعالجة', color: 'var(--warn)' },
  FAILED: { ar: 'فاشل/مرفوض', color: 'var(--critical)' },
  CANCELLED: { ar: 'ملغى', color: 'var(--muted)' },
};
const txStatusInfo = (s) => TX_STATUS[s] || { ar: s, color: 'var(--warn)' };
const WALLET_AR = { 0: 'الحساب الفوري (Spot)', 1: 'محفظة التمويل (Funding)' };
const shortId = (s) => { s = String(s || ''); return s.length > 18 ? s.slice(0, 10) + '…' + s.slice(-6) : s; };

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
function fiatName(code) {
  return (FIAT_INFO[code] && `${FIAT_INFO[code].name} (${FIAT_INFO[code].sym})`) || code;
}
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
const symForCode = (code) => (FIAT_INFO[code] && FIAT_INFO[code].sym) || code;

function chip(text, color) {
  const span = document.createElement('span');
  span.className = 'chip';
  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.style.background = color;
  span.append(dot, document.createTextNode(text));
  return span;
}

/* ============================ الاتصال بالخادم ============================ */

async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers);
  if (state.auth.token) opts.headers['X-Auth-Token'] = state.auth.token;
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { handleUnauthorized(); throw new Error(j.error || 'انتهت الجلسة — سجّل الدخول من جديد'); }
  if (!r.ok) throw new Error(j.error || 'خطأ في الاتصال بالخادم المحلي');
  return j;
}

async function loadOrders() {
  const j = await api('/api/orders');
  state.orders = (j.orders || []).sort((a, b) => b.createTime - a.createTime);
  state.settings.lastSync = j.lastSync;
  populateFiatFilter();
}
async function loadTransfers() {
  const j = await api('/api/transfers');
  state.transfers = (j.transfers || []).sort((a, b) => b.time - a.time);
  state.settings.lastSync = j.lastSync;
}
async function loadSettings() {
  state.settings = await api('/api/settings');
}
const loadAll = () => Promise.all([loadOrders(), loadTransfers(), loadSettings()]);

async function refreshBalance() {
  if (state.balanceLoading) return;
  state.balanceLoading = true;
  state.balanceError = null;
  renderBalance();
  const btn = $('#btnRefreshBal');
  if (btn) btn.disabled = true;
  try {
    state.balance = await api('/api/balance');
  } catch (e) {
    state.balanceError = e.message;
  } finally {
    state.balanceLoading = false;
    if (btn) btn.disabled = false;
    renderBalance();
  }
}

/* ============================ المصادقة ============================ */

const canEdit = () => state.auth.role === 'admin';

function clearSession() {
  state.auth = { role: null, token: null };
  try { sessionStorage.removeItem('p2p_token'); sessionStorage.removeItem('p2p_role'); } catch {}
}

let glitterStop = null;
function stopGlitter() {
  if (glitterStop) { try { glitterStop(); } catch {} glitterStop = null; }
}
function startLoginGlitter() {
  stopGlitter();
  if (typeof Glitter === 'undefined') return;
  try { glitterStop = Glitter.mount($('#loginScreen')); } catch {}
}
function startAppGlitter() {
  stopGlitter();
  if (typeof Glitter === 'undefined') return;
  const el = $('#appGlitter');
  if (!el) return;
  // خلفية هادئة داخل التطبيق: نجوم أقل وسطوع منخفض حتى لا تشوّش على القراءة
  try {
    glitterStop = Glitter.mount(el, {
      particleCount: 240, brightness: 45, trailAmount: 80,
      starSize: 9, speed: 3, glitterIntensity: 2,
    });
  } catch {}
}

function showLogin(configured) {
  $('#app').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  $('#setupForm').classList.toggle('hidden', configured);
  $('#loginForm').classList.toggle('hidden', !configured);
  $('#loginError').textContent = '';
  $('#setupError').textContent = '';
  startLoginGlitter();
  const inp = configured ? $('#loginForm').elements.password : $('#setupForm').elements.adminPassword;
  setTimeout(() => { try { inp.focus(); } catch {} }, 50);
}

function handleUnauthorized() {
  clearSession();
  showLogin(true);
}

function enterApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  startAppGlitter();
  applyRole();
  renderAll();
  renderBalance();
  if (state.settings.hasSecret && state.settings.apiKeyMasked) refreshBalance();
}

function applyRole() {
  const admin = state.auth.role === 'admin';
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !admin));
  const badge = $('#roleBadge');
  badge.textContent = admin ? '● مسؤول' : '● مستخدم';
  badge.classList.toggle('admin', admin);
}

async function checkAuth() {
  let status;
  try { status = await api('/api/auth/status'); } catch { status = { configured: false }; }
  const token = sessionStorage.getItem('p2p_token');
  const role = sessionStorage.getItem('p2p_role');
  if (token && role) {
    state.auth = { token, role };
    try { await loadAll(); enterApp(); return; }
    catch { clearSession(); }
  }
  showLogin(!!status.configured);
}

async function doSetup(e) {
  e.preventDefault();
  const el = $('#setupForm').elements;
  const ap = el.adminPassword.value, up = el.userPassword.value;
  $('#setupError').textContent = '';
  try {
    const j = await api('/api/auth/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: ap, userPassword: up }),
    });
    state.auth = { token: j.token, role: j.role };
    sessionStorage.setItem('p2p_token', j.token);
    sessionStorage.setItem('p2p_role', j.role);
    await loadAll();
    enterApp();
  } catch (err) { $('#setupError').textContent = err.message; }
}

let loginRole = 'admin';
async function doLogin(e) {
  e.preventDefault();
  const password = $('#loginForm').elements.password.value;
  $('#loginError').textContent = '';
  try {
    const j = await api('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: loginRole, password }),
    });
    state.auth = { token: j.token, role: j.role };
    sessionStorage.setItem('p2p_token', j.token);
    sessionStorage.setItem('p2p_role', j.role);
    $('#loginForm').elements.password.value = '';
    await loadAll();
    enterApp();
  } catch (err) { $('#loginError').textContent = err.message; }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearSession();
  location.reload();
}

/* ============================ الفلترة ============================ */

function rangeBounds() {
  const f = state.filters;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (f.range === 'all') return [0, Infinity];
  if (f.range === '1') return [startOfToday, Infinity];
  if (f.range === 'custom') {
    const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : 0;
    const to = f.to ? new Date(f.to + 'T23:59:59.999').getTime() : Infinity;
    return [from, to];
  }
  const days = Number(f.range);
  return [startOfToday - (days - 1) * 86400000, Infinity];
}

function statusMatchOrder(s, filter) {
  if (filter === 'all') return true;
  if (filter === 'COMPLETED') return s === 'COMPLETED';
  if (filter === 'CANCELLED') return isCancelled(s);
  if (filter === 'other') return s !== 'COMPLETED' && !isCancelled(s);
  return false; // PENDING/FAILED خاصة بالحوالات
}
function statusMatchTx(s, filter) {
  if (filter === 'all') return true;
  if (filter === 'COMPLETED') return s === 'COMPLETED';
  if (filter === 'CANCELLED') return s === 'CANCELLED';
  if (filter === 'PENDING') return s === 'PENDING';
  if (filter === 'FAILED') return s === 'FAILED';
  return false; // other خاص بالطلبات
}
function orderMatchesSearch(o, q) {
  return o.orderNumber.toLowerCase().includes(q)
    || (o.counterPart || '').toLowerCase().includes(q)
    || String(o.reference || '').toLowerCase().includes(q)
    || String(o.note || '').toLowerCase().includes(q);
}
function txMatchesSearch(t, q) {
  return String(t.txId || '').toLowerCase().includes(q)
    || String(t.address || '').toLowerCase().includes(q)
    || String(t.coin || '').toLowerCase().includes(q)
    || String(t.network || '').toLowerCase().includes(q)
    || String(t.id || '').toLowerCase().includes(q)
    || String(t.reference || '').toLowerCase().includes(q)
    || String(t.note || '').toLowerCase().includes(q);
}

function applyFilters() {
  const f = state.filters;
  const [from, to] = rangeBounds();
  const q = f.q.trim().toLowerCase();
  const typeIsP2P = f.type === 'SELL' || f.type === 'BUY';
  const typeIsTx = f.type === 'deposit' || f.type === 'withdraw';
  const statusIsTx = f.status === 'PENDING' || f.status === 'FAILED';
  const statusIsOther = f.status === 'other';

  state.filtered = state.orders.filter((o) => {
    if (o.createTime < from || o.createTime > to) return false;
    if (typeIsTx || statusIsTx) return false;
    if (typeIsP2P && o.tradeType !== f.type) return false;
    if (f.fiat !== 'all' && fiatCode(o) !== f.fiat) return false;
    if (!statusMatchOrder(o.orderStatus, f.status)) return false;
    if (q && !orderMatchesSearch(o, q)) return false;
    return true;
  });

  state.filteredTx = state.transfers.filter((t) => {
    if (t.time < from || t.time > to) return false;
    if (typeIsP2P || statusIsOther) return false;
    if (f.fiat !== 'all') return false; // الحوالات بالـ USDT — لا تندرج تحت عملة محلية بعينها
    if (typeIsTx && t.kind !== f.type) return false;
    if (!statusMatchTx(t.status, f.status)) return false;
    if (q && !txMatchesSearch(t, q)) return false;
    return true;
  });

  buildLedger();
}

function ledgerRow(item, kind) {
  if (kind === 'transfer') {
    return { _kind: 'transfer', raw: item, _t: item.time, _type: item.kind, _amount: item.amount, _price: null, _total: null, _status: item.status };
  }
  return { _kind: 'p2p', raw: item, _t: item.createTime, _type: item.tradeType, _amount: item.amount, _price: item.unitPrice, _total: item.totalPrice, _status: item.orderStatus };
}
function buildLedger() {
  const rows = [];
  for (const o of state.filtered) rows.push(ledgerRow(o, 'p2p'));
  for (const t of state.filteredTx) rows.push(ledgerRow(t, 'transfer'));
  state.ledger = rows;
}

function populateFiatFilter() {
  const sel = $('#fFiat');
  if (!sel) return;
  const codes = distinctFiats(state.orders).sort();
  const cur = state.filters.fiat;
  sel.textContent = '';
  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'كل العملات';
  sel.append(optAll);
  for (const c of codes) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = fiatName(c);
    sel.append(opt);
  }
  sel.style.display = codes.length > 1 ? '' : 'none';
  sel.value = (codes.includes(cur) || cur === 'all') ? cur : 'all';
  if (sel.value !== cur) state.filters.fiat = sel.value;
}

/* ============================ بطاقات الأرقام ============================ */

function tileCard(t) {
  const card = document.createElement('div');
  card.className = 'card tile';
  const l = document.createElement('div');
  l.className = 't-label';
  l.textContent = t.label;
  const v = document.createElement('div');
  v.className = 't-value';
  v.textContent = t.value;
  if (t.unit) {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = t.unit;
    v.append(u);
  }
  const s = document.createElement('div');
  s.className = 't-sub';
  s.textContent = t.sub;
  card.append(l, v, s);
  return card;
}

function renderTiles() {
  const wrap = $('#tiles');
  wrap.textContent = '';
  const completed = state.filtered.filter((o) => o.orderStatus === 'COMPLETED');
  const sells = completed.filter((o) => o.tradeType === 'SELL');
  const buys = completed.filter((o) => o.tradeType === 'BUY');
  const sellAmt = sells.reduce((s, o) => s + grossUSDT(o), 0);
  const buyAmt = buys.reduce((s, o) => s + grossUSDT(o), 0);
  const commission = completed.reduce((s, o) => s + (o.commission || 0), 0);

  const fiats = distinctFiats(completed);
  const useFiat = state.filters.fiat !== 'all' ? state.filters.fiat : (dominantFiat(sells) || dominantFiat(completed));
  const fiatSells = sells.filter((o) => fiatCode(o) === useFiat);
  const sellFiat = fiatSells.reduce((s, o) => s + o.totalPrice, 0);
  const fiatSellAmt = fiatSells.reduce((s, o) => s + o.amount, 0);
  const avgPrice = fiatSellAmt > 0 ? sellFiat / fiatSellAmt : 0;
  const sym = symForCode(useFiat) || 'العملة';
  const multi = state.filters.fiat === 'all' && fiats.length > 1;

  const dep = state.filteredTx.filter((t) => t.kind === 'deposit' && t.status === 'COMPLETED' && t.coin === 'USDT');
  const wd = state.filteredTx.filter((t) => t.kind === 'withdraw' && t.status === 'COMPLETED' && t.coin === 'USDT');
  const depSum = dep.reduce((s, t) => s + t.amount, 0);
  const wdSum = wd.reduce((s, t) => s + t.amount, 0);
  const nOps = state.filtered.length + state.filteredTx.length;

  const tiles = [
    { label: 'مبيعات', value: fmt2(sellAmt), unit: 'USDT', sub: `${fmt0(sells.length)} طلب مكتمل` },
    { label: 'مشتريات', value: fmt2(buyAmt), unit: 'USDT', sub: `${fmt0(buys.length)} طلب مكتمل` },
    { label: 'مقبوضات البيع', value: fmt0(sellFiat), unit: sym, sub: multi ? `بعملة ${sym} · اختر العملة للتفصيل` : 'الطلبات المكتملة' },
    { label: 'متوسط سعر البيع', value: avgPrice ? fmt2(avgPrice) : '—', unit: avgPrice ? `${sym}/USDT` : '', sub: multi ? `بعملة ${sym}` : 'مرجّح بالكمية' },
    { label: 'إجمالي الإيداع', value: fmt2(depSum), unit: 'USDT', sub: `${fmt0(dep.length)} عملية مكتملة` },
    { label: 'إجمالي السحب', value: fmt2(wdSum), unit: 'USDT', sub: `${fmt0(wd.length)} عملية مكتملة` },
    { label: 'العمولات', value: fmt2(commission), unit: 'USDT', sub: 'رسوم المنصة' },
    { label: 'عدد العمليات', value: fmt0(nOps), unit: '', sub: `${fmt0(state.filtered.length)} P2P · ${fmt0(state.filteredTx.length)} حوالة` },
  ];
  for (const t of tiles) wrap.append(tileCard(t));
}

/* ============================ الرسوم البيانية ============================ */

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const c = m * Math.pow(10, exp);
    if (c >= v) return c;
  }
  return Math.pow(10, exp + 1);
}
function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function makeBuckets(completed) {
  if (!completed.length) return { unit: 'day', buckets: [] };
  let min = Infinity, max = -Infinity;
  for (const o of completed) {
    if (o.createTime < min) min = o.createTime;
    if (o.createTime > max) max = o.createTime;
  }
  const spanDays = (max - min) / 86400000;
  const unit = spanDays <= 92 ? 'day' : spanDays <= 550 ? 'week' : 'month';
  const keyOf = (t) => {
    const d = new Date(t);
    if (unit === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };
  const next = (t) => {
    const d = new Date(t);
    if (unit === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  };
  const labelOf = (t) => {
    const d = new Date(t);
    if (unit === 'month') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };
  const titleOf = (t) => {
    const d = new Date(t);
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (unit === 'day') return iso;
    if (unit === 'week') return 'أسبوع يبدأ ' + iso;
    return 'شهر ' + `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  };
  const map = new Map();
  const start = keyOf(min), end = keyOf(max);
  for (let t = start; t <= end && map.size < 500; t = next(t)) {
    map.set(t, { t, label: labelOf(t), title: titleOf(t), sell: 0, buy: 0, sellFiat: 0, sellAmt: 0 });
  }
  for (const o of completed) {
    const b = map.get(keyOf(o.createTime));
    if (!b) continue;
    if (o.tradeType === 'SELL') { b.sell += o.amount; b.sellFiat += o.totalPrice; b.sellAmt += o.amount; }
    else b.buy += o.amount;
  }
  return { unit, buckets: Array.from(map.values()) };
}

const tooltipEl = () => $('#tooltip');
function showTooltip(evt, title, rows) {
  const tt = tooltipEl();
  tt.textContent = '';
  const t = document.createElement('div');
  t.className = 'tt-title';
  t.textContent = title;
  tt.append(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    if (r.color) {
      const k = document.createElement('i');
      k.className = 'tt-key';
      k.style.background = r.color;
      row.append(k);
    }
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = r.value;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = r.name;
    row.append(val, name);
    tt.append(row);
  }
  tt.classList.remove('hidden');
  positionTooltip(evt);
}
function positionTooltip(evt) {
  const tt = tooltipEl();
  const pad = 14;
  const r = tt.getBoundingClientRect();
  let x = evt.clientX - r.width - pad;
  if (x < 8) x = evt.clientX + pad;
  let y = evt.clientY - r.height - 10;
  if (y < 8) y = evt.clientY + 16;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}
function hideTooltip() { tooltipEl().classList.add('hidden'); }

function renderVolChart() {
  const el = $('#volChart');
  el.textContent = '';
  const completed = state.filtered.filter((o) => o.orderStatus === 'COMPLETED');
  const { buckets } = makeBuckets(completed);
  if (!buckets.length || buckets.every((b) => b.sell === 0 && b.buy === 0)) {
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = 'لا توجد طلبات مكتملة في هذا النطاق';
    el.append(note);
    return;
  }
  const w = Math.max(el.clientWidth || 0, 320), h = 250;
  const pad = { t: 14, r: 8, b: 26, l: 52 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const yMax = niceMax(Math.max(...buckets.map((b) => b.sell + b.buy)));
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    const y = pad.t + ph - (v / yMax) * ph;
    svg.append(svgEl('line', { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, class: i === 0 ? 'base-line' : 'grid-line' }));
    const txt = svgEl('text', { x: pad.l - 6, y: y + 4, class: 'axis-text', 'text-anchor': 'end' });
    txt.textContent = compactNum(v);
    svg.append(txt);
  }
  const n = buckets.length;
  const band = pw / n;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const GAP = 2;
  const stride = Math.max(1, Math.ceil(n / 6));
  const barGroups = [];
  buckets.forEach((b, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - barW / 2;
    const hSell = (b.sell / yMax) * ph;
    const hBuy = (b.buy / yMax) * ph;
    const group = [];
    const baseY = pad.t + ph;
    if (b.sell > 0) {
      const topmost = !(b.buy > 0);
      const y = baseY - hSell;
      const shape = topmost
        ? svgEl('path', { d: roundedTopRect(x, y, barW, hSell, 4), fill: 'var(--sell)', class: 'bar' })
        : svgEl('rect', { x, y, width: barW, height: hSell, fill: 'var(--sell)', class: 'bar' });
      svg.append(shape);
      group.push(shape);
    }
    if (b.buy > 0) {
      const gap = b.sell > 0 && hBuy > GAP + 1 ? GAP : 0;
      const hb = Math.max(hBuy - gap, 1);
      const y = baseY - hSell - gap - hb;
      const shape = svgEl('path', { d: roundedTopRect(x, y, barW, hb, 4), fill: 'var(--buy)', class: 'bar' });
      svg.append(shape);
      group.push(shape);
    }
    barGroups.push(group);
    if (i % stride === 0) {
      const txt = svgEl('text', { x: cx, y: h - 8, class: 'axis-text', 'text-anchor': 'middle' });
      txt.textContent = b.label;
      svg.append(txt);
    }
  });
  buckets.forEach((b, i) => {
    const hit = svgEl('rect', { x: pad.l + band * i, y: pad.t, width: band, height: ph, fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) => {
      $$('#volChart .bar').forEach((bar) => bar.classList.add('dim'));
      barGroups[i].forEach((bar) => bar.classList.remove('dim'));
      const rows = [];
      if (b.sell > 0) rows.push({ color: 'var(--sell)', value: fmt2(b.sell) + ' USDT', name: 'بيع' });
      if (b.buy > 0) rows.push({ color: 'var(--buy)', value: fmt2(b.buy) + ' USDT', name: 'شراء' });
      if (rows.length === 2) rows.push({ color: '', value: fmt2(b.sell + b.buy) + ' USDT', name: 'الإجمالي' });
      if (!rows.length) rows.push({ color: '', value: '0', name: 'لا حركة' });
      showTooltip(evt, b.title, rows);
    });
    hit.addEventListener('pointerleave', () => {
      $$('#volChart .bar').forEach((bar) => bar.classList.remove('dim'));
      hideTooltip();
    });
    svg.append(hit);
  });
  el.append(svg);
}

function renderPriceChart() {
  const el = $('#priceChart');
  el.textContent = '';
  const completedAll = state.filtered.filter((o) => o.orderStatus === 'COMPLETED');
  const useFiat = state.filters.fiat !== 'all'
    ? state.filters.fiat
    : (dominantFiat(completedAll.filter((o) => o.tradeType === 'SELL')) || dominantFiat(completedAll));
  const completed = completedAll.filter((o) => fiatCode(o) === useFiat);
  const { buckets } = makeBuckets(completed);
  const fiat = symForCode(useFiat) || 'العملة';
  $('#priceUnit').textContent = buckets.some((b) => b.sellAmt > 0) ? `${fiat} / USDT` : '';

  const pts = [];
  buckets.forEach((b, i) => {
    if (b.sellAmt > 0) pts.push({ i, title: b.title, price: b.sellFiat / b.sellAmt });
  });
  if (!pts.length) {
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = 'لا توجد مبيعات مكتملة في هذا النطاق';
    el.append(note);
    return;
  }
  const w = Math.max(el.clientWidth || 0, 320), h = 250;
  const pad = { t: 16, r: 14, b: 26, l: 52 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  let lo = Math.min(...pts.map((p) => p.price));
  let hi = Math.max(...pts.map((p) => p.price));
  let span = hi - lo;
  if (span <= 0) span = Math.max(hi * 0.02, 1);
  lo -= span * 0.25;
  hi += span * 0.25;
  const n = buckets.length;
  const band = pw / n;
  const X = (i) => pad.l + band * i + band / 2;
  const Y = (p) => pad.t + ph - ((p - lo) / (hi - lo)) * ph;
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = pad.t + ph - ((v - lo) / (hi - lo)) * ph;
    svg.append(svgEl('line', { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, class: i === 0 ? 'base-line' : 'grid-line' }));
    const txt = svgEl('text', { x: pad.l - 6, y: y + 4, class: 'axis-text', 'text-anchor': 'end' });
    txt.textContent = compactNum(v);
    svg.append(txt);
  }
  const stride = Math.max(1, Math.ceil(n / 6));
  buckets.forEach((b, i) => {
    if (i % stride === 0) {
      const txt = svgEl('text', { x: X(i), y: h - 8, class: 'axis-text', 'text-anchor': 'middle' });
      txt.textContent = b.label;
      svg.append(txt);
    }
  });
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${X(p.i).toFixed(1)},${Y(p.price).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { d, fill: 'none', stroke: 'var(--sell)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  for (const p of [pts[0], pts[pts.length - 1]]) {
    svg.append(svgEl('circle', { cx: X(p.i), cy: Y(p.price), r: 4.5, fill: 'var(--sell)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  }
  const last = pts[pts.length - 1];
  const lx = Math.min(X(last.i), pad.l + pw - 4);
  const ly = Math.max(Y(last.price) - 10, pad.t + 10);
  const endTxt = svgEl('text', { x: lx, y: ly, class: 'end-label', 'text-anchor': 'end' });
  endTxt.textContent = fmt2(last.price);
  svg.append(endTxt);
  const hoverLine = svgEl('line', { y1: pad.t, y2: pad.t + ph, x1: -9, x2: -9, class: 'hover-line' });
  svg.append(hoverLine);
  const hit = svgEl('rect', { x: pad.l, y: pad.t, width: pw, height: ph, fill: 'transparent' });
  hit.addEventListener('pointermove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    let nearest = pts[0];
    let bd = Infinity;
    for (const p of pts) {
      const dd = Math.abs(X(p.i) - mx);
      if (dd < bd) { bd = dd; nearest = p; }
    }
    hoverLine.setAttribute('x1', X(nearest.i));
    hoverLine.setAttribute('x2', X(nearest.i));
    showTooltip(evt, nearest.title, [{ color: 'var(--sell)', value: fmt2(nearest.price), name: fiat + '/USDT' }]);
  });
  hit.addEventListener('pointerleave', () => {
    hoverLine.setAttribute('x1', -9);
    hoverLine.setAttribute('x2', -9);
    hideTooltip();
  });
  svg.append(hit);
  el.append(svg);
}

function makeTxBuckets(list) {
  if (!list.length) return { unit: 'day', buckets: [] };
  let min = Infinity, max = -Infinity;
  for (const t of list) { if (t.time < min) min = t.time; if (t.time > max) max = t.time; }
  const spanDays = (max - min) / 86400000;
  const unit = spanDays <= 92 ? 'day' : spanDays <= 550 ? 'week' : 'month';
  const keyOf = (t) => {
    const d = new Date(t);
    if (unit === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };
  const next = (t) => {
    const d = new Date(t);
    if (unit === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  };
  const labelOf = (t) => {
    const d = new Date(t);
    if (unit === 'month') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };
  const titleOf = (t) => {
    const d = new Date(t);
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (unit === 'day') return iso;
    if (unit === 'week') return 'أسبوع يبدأ ' + iso;
    return 'شهر ' + `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  };
  const map = new Map();
  const start = keyOf(min), end = keyOf(max);
  for (let t = start; t <= end && map.size < 500; t = next(t)) {
    map.set(t, { t, label: labelOf(t), title: titleOf(t), dep: 0, wd: 0 });
  }
  for (const t of list) {
    const b = map.get(keyOf(t.time));
    if (!b) continue;
    if (t.kind === 'deposit') b.dep += t.amount;
    else b.wd += t.amount;
  }
  return { unit, buckets: Array.from(map.values()) };
}

function renderTxChart() {
  const el = $('#txChart');
  if (!el) return;
  el.textContent = '';
  const done = state.filteredTx.filter((t) => t.status === 'COMPLETED' && t.coin === 'USDT');
  const { buckets } = makeTxBuckets(done);
  if (!buckets.length || buckets.every((b) => b.dep === 0 && b.wd === 0)) {
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = 'لا توجد عمليات إيداع/سحب مكتملة (USDT) في هذا النطاق';
    el.append(note);
    return;
  }
  const w = Math.max(el.clientWidth || 0, 320), h = 250;
  const pad = { t: 14, r: 8, b: 26, l: 52 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const yMax = niceMax(Math.max(...buckets.map((b) => Math.max(b.dep, b.wd))));
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    const y = pad.t + ph - (v / yMax) * ph;
    svg.append(svgEl('line', { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, class: i === 0 ? 'base-line' : 'grid-line' }));
    const txt = svgEl('text', { x: pad.l - 6, y: y + 4, class: 'axis-text', 'text-anchor': 'end' });
    txt.textContent = compactNum(v);
    svg.append(txt);
  }
  const n = buckets.length;
  const band = pw / n;
  const pairW = Math.min(26, Math.max(4, band * 0.6));
  const barW = Math.max(2, (pairW - 2) / 2);
  const baseY = pad.t + ph;
  const stride = Math.max(1, Math.ceil(n / 6));
  const barGroups = [];
  buckets.forEach((b, i) => {
    const cx = pad.l + band * i + band / 2;
    const group = [];
    const specs = [
      { val: b.dep, color: 'var(--good)', dx: -barW / 2 - 1 },
      { val: b.wd, color: 'var(--critical)', dx: barW / 2 + 1 },
    ];
    for (const sp of specs) {
      if (sp.val <= 0) continue;
      const bh = (sp.val / yMax) * ph;
      const x = cx + sp.dx - barW / 2;
      const shape = svgEl('path', { d: roundedTopRect(x, baseY - bh, barW, bh, 3), fill: sp.color, class: 'bar' });
      svg.append(shape);
      group.push(shape);
    }
    barGroups.push(group);
    if (i % stride === 0) {
      const txt = svgEl('text', { x: cx, y: h - 8, class: 'axis-text', 'text-anchor': 'middle' });
      txt.textContent = b.label;
      svg.append(txt);
    }
  });
  buckets.forEach((b, i) => {
    const hit = svgEl('rect', { x: pad.l + band * i, y: pad.t, width: band, height: ph, fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) => {
      $$('#txChart .bar').forEach((bar) => bar.classList.add('dim'));
      barGroups[i].forEach((bar) => bar.classList.remove('dim'));
      const rows = [];
      if (b.dep > 0) rows.push({ color: 'var(--good)', value: fmt2(b.dep) + ' USDT', name: 'إيداع' });
      if (b.wd > 0) rows.push({ color: 'var(--critical)', value: fmt2(b.wd) + ' USDT', name: 'سحب' });
      if (!rows.length) rows.push({ color: '', value: '0', name: 'لا حركة' });
      showTooltip(evt, b.title, rows);
    });
    hit.addEventListener('pointerleave', () => {
      $$('#txChart .bar').forEach((bar) => bar.classList.remove('dim'));
      hideTooltip();
    });
    svg.append(hit);
  });
  el.append(svg);
}

/* ============================ الجدول الموحّد ============================ */

function sortLedger() {
  const { key, dir } = state.sort;
  state.ledger.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

function annotCell(entity, field, kind) {
  const td = document.createElement('td');
  td.className = 'col-note';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'note-input';
  input.value = entity[field] || '';
  input.placeholder = field === 'reference' ? 'إشاري…' : 'ملاحظة…';
  if (canEdit()) {
    input.title = field === 'reference' ? 'الإشاري — يُحفظ تلقائيًا' : 'الملاحظة — تُحفظ تلقائيًا';
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    input.addEventListener('change', () => saveAnnotation(kind, entity, field, input.value, input));
  } else {
    input.readOnly = true;
    input.classList.add('readonly');
    input.title = 'التعديل للمسؤول فقط';
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  td.append(input);
  return td;
}

async function saveAnnotation(kind, entity, field, value, inputEl) {
  entity[field] = value;
  const url = kind === 'transfer' ? '/api/transfers/annotate' : '/api/orders/annotate';
  const id = kind === 'transfer' ? entity.id : entity.orderNumber;
  try {
    await api(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, note: entity.note || '', reference: entity.reference || '' }),
    });
    if (inputEl) { inputEl.classList.add('saved'); setTimeout(() => inputEl.classList.remove('saved'), 900); }
  } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
}

function tdText(tr, text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  tr.append(td);
  return td;
}

function renderTable() {
  sortLedger();
  const tbody = $('#tbody');
  tbody.textContent = '';
  const total = state.ledger.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const slice = state.ledger.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  const hasData = state.orders.length > 0 || state.transfers.length > 0;
  $('#emptyState').classList.toggle('hidden', hasData);
  $('#ledgerTable').style.display = hasData ? '' : 'none';
  $('#pager').style.display = total > PAGE_SIZE ? '' : 'none';

  const mixed = distinctFiats(state.filtered).length > 1;
  $('#tableCount').textContent = total
    ? `${fmt0(total)} عملية`
    : (hasData ? 'لا نتائج مطابقة للفلاتر' : '');

  for (const row of slice) {
    const isP2P = row._kind === 'p2p';
    const it = row.raw;
    const tr = document.createElement('tr');

    tdText(tr, fmtDT(row._t));

    const tdType = document.createElement('td');
    if (isP2P) { const ti = TYPE_INFO[it.tradeType]; tdType.append(chip(ti.ar, ti.color)); }
    else { const ki = TX_KIND[it.kind]; tdType.append(chip(ki.ar, ki.color)); }
    tr.append(tdType);

    tdText(tr, fmt2(isP2P ? grossUSDT(it) : row._amount), 'num strong');
    tdText(tr, isP2P ? fmt2(it.unitPrice) : '—', 'num');
    tdText(tr, isP2P ? (mixed ? fmt0(it.totalPrice) + ' ' + fiatSymOf(it) : fmt0(it.totalPrice)) : '—', 'num strong');
    tdText(tr, isP2P ? fiatSymOf(it) : (it.network || '—'));
    tdText(tr, isP2P ? (it.counterPart || '—') : '—');

    const tdSt = document.createElement('td');
    const si = isP2P ? statusInfo(it.orderStatus) : txStatusInfo(it.status);
    tdSt.append(chip(si.ar, si.color));
    tr.append(tdSt);

    tr.append(annotCell(it, 'reference', isP2P ? 'order' : 'transfer'));
    tr.append(annotCell(it, 'note', isP2P ? 'order' : 'transfer'));

    const tdId = document.createElement('td');
    tdId.className = 'mono';
    tdId.textContent = isP2P ? it.orderNumber : (it.txId ? shortId(it.txId) : it.id);
    tr.append(tdId);

    tr.addEventListener('click', () => (isP2P ? openDetails(it) : openTransferDetails(it)));
    tbody.append(tr);
  }

  $('#pgInfo').textContent = `صفحة ${fmt0(state.page)} من ${fmt0(pages)}`;
  $('#pgPrev').disabled = state.page <= 1;
  $('#pgNext').disabled = state.page >= pages;

  $$('#ledgerTable th').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sort.key) {
      th.classList.add(state.sort.dir === 1 ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

/* ============================ العرض الكامل ============================ */

function renderAll() {
  applyFilters();
  renderTiles();
  renderVolChart();
  renderPriceChart();
  renderTable();
  const ls = state.settings.lastSync;
  $('#lastSync').textContent = ls ? 'آخر مزامنة: ' + fmtDT(ls) : 'لم تتم مزامنة بعد';
}

/* ============================ النوافذ ============================ */

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function closeAllModals() { $$('.backdrop').forEach((b) => b.classList.add('hidden')); }

function detailRow(key, value, opts = {}) {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'v';
  if (value instanceof Node) v.append(value);
  else v.textContent = value;
  if (opts.copy) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'نسخ';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(opts.copy);
        btn.textContent = 'تم ✓';
        setTimeout(() => (btn.textContent = 'نسخ'), 1200);
      } catch { toast('تعذّر النسخ', 'err'); }
    });
    v.append(btn);
  }
  row.append(k, v);
  return row;
}

function annotDetailRow(entity, field, kind, label) {
  const input = document.createElement(field === 'note' ? 'textarea' : 'input');
  if (field === 'note') input.rows = 2; else input.type = 'text';
  input.className = 'detail-annot';
  input.value = entity[field] || '';
  input.placeholder = field === 'reference' ? 'علامة/مرجع خاص بك' : 'ملاحظتك على العملية';
  if (canEdit()) {
    input.addEventListener('change', () => saveAnnotation(kind, entity, field, input.value, input));
  } else {
    input.readOnly = true;
    input.classList.add('readonly');
  }
  return detailRow(label, input);
}

function openDetails(o) {
  state.detailsOrder = o;
  const body = $('#detailsBody');
  body.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'detail-rows';
  const ti = TYPE_INFO[o.tradeType];
  const si = statusInfo(o.orderStatus);
  const fiat = fiatSymOf(o);
  wrap.append(detailRow('النوع', chip(ti.ar + ' ' + o.asset, ti.color)));
  wrap.append(detailRow('الحالة', chip(si.ar, si.color)));
  wrap.append(detailRow('الكمية (شاملة العمولة)', fmt2(grossUSDT(o)) + ' ' + o.asset));
  if (o.commission > 0) {
    wrap.append(detailRow('الرسوم', fmt2(o.commission) + ' ' + o.asset));
    wrap.append(detailRow('الكمية المُحرّرة', fmt2(o.amount) + ' ' + o.asset));
  }
  wrap.append(detailRow('السعر', fmt2(o.unitPrice) + (fiat ? ' ' + fiat : '')));
  wrap.append(detailRow('المبلغ بالعملة المحلية', fmt0(o.totalPrice) + (fiat ? ' ' + fiat : '')));
  wrap.append(detailRow('الطرف الآخر', o.counterPart || '—'));
  if (o.advertisementRole) {
    wrap.append(detailRow('دورك في الطلب', o.advertisementRole === 'MAKER' ? 'معلن (Maker)' : 'منفّذ (Taker)'));
  }
  wrap.append(detailRow('وقت الإنشاء', fmtDTsec(o.createTime)));
  const noSpan = document.createElement('span');
  noSpan.className = 'mono';
  noSpan.textContent = o.orderNumber;
  wrap.append(detailRow('رقم الطلب', noSpan, { copy: o.orderNumber }));
  wrap.append(detailRow('المصدر', SOURCE_AR[o.source] || o.source));
  wrap.append(annotDetailRow(o, 'reference', 'order', 'الإشاري'));
  wrap.append(annotDetailRow(o, 'note', 'order', 'الملاحظة'));
  body.append(wrap);
  openModal('#mDetails');
}

function openTransferDetails(t) {
  const body = $('#txDetailsBody');
  body.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'detail-rows';
  const ki = TX_KIND[t.kind] || { ar: t.kind, color: 'var(--muted)' };
  const si = txStatusInfo(t.status);
  wrap.append(detailRow('النوع', chip(ki.ar + ' ' + (t.coin || ''), ki.color)));
  wrap.append(detailRow('الحالة', chip(si.ar, si.color)));
  wrap.append(detailRow('الكمية', fmt2(t.amount) + ' ' + (t.coin || '')));
  if (t.kind === 'withdraw') {
    wrap.append(detailRow('رسوم الشبكة', fmt2(t.fee) + ' ' + (t.coin || '')));
    wrap.append(detailRow('الإجمالي المخصوم', fmt2(t.amount + (t.fee || 0)) + ' ' + (t.coin || '')));
  }
  wrap.append(detailRow('الشبكة', t.network || '—'));
  if (t.walletType != null && WALLET_AR[t.walletType]) {
    wrap.append(detailRow('المحفظة', WALLET_AR[t.walletType]));
  }
  if (t.address) {
    const addr = document.createElement('span');
    addr.className = 'mono';
    addr.textContent = t.address;
    wrap.append(detailRow('العنوان', addr, { copy: t.address }));
  }
  if (t.txId) {
    const tx = document.createElement('span');
    tx.className = 'mono';
    tx.textContent = shortId(t.txId);
    wrap.append(detailRow('معرّف العملية (TxID)', tx, { copy: t.txId }));
  }
  wrap.append(detailRow('وقت الإنشاء', fmtDTsec(t.time)));
  if (t.completeTime) wrap.append(detailRow('وقت الاكتمال', fmtDTsec(t.completeTime)));
  wrap.append(detailRow('المصدر', SOURCE_AR[t.source] || t.source || 'من المنصة'));
  wrap.append(annotDetailRow(t, 'reference', 'transfer', 'الإشاري'));
  wrap.append(annotDetailRow(t, 'note', 'transfer', 'الملاحظة'));
  body.append(wrap);
  openModal('#mTransfer');
}

let confirmAction = null;
function openConfirm(message, onYes) {
  $('#confirmMsg').textContent = message;
  confirmAction = onYes;
  openModal('#mConfirm');
}

/* ============================ الإضافة اليدوية ============================ */

let totalPriceDirty = false;
function toLocalDatetimeValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function openAdd() {
  const form = $('#addForm');
  form.reset();
  form.elements.dt.value = toLocalDatetimeValue(new Date());
  totalPriceDirty = false;
  openModal('#mAdd');
}
function autoTotal() {
  const form = $('#addForm');
  if (totalPriceDirty) return;
  const amount = parseFloat(form.elements.amount.value);
  const price = parseFloat(form.elements.unitPrice.value);
  if (amount > 0 && price > 0) form.elements.totalPrice.value = Math.round(amount * price * 100) / 100;
}
async function saveAdd() {
  const form = $('#addForm');
  if (!form.reportValidity()) return;
  const el = form.elements;
  const dt = new Date(el.dt.value);
  const fc = el.fiat.value;
  const payload = {
    tradeType: el.tradeType.value,
    createTime: dt.getTime(),
    amount: parseFloat(el.amount.value),
    unitPrice: parseFloat(el.unitPrice.value),
    totalPrice: parseFloat(el.totalPrice.value) || 0,
    fiat: fc,
    fiatSymbol: FIAT_INFO[fc] ? FIAT_INFO[fc].sym : fc,
    counterPart: el.counterPart.value.trim(),
    orderStatus: el.orderStatus.value,
    commission: parseFloat(el.commission.value) || 0,
    orderNumber: el.orderNumber.value.trim(),
    reference: el.reference.value.trim(),
    note: el.note.value.trim(),
    asset: 'USDT',
  };
  try {
    await api('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closeModal('#mAdd');
    toast('تم حفظ الطلب ✓');
    await loadOrders();
    renderAll();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ CSV: تصدير ============================ */

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function ledgerRows() {
  return state.ledger.map((row) => {
    const it = row.raw, isP2P = row._kind === 'p2p';
    return {
      date: fmtDTsec(row._t),
      type: isP2P ? (it.tradeType === 'SELL' ? 'بيع' : 'شراء') : (it.kind === 'deposit' ? 'إيداع' : 'سحب'),
      amount: isP2P ? grossUSDT(it) : it.amount,
      price: isP2P ? it.unitPrice : '',
      total: isP2P ? it.totalPrice : '',
      curNet: isP2P ? fiatSymOf(it) : (it.network || ''),
      party: isP2P ? (it.counterPart || '') : '',
      status: isP2P ? statusInfo(it.orderStatus).ar : txStatusInfo(it.status).ar,
      fee: isP2P ? (it.commission || 0) : (it.fee || 0),
      reference: it.reference || '',
      note: it.note || '',
      id: isP2P ? it.orderNumber : (it.txId || it.id || ''),
    };
  });
}

function exportCSV() {
  if (!state.ledger.length) { toast('لا توجد عمليات ضمن الفلاتر الحالية للتصدير', 'err'); return; }
  const headers = ['التاريخ', 'النوع', 'الكمية USDT', 'السعر', 'المبلغ', 'العملة/الشبكة', 'الطرف الآخر', 'الحالة', 'العمولة/الرسوم', 'الإشاري', 'الملاحظة', 'المعرّف'];
  const lines = [headers.join(',')];
  for (const r of ledgerRows()) {
    lines.push([
      csvCell(r.date), r.type, r.amount, r.price, r.total, csvCell(r.curNet),
      csvCell(r.party), csvCell(r.status), r.fee, csvCell(r.reference), csvCell(r.note), csvCell(r.id),
    ].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `سجل-العمليات-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`تم تصدير ${fmt0(state.ledger.length)} عملية ✓`);
}

function exportXlsx() {
  if (!state.ledger.length) { toast('لا توجد عمليات ضمن الفلاتر الحالية للتصدير', 'err'); return; }
  const columns = [
    { header: 'التاريخ', width: 19, type: 'text' },
    { header: 'النوع', width: 8, type: 'text' },
    { header: 'الكمية (USDT)', width: 13, type: 'number' },
    { header: 'السعر', width: 12, type: 'number' },
    { header: 'المبلغ', width: 16, type: 'number' },
    { header: 'العملة/الشبكة', width: 12, type: 'text' },
    { header: 'الطرف الآخر', width: 16, type: 'text' },
    { header: 'الحالة', width: 12, type: 'text' },
    { header: 'العمولة/الرسوم', width: 12, type: 'number' },
    { header: 'الإشاري', width: 16, type: 'text' },
    { header: 'الملاحظة', width: 22, type: 'text' },
    { header: 'المعرّف / TxID', width: 28, type: 'text' },
  ];
  const rows = ledgerRows().map((r) => [r.date, r.type, r.amount, r.price, r.total, r.curNet, r.party, r.status, r.fee, r.reference, r.note, r.id]);
  const d = new Date();
  XLSXMini.download(`سجل-العمليات-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.xlsx`, 'العمليات', columns, rows);
  toast(`تم تصدير ${fmt0(state.ledger.length)} عملية إلى Excel ✓`);
}

/* ============================ CSV: استيراد ============================ */

function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
  }
  return rows;
}

const HEADER_MAP = {
  orderNumber: ['رقم الطلب', 'المعرّف', 'order number', 'order no', 'orderno', 'order id'],
  tradeType: ['النوع', 'order type', 'type', 'trade type'],
  asset: ['الأصل', 'asset type', 'asset'],
  fiatSymbol: ['العملة', 'العملة/الشبكة', 'fiat type', 'fiat'],
  totalPrice: ['المبلغ', 'total price', 'fiat amount'],
  unitPrice: ['السعر', 'price', 'unit price', 'exchange rate'],
  amount: ['الكمية', 'الكمية usdt', 'quantity', 'crypto amount', 'amount'],
  counterPart: ['الطرف الآخر', 'couterparty', 'counterparty', 'counter party', 'nickname'],
  orderStatus: ['الحالة', 'status'],
  createTime: ['التاريخ', 'created time', 'create time', 'date', 'time'],
  commission: ['العمولة', 'العمولة/الرسوم', 'commission', 'fee', 'maker fee', 'taker fee'],
  reference: ['الإشاري'],
  note: ['الملاحظة', 'ملاحظة', 'note', 'remark'],
};
function mapHeaders(headerRow) {
  const normalized = headerRow.map((hh) => String(hh).replace(/﻿/g, '').trim().toLowerCase());
  const map = {};
  for (const [field, candidates] of Object.entries(HEADER_MAP)) {
    for (const cand of candidates) {
      const idx = normalized.indexOf(cand);
      if (idx !== -1 && !Object.values(map).includes(idx)) { map[field] = idx; break; }
    }
  }
  return map;
}
function parseImportDate(s) {
  s = String(s).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
function parseImportFile(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('الملف فارغ أو لا يحتوي على صفوف بيانات');
  const map = mapHeaders(rows[0]);
  if (map.amount == null || (map.unitPrice == null && map.totalPrice == null)) {
    throw new Error('لم يتم التعرف على أعمدة الملف — يجب أن يحتوي على عمود الكمية وعمود السعر أو المبلغ على الأقل');
  }
  const get = (row, f) => (map[f] != null ? String(row[map[f]] ?? '').trim() : '');
  const orders = [];
  let bad = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const typeRaw = get(row, 'tradeType');
    const statusRaw = get(row, 'orderStatus');
    const dateRaw = get(row, 'createTime');
    const ct = dateRaw ? parseImportDate(dateRaw) : Date.now();
    if (!Number.isFinite(ct)) { bad++; continue; }
    if (/إيداع|سحب|deposit|withdraw/i.test(typeRaw)) { bad++; continue; } // الحوالات لا تُستورد كطلبات
    const o = {
      orderNumber: get(row, 'orderNumber'),
      tradeType: /buy|شراء/i.test(typeRaw) ? 'BUY' : 'SELL',
      asset: get(row, 'asset') || 'USDT',
      fiatSymbol: get(row, 'fiatSymbol'),
      fiat: get(row, 'fiatSymbol'),
      amount: parseFloat(String(get(row, 'amount')).replace(/,/g, '')) || 0,
      unitPrice: parseFloat(String(get(row, 'unitPrice')).replace(/,/g, '')) || 0,
      totalPrice: parseFloat(String(get(row, 'totalPrice')).replace(/,/g, '')) || 0,
      commission: parseFloat(String(get(row, 'commission')).replace(/,/g, '')) || 0,
      counterPart: get(row, 'counterPart'),
      orderStatus: /completed|مكتمل/i.test(statusRaw) ? 'COMPLETED'
        : /cancel|ملغى|ملغي|ألغي/i.test(statusRaw) ? 'CANCELLED'
        : /appeal|تحكيم|نزاع/i.test(statusRaw) ? 'IN_APPEAL'
        : statusRaw ? statusRaw.toUpperCase() : 'COMPLETED',
      createTime: ct,
      reference: get(row, 'reference'),
      note: get(row, 'note'),
    };
    if (!(o.amount > 0)) { bad++; continue; }
    if (!o.totalPrice && o.unitPrice) o.totalPrice = o.amount * o.unitPrice;
    if (!(o.totalPrice > 0)) { bad++; continue; }
    orders.push(o);
  }
  return { orders, bad };
}
function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const preview = $('#importPreview');
    try {
      const { orders, bad } = parseImportFile(String(reader.result));
      state.importRows = orders;
      preview.textContent = '';
      const l1 = document.createElement('div');
      l1.textContent = `✓ تم التعرف على ${fmt0(orders.length)} طلبًا` + (bad ? ` — تم تجاهل ${fmt0(bad)} صفًا (غير صالح أو حوالة)` : '');
      preview.append(l1);
      if (orders.length) {
        const sells = orders.filter((o) => o.tradeType === 'SELL').length;
        const l2 = document.createElement('div');
        l2.textContent = `منها ${fmt0(sells)} بيع و ${fmt0(orders.length - sells)} شراء — سيتم دمجها مع السجل الحالي (بدون تكرار)`;
        preview.append(l2);
      }
      preview.classList.remove('hidden');
      $('#btnConfirmImport').classList.toggle('hidden', !orders.length);
    } catch (e) {
      state.importRows = null;
      preview.textContent = '⚠ ' + e.message;
      preview.classList.remove('hidden');
      $('#btnConfirmImport').classList.add('hidden');
    }
  };
  reader.readAsText(file, 'utf-8');
}
async function confirmImport() {
  if (!state.importRows || !state.importRows.length) return;
  try {
    const j = await api('/api/orders/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: state.importRows }),
    });
    closeModal('#mImport');
    toast(`تم الاستيراد: ${fmt0(j.added)} جديد و ${fmt0(j.updated)} محدّث ✓`);
    await loadOrders();
    renderAll();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ محفظة التمويل ============================ */

function renderBalance() {
  const valEl = $('#walletUsdt'), subEl = $('#walletSub'), extraEl = $('#walletExtra'), updEl = $('#walletUpdated');
  if (!valEl) return;
  if (state.balanceLoading) { subEl.textContent = 'جارٍ جلب الرصيد من المنصة…'; return; }
  if (state.balanceError) {
    valEl.textContent = '—'; subEl.textContent = '⚠ ' + state.balanceError; extraEl.textContent = ''; updEl.textContent = '';
    return;
  }
  if (!state.balance) {
    valEl.textContent = '—'; subEl.textContent = 'اضغط «⟳ تحديث الرصيد» لعرض رصيدك الحالي في محفظة التمويل.';
    return;
  }
  const assets = state.balance.assets || [];
  const usdt = assets.find((a) => String(a.asset).toUpperCase() === 'USDT');
  const free = usdt ? num(usdt.free) : 0;
  const held = usdt ? num(usdt.locked) + num(usdt.freeze) + num(usdt.withdrawing) : 0;
  valEl.textContent = fmt2(free + held);
  subEl.textContent = `متاح ${fmt2(free)}${held > 0 ? ` · مُجمّد/قيد التنفيذ ${fmt2(held)}` : ''} USDT`;
  const others = assets
    .filter((a) => String(a.asset).toUpperCase() !== 'USDT' && num(a.free) + num(a.locked) + num(a.freeze) > 0)
    .map((a) => `${a.asset} ${fmt2(num(a.free) + num(a.locked) + num(a.freeze))}`);
  extraEl.textContent = others.length ? 'أصول أخرى: ' + others.slice(0, 8).join(' · ') : '';
  updEl.textContent = state.balance.updatedAt ? 'آخر تحديث: ' + fmtDT(state.balance.updatedAt) : '';
}

/* ============================ الإعدادات ============================ */

async function openSettings() {
  try { await loadSettings(); } catch {}
  const form = $('#settingsForm');
  form.reset();
  form.elements.apiKey.value = '';
  form.elements.apiKey.placeholder = state.settings.apiKeyMasked
    ? state.settings.apiKeyMasked + ' (محفوظ — اتركه فارغًا للإبقاء عليه)'
    : 'ألصق مفتاح API هنا';
  form.elements.apiSecret.placeholder = state.settings.hasSecret
    ? '•••••••• (محفوظ — اتركه فارغًا للإبقاء عليه)'
    : 'ألصق المفتاح السري هنا';
  form.elements.months.value = state.settings.months || 12;
  form.elements.baseUrl.value = state.settings.baseUrl || 'https://api.binance.com';
  openModal('#mSettings');
}
async function saveSettings() {
  const form = $('#settingsForm');
  const el = form.elements;
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: el.apiKey.value.trim(), apiSecret: el.apiSecret.value.trim(),
        months: Number(el.months.value) || 12, baseUrl: el.baseUrl.value,
      }),
    });
    await loadSettings();
    closeModal('#mSettings');
    toast('تم حفظ الإعدادات ✓');
  } catch (e) { toast(e.message, 'err'); }
}

async function savePasswords() {
  const el = $('#passForm').elements;
  const ap = el.adminPassword.value, up = el.userPassword.value;
  if (!ap && !up) { closeModal('#mChangePass'); return; }
  try {
    await api('/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: ap, userPassword: up }),
    });
    $('#passForm').reset();
    closeModal('#mChangePass');
    toast('تم تحديث كلمات السر ✓');
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ المزامنة ============================ */

async function runSync() {
  if (state.syncing) return;
  try { await loadSettings(); } catch {}
  if (!state.settings.hasSecret || !state.settings.apiKeyMasked) {
    toast('لم يُدخل مفتاح API بعد — على المسؤول إدخاله من الإعدادات', 'err');
    if (canEdit()) openSettings();
    return;
  }
  state.syncing = true;
  $('#btnSync').disabled = true;
  $('#syncBar').classList.remove('hidden');
  $('#syncMsg').textContent = 'جارٍ بدء المزامنة…';
  $('#syncPct').style.width = '2%';
  let sawError = null;
  try {
    const headers = {};
    if (state.auth.token) headers['X-Auth-Token'] = state.auth.token;
    const res = await fetch('/api/sync', { method: 'POST', headers });
    if (res.status === 401) { handleUnauthorized(); throw new Error('انتهت الجلسة — سجّل الدخول'); }
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'تعذّر بدء المزامنة');
    }
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
        if (ev.error) { sawError = ev.error; }
        else if (ev.done) {
          $('#syncPct').style.width = '100%';
          const newTx = (ev.depAdded || 0) + (ev.wdAdded || 0);
          toast(`اكتملت المزامنة ✓ — ${fmt0(ev.added)} طلب و ${fmt0(newTx)} حوالة (جديدة)`);
        } else {
          if (ev.msg) $('#syncMsg').textContent = ev.msg;
          if (ev.pct != null) $('#syncPct').style.width = ev.pct + '%';
        }
      }
    }
    if (sawError) throw new Error(sawError);
    await Promise.all([loadOrders(), loadTransfers()]);
    renderAll();
    refreshBalance();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    state.syncing = false;
    $('#btnSync').disabled = false;
    setTimeout(() => $('#syncBar').classList.add('hidden'), 800);
  }
}

/* ============================ تنبيهات ============================ */

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}

/* ============================ القائمة المنسدلة ============================ */

function closeMenu() { $('#menuDropdown').classList.add('hidden'); $('#btnMenu').setAttribute('aria-expanded', 'false'); }
function toggleMenu() {
  const dd = $('#menuDropdown');
  const open = dd.classList.toggle('hidden');
  $('#btnMenu').setAttribute('aria-expanded', String(!open));
}

/* ============================ ربط الأحداث ============================ */

function wireEvents() {
  // --- تسجيل الدخول ---
  $('#setupForm').addEventListener('submit', doSetup);
  $('#loginForm').addEventListener('submit', doLogin);
  $$('#roleSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#roleSeg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      loginRole = btn.dataset.role;
      $('#loginError').textContent = '';
    });
  });

  // --- النطاق الزمني (أزرار سريعة) ---
  $$('#rangeSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#rangeSeg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      state.filters.range = btn.dataset.range;
      state.filters.from = null; state.filters.to = null;
      $('#xFrom').value = ''; $('#xTo').value = '';
      state.page = 1;
      renderAll();
    });
  });

  // --- فلتر التاريخ من/إلى (بجانب زر Excel) ---
  const onDateChange = () => {
    const from = $('#xFrom').value, to = $('#xTo').value;
    if (from || to) {
      state.filters.range = 'custom';
      state.filters.from = from; state.filters.to = to;
      $$('#rangeSeg button').forEach((b) => b.classList.remove('on'));
    } else {
      state.filters.range = 'all';
      $$('#rangeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.range === 'all'));
    }
    state.page = 1;
    renderAll();
  };
  $('#xFrom').addEventListener('change', onDateChange);
  $('#xTo').addEventListener('change', onDateChange);

  // --- بقية الفلاتر ---
  $('#fType').addEventListener('change', (e) => { state.filters.type = e.target.value; state.page = 1; renderAll(); });
  $('#fStatus').addEventListener('change', (e) => { state.filters.status = e.target.value; state.page = 1; renderAll(); });
  $('#fFiat').addEventListener('change', (e) => { state.filters.fiat = e.target.value; state.page = 1; renderAll(); });
  let searchTimer;
  $('#fSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.q = e.target.value; state.page = 1; renderAll(); }, 200);
  });

  // --- الفرز ---
  $$('#ledgerTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else { state.sort.key = key; state.sort.dir = key === '_t' ? -1 : 1; }
      renderTable();
    });
  });

  // --- الترقيم ---
  $('#pgPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderTable(); } });
  $('#pgNext').addEventListener('click', () => { state.page++; renderTable(); });

  // --- القائمة ---
  $('#btnMenu').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('#menuDropdown').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeMenu);

  $('#btnSync').addEventListener('click', () => { closeMenu(); runSync(); });
  $('#btnAdd').addEventListener('click', () => { closeMenu(); openAdd(); });
  $('#btnImport').addEventListener('click', () => {
    closeMenu();
    $('#csvFile').value = '';
    $('#importPreview').classList.add('hidden');
    $('#btnConfirmImport').classList.add('hidden');
    state.importRows = null;
    openModal('#mImport');
  });
  $('#btnExport').addEventListener('click', () => { closeMenu(); exportCSV(); });
  $('#btnSettings').addEventListener('click', () => { closeMenu(); openSettings(); });
  $('#btnChangePass').addEventListener('click', () => { closeMenu(); $('#passForm').reset(); openModal('#mChangePass'); });
  $('#btnLogout').addEventListener('click', () => { closeMenu(); doLogout(); });

  // --- تصدير Excel (بجانب العنوان) ---
  $('#btnExportXlsx').addEventListener('click', exportXlsx);

  // --- الرصيد ---
  $('#btnRefreshBal').addEventListener('click', refreshBalance);

  // --- الإضافة اليدوية ---
  $('#btnSaveAdd').addEventListener('click', saveAdd);
  $('#addForm').elements.amount.addEventListener('input', autoTotal);
  $('#addForm').elements.unitPrice.addEventListener('input', autoTotal);
  $('#addForm').elements.totalPrice.addEventListener('input', () => { totalPriceDirty = true; });

  // --- الاستيراد ---
  $('#csvFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]); });
  $('#btnConfirmImport').addEventListener('click', confirmImport);

  // --- الإعدادات ---
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnClearAll').addEventListener('click', () => {
    openConfirm('سيتم حذف جميع الطلبات المخزّنة محليًا نهائيًا. هل أنت متأكد؟', async () => {
      try { await api('/api/orders/clear', { method: 'POST' }); closeAllModals(); toast('تم مسح جميع الطلبات'); await loadOrders(); renderAll(); }
      catch (e) { toast(e.message, 'err'); }
    });
  });
  $('#btnClearTransfers').addEventListener('click', () => {
    openConfirm('سيتم حذف سجل الإيداع والسحب المخزّن محليًا نهائيًا. هل أنت متأكد؟', async () => {
      try { await api('/api/transfers/clear', { method: 'POST' }); closeAllModals(); toast('تم مسح سجل الإيداع والسحب'); await loadTransfers(); renderAll(); }
      catch (e) { toast(e.message, 'err'); }
    });
  });

  // --- تغيير كلمات السر ---
  $('#btnSavePass').addEventListener('click', savePasswords);

  // --- حذف طلب ---
  $('#btnDeleteOrder').addEventListener('click', () => {
    const o = state.detailsOrder;
    if (!o) return;
    openConfirm(`سيتم حذف الطلب ${o.orderNumber} من السجل المحلي. هل أنت متأكد؟`, async () => {
      try { await api('/api/orders?id=' + encodeURIComponent(o.orderNumber), { method: 'DELETE' }); closeAllModals(); toast('تم حذف الطلب'); await loadOrders(); renderAll(); }
      catch (e) { toast(e.message, 'err'); }
    });
  });

  // --- نافذة التأكيد ---
  $('#btnConfirmYes').addEventListener('click', () => {
    const fn = confirmAction;
    confirmAction = null;
    closeModal('#mConfirm');
    if (fn) fn();
  });

  // --- إغلاق النوافذ ---
  $$('.backdrop').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) bd.classList.add('hidden'); }));
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('.backdrop').classList.add('hidden')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });

  // --- إعادة رسم عند تغيير الحجم ---
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderVolChart(); renderPriceChart(); }, 150);
  });
}

/* ============================ البداية ============================ */

function init() {
  wireEvents();
  checkAuth();
}
init();
