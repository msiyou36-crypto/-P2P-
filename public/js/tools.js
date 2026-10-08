/* أدوات المسؤول: نافذة «فحص المزامنة» بأدواتها (فحص ما تُرجعه المنصة، جلب يوم، هوية
   المفتاح، فحص الدخيل وحذفه واسترجاعه، الاستعادة من ملف، حذف بيانات الحساب الآخر، الأرشفة
   بتاريخ)، والإضافة اليدوية، والاستيراد والتصدير، والإعدادات وكلمات السر وسجل الدخول */
'use strict';

/* ============================ فحص المزامنة ============================ */

function openDiag() { $('#diagResult').textContent = ''; resetDropzone($('#restoreDrop')); openModal('#mDiag'); }

/** صندوق النتيجة أسفل الأدوات: يُفرَّغ ويُمرَّر إليه، فيرى المسؤول ما يحدث مهما كانت الأداة */
function diagBox() {
  const box = $('#diagResult');
  box.textContent = '';
  requestAnimationFrame(() => box.scrollIntoView({ block: 'start' }));
  return box;
}

/** شريط تقدّم داخل نافذة الفحص؛ يُرجع { msg, fill, remove } */
function progressRow(box) {
  const row = document.createElement('div');
  row.className = 'syncbar-row';
  const spin = document.createElement('span'); spin.className = 'spinner';
  const msg = document.createElement('span'); msg.textContent = 'جارٍ البدء…';
  row.append(spin, msg);
  const track = document.createElement('div'); track.className = 'syncbar-track';
  const fill = document.createElement('div'); fill.className = 'syncbar-fill'; fill.style.width = '2%';
  track.append(fill);
  box.append(row, track);
  return { msg, fill, row, remove: () => { row.remove(); track.remove(); } };
}

/** قائمة بخانات اختيار داخل نافذة الفحص؛ يُرجع { boxes, add(kind, item, label, checked) } */
function checkList(box) {
  const list = document.createElement('div');
  list.className = 'foreign-list';
  box.append(list);
  const boxes = [];
  return {
    boxes,
    add(kind, it, label, checked) {
      const lab = document.createElement('label');
      lab.className = 'foreign-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = checked; cb.dataset.kind = kind; cb.dataset.id = it.id; cb.dataset.time = String(it.time || 0); cb._rec = it;
      const span = document.createElement('span'); span.textContent = label;
      lab.append(cb, span);
      list.append(lab);
      boxes.push(cb);
    },
  };
}
const orderLabel = (o, time) => `${fmtDT(time)} — ${o.tradeType === 'SELL' ? 'بيع' : 'شراء'} ${fmt2(o.amount)} USDT @ ${fmt2p(o.unitPrice)} ${o.fiat || ''} = ${fmt2p(o.totalPrice)} — ${o.counterPart || '—'}${o.reference ? ' — إشاري: ' + o.reference : ''}`;
const transferLabel = (t) => `${fmtDT(t.time)} — ${txKindAr(t.kind)} ${fmt2(t.amount)} ${t.coin || 'USDT'}${t.network ? ' (' + t.network + ')' : ''}${t.counterPart ? ' — ' + t.counterPart : ''}${t.reference ? ' — إشاري: ' + t.reference : ''}`;

/** يُعيد تحميل السجل ويرسمه بعد عمليةٍ غيّرته */
async function reloadAfterChange() {
  closeAllModals();
  await Promise.all([loadOrders(), loadTransfers()]);
  renderAll();
  refreshBalance();
}

