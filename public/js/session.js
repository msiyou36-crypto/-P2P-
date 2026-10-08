/* الدخول والأدوار، تحميل البيانات من الخادم، سمة السستم (لونه وأيقوناته)، وبوّابة وضع
   الصيانة (ضبطه من js/admin.js). الخلفيات المتحركة (الفيديو والنجوم) في js/backgrounds.js */
'use strict';

/* ============================ تحميل البيانات ============================ */

async function loadOrders() {
  const j = await api('/api/orders');
  state.orders = (j.orders || []).sort((a, b) => b.createTime - a.createTime);
  state.settings.lastSync = j.lastSync;
  populateFiatFilter();
}
async function loadTransfers() {
  const j = await api('/api/transfers');
  state.transfers = (j.transfers || []).filter((t) => !isInternalKind(t.kind)).sort((a, b) => b.time - a.time);
  state.settings.lastSync = j.lastSync;
}
/** يُعيد تحميل الطلبات والحوالات معًا ثم يرسم كل شيء */
async function reloadLedger() {
  await Promise.all([loadOrders(), loadTransfers()]);
  renderAll();
}
/** بعد عمليةٍ غيّرت السجل من نافذة (حذف، استعادة، أرشفة): تُغلق النوافذ ويُعاد التحميل والرصيد */
async function reloadAfterChange() {
  closeAllModals();
  await reloadLedger();
  refreshBalance();
}
async function loadSettings() { state.settings = await api('/api/settings'); }
/* لقطات الرصيد اليومية: { 'YYYY-MM-DD': {bal, at} } → مصفوفة مرتّبة بالوقت */
function setBalSnaps(obj) {
  state.balSnaps = Object.entries(obj || {})
    .map(([day, v]) => ({ day, bal: num(v && v.bal), at: Number(v && v.at) || 0 }))
    .filter((s) => s.at > 0)
    .sort((a, b) => a.at - b.at);
}
async function loadBalSnaps() {
  try { setBalSnaps((await api('/api/balance/snapshots')).snapshots); }
  catch { state.balSnaps = []; }
}
/* رصيد مرات المزامنة المتبقية اليوم (يحسبه الخادم). والخادم يعرف إن كانت المنصة قد
   حظرت العنوان — فيُقفل زر المزامنة هنا أيضًا بالمدة الباقية (blockedFor) */
async function loadSyncQuota() {
  try { state.syncQuota = await api('/api/sync/quota'); }
  catch { state.syncQuota = { unlimited: true, quota: 0, used: 0, left: null }; }
  extendSyncCooldown((Number(state.syncQuota.blockedFor) || 0) * 1000);
}
async function loadAccount() {
  const j = await api('/api/account');
  state.account.active = j.active;
  state.account.locked = !!j.locked;
  const cur = (j.accounts || []).find((a) => a.id === j.active);
  if (cur) state.account.name = cur.name;
  renderAccount();
}
const loadAll = () => Promise.all([loadAccount(), loadOrders(), loadTransfers(), loadSettings(), loadSyncQuota(), loadBalSnaps()]);

/* ============================ سمة السستم ============================ */

/* لكل سستم لونه: P3P بالبرتقالي، وP2P بالبرغندي — فيُعرف الحساب من أول نظرة. السمة تُوضع
   على الجذر (data-account) فتقرؤها التنسيقات، وتتبعها أيقونة التبويب وبيان التطبيق. */
const ACCOUNT_THEME = {
  p2p: { accent: '#8e1f3f', ink: '#fbeef2', bar: '#1a1a19' },   // أيقوناته باللاحقة «-p2p»
  p3p: { accent: '#fb923c', ink: '#1a1a19', bar: '#1a1a19' },   // الأيقونات الأصلية
};
function applyAccountTheme(id) {
  const t = ACCOUNT_THEME[id] || ACCOUNT_THEME.p3p;
  document.documentElement.dataset.account = ACCOUNT_THEME[id] ? id : '';
  state.themeAccent = t.accent;
  const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23" + t.accent.slice(1)
    + "'/%3E%3Cpath d='M9 20v-8l4 5 3-4 3 4 4-5v8' stroke='%23" + t.ink.slice(1)
    + "' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
  // كل ملف أيقونة له نظيرٌ باللاحقة «-p2p»؛ الاسم الأصلي يُحفظ على الوسم مرّةً ويُشتقّ منه
  const swap = (l) => {
    if (l.type === 'image/svg+xml') { l.href = svg; return; }
    const base = l.dataset.base || (l.dataset.base = l.getAttribute('href'));
    l.href = ACCOUNT_THEME[id] && id !== 'p3p' ? base.replace(/\.(png|ico|webmanifest)$/, '-' + id + '.$1') : base;
  };
  $$('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').forEach(swap);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = t.bar;
}
/** اسم السستم في تبويب المتصفح وفي رأس التطبيق وشاشة الدخول */
function setSystemTitle(name) {
  const title = 'سجل ' + name;
  for (const h of $$('#appTitle, #loginScreen h1')) h.textContent = title;
  document.title = title;
}
function renderAccount() {
  applyAccountTheme(state.account.active);
  setSystemTitle(state.account.name);
  // حذفُ بيانات الحساب الآخر له معنى في السستم المقفول وحده
  const fz = $('#foreignZone');
  if (fz) fz.classList.toggle('hidden', !state.account.locked);
}

/* ============================ المصادقة ============================ */

function clearSession() {
  state.auth = { role: null, token: null };
  ssSet('p2p_token', null);
  ssSet('p2p_role', null);
}
function saveSession(j) {
  state.auth = { token: j.token, role: j.role };
  ssSet('p2p_token', j.token);
  ssSet('p2p_role', j.role);
}

