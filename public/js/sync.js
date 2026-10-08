/* المزامنة: نافذة اختيار ما يُجلب، وقفل الحظر (٣٠ دقيقة بعد أي 429/418، يبقى بعد إعادة
   تحميل الصفحة ويُضبط أيضًا من blockedFor الذي يُرسله الخادم)، وقراءة بثّ التقدّم */
'use strict';

const SYNC_COOLDOWN_KEY = 'p2pSyncCooldownUntil';
let _cooldownTimer = null;
const syncCooldownUntil = () => Number(localStorage.getItem(SYNC_COOLDOWN_KEY) || 0);
function setSyncCooldown(ms) {
  localStorage.setItem(SYNC_COOLDOWN_KEY, String(Date.now() + ms));
  applySyncCooldown();
}
/** نصّ زرّ المزامنة وشارته الصغيرة (المتبقّي من الحصّة، أو دقائق الانتظار بعد الحظر) */
function setSyncButton(text, badge) {
  const btn = $('#btnSync');
  btn.querySelector('.sync-label').textContent = text;
  const b = btn.querySelector('.sync-badge');
  b.textContent = badge || '';
  b.hidden = !badge;
}
/** يضبط زر المزامنة: مقفول أثناء الحظر أو عند نفاد الحصّة، وإلا يعرض المتبقي */
function applySyncCooldown() {
  const btn = $('#btnSync');
  if (!btn || state.syncing) return;
  const q = state.syncQuota || { unlimited: true };
  btn.classList.remove('is-busy');
  const rem = syncCooldownUntil() - Date.now();
  if (rem > 0) {
    btn.disabled = true;
    setSyncButton('مزامنة', `${fmt0(Math.ceil(rem / 60000))} د`);
    btn.title = `المنصة حظرت الطلبات مؤقتًا — انتظر ${Math.ceil(rem / 60000)} دقيقة قبل إعادة المزامنة`;
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    _cooldownTimer = setTimeout(applySyncCooldown, Math.min(rem, 30000));
    return;
  }
  if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
  setSyncButton('مزامنة', q.unlimited ? '' : fmt0(q.left || 0));
  if (!q.unlimited && !(q.left > 0)) {
    btn.disabled = true;
    btn.title = q.quota ? `انتهى عدد مرات المزامنة اليوم (${fmt0(q.quota)}) — يتجدّد بكرة` : 'المزامنة غير مسموحة لحسابك — راجع المسؤول';
    return;
  }
  btn.disabled = false;
  btn.title = q.unlimited ? 'اختر ما تجلبه من المنصة ثم زامن' : `متبقّي ${fmt0(q.left)} من ${fmt0(q.quota)} مزامنة اليوم`;
}
/** بعد أي خطأ من المنصة: إن كان حظرًا يُقفل الزر ٣٠ دقيقة */
function noteBanError(message) {
  if (/HTTP 4(18|29)|حظر/.test(message || '')) setSyncCooldown(30 * 60000);
}

/* ===== ماذا نجلب؟ =====
 * زرّ المزامنة يفتح نافذةً بمربّعات اختيار: كل نوعٍ يُجلب وحده أو مع غيره، والاختيار
 * يُحفظ في المتصفح للمرّة القادمة. ترتيب الجلب لا يهمّ: كل عملية تُعرض بتاريخها في
 * المنصة، فما يُجلب لاحقًا يقع في مكانه. التحقق من التوقيت يتمّ تلقائيًا (طلبٌ خفيف).
 * «الرصيد» ليس مزامنة: تحديثٌ لبطاقة الرصيد بعدها (ووحده لا يُخصم من الحصّة). */
const SYNC_KINDS = [
  { id: 'p2p', label: 'طلبات P2P', hint: 'البيع والشراء — أكثرُ المزامنة طلباتٍ للمنصة' },
  { id: 'deposit', label: 'الإيداع', hint: 'ما وصل محفظتك من الخارج' },
  { id: 'withdraw', label: 'السحب', hint: 'ما خرج من محفظتك إلى الخارج' },
  { id: 'pay', label: 'Binance Pay', hint: 'الإرسال والاستلام بين حسابات Binance' },
  { id: 'convert', label: 'التحويل بين العملات', hint: 'Convert (مثل USDT ← TRX)' },
  { id: 'spot', label: 'السوق الفوري', hint: 'صفقات Spot' },
  { id: 'balance', label: 'الرصيد', hint: 'تحديث بطاقة الرصيد بعد المزامنة' },
];
const SYNC_KINDS_KEY = 'p2pSyncKinds';
const kindLabel = (id) => (SYNC_KINDS.find((k) => k.id === id) || { label: id }).label;
function savedSyncKinds() {
  try {
    const v = JSON.parse(localStorage.getItem(SYNC_KINDS_KEY) || 'null');
    const ok = Array.isArray(v) ? v.filter((id) => SYNC_KINDS.some((k) => k.id === id)) : [];
    if (ok.length) return ok;
  } catch {}
  return SYNC_KINDS.map((k) => k.id);   // أول مرّة: الكل
}

/** يفتح نافذة الاختيار بعد التحقق من أن المزامنة ممكنة الآن */
async function openSyncPicker() {
  if (state.syncing) return;
  const rem = syncCooldownUntil() - Date.now();
  if (rem > 0) {
    toast(`المنصة حظرت الطلبات مؤقتًا — انتظر ${Math.ceil(rem / 60000)} دقيقة قبل إعادة المحاولة، فتكرار الضغط يُطيل الحظر`, 'err');
    return;
  }
  try { await loadSyncQuota(); } catch {}
  const q = state.syncQuota || { unlimited: true };
  if (!q.unlimited && !(q.left > 0)) {
    toast(q.quota ? `انتهى عدد مرات المزامنة اليوم (${fmt0(q.quota)}) — جرّب بكرة أو راجع المسؤول` : 'المزامنة غير مسموحة لحسابك — راجع المسؤول', 'err');
    return;
  }
  try { await loadSettings(); } catch {}
  if (!state.settings.hasSecret || !state.settings.apiKeyMasked) {
    toast('لم يُدخل مفتاح API بعد — على المسؤول إدخاله من الإعدادات', 'err');
    if (canEdit()) openSettings();
    return;
  }
  renderSyncKinds(savedSyncKinds());
  openModal('#mSync');
}

