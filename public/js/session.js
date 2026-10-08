/* الدخول والأدوار، تحميل البيانات من الخادم، سمة السستم (لونه وأيقوناته)، ووضع الصيانة */
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
  const blocked = Number(state.syncQuota.blockedFor) || 0;
  if (blocked > 0 && syncCooldownUntil() < Date.now() + blocked * 1000) {
    try { localStorage.setItem(SYNC_COOLDOWN_KEY, String(Date.now() + blocked * 1000)); } catch {}
  }
  applySyncCooldown();
}
async function loadAccount() {
  const j = await api('/api/account');
  state.account.active = j.active;
  state.account.locked = !!j.locked;
  state.account.list = j.accounts || [];
  const cur = state.account.list.find((a) => a.id === j.active);
  state.account.name = cur ? cur.name : (j.active === 'p3p' ? 'حوالات P3P' : 'حوالات P2P');
  renderAccount();
}
const loadAll = () => Promise.all([loadAccount(), loadOrders(), loadTransfers(), loadSettings(), loadSyncQuota(), loadBalSnaps()]);

/* ============================ سمة السستم ============================ */

/* لكل سستم لونه: P3P بالذهبي، وP2P بالبرغندي — فيُعرف الحساب من أول نظرة. السمة تُوضع
   على الجذر (data-account) فتقرؤها التنسيقات، وتتبعها أيقونة التبويب وبيان التطبيق. */
const ACCOUNT_THEME = {
  p2p: { accent: '#8e1f3f', ink: '#fbeef2', bar: '#1a1a19' },   // أيقوناته باللاحقة «-p2p»
  p3p: { accent: '#f0b90b', ink: '#1a1a19', bar: '#1a1a19' },   // الأيقونات الأصلية
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t.bar;
}
function renderAccount() {
  applyAccountTheme(state.account.active);
  const title = 'سجل ' + state.account.name;
  const h = $('#appTitle');
  if (h) h.textContent = title;
  document.title = title;
  // حذفُ بيانات الحساب الآخر له معنى في السستم المقفول وحده
  const fz = $('#foreignZone');
  if (fz) fz.classList.toggle('hidden', !state.account.locked);
}

/* ============================ المصادقة ============================ */

function clearSession() {
  state.auth = { role: null, token: null };
  try { sessionStorage.removeItem('p2p_token'); sessionStorage.removeItem('p2p_role'); } catch {}
}
function saveSession(j) {
  state.auth = { token: j.token, role: j.role };
  sessionStorage.setItem('p2p_token', j.token);
  sessionStorage.setItem('p2p_role', j.role);
}

/* خلفية النجوم (glitter.js): كاملة في شاشة الدخول، وخفيفة داخل التطبيق */
let glitterStop = null;
function stopGlitter() {
  if (glitterStop) { try { glitterStop(); } catch {} glitterStop = null; }
}
function startLoginGlitter() {
  stopGlitter();
  if (typeof Glitter === 'undefined') return;
  try { glitterStop = Glitter.mount($('#loginScreen'), { color2: state.themeAccent || '#f0b90b' }); } catch {}
}
function startAppGlitter() {
  stopGlitter();
  if (typeof Glitter === 'undefined') return;
  const el = $('#appGlitter');
  if (!el) return;
  try {
    glitterStop = Glitter.mount(el, { particleCount: 90, brightness: 40, trailAmount: 78, starSize: 9, speed: 2.5, glitterIntensity: 2, maxDpr: 1, color2: state.themeAccent || '#f0b90b' });
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

async function enterApp() {
  if (await checkMaintenanceGate()) return;   // النظام مقفول أمام المستخدم (صيانة)
  startMaintenanceWatch();
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  startAppGlitter();
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
    const lh = document.querySelector('#loginScreen h1');
    if (lh) lh.textContent = 'سجل ' + status.account.name;
    document.title = 'سجل ' + status.account.name;
  }
  const token = sessionStorage.getItem('p2p_token');
  const role = sessionStorage.getItem('p2p_role');
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

/* ============================ وضع الصيانة ============================ */

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
    if (m && m.on) { clearInterval(_maintTimer); _maintTimer = null; showMaintenanceScreen(m); }
  }, 60000);
}
function showMaintenanceScreen(m) {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#maintScreenMsg').textContent = m.message || 'النظام متوقف مؤقتًا للصيانة. حاول لاحقًا.';
  const a = $('#maintScreenLink');
  const link = String(m.link || '').trim();
  if (/^https?:\/\//i.test(link)) { a.href = link; a.classList.remove('hidden'); }
  else { a.removeAttribute('href'); a.classList.add('hidden'); }
  $('#maintenanceScreen').classList.remove('hidden');
}
async function openMaintenance() {
  try {
    const m = await api('/api/maintenance');
    $('#maintOn').checked = !!m.on;
    $('#maintMsg').value = m.message || '';
    $('#maintLink').value = m.link || '';
    $('#maintSystem').textContent = m.system || location.host;   // الإيقاف يخصّ هذا السستم وحده
  } catch (e) { toast('تعذّر جلب حالة الصيانة: ' + e.message, 'err'); return; }
  openModal('#mMaintenance');
}
async function saveMaintenance() {
  const on = $('#maintOn').checked;
  try {
    await postJSON('/api/maintenance', { on, message: $('#maintMsg').value.trim(), link: $('#maintLink').value.trim() });
    closeModal('#mMaintenance');
    toast(on ? 'تم تفعيل وضع الصيانة ⛔ — النظام مقفول أمام المستخدمين' : 'تم إيقاف وضع الصيانة ✓ — النظام يعمل');
  } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
}
