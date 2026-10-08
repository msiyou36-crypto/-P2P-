/* ربط الأحداث والبداية (آخر ملف يُحمَّل) */
'use strict';

/* ===== القائمة المنسدلة =====
 * تُفتح بالنقر أو بسهم الأسفل على زرّها، فيتركّز أول بند؛ الأسهم وHome/End تنقل بين
 * البنود الظاهرة، وEscape يغلقها ويعيد التركيز إلى الزرّ، والنقر خارجها يغلقها. */
const menuItems = () => $$('#menuDropdown .menu-item').filter((b) => b.offsetParent !== null);
function openMenu() {
  $('#menuDropdown').classList.remove('hidden');
  $('#btnMenu').setAttribute('aria-expanded', 'true');
  const first = menuItems()[0];
  if (first) first.focus({ preventScroll: true });
}
function closeMenu() { $('#menuDropdown').classList.add('hidden'); $('#btnMenu').setAttribute('aria-expanded', 'false'); }
function toggleMenu() { if ($('#menuDropdown').classList.contains('hidden')) openMenu(); else closeMenu(); }
function menuKeys(e) {
  const items = menuItems();
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const go = (k) => { e.preventDefault(); items[(k + items.length) % items.length].focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); $('#btnMenu').focus(); }
  else if (e.key === 'Tab') closeMenu();
}
/** زرّ في القائمة المنسدلة: يغلقها ثم ينفّذ */
const menuAction = (id, fn) => $(id).addEventListener('click', () => { closeMenu(); fn(); });

function wireEvents() {
  decorateIcons();     // أيقونات الأزرار والقائمة الثابتة في الصفحة (data-icon)
  wireScrollHints();   // النوافذ بلا شريط تمرير: تلاشٍ أسفلها إن كان تحتها المزيد
  wireBackgrounds();   // زرّا إيقاف الفيديو (شاشة الدخول والقائمة)، واستئنافه عند العودة للصفحة

  // --- تسجيل الدخول ---
  $('#setupForm').addEventListener('submit', doSetup);
  $('#loginForm').addEventListener('submit', doLogin);
  $$('#roleSeg button').forEach((btn) => btn.addEventListener('click', () => pickLoginRole(btn)));

  // --- الفترة: أزرارٌ جاهزة، و«مخصّص» يُظهر من/إلى ---
  $$('#rangeSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range;
      if (r === 'custom') {
        // «من/إلى» تبدأ من الفترة المعروضة الآن، فلا يتغيّر الجدول حتى تعدّلهما
        if (state.filters.range !== 'custom') {
          const [from] = rangeBounds();
          setCustomRange(from > 0 ? bizDayLabel(from) : '', from > 0 ? bizDayLabel(bizDayStart(Date.now())) : '');
          renderAll();
        }
        $('#xFrom').focus();
        return;
      }
      state.filters.range = r;
      state.filters.from = null; state.filters.to = null;
      $('#xFrom').value = ''; $('#xTo').value = '';
      state.page = 1;
      showRange(r);
      renderAll();
    });
  });
  const onDateChange = () => { setCustomRange($('#xFrom').value, $('#xTo').value); renderAll(); };
  $('#xFrom').addEventListener('change', onDateChange);
  $('#xTo').addEventListener('change', onDateChange);
  showRange(state.filters.range);

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

  // --- بطاقة الرصيد، وتصدير Excel من رأس الجدول ---
  $('#btnRefreshBal').addEventListener('click', refreshBalance);
  $('#btnExportXlsx').addEventListener('click', exportXlsx);

  // --- الشريط العلوي: المزامنة (والنقر عليها يغلق القائمة كأي نقرٍ خارجها) ---
  $('#btnSync').addEventListener('click', openSyncPicker);
  applySyncCooldown();
  $('#btnSyncStart').addEventListener('click', startSync);
  $('#syncAll').addEventListener('change', (e) => toggleAllSyncKinds(e.target.checked));

  // --- القائمة ---
  $('#btnMenu').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('#btnMenu').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(); } });
  $('#menuDropdown').addEventListener('click', (e) => e.stopPropagation());
  $('#menuDropdown').addEventListener('keydown', menuKeys);
  document.addEventListener('click', closeMenu);
  menuAction('#btnArchive', () => setArchiveView(true));
  $('#btnArchiveBack').addEventListener('click', () => setArchiveView(false));
  menuAction('#btnDiag', openDiag);
  menuAction('#btnMaintenance', openMaintenance);
  menuAction('#btnAdd', openAdd);
  menuAction('#btnImport', openImport);
  menuAction('#btnExport', exportCSV);
  menuAction('#btnSettings', openSettings);
  menuAction('#btnChangePass', openChangePass);
  menuAction('#btnLoginLog', openLoginLog);
  $('#logNewer').addEventListener('click', () => stepLoginLog(-1));
  $('#logOlder').addEventListener('click', () => stepLoginLog(1));
  menuAction('#btnLogout', doLogout);

  // --- نافذة الفحص ---
  $('#btnRunDiag').addEventListener('click', runDiag);
  $('#btnFetchDay').addEventListener('click', fetchOneDay);
  $('#btnWhoAmI').addEventListener('click', whoAmI);
  $('#btnForeignScan').addEventListener('click', foreignScan);
  $('#btnForeignUndo').addEventListener('click', undoForeignDelete);
  wireDropzone($('#restoreDrop'));
  $('#btnRestoreFile').addEventListener('click', restoreFromFile);

  // --- الصيانة ---
  $('#btnSaveMaint').addEventListener('click', saveMaintenance);
  $('#maintLogout').addEventListener('click', doLogout);

  // --- الإضافة اليدوية والاستيراد ---
  $('#btnSaveAdd').addEventListener('click', saveAdd);
  $('#addForm').elements.amount.addEventListener('input', autoTotal);
  $('#addForm').elements.unitPrice.addEventListener('input', autoTotal);
  $('#addForm').elements.totalPrice.addEventListener('input', markTotalEdited);
  $('#addForm').elements.fiat.addEventListener('change', syncAddUnits);
  wireDropzone($('#csvDrop'), handleImportFile);   // نقرٌ أو سحبُ ملف CSV وإفلاته
  $('#btnConfirmImport').addEventListener('click', confirmImport);

  // --- الإعدادات وكلمات السر ومنطقة الخطر ---
  wirePwToggles();   // زرّ العين بجانب كل حقل كلمة سر
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnSavePass').addEventListener('click', savePasswords);
  wireDangerZone();

  // --- حذف طلب من نافذة التفاصيل ---
  $('#btnDeleteOrder').addEventListener('click', deleteDetailsOrder);

  // --- نافذة التأكيد وإغلاق النوافذ ---
  $('#btnConfirmYes').addEventListener('click', () => {
    const fn = confirmAction;
    confirmAction = null;
    closeModal('#mConfirm');
    if (fn) fn();
  });
  $$('.backdrop').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) bd.classList.add('hidden'); }));
  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('.backdrop').classList.add('hidden')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAllModals(); closeMenu(); } });

  // --- تغيير الحجم: تُعاد الرسوم، والفيديو للشاشات العريضة وحدها ---
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderVolChart(); renderPriceChart(); fitAppBackground(); }, 150);
  });
}

wireEvents();
checkAuth();