/** مربّعات الأنواع مع وقت آخر مزامنة لكلٍّ منها */
function renderSyncKinds(selected) {
  const box = $('#syncKinds');
  box.textContent = '';
  const by = state.settings.lastSyncBy || {};
  for (const k of SYNC_KINDS) {
    const lab = document.createElement('label');
    lab.className = 'sync-kind';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = k.id;
    cb.checked = selected.includes(k.id);
    cb.addEventListener('change', updateSyncPicker);
    const text = document.createElement('span');
    text.className = 'sk-text';
    const name = document.createElement('span');
    name.className = 'sk-label';
    name.textContent = k.label;
    const hint = document.createElement('span');
    hint.className = 'sk-hint';
    hint.textContent = k.hint;
    text.append(name, hint);
    const last = document.createElement('span');
    last.className = 'sk-last';
    last.textContent = k.id === 'balance'
      ? (state.balance && state.balance.updatedAt ? 'آخر تحديث: ' + fmtDT(state.balance.updatedAt) : '')
      : (by[k.id] ? 'آخر مزامنة: ' + fmtDT(by[k.id]) : 'لم يُزامَن بعد');
    lab.append(cb, text, last);
    box.append(lab);
  }
  updateSyncPicker();
}
const pickedSyncKinds = () => $$('#syncKinds input:checked').map((cb) => cb.value);
function updateSyncPicker() {
  const n = pickedSyncKinds().length;
  const all = $('#syncAll');
  all.checked = n === SYNC_KINDS.length;
  all.indeterminate = n > 0 && n < SYNC_KINDS.length;
  all.closest('.sync-kind').classList.toggle('on', all.checked);
  $$('#syncKinds .sync-kind').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
  const btn = $('#btnSyncStart');
  btn.disabled = !n;
  btn.querySelector('.lbl').textContent = n === SYNC_KINDS.length ? 'زامن الكل' : `زامن المحدَّد (${fmt0(n)})`;
}
function toggleAllSyncKinds(on) {
  $$('#syncKinds input').forEach((cb) => { cb.checked = on; });
  updateSyncPicker();
}
function startSync() {
  const picked = pickedSyncKinds();
  if (!picked.length) return;
  try { localStorage.setItem(SYNC_KINDS_KEY, JSON.stringify(picked)); } catch {}
  closeModal('#mSync');
  runSync(picked);
}

/** يجلب الأنواع المختارة؛ «الرصيد» يُحدَّث بعدها إن اختير */
async function runSync(kinds) {
  if (state.syncing) return;
  const dataKinds = kinds.filter((k) => k !== 'balance');
  const withBalance = kinds.includes('balance');
  if (!dataKinds.length) { refreshBalance(); return; }   // الرصيد وحده: بلا مزامنة ولا خصم من الحصّة
  state.syncing = true;
  $('#btnSync').disabled = true;
  $('#btnSync').classList.add('is-busy');   // الأيقونة تدور حتى تنتهي
  setSyncButton('جارٍ المزامنة…', '');
  $('#syncBar').classList.remove('hidden');
  $('#syncMsg').textContent = 'جارٍ بدء المزامنة…';
  $('#syncPct').style.width = '2%';
  let sawError = null;
  try {
    const res = await openStream('/api/sync', { kinds: dataKinds });
    await readNdjson(res, (ev) => {
      if (ev.error) { sawError = ev.error; return; }
      if (ev.done) {
        $('#syncPct').style.width = '100%';
        const newTx = (ev.depAdded || 0) + (ev.wdAdded || 0) + (ev.payAdded || 0) + (ev.cvtAdded || 0) + (ev.sptAdded || 0);
        const ran = ev.kinds || dataKinds;
        const what = ran.length < SYNC_KINDS.length - 1 ? ` (${ran.map(kindLabel).join('، ')})` : '';
        toast(`اكتملت المزامنة${what} ✓ — ${fmt0(ev.added)} طلب و ${fmt0(newTx)} حوالة (جديدة)`);
        return;
      }
      if (ev.msg) $('#syncMsg').textContent = ev.msg;
      if (ev.pct != null) $('#syncPct').style.width = ev.pct + '%';
      if (ev.msg && ev.msg.startsWith('⚠')) toast(ev.msg, 'err');   // تحذيرات الجلب المبتور تبقى مرئية
    });
    if (sawError) throw new Error(sawError);
    await Promise.all([loadOrders(), loadTransfers(), loadSettings()]);
    allowHeal();   // عمليةٌ وصلت في وسط الدفتر تُبطل ما ثُبِّت بعدها، فيُعاد الحساب
    renderAll();
    if (withBalance) refreshBalance();
  } catch (e) {
    toast(e.message, 'err');
    noteBanError(e.message);
  } finally {
    state.syncing = false;
    applySyncCooldown();                                 // يعيد الزرّ فورًا، ثم الحصّة الجديدة
    loadSyncQuota().catch(() => applySyncCooldown());   // الخادم خصم مرّة قبل البدء
    setTimeout(() => $('#syncBar').classList.add('hidden'), 800);
  }
}
