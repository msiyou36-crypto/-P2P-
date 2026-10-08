/* نافذة «فحص المزامنة» (للمسؤول): أدواتٌ تسأل المنصة مباشرةً وتقارن بالمحفوظ — فحص ما
   تُرجعه من طلبات P2P، وجلب يومٍ واحد، وصاحب المفتاح، والعمليات الدخيلة (حذفها واسترجاعها)،
   والاستعادة من ملف تصدير. كلٌّ يكتب نتيجته في صندوقٍ واحد أسفل الأدوات */
'use strict';

const diagLine = (cls, text) => mk('div', cls, text);

function openDiag() { $('#diagResult').textContent = ''; resetDropzone($('#restoreDrop')); openModal('#mDiag'); }

/** صندوق النتيجة أسفل الأدوات: يُفرَّغ ويُمرَّر إليه، فيرى المسؤول ما يحدث مهما كانت الأداة */
function diagBox() {
  const box = $('#diagResult');
  box.textContent = '';
  requestAnimationFrame(() => box.scrollIntoView({ block: 'start' }));
  return box;
}

/** طلبٌ واحد من أداة: الزرّ معطّلٌ وسطرُ انتظار حتى يصل الردّ، ثم يُفرَّغ الصندوق للنتيجة.
    عند الخطأ يُعرض سببه (وإن كان حظرًا قُفلت المزامنة) ويُرجَع null */
async function diagCall(btn, box, waitMsg, call) {
  btn.disabled = true;
  box.append(diagLine('hint', waitMsg));
  try {
    const d = await call();
    box.textContent = '';
    return d;
  } catch (e) {
    box.textContent = '';
    box.append(diagLine('diag-bad', e.message));
    noteBanError(e.message);
    return null;
  } finally {
    btn.disabled = false;
  }
}

/** شريط تقدّم داخل نافذة الفحص؛ يُرجع { msg, fill, row, remove } */
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

/* ما تُرجعه المنصة فعلًا في آخر N يومًا مقابل المحفوظ */
async function runDiag() {
  const days = Math.min(Math.max(Number($('#diagDays').value) || 3, 1), 29);
  const box = diagBox();
  const d = await diagCall($('#btnRunDiag'), box, 'جارٍ سؤال المنصة… قد يستغرق بضع ثوانٍ.', () => api('/api/diag/p2p?days=' + days));
  if (!d) return;
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
      for (const v of [fmtDT(r.time), r.tradeType === 'BUY' ? 'شراء' : 'بيع', fmt2(r.amount), r.status, r.tail, r.stored ? 'نعم' : 'لا']) {
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
  if (!day) { box.append(diagLine('diag-bad', 'اختر اليوم أولًا')); return; }
  const d = await diagCall($('#btnFetchDay'), box, `جارٍ سؤال المنصة عن ${day}…`, () => postJSON('/api/sync/day', { day }));
  if (!d) return;
  box.append(diagLine(
    d.total === 0 ? 'diag-bad' : (d.totalAdded > 0 ? 'diag-ok' : 'hint'),
    d.total === 0
      ? `المنصة لم تُرجع أي عملية في ${d.day} — فما ينقصك لا تُرجعه المنصة أصلًا لهذا المفتاح، وسبيلُه «إضافة يدوية» من القائمة.`
      : (d.totalAdded > 0
        ? `وصلت ${fmt0(d.total)} عملية في ${d.day}، منها ${fmt0(d.totalAdded)} جديدة أُضيفت للسجل ✓`
        : `وصلت ${fmt0(d.total)} عملية في ${d.day} وكلها محفوظة عندك — فما لا تجده في الجدول لا تُرجعه المنصة.`)));
  // لكل نوعٍ ما وصل منه (الأسماء كما في نافذة المزامنة)
  for (const k of Object.keys(d.found || {})) {
    if (!d.found[k]) continue;
    box.append(diagLine('hint', `${kindLabel(k)}: وصل ${fmt0(d.found[k])}${d.added[k] ? ` · جديد ${fmt0(d.added[k])}` : ''}`));
  }
  for (const s of (d.skipped || [])) box.append(diagLine('diag-bad', 'تعذّر جلب ' + s));
  // نضبط فلتر الجدول على ذلك اليوم فيرى المستخدم النتيجة أمامه فورًا
  setCustomRange(d.day, d.day);
  if (d.totalAdded > 0) { allowHeal(); await reloadLedger(); } else renderAll();
  const shown = state.ledger.length;
  box.append(diagLine(shown ? 'diag-ok' : 'diag-bad', shown
    ? `محفوظ عندك في ${d.day}: ${fmt0(d.stored)} عملية — وضبطتُ الجدول على هذا اليوم، وهي ظاهرة فيه الآن (${fmt0(shown)}).`
    : `محفوظ عندك في ${d.day}: ${fmt0(d.stored)} عملية، ولا يعرض الجدول شيئًا — تحقّق من فلتر «النوع» و«الحالة» أعلى الجدول.`));
  if (d.totalAdded > 0) toast(`أُضيفت ${fmt0(d.totalAdded)} عملية من ${d.day}`);
}

/* أيُّ حساب Binance يقرأه مفتاح هذا السستم؟ */
async function whoAmI() {
  const box = diagBox();
  const d = await diagCall($('#btnWhoAmI'), box, 'جارٍ سؤال المنصة عن صاحب المفتاح…', () => api('/api/diag/whoami'));
  if (!d) return;
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
      det.append(diagLine('hint', `${c.type === 'SELL' ? 'بيع' : 'شراء'} ${fmtD(c.from)} ← ${fmtD(c.to)} · صفحة ${c.page}: ${fmt0(c.rows)} صف (سقف ${fmt0(c.cap)})`
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
  const src = (x) => SOURCE_AR[x.source] || x.source || '';
  for (const o of rep.orders) {
    const sure = o.time > lastO;
    list.add('order', o, `${orderLabel(o, o.time)} (${src(o)})${sure ? '' : ' — ؟ قبل آخر طلبٍ أرجعته المنصة'}`, sure);
  }
  for (const t of rep.transfers) list.add('transfer', t, `${transferLabel(t)} (${src(t)})`, true);
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
        toast(`حُذفت ${fmt0(j.deleted)} عملية من ${j.accountName}`);
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
      toast(j.restored ? `أُعيدت ${fmt0(j.restored)} عملية إلى ${j.accountName}` : 'سلّة المحذوف فارغة — لا شيء يُعاد', j.restored ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* الاستعادة من ملف تصدير (Excel/CSV من النظام). أوقات الملف بتوقيت هذا الجهاز (tz) */
async function restoreFromFile() {
  const inp = $('#restoreFile');
  const box = diagBox();
  const btn = $('#btnRestoreFile');
  const file = inp.files && inp.files[0];
  if (!file) { box.append(diagLine('diag-bad', 'اختر ملف التصدير أولًا (Excel أو CSV)')); return; }
  btn.disabled = true;
  box.append(diagLine('hint', `جارٍ قراءة «${file.name}» ومقارنته بالمحفوظ…`));
  let d;
  try { d = await api('/api/restore/preview?tz=' + new Date().getTimezoneOffset(), { method: 'POST', body: file }); }
  catch (e) { box.textContent = ''; box.append(diagLine('diag-bad', e.message)); return; }
  finally { btn.disabled = false; }
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
      toast(`أُعيدت ${fmt0(j.restored)} عملية إلى ${j.accountName}`);
    } catch (e) { toast(e.message, 'err'); }
  }));
  box.append(act);
}
