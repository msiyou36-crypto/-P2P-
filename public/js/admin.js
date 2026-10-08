/* أدوات المسؤول خارج الفحص: منطقة الخطر (مسحٌ وإعادة حساب وأرشفة بتاريخ وحذف بيانات الحساب
   الآخر)، والإعدادات، وكلمات السر، وسجل الدخول، وضبط وضع الصيانة (بوّابته في js/session.js) */
'use strict';

/* ============================ منطقة الخطر ============================ */

/* حذفُ بيانات الحساب الآخر من قاعدة هذا السستم (بعد الفصل التام) */
async function cleanForeign() {
  let d;
  try { d = await api('/api/system/foreign'); } catch (e) { toast(e.message, 'err'); return; }
  if (!d.count) { toast(`لا توجد بيانات لـ«${d.otherName}» في قاعدة هذا السستم`); return; }
  const list = d.items.map((i) => `${i.key} (${fmt0(i.rows)})`).join('، ');
  openConfirm(`سيُحذف من قاعدة هذا السستم ${fmt0(d.count)} مفتاحًا يخصّ «${d.otherName}»: ${list}. لا تفعل هذا إلا بعد أن يعمل سستم «${d.otherName}» على قاعدته الجديدة وترى بياناته فيه. هل أنت متأكد؟`, async () => {
    const w = prompt('للتأكيد اكتب كلمة: حذف');
    if (w == null || w.trim() !== 'حذف') { toast('أُلغي الحذف'); return; }
    try {
      const j = await api('/api/system/foreign', { method: 'DELETE' });
      toast(`حُذفت بيانات ${j.otherName} من هذه القاعدة (${fmt0(j.deleted)} مفتاحًا)`);
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* أرشفةُ كل ما قبل تاريخ (أو إرجاعه من الأرشيف) */
async function archiveBefore(undo) {
  const inp = $('#archiveBefore');
  const ms = inp.value ? new Date(inp.value).getTime() : NaN;
  if (!Number.isFinite(ms)) { toast('حدّد التاريخ والوقت أولًا', 'err'); return; }
  const when = fmtDT(ms);
  openConfirm(undo
    ? `سيُرجَع من الأرشيف كل ما قبل ${when} إلى الجدول وإلى حساب «الباقي» في «${state.account.name}». هل أنت متأكد؟`
    : `ستُؤرشف كل العمليات التي قبل ${when} في «${state.account.name}»: تخرج من الجدول ومن حساب «الباقي من USDT»، وتبقى في الأرشيف. هل أنت متأكد؟`, async () => {
    try {
      const j = await postJSON('/api/archive/before', { before: ms, undo: !!undo });
      await reloadAfterChange();
      const n = (j.orders || 0) + (j.transfers || 0);
      toast(n ? (undo ? `أُرجع ${fmt0(n)} عملية من الأرشيف` : `أُرشفت ${fmt0(n)} عملية (${fmt0(j.orders)} طلبًا و${fmt0(j.transfers)} حوالة)`) : 'لا شيء قبل هذا التاريخ', n ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/** أزرار منطقة الخطر — نافذةٌ فوق الإعدادات، و«رجوع» يغلقها فتبقى الإعدادات كما تركتها */
function wireDangerZone() {
  /** زرّ تأكيدٍ ثم تنفيذٍ ثم إعادة تحميل */
  const confirmThen = (id, message, fn, done) => $(id).addEventListener('click', () => openConfirm(message, async () => {
    try { const j = await fn(); closeAllModals(); await done(j); } catch (e) { toast(e.message, 'err'); }
  }));
  $('#btnOpenDanger').addEventListener('click', () => openModal('#mDanger'));
  $('#btnDangerBack').addEventListener('click', () => closeModal('#mDanger'));
  $('#btnArchiveBefore').addEventListener('click', () => archiveBefore(false));
  $('#btnUnarchiveBefore').addEventListener('click', () => archiveBefore(true));
  $('#btnForeignClean').addEventListener('click', cleanForeign);
  confirmThen('#btnClearAll', 'سيتم حذف جميع الطلبات المخزّنة نهائيًا. هل أنت متأكد؟',
    () => api('/api/orders/clear', { method: 'POST' }), async () => { toast('تم مسح جميع الطلبات'); await loadOrders(); renderAll(); });
  confirmThen('#btnClearTransfers', 'سيتم حذف سجل الإيداع والسحب المخزّن نهائيًا. هل أنت متأكد؟',
    () => api('/api/transfers/clear', { method: 'POST' }), async () => { toast('تم مسح سجل الإيداع والسحب'); await loadTransfers(); renderAll(); });
  confirmThen('#btnUnfreezeBal', 'سيُلغى تثبيت عمود «الباقي من USDT» وتُحسب كل الأرقام من جديد. استخدمها لو ثُبِّتت أرقام خاطئة. هل أنت متأكد؟',
    () => api('/api/balance/unfreeze', { method: 'POST' }), async (j) => { await reloadLedger(); toast(`أُلغي تثبيت ${fmt0(j.cleared)} رقم — أُعيد الحساب`); });
}

/* ============================ الإعدادات وكلمات السر ============================ */

async function openSettings() {
  try { await loadSettings(); } catch {}
  $('#mSettingsTitle').textContent = 'الإعدادات — ' + state.account.name;
  const form = $('#settingsForm');
  form.reset();
  form.elements.apiKey.value = '';
  form.elements.apiKey.placeholder = state.settings.apiKeyMasked ? state.settings.apiKeyMasked + ' (محفوظ — اتركه فارغًا للإبقاء عليه)' : 'ألصق مفتاح API هنا';
  form.elements.apiSecret.placeholder = state.settings.hasSecret ? '•••••••• (محفوظ — اتركه فارغًا للإبقاء عليه)' : 'ألصق المفتاح السري هنا';
  form.elements.rangeHours.value = String(state.settings.rangeHours || 720);
  form.elements.syncQuota.value = String(state.settings.syncQuota != null ? state.settings.syncQuota : 3);
  // عنوانٌ محفوظ ليس في القائمة يُضاف إليها فيظهر كما هو بدل خانةٍ فارغة
  const base = state.settings.baseUrl || 'https://api.binance.com';
  const sel = form.elements.baseUrl;
  if (![...sel.options].some((o) => o.value === base)) sel.append(new Option(base.replace(/^https?:\/\//, ''), base));
  sel.value = base;
  hidePasswords(form);
  openModal('#mSettings');
}
async function saveSettings() {
  const el = $('#settingsForm').elements;
  try {
    await postJSON('/api/settings', {
      apiKey: el.apiKey.value.trim(), apiSecret: el.apiSecret.value.trim(),
      rangeHours: Number(el.rangeHours.value) || 720, baseUrl: el.baseUrl.value,
      syncQuota: Math.max(Math.floor(Number(el.syncQuota.value)) || 0, 0),
    });
    await loadSettings();
    await loadSyncQuota();
    closeModal('#mSettings');
    toast('تم حفظ الإعدادات');
  } catch (e) { toast(e.message, 'err'); }
}

async function savePasswords() {
  const el = $('#passForm').elements;
  const body = {};   // الفارغ يعني «أبقِ كلمة السر الحالية»
  if (el.adminPassword.value) body.adminPassword = el.adminPassword.value;
  if (el.userPassword.value) body.userPassword = el.userPassword.value;
  if (el.user2Password.value) body.user2Password = el.user2Password.value;
  if (!Object.keys(body).length) { closeModal('#mChangePass'); return; }
  try {
    await postJSON('/api/auth/password', body);
    $('#passForm').reset();
    closeModal('#mChangePass');
    toast('تم تحديث كلمات السر');
  } catch (e) { toast(e.message, 'err'); }
}

function openChangePass() {
  $('#passForm').reset();
  hidePasswords($('#passForm'));
  openModal('#mChangePass');
}

/* ============================ سجل الدخول ============================ */

/* الدور، وما حدث (دخول، أو ما يُثقل على المنصة: مزامنة وفحص وجلب يوم)، والوقت، والعنوان —
   في صفحاتٍ بقدر ارتفاع الشاشة بدل التمرير */
const LOG_KINDS = { sync: ['refresh', 'مزامنة'], scan: ['search', 'فحص'], day: ['calendar', 'جلب يوم'] };
let logEvents = [];
let logPage = 0;
const logPageSize = () => Math.max(5, Math.floor((window.innerHeight - 270) / 42));   // ما يتّسع له ارتفاع الشاشة
function loginLogRow(ev) {
  const tr = document.createElement('tr');
  const role = mk('span', 'role-pill r-' + (ev.role || 'user'));
  role.append(svgIcon(ROLE_SVG[ev.role] || 'user'), ROLE_NAMES[ev.role] || ev.role || '—');
  const [icon, label] = LOG_KINDS[ev.kind] || ['login', 'دخول'];
  const what = mk('span', 'ev-chip ev-' + (LOG_KINDS[ev.kind] ? ev.kind : 'login'));
  what.append(svgIcon(icon, icon === 'login' ? 'flip' : ''),
    label + (Array.isArray(ev.kinds) ? ' (' + ev.kinds.map(kindLabel).join('، ') + ')' : ''));   // مزامنةٌ لبعض الأنواع
  for (const el of [role, what]) { const td = document.createElement('td'); td.append(el); tr.append(td); }
  tdText(tr, ev.time ? fmtDTsec(ev.time) : '—', 'num');
  tdText(tr, ev.ip || '—', 'mono');
  return tr;
}
function renderLoginLog() {
  const size = logPageSize();
  const pages = Math.max(1, Math.ceil(logEvents.length / size));
  logPage = Math.min(Math.max(logPage, 0), pages - 1);
  const from = logPage * size;
  const tbody = $('#loginLogBody');
  tbody.textContent = '';
  for (const ev of logEvents.slice(from, from + size)) tbody.append(loginLogRow(ev));
  $('#logPager').classList.toggle('hidden', pages < 2);
  $('#logInfo').textContent = `${fmt0(from + 1)}–${fmt0(Math.min(from + size, logEvents.length))} من ${fmt0(logEvents.length)}`;
  $('#logNewer').disabled = logPage === 0;
  $('#logOlder').disabled = logPage >= pages - 1;
}
/** زرّا الصفحات: d = -1 للأحدث، و1 للأقدم */
function stepLoginLog(d) { logPage += d; renderLoginLog(); }
async function openLoginLog() {
  logEvents = [];
  logPage = 0;
  $('#loginLogBody').textContent = '';
  $('#loginLogEmpty').classList.add('hidden');
  $('#logPager').classList.add('hidden');
  openModal('#mLoginLog');
  try {
    const j = await api('/api/auth/log');
    logEvents = j.events || [];
    $('#loginLogEmpty').classList.toggle('hidden', logEvents.length > 0);
    renderLoginLog();
  } catch (e) {
    $('#loginLogEmpty').classList.remove('hidden');
    toast(e.message, 'err');
  }
}

/* ============================ ضبط وضع الصيانة ============================ */

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
    toast(on ? 'تم تفعيل وضع الصيانة — النظام مقفول أمام المستخدمين' : 'تم إيقاف وضع الصيانة — النظام يعمل');
  } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
}