/* ما تُرجعه المنصة فعلًا في آخر N يومًا مقابل المحفوظ */
async function runDiag() {
  const days = Math.min(Math.max(Number($('#diagDays').value) || 3, 1), 29);
  const box = diagBox();
  const btn = $('#btnRunDiag');
  btn.disabled = true;
  box.append(diagLine('hint', 'جارٍ سؤال المنصة… قد يستغرق بضع ثوانٍ.'));
  let d;
  try { d = await api('/api/diag/p2p?days=' + days); }
  catch (e) { box.textContent = ''; box.append(diagLine('diag-bad', e.message)); noteBanError(e.message); btn.disabled = false; return; }
  btn.disabled = false;
  box.textContent = '';
  const total = d.fromPlatform.length;
  // عمليةٌ وقعت بعد آخر مزامنةٍ لطلبات P2P ليست خللًا — لم يأتِ دورها بعد
  const by = state.settings.lastSyncBy;
  const ls = Number(by ? by.p2p : state.settings.lastSync) || 0;
  const unsaved = d.fromPlatform.filter((x) => !x.stored);
  const fresh = ls ? unsaved.filter((x) => x.time > ls).length : 0;
  const stale = unsaved.length - fresh;
  box.append(diagLine(
    total === 0 || stale > 0 ? 'diag-bad' : 'diag-ok',
    total === 0
      ? `المنصة لم تُرجع أي عملية P2P في آخر ${days} يوم — العمليات المفقودة ليست على هذا المفتاح.`
      : stale > 0
        ? `المنصة أرجعت ${fmt0(total)} عملية، منها ${fmt0(stale)} وقعت قبل آخر مزامنة ولم تُحفظ — هذه هي المشكلة، والمزامنة القادمة تُصلحها.`
        : fresh > 0
          ? `المنصة أرجعت ${fmt0(total)} عملية، وكلُّ ما ليس عندك (${fmt0(fresh)}) وقع بعد آخر مزامنة — لا خلل، اضغط «مزامنة» ليصل.`
          : `المنصة أرجعت ${fmt0(total)} عملية وكلها محفوظة عندك — فما لا تجده في الجدول لا تُرجعه المنصة أصلًا لهذا المفتاح.`));
  if (total) {
    const t = document.createElement('table');
    t.className = 'diag-table';
    const th = document.createElement('tr');
    for (const h of ['التاريخ', 'النوع', 'الكمية', 'الحالة', 'آخر ٤', 'محفوظة؟']) { const c = document.createElement('th'); c.textContent = h; th.append(c); }
    t.append(th);
    for (const r of d.fromPlatform) {
      const tr = document.createElement('tr');
      if (!r.stored) tr.className = 'diag-miss';
      for (const v of [fmtDT(r.time), r.tradeType === 'BUY' ? 'شراء' : 'بيع', fmt2(r.amount), r.status, r.tail, r.stored ? 'نعم' : 'لا ✗']) {
        const c = document.createElement('td'); c.textContent = v; tr.append(c);
      }
      t.append(tr);
    }
    box.append(t);
  }
  if (d.onlyOurs && d.onlyOurs.length) {
    box.append(diagLine('hint', `محفوظ عندك ولم تُرجعه المنصة (${fmt0(d.onlyOurs.length)}): ` + d.onlyOurs.map((o) => o.tail + ' · ' + fmt2(o.amount)).join(' — ')));
  }
  for (const w of (d.warnings || [])) box.append(diagLine('diag-bad', w));
}

/* جلب يومٍ واحد: علاجٌ موضعي لمن ينقصه يوم، بلا كلفة المزامنة الكاملة */
async function fetchOneDay() {
  const day = $('#diagDay').value;
  const box = diagBox();
  const btn = $('#btnFetchDay');
  if (!day) { box.append(diagLine('diag-bad', 'اختر اليوم أولًا')); return; }
  btn.disabled = true;
  box.append(diagLine('hint', `جارٍ سؤال المنصة عن ${day}…`));
  let d;
  try { d = await postJSON('/api/sync/day', { day }); }
  catch (e) { box.textContent = ''; box.append(diagLine('diag-bad', e.message)); noteBanError(e.message); btn.disabled = false; return; }
  btn.disabled = false;
  box.textContent = '';
  const NAMES = { p2p: 'طلبات P2P', deposit: 'إيداع', withdraw: 'سحب', pay: 'Binance Pay', convert: 'تحويل Convert' };
  box.append(diagLine(
    d.total === 0 ? 'diag-bad' : (d.totalAdded > 0 ? 'diag-ok' : 'hint'),
    d.total === 0
      ? `المنصة لم تُرجع أي عملية في ${d.day} — فما ينقصك لا تُرجعه المنصة أصلًا لهذا المفتاح، وسبيلُه «إضافة يدوية» من القائمة.`
      : (d.totalAdded > 0
        ? `وصلت ${fmt0(d.total)} عملية في ${d.day}، منها ${fmt0(d.totalAdded)} جديدة أُضيفت للسجل ✓`
        : `وصلت ${fmt0(d.total)} عملية في ${d.day} وكلها محفوظة عندك — فما لا تجده في الجدول لا تُرجعه المنصة.`)));
  for (const k of Object.keys(NAMES)) {
    if (!d.found[k]) continue;
    box.append(diagLine('hint', `${NAMES[k]}: وصل ${fmt0(d.found[k])}${d.added[k] ? ` · جديد ${fmt0(d.added[k])}` : ''}`));
  }
  for (const s of (d.skipped || [])) box.append(diagLine('diag-bad', 'تعذّر جلب ' + s));
  if (d.totalAdded > 0) { await Promise.all([loadOrders(), loadTransfers()]); allowHeal(); }
  // نضبط فلتر الجدول على ذلك اليوم فيرى المستخدم النتيجة أمامه فورًا
  $('#xFrom').value = d.day;
  $('#xTo').value = d.day;
  state.filters.range = 'custom';
  state.filters.from = d.day;
  state.filters.to = d.day;
  state.page = 1;
  $$('#rangeSeg button').forEach((b) => b.classList.remove('on'));
  renderAll();
  const shown = state.ledger.length;
  box.append(diagLine(shown ? 'diag-ok' : 'diag-bad', shown
    ? `محفوظ عندك في ${d.day}: ${fmt0(d.stored)} عملية — وضبطتُ الجدول على هذا اليوم، وهي ظاهرة فيه الآن (${fmt0(shown)}).`
    : `محفوظ عندك في ${d.day}: ${fmt0(d.stored)} عملية، ولا يعرض الجدول شيئًا — تحقّق من فلتر «النوع» و«الحالة» أعلى الجدول.`));
  if (d.totalAdded > 0) toast(`أُضيفت ${fmt0(d.totalAdded)} عملية من ${d.day} ✓`);
}

