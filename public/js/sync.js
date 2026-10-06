/* المزامنة: زرّها، وقفل الحظر (٣٠ دقيقة بعد أي 429/418، يبقى بعد إعادة تحميل الصفحة
   ويُضبط أيضًا من blockedFor الذي يُرسله الخادم)، وقراءة بثّ التقدّم */
'use strict';

const SYNC_COOLDOWN_KEY = 'p2pSyncCooldownUntil';
let _cooldownTimer = null;
const syncCooldownUntil = () => Number(localStorage.getItem(SYNC_COOLDOWN_KEY) || 0);
function setSyncCooldown(ms) {
  localStorage.setItem(SYNC_COOLDOWN_KEY, String(Date.now() + ms));
  applySyncCooldown();
}
/** يضبط زر المزامنة: مقفول أثناء الحظر أو عند نفاد الحصّة، وإلا يعرض المتبقي */
function applySyncCooldown() {
  const btn = $('#btnSync');
  if (!btn || state.syncing) return;
  const q = state.syncQuota || { unlimited: true };
  btn.textContent = q.unlimited ? '⟳ مزامنة' : `⟳ مزامنة (${fmt0(q.left || 0)})`;
  const rem = syncCooldownUntil() - Date.now();
  if (rem > 0) {
    btn.disabled = true;
    btn.title = `المنصة حظرت الطلبات مؤقتًا — انتظر ${Math.ceil(rem / 60000)} دقيقة قبل إعادة المزامنة`;
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    _cooldownTimer = setTimeout(applySyncCooldown, Math.min(rem, 30000));
    return;
  }
  if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
  if (!q.unlimited && !(q.left > 0)) {
    btn.disabled = true;
    btn.title = q.quota ? `انتهى عدد مرات المزامنة اليوم (${fmt0(q.quota)}) — يتجدّد بكرة` : 'المزامنة غير مسموحة لحسابك — راجع المسؤول';
    return;
  }
  btn.disabled = false;
  btn.title = q.unlimited ? 'مزامنة' : `متبقّي ${fmt0(q.left)} من ${fmt0(q.quota)} مزامنة اليوم`;
}
/** بعد أي خطأ من المنصة: إن كان حظرًا يُقفل الزر ٣٠ دقيقة */
function noteBanError(message) {
  if (/HTTP 4(18|29)|حظر/.test(message || '')) setSyncCooldown(30 * 60000);
}

async function runSync() {
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
  state.syncing = true;
  $('#btnSync').disabled = true;
  $('#syncBar').classList.remove('hidden');
  $('#syncMsg').textContent = 'جارٍ بدء المزامنة…';
  $('#syncPct').style.width = '2%';
  let sawError = null;
  try {
    const res = await openStream('/api/sync');
    await readNdjson(res, (ev) => {
      if (ev.error) { sawError = ev.error; return; }
      if (ev.done) {
        $('#syncPct').style.width = '100%';
        const newTx = (ev.depAdded || 0) + (ev.wdAdded || 0) + (ev.payAdded || 0) + (ev.cvtAdded || 0) + (ev.sptAdded || 0);
        toast(`اكتملت المزامنة ✓ — ${fmt0(ev.added)} طلب و ${fmt0(newTx)} حوالة (جديدة)`);
        return;
      }
      if (ev.msg) $('#syncMsg').textContent = ev.msg;
      if (ev.pct != null) $('#syncPct').style.width = ev.pct + '%';
      if (ev.msg && ev.msg.startsWith('⚠')) toast(ev.msg, 'err');   // تحذيرات الجلب المبتور تبقى مرئية
    });
    if (sawError) throw new Error(sawError);
    await Promise.all([loadOrders(), loadTransfers()]);
    renderAll();
    refreshBalance();
  } catch (e) {
    toast(e.message, 'err');
    noteBanError(e.message);
  } finally {
    state.syncing = false;
    loadSyncQuota().catch(() => applySyncCooldown());   // الخادم خصم مرّة قبل البدء
    setTimeout(() => $('#syncBar').classList.add('hidden'), 800);
  }
}
