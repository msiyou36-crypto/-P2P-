/* ربط الأحداث والبداية (آخر ملف يُحمَّل) */
'use strict';

function closeMenu() { $('#menuDropdown').classList.add('hidden'); $('#btnMenu').setAttribute('aria-expanded', 'false'); }
function toggleMenu() {
  const open = $('#menuDropdown').classList.toggle('hidden');
  $('#btnMenu').setAttribute('aria-expanded', String(!open));
}
/** زرّ في القائمة المنسدلة: يغلقها ثم ينفّذ */
const menuAction = (id, fn) => $(id).addEventListener('click', () => { closeMenu(); fn(); });
/** زرّ تأكيدٍ ثم تنفيذٍ ثم إعادة تحميل */
function confirmThen(id, message, fn, done) {
  $(id).addEventListener('click', () => openConfirm(message, async () => {
    try { const j = await fn(); closeAllModals(); await done(j); } catch (e) { toast(e.message, 'err'); }
  }));
}

function wireEvents() {
  // --- تسجيل الدخول ---
  $('#setupForm').addEventListener('submit', doSetup);
  $('#loginForm').addEventListener('submit', doLogin);
  $$('#roleSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#roleSeg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      loginRole = btn.dataset.role;
      const cap = $('#roleCaption');
      if (cap) cap.textContent = ROLE_NAMES[loginRole] || '';
      $('#loginError').textContent = '';
      try { $('#loginForm').elements.password.focus(); } catch {}
    });
  });

  // --- النطاق الزمني وفلتر من/إلى ---
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

  // --- الفرز والترقيم ---
  $$('#ledgerTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else { state.sort.key = key; state.sort.dir = key === '_t' ? -1 : 1; }
      renderLedger();
    });
  });
  $('#pgPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderLedger(); } });
  $('#pgNext').addEventListener('click', () => { state.page++; renderLedger(); });
  wireViewControls();   // شكل العرض: جدول، يومي، بطاقات، مربعات

  // --- القائمة ---
  $('#btnMenu').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('#menuDropdown').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeMenu);
  menuAction('#btnSync', openSyncPicker);
  applySyncCooldown();
  $('#btnSyncStart').addEventListener('click', startSync);
  $('#syncAll').addEventListener('change', (e) => toggleAllSyncKinds(e.target.checked));
  menuAction('#btnArchive', () => setArchiveView(true));
  $('#btnArchiveBack').addEventListener('click', () => setArchiveView(false));
  menuAction('#btnDiag', openDiag);
  menuAction('#btnMaintenance', openMaintenance);
  menuAction('#btnAdd', openAdd);
  menuAction('#btnImport', () => {
    $('#csvFile').value = '';
    $('#importPreview').classList.add('hidden');
    $('#btnConfirmImport').classList.add('hidden');
    state.importRows = null;
    openModal('#mImport');
  });
  menuAction('#btnExport', exportCSV);
  menuAction('#btnSettings', openSettings);
  menuAction('#btnChangePass', () => { $('#passForm').reset(); openModal('#mChangePass'); });
  menuAction('#btnLoginLog', openLoginLog);
  menuAction('#btnLogout', doLogout);
  $('#btnExportXlsx').addEventListener('click', exportXlsx);
  $('#btnRefreshBal').addEventListener('click', refreshBalance);

  // --- نافذة الفحص ---
  $('#btnRunDiag').addEventListener('click', runDiag);
  $('#btnFetchDay').addEventListener('click', fetchOneDay);
  $('#btnWhoAmI').addEventListener('click', whoAmI);
  $('#btnForeignScan').addEventListener('click', foreignScan);
  $('#btnForeignUndo').addEventListener('click', undoForeignDelete);
  $('#btnRestoreFile').addEventListener('click', restoreFromFile);

  // --- الصيانة ---
  $('#btnSaveMaint').addEventListener('click', saveMaintenance);
  $('#maintLogout').addEventListener('click', doLogout);

  // --- الإضافة اليدوية والاستيراد ---
  $('#btnSaveAdd').addEventListener('click', saveAdd);
  $('#addForm').elements.amount.addEventListener('input', autoTotal);
  $('#addForm').elements.unitPrice.addEventListener('input', autoTotal);
  $('#addForm').elements.totalPrice.addEventListener('input', () => { totalPriceDirty = true; });
  $('#csvFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]); });
  $('#btnConfirmImport').addEventListener('click', confirmImport);

  // --- الإعدادات ومنطقة الخطر ---
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnSavePass').addEventListener('click', savePasswords);
  $('#btnArchiveBefore').addEventListener('click', () => archiveBefore(false));
  $('#btnUnarchiveBefore').addEventListener('click', () => archiveBefore(true));
  $('#btnForeignClean').addEventListener('click', cleanForeign);
  confirmThen('#btnClearAll', 'سيتم حذف جميع الطلبات المخزّنة نهائيًا. هل أنت متأكد؟',
    () => api('/api/orders/clear', { method: 'POST' }), async () => { toast('تم مسح جميع الطلبات'); await loadOrders(); renderAll(); });
  confirmThen('#btnClearTransfers', 'سيتم حذف سجل الإيداع والسحب المخزّن نهائيًا. هل أنت متأكد؟',
    () => api('/api/transfers/clear', { method: 'POST' }), async () => { toast('تم مسح سجل الإيداع والسحب'); await loadTransfers(); renderAll(); });
  confirmThen('#btnUnfreezeBal', 'سيُلغى تثبيت عمود «الباقي من USDT» وتُحسب كل الأرقام من جديد. استخدمها لو ثُبِّتت أرقام خاطئة. هل أنت متأكد؟',
    () => api('/api/balance/unfreeze', { method: 'POST' }), async (j) => { await Promise.all([loadOrders(), loadTransfers()]); renderAll(); toast(`أُلغي تثبيت ${fmt0(j.cleared)} رقم — أُعيد الحساب`); });

  // --- حذف طلب من نافذة التفاصيل ---
  $('#btnDeleteOrder').addEventListener('click', () => {
    const o = state.detailsOrder;
    if (!o) return;
    openConfirm(`سيتم حذف الطلب ${o.orderNumber} من السجل. هل أنت متأكد؟`, async () => {
      try { await api('/api/orders?id=' + encodeURIComponent(o.orderNumber), { method: 'DELETE' }); closeAllModals(); toast('تم حذف الطلب'); await loadOrders(); renderAll(); }
      catch (e) { toast(e.message, 'err'); }
    });
  });

  // --- نافذة التأكيد وإغلاق النوافذ ---
  $('#btnConfirmYes').addEventListener('click', () => {
    const fn = confirmAction;
    confirmAction = null;
    closeModal('#mConfirm');
    if (fn) fn();
  });
  $$('.backdrop').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) bd.classList.add('hidden'); }));
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('.backdrop').classList.add('hidden')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });

  // --- إعادة رسم الرسوم عند تغيير الحجم ---
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderVolChart(); renderPriceChart(); }, 150);
  });
}

wireEvents();
checkAuth();