/* أيُّ حساب Binance يقرأه مفتاح هذا السستم؟ */
async function whoAmI() {
  const box = diagBox();
  const btn = $('#btnWhoAmI');
  btn.disabled = true;
  box.append(diagLine('hint', 'جارٍ سؤال المنصة عن صاحب المفتاح…'));
  let d;
  try { d = await api('/api/diag/whoami'); }
  catch (e) { box.textContent = ''; box.append(diagLine('diag-bad', e.message)); noteBanError(e.message); btn.disabled = false; return; }
  btn.disabled = false;
  box.textContent = '';
  box.append(diagLine('diag-ok', `مفتاح هذا السستم («${d.accountName}»، ${d.keyMasked}) يقرأ حساب Binance ذا المعرّف UID: ${d.uid || '—'}`));
  box.append(diagLine('hint', 'افتح تطبيق Binance ← الصفحة الشخصية (أعلى اليسار) ← UID. إن طابق معرّفَ الحساب المقصود فالمفتاح صحيح؛ وإن طابق الحساب الآخر فالمفتاحان متبادلان.'));
}

/* عملياتٌ محفوظة هنا لا يُرجعها مفتاح هذا الحساب: تُعرض بخانات اختيار والمسؤول يقرّر */
async function foreignScan() {
  const days = Math.min(Math.max(Number($('#foreignDays').value) || 90, 1), 400);
  const box = diagBox();
  const btn = $('#btnForeignScan');
  btn.disabled = true;
  const prog = progressRow(box);
  let rep = null, sawError = null;
  try {
    const res = await openStream('/api/diag/foreign-ops', { days });
    await readNdjson(res, (ev) => {
      if (ev.error) sawError = ev.error;
      else if (ev.done) rep = ev;
      else { if (ev.msg) prog.msg.textContent = ev.msg; if (ev.pct != null) prog.fill.style.width = ev.pct + '%'; }
    });
    if (sawError) throw new Error(sawError);
  } catch (e) {
    box.insertBefore(diagLine('diag-bad', e.message), prog.row);
    noteBanError(e.message);
  } finally {
    prog.remove();
    btn.disabled = false;
  }
  if (!rep) return;
  for (const w of rep.warnings || []) box.append(diagLine('diag-bad', w));
  const n = rep.orders.length + rep.transfers.length;
  const lastO = (rep.lastReturned && rep.lastReturned.order) || 0;
  box.append(diagLine('hint', `المنصة أرجعت لمفتاح «${rep.accountName}» في آخر ${fmt0(rep.days)} يومًا: ${fmt0(rep.fetched.orders)} طلبًا و${fmt0(rep.fetched.transfers)} حوالة.`));
  // أثر الجلب يكشف إن كانت المنصة تُرجع صفحةً مبتورة — وعندها القائمة ليست حكمًا
  if (rep.truncated) box.append(diagLine('diag-bad', rep.windowsIgnored
    ? 'المنصة تُهمل الفترة المطلوبة وتُرجع أحدث صفحةٍ فقط — الجلب مبتور بطبيعة المنصة، وقائمة الطلبات أدناه ليست موثوقة (كل ما هو أقدم سيظهر «غير مُرجَع»). لا تحذف منها شيئًا.'
    : 'الجلب مبتور (نفد الرصيد أو لم تكفِ قسمة الفترة) — قائمة الطلبات أدناه ليست موثوقة. لا تحذف منها شيئًا وأرسل «تفاصيل الجلب».'));
  const calls = rep.calls || [];
  if (calls.length) {
    const det = document.createElement('details');
    det.className = 'fold';
    const sum = document.createElement('summary'); sum.textContent = 'تفاصيل الجلب (لكل نافذة وصفحة)';
    det.append(sum);
    for (const c of calls) {
      det.append(diagLine('hint', `${c.type === 'SELL' ? 'بيع' : 'شراء'} ${fmtDT(c.from).slice(0, 10)} ← ${fmtDT(c.to).slice(0, 10)} · صفحة ${c.page}: ${fmt0(c.rows)} صف (سقف ${fmt0(c.cap)})`
        + (c.total != null ? ` (المجموع المعلن ${fmt0(c.total)})` : '') + ` · جديد ${fmt0(c.fresh)}` + (c.outside ? ` · خارج الفترة ${fmt0(c.outside)}` : '')));
    }
    box.append(det);
  }
  if (!n) { box.append(diagLine('diag-ok', 'كل ما هو محفوظ هنا في هذه الفترة أرجعته المنصة لهذا الحساب ✓ — لا شيء غريب.')); return; }
  // آخر طلبٍ أرجعته المنصة هو الحدّ الفاصل: ما بعده ليس من هذا الحساب يقينًا فيُحدَّد تلقائيًا
  const sureO = rep.orders.filter((o) => o.time > lastO).length;
  if (lastO) box.append(diagLine('hint', `آخر طلب P2P أرجعته المنصة لهذا الحساب: ${fmtDT(lastO)} — كل طلبٍ محفوظ بعده ليس من هذا الحساب يقينًا (${fmt0(sureO)} طلبًا، محدَّدة تلقائيًا). ما قبله (${fmt0(rep.orders.length - sureO)}) اتركه إلا إن كنت متأكدًا.`));
  const byMonth = {};
  for (const x of [...rep.orders, ...rep.transfers]) { const m = fmtDT(x.time).slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; }
  box.append(diagLine('hint', 'توزيعها بالشهر: ' + Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).map(([m, c]) => `${m} ×${fmt0(c)}`).join(' · ')));
  box.append(diagLine('diag-bad', `${fmt0(n)} عملية محفوظة هنا لم تُرجعها المنصة لهذا الحساب — راجع القائمة، ثم احذف المحدَّد.`));

  const ctl = document.createElement('div');
  ctl.className = 'diag-bar';
  const mkBtn = (text) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = text; return b; };
  const bSure = mkBtn('المؤكَّد فقط'), bAll = mkBtn('حدّد الكل'), bNone = mkBtn('أزل التحديد'), bAfter = mkBtn('حدّد ما بعد التاريخ');
  const afterInp = document.createElement('input');
  afterInp.type = 'datetime-local'; afterInp.dir = 'ltr';
  afterInp.setAttribute('aria-label', 'التاريخ الذي يُحدَّد ما بعده');
  ctl.append(bSure, bAll, bNone, afterInp, bAfter);
  box.append(ctl);
  const list = checkList(box);
  const SRC_AR = { binance: 'من المزامنة', import: 'من ملف مستورد', manual: 'إضافة يدوية' };
  for (const o of rep.orders) {
    const sure = o.time > lastO;
    list.add('order', o, `${orderLabel(o, o.time)} (${SRC_AR[o.source] || o.source || ''})${sure ? '' : ' — ؟ قبل آخر طلبٍ أرجعته المنصة'}`, sure);
  }
  for (const t of rep.transfers) list.add('transfer', t, `${transferLabel(t)} (${SRC_AR[t.source] || t.source || ''})`, true);
  const boxes = list.boxes;
  boxes.forEach((b) => { b.dataset.sure = b.checked ? '1' : ''; });
  const act = iconButton('btn danger diag-act', 'trash');
  const refresh = () => { const c = boxes.filter((b) => b.checked).length; act.lbl.textContent = `احذف المحدّدة (${fmt0(c)}) من «${rep.accountName}»`; act.disabled = !c; };
  boxes.forEach((b) => b.addEventListener('change', refresh));
  bAll.addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); refresh(); });
  bNone.addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); refresh(); });
  bSure.addEventListener('click', () => { boxes.forEach((b) => { b.checked = !!b.dataset.sure; }); refresh(); });
  bAfter.addEventListener('click', () => {
    const ms = afterInp.value ? new Date(afterInp.value).getTime() : NaN;
    if (!Number.isFinite(ms)) { toast('حدّد التاريخ أولًا', 'err'); return; }
    boxes.forEach((b) => { b.checked = Number(b.dataset.time) >= ms; });
    refresh();
  });
  refresh();
  act.addEventListener('click', () => {
    const sel = boxes.filter((b) => b.checked);
    openConfirm(`ستُحذف ${fmt0(sel.length)} عملية من «${rep.accountName}» نهائيًا (لا تعود بالمزامنة، لأن المنصة لا تُرجعها لهذا الحساب أصلًا)، ويُعاد حساب «الباقي من USDT». هل أنت متأكد؟`, async () => {
      try {
        const j = await postJSON('/api/diag/foreign-ops/delete', {
          orders: sel.filter((b) => b.dataset.kind === 'order').map((b) => b.dataset.id),
          transfers: sel.filter((b) => b.dataset.kind === 'transfer').map((b) => b.dataset.id),
        });
        await reloadAfterChange();
        toast(`حُذفت ${fmt0(j.deleted)} عملية من ${j.accountName} ✓`);
      } catch (e) { toast(e.message, 'err'); }
    });
  });
  box.append(act);
}