function showLogin(configured) {
  $('#app').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  $('#setupForm').classList.toggle('hidden', configured);
  $('#loginForm').classList.toggle('hidden', !configured);
  $('#loginError').textContent = '';
  $('#setupError').textContent = '';
  startLoginBackground();
  const inp = configured ? $('#loginForm').elements.password : $('#setupForm').elements.adminPassword;
  setTimeout(() => { try { inp.focus(); } catch {} }, 50);
}

/** ردّ 401: انتهت الجلسة فتعود شاشة الدخول. وبلا جلسةٍ أصلًا (كلمة سرٍّ خاطئة عند الدخول،
    أو ردٌّ متأخر بعد الخروج) لا شيء يُغلق — والخطأ يظهر في مكانه */
function handleUnauthorized() {
  if (!state.auth.token) return;
  stopMaintenanceWatch();
  clearSession();
  showLogin(true);
}

async function enterApp() {
  if (await checkMaintenanceGate()) return;   // النظام مقفول أمام المستخدم (صيانة)
  startMaintenanceWatch();
  $('#loginScreen').classList.add('hidden');
  stopLoginBackground();
  $('#app').classList.remove('hidden');
  startAppBackground();
  applyRole();
  renderAll();
  renderBalance();
  if (state.settings.hasSecret && state.settings.apiKeyMasked) refreshBalance();
}

function applyRole() {
  const role = state.auth.role;
  const admin = role === 'admin';
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !admin));
  if (!admin && state.showArchive) {   // الأرشيف للمسؤول وحده
    state.showArchive = false;
    const bar = $('#archiveBar');
    if (bar) bar.classList.add('hidden');
  }
  const badge = $('#roleBadge');
  badge.textContent = '';
  badge.append(svgIcon(ROLE_SVG[role] || 'user'), ROLE_NAMES[role] || 'مستخدم');
  badge.classList.toggle('admin', admin);
  badge.classList.toggle('annot', role === 'user2');
}

async function checkAuth() {
  let status;
  try { status = await api('/api/auth/status'); } catch { status = { configured: false }; }
  // السستم المقفول يُعلن حسابه قبل الدخول، فتأخذ شاشةُ الدخول لونَه واسمه من أول لحظة
  if (status.account && status.account.id) {
    applyAccountTheme(status.account.id);
    setSystemTitle(status.account.name);
  }
  $$('.app-version').forEach((el) => { el.textContent = status.version ? 'الإصدار ' + status.version : ''; });
  const token = ssGet('p2p_token');
  const role = ssGet('p2p_role');
  if (token && role) {
    state.auth = { token, role };
    try { await loadAll(); await enterApp(); return; }
    catch { clearSession(); }
  }
  showLogin(!!status.configured);
}

async function doSetup(e) {
  e.preventDefault();
  const el = $('#setupForm').elements;
  $('#setupError').textContent = '';
  try {
    saveSession(await postJSON('/api/auth/setup', { adminPassword: el.adminPassword.value, userPassword: el.userPassword.value, user2Password: el.user2Password.value }));
    await loadAll();
    await enterApp();
  } catch (err) { $('#setupError').textContent = err.message; }
}

let loginRole = 'admin';
/** زرّ الدور في شاشة الدخول: يُعلَّم وحده، ويُنقل التركيز إلى كلمة السر */
function pickLoginRole(btn) {
  $$('#roleSeg button').forEach((b) => {
    b.classList.toggle('on', b === btn);
    b.setAttribute('aria-checked', String(b === btn));
  });
  loginRole = btn.dataset.role;
  $('#loginError').textContent = '';
  try { $('#loginForm').elements.password.focus(); } catch {}
}
async function doLogin(e) {
  e.preventDefault();
  const password = $('#loginForm').elements.password.value;
  $('#loginError').textContent = '';
  try {
    saveSession(await postJSON('/api/auth/login', { role: loginRole, password }));
    $('#loginForm').elements.password.value = '';
    await loadAll();
    await enterApp();
  } catch (err) { $('#loginError').textContent = err.message; }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearSession();
  location.reload();
}

/* ============================ بوّابة وضع الصيانة ============================ */

/** true إن كان النظام مقفولًا أمام هذا المستخدم (فيُوقف دخول التطبيق) */
async function checkMaintenanceGate() {
  let m;
  try { m = await api('/api/maintenance'); } catch { return false; }
  if (m && m.on && state.auth.role !== 'admin') { showMaintenanceScreen(m); return true; }
  $('#maintenanceScreen').classList.add('hidden');
  return false;
}
// متابعة دورية: لو فعّل المسؤول الصيانة والمستخدم داخل النظام، يُقفل عليه
let _maintTimer = null;
function startMaintenanceWatch() {
  if (_maintTimer || state.auth.role === 'admin') return;
  _maintTimer = setInterval(async () => {
    let m;
    try { m = await api('/api/maintenance'); } catch { return; }
    if (m && m.on) { stopMaintenanceWatch(); showMaintenanceScreen(m); }
  }, 60000);
}
function stopMaintenanceWatch() {
  if (_maintTimer) { clearInterval(_maintTimer); _maintTimer = null; }
}
function showMaintenanceScreen(m) {
  $('#loginScreen').classList.add('hidden');
  stopLoginBackground();
  stopAppBackground();
  stopGlitter();
  $('#app').classList.add('hidden');
  $('#maintScreenMsg').textContent = m.message || 'النظام متوقف مؤقتًا للصيانة. حاول لاحقًا.';
  const a = $('#maintScreenLink');
  const link = String(m.link || '').trim();
  if (/^https?:\/\//i.test(link)) { a.href = link; a.classList.remove('hidden'); }
  else { a.removeAttribute('href'); a.classList.add('hidden'); }
  $('#maintenanceScreen').classList.remove('hidden');
}