/* استرجاعُ آخر حذفٍ من أداة الفحص (سلّة المحذوف تُعاد كلها) */
async function undoForeignDelete() {
  openConfirm('سيُعاد كل ما حُذف في آخر عملية حذف من أداة «ما لا يخصّ هذا الحساب»، ويُعاد حساب «الباقي». هل أنت متأكد؟', async () => {
    try {
      const j = await api('/api/diag/foreign-ops/undo', { method: 'POST' });
      await reloadAfterChange();
      toast(j.restored ? `أُعيدت ${fmt0(j.restored)} عملية إلى ${j.accountName} ✓` : 'سلّة المحذوف فارغة — لا شيء يُعاد', j.restored ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* الاستعادة من ملف تصدير (Excel/CSV من النظام) */
async function restoreFromFile() {
  const inp = $('#restoreFile');
  const box = diagBox();
  const btn = $('#btnRestoreFile');
  const file = inp.files && inp.files[0];
  if (!file) { box.append(diagLine('diag-bad', 'اختر ملف التصدير أولًا (Excel أو CSV)')); return; }
  btn.disabled = true;
  box.append(diagLine('hint', `جارٍ قراءة «${file.name}» ومقارنته بالمحفوظ…`));
  let d;
  try {
    const headers = {};
    if (state.auth.token) headers['X-Auth-Token'] = state.auth.token;
    const res = await fetch('/api/restore/preview', { method: 'POST', headers, body: file });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { handleUnauthorized(); throw new Error('انتهت الجلسة — سجّل الدخول'); }
    if (!res.ok) throw new Error(j.error || 'تعذّرت قراءة الملف');
    d = j;
  } catch (e) { box.textContent = ''; box.append(diagLine('diag-bad', e.message)); btn.disabled = false; return; }
  btn.disabled = false;
  box.textContent = '';
  box.append(diagLine('hint', `في الملف ${fmt0(d.rows)} صفًّا: ${fmt0(d.inFile.orders)} طلبًا و${fmt0(d.inFile.transfers)} حوالة Pay/تحويل و${fmt0(d.inFile.depwd)} إيداعًا/سحبًا (هذه تُعيدها المزامنة من المنصة إن نقصت).`));
  const n = d.missingOrders.length + d.missingTransfers.length;
  if (!n) { box.append(diagLine('diag-ok', `كل طلبات الملف وحوالاته موجودة في «${d.accountName}» ✓ — لا شيء ينقص.`)); return; }
  box.append(diagLine('diag-bad', `${fmt0(n)} عملية في الملف غير موجودة الآن في «${d.accountName}» — اختر ما يُعاد.`));
  const list = checkList(box);
  for (const o of d.missingOrders) list.add('order', o, orderLabel(o, o.createTime), true);
  for (const t of d.missingTransfers) list.add('transfer', t, transferLabel(t), true);
  const boxes = list.boxes;
  const act = iconButton('btn accent diag-act', 'undo');
  const refresh = () => { const c = boxes.filter((b) => b.checked).length; act.lbl.textContent = `أعد المحدّدة (${fmt0(c)}) إلى «${d.accountName}»`; act.disabled = !c; };
  boxes.forEach((b) => b.addEventListener('change', refresh));
  refresh();
  act.addEventListener('click', () => openConfirm(`ستُعاد ${fmt0(boxes.filter((b) => b.checked).length)} عملية إلى «${d.accountName}» من الملف، ويُعاد حساب «الباقي». هل أنت متأكد؟`, async () => {
    try {
      const sel = boxes.filter((b) => b.checked);
      const j = await postJSON('/api/restore/apply', { orders: sel.filter((b) => b.dataset.kind === 'order').map((b) => b._rec), transfers: sel.filter((b) => b.dataset.kind === 'transfer').map((b) => b._rec) });
      await reloadAfterChange();
      toast(`أُعيدت ${fmt0(j.restored)} عملية إلى ${j.accountName} ✓`);
    } catch (e) { toast(e.message, 'err'); }
  }));
  box.append(act);
}

/* حذفُ بيانات الحساب الآخر من قاعدة هذا السستم (بعد الفصل التام) */
async function cleanForeign() {
  let d;
  try { d = await api('/api/system/foreign'); } catch (e) { toast(e.message, 'err'); return; }
  if (!d.count) { toast(`لا توجد بيانات لـ«${d.otherName}» في قاعدة هذا السستم ✓`); return; }
  const list = d.items.map((i) => `${i.key} (${fmt0(i.rows)})`).join('، ');
  openConfirm(`سيُحذف من قاعدة هذا السستم ${fmt0(d.count)} مفتاحًا يخصّ «${d.otherName}»: ${list}. لا تفعل هذا إلا بعد أن يعمل سستم «${d.otherName}» على قاعدته الجديدة وترى بياناته فيه. هل أنت متأكد؟`, async () => {
    const w = prompt('للتأكيد اكتب كلمة: حذف');
    if (w == null || w.trim() !== 'حذف') { toast('أُلغي الحذف'); return; }
    try {
      const j = await api('/api/system/foreign', { method: 'DELETE' });
      toast(`حُذفت بيانات ${j.otherName} من هذه القاعدة (${fmt0(j.deleted)} مفتاحًا) ✓`);
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
      toast(n ? (undo ? `أُرجع ${fmt0(n)} عملية من الأرشيف ✓` : `أُرشفت ${fmt0(n)} عملية (${fmt0(j.orders)} طلبًا و${fmt0(j.transfers)} حوالة) ✓`) : 'لا شيء قبل هذا التاريخ', n ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============================ الإضافة اليدوية ============================ */

let totalPriceDirty = false;
const toLocalDatetimeValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function openAdd() {
  const form = $('#addForm');
  form.reset();
  form.elements.dt.value = toLocalDatetimeValue(new Date());
  totalPriceDirty = false;
  syncAddUnits();
  openModal('#mAdd');
}
/** وحدة السعر والمبلغ داخل الحقل تتبع العملة المختارة (ج.س أو ج.م) */
function syncAddUnits() {
  const code = $('#addForm').elements.fiat.value;
  $$('#addForm .fiat-unit').forEach((u) => { u.textContent = symForCode(code); });
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
  const fc = el.fiat.value;
  const payload = {
    tradeType: el.tradeType.value,
    createTime: new Date(el.dt.value).getTime(),
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
    await postJSON('/api/orders', payload);
    closeModal('#mAdd');
    toast('تم حفظ الطلب ✓');
    await loadOrders();
    renderAll();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ التصدير ============================ */

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** صفوف الجدول المعروض بأعمدة التصدير (نفس الأعمدة في CSV وExcel) */
function ledgerRows() {
  return state.ledger.map((row) => {
    const it = row.raw, isP2P = row._kind === 'p2p';
    const b = balOf(it, isP2P);
    return {
      date: fmtDTsec(row._t),
      type: isP2P ? (it.tradeType === 'SELL' ? 'بيع' : 'شراء') : txKindAr(it.kind),
      amount: isP2P ? grossUSDT(it) : it.amount,
      balance: b == null ? '' : b,
      price: isP2P ? effUnitPrice(it) : (it.unitPriceOverride != null ? it.unitPriceOverride : ''),
      total: isP2P ? effTotalPrice(it) : (it.totalPriceOverride != null ? it.totalPriceOverride : ''),
      curNet: it.networkLabelOverride != null ? it.networkLabelOverride : (isP2P ? fiatSymOf(it) : (it.network || it.coin || '')),
      party: it.counterPart || '',
      status: isP2P ? statusInfo(it.orderStatus).ar : txStatusInfo(it.status).ar,
      fee: isP2P ? effComm(it) : (it.fee || 0),
      reference: it.reference || '',
      note: it.note || '',
      id: isP2P ? it.orderNumber : (it.txId || it.id || ''),
    };
  });
}
const exportFileName = (ext) => { const d = new Date(); return `سجل-العمليات-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.${ext}`; };

function exportCSV() {
  if (!state.ledger.length) { toast('لا توجد عمليات ضمن الفلاتر الحالية للتصدير', 'err'); return; }
  const headers = ['التاريخ', 'النوع', 'الكمية USDT', 'السعر', 'المبلغ', 'العملة/الشبكة', 'الباقي من USDT', 'الطرف الآخر', 'الحالة', 'العمولة/الرسوم', 'الإشاري', 'الملاحظة', 'المعرّف'];
  const lines = [headers.join(',')];
  for (const r of ledgerRows()) {
    lines.push([csvCell(r.date), r.type, r.amount, r.price, r.total, csvCell(r.curNet), r.balance, csvCell(r.party), csvCell(r.status), r.fee, csvCell(r.reference), csvCell(r.note), csvCell(r.id)].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFileName('csv');
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
    { header: 'الباقي من USDT', width: 16, type: 'number' },
    { header: 'الطرف الآخر', width: 16, type: 'text' },
    { header: 'الحالة', width: 12, type: 'text' },
    { header: 'العمولة/الرسوم', width: 12, type: 'number' },
    { header: 'الإشاري', width: 16, type: 'text' },
    { header: 'الملاحظة', width: 22, type: 'text' },
    { header: 'المعرّف / TxID', width: 28, type: 'text' },
  ];
  const rows = ledgerRows().map((r) => [r.date, r.type, r.amount, r.price, r.total, r.curNet, r.balance, r.party, r.status, r.fee, r.reference, r.note, r.id]);
  XLSXMini.download(exportFileName('xlsx'), 'العمليات', columns, rows);
  toast(`تم تصدير ${fmt0(state.ledger.length)} عملية إلى Excel ✓`);
}

/* ============================ الاستيراد (CSV) ============================ */

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

/* أسماء الأعمدة المقبولة: ملف هذا النظام، وملف تصدير Binance الرسمي (بالإنجليزية) */
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
  const numCell = (row, f) => parseFloat(String(get(row, f)).replace(/,/g, '')) || 0;
  const orders = [];
  let bad = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const typeRaw = get(row, 'tradeType');
    const statusRaw = get(row, 'orderStatus');
    const dateRaw = get(row, 'createTime');
    const ct = dateRaw ? parseImportDate(dateRaw) : Date.now();
    if (!Number.isFinite(ct)) { bad++; continue; }
    if (/إيداع|سحب|deposit|withdraw/i.test(typeRaw)) { bad++; continue; }   // الحوالات لا تُستورد كطلبات
    const o = {
      orderNumber: get(row, 'orderNumber'),
      tradeType: /buy|شراء/i.test(typeRaw) ? 'BUY' : 'SELL',
      asset: get(row, 'asset') || 'USDT',
      fiatSymbol: get(row, 'fiatSymbol'),
      fiat: get(row, 'fiatSymbol'),
      amount: numCell(row, 'amount'),
      unitPrice: numCell(row, 'unitPrice'),
      totalPrice: numCell(row, 'totalPrice'),
      commission: numCell(row, 'commission'),
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
function openImport() {
  resetDropzone($('#csvDrop'));
  $('#importPreview').classList.add('hidden');
  $('#btnConfirmImport').classList.add('hidden');
  state.importRows = null;
  openModal('#mImport');
}
/** يقرأ الملف المختار ويعرض ملخّصه (أخضر إن وُجدت طلبات، وأصفر بالسبب إن لم تُوجد) */
function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const preview = $('#importPreview');
    const text = document.createElement('div');
    let ok = false;
    try {
      const { orders, bad } = parseImportFile(String(reader.result));
      state.importRows = orders;
      ok = orders.length > 0;
      const l1 = document.createElement('b');
      l1.textContent = `تم التعرف على ${fmt0(orders.length)} طلبًا` + (bad ? ` — وتُجوهل ${fmt0(bad)} صفًّا (غير صالح أو حوالة)` : '');
      text.append(l1);
      if (orders.length) {
        const sells = orders.filter((o) => o.tradeType === 'SELL').length;
        const l2 = document.createElement('span');
        l2.textContent = `منها ${fmt0(sells)} بيع و ${fmt0(orders.length - sells)} شراء — تُدمج مع السجل الحالي بلا تكرار`;
        text.append(l2);
      }
    } catch (e) {
      state.importRows = null;
      text.textContent = e.message;
    }
    preview.textContent = '';
    preview.append(text);
    preview.classList.remove('hidden');
    preview.classList.toggle('is-ok', ok);
    preview.classList.toggle('is-bad', !ok);
    $('#btnConfirmImport').classList.toggle('hidden', !ok);
  };
  reader.readAsText(file, 'utf-8');
}
async function confirmImport() {
  if (!state.importRows || !state.importRows.length) return;
  try {
    const j = await postJSON('/api/orders/bulk', { orders: state.importRows });
    closeModal('#mImport');
    toast(`تم الاستيراد: ${fmt0(j.added)} جديد و ${fmt0(j.updated)} محدّث ✓`);
    await loadOrders();
    allowHeal();
    renderAll();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ الإعدادات وكلمات السر وسجل الدخول ============================ */

async function openSettings() {
  try { await loadSettings(); } catch {}
  const ttl = $('#mSettings .modal-head h3');
  if (ttl) ttl.textContent = 'الإعدادات — ' + state.account.name;
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
    toast('تم حفظ الإعدادات ✓');
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
    toast('تم تحديث كلمات السر ✓');
  } catch (e) { toast(e.message, 'err'); }
}

function openChangePass() {
  $('#passForm').reset();
  hidePasswords($('#passForm'));
  openModal('#mChangePass');
}

/* سجل الدخول: الدور، وما حدث (دخول، أو ما يُثقل على المنصة: مزامنة وفحص وجلب يوم)، والوقت، والعنوان */
const LOG_KINDS = { sync: ['refresh', 'مزامنة'], scan: ['search', 'فحص'], day: ['calendar', 'جلب يوم'] };
async function openLoginLog() {
  const tbody = $('#loginLogBody');
  const empty = $('#loginLogEmpty');
  tbody.textContent = '';
  empty.classList.add('hidden');
  openModal('#mLoginLog');
  try {
    const j = await api('/api/auth/log');
    const events = j.events || [];
    empty.classList.toggle('hidden', events.length > 0);
    for (const ev of events) {
      const tr = document.createElement('tr');
      const role = document.createElement('span');
      role.className = 'role-pill r-' + (ev.role || 'user');
      role.append(svgIcon(ROLE_SVG[ev.role] || 'user'), ROLE_NAMES[ev.role] || ev.role || '—');
      const [icon, label] = LOG_KINDS[ev.kind] || ['login', 'دخول'];
      const what = document.createElement('span');
      what.className = 'ev-chip ev-' + (LOG_KINDS[ev.kind] ? ev.kind : 'login');
      what.append(svgIcon(icon, icon === 'login' ? 'flip' : ''),
        label + (Array.isArray(ev.kinds) ? ' (' + ev.kinds.map(kindLabel).join('، ') + ')' : ''));   // مزامنةٌ لبعض الأنواع
      for (const el of [role, what]) { const td = document.createElement('td'); td.append(el); tr.append(td); }
      tdText(tr, ev.time ? fmtDTsec(ev.time) : '—', 'num');
      tdText(tr, ev.ip || '—', 'mono');
      tbody.append(tr);
    }
  } catch (e) {
    empty.classList.remove('hidden');
    toast(e.message, 'err');
  }
}
