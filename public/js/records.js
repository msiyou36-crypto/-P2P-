/* السجل يدخل ويخرج بيد المستخدم: الإضافة اليدوية لطلبٍ لم يصل من المنصة، والاستيراد من
   ملف CSV، والتصدير (CSV وExcel) للعمليات المعروضة بفلاترها */
'use strict';

/* ============================ الإضافة اليدوية ============================ */

let totalPriceDirty = false;   // كتب المستخدم المبلغ بيده فلا يُحسب تلقائيًا بعدها
const toLocalDatetimeValue = (d) => fmtDT(d).replace(' ', 'T');
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
/** حقل المبلغ كُتب يدويًا: يتوقف حسابه من الكمية والسعر */
function markTotalEdited() { totalPriceDirty = true; }
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
    toast('تم حفظ الطلب');
    await loadOrders();
    renderAll();
  } catch (e) { toast(e.message, 'err'); }
}

/* ============================ التصدير ============================ */

function csvCell(v) {
  let s = String(v == null ? '' : v);
  // نصٌّ يبدأ بـ = أو + أو - أو @ يفسّره Excel صيغةً: تسبقه فاصلةٌ عليا فيبقى نصًّا (والأرقام كما هي)
  if (/^[=+\-@]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** صفوف الجدول المعروض بأعمدة التصدير (نفس الأعمدة في CSV وExcel، ونفس قيم الجدول) */
function ledgerRows() {
  return state.ledger.map((row) => {
    const it = row.raw, isP2P = row._kind === 'p2p';
    const b = balOf(it, isP2P);
    return {
      date: fmtDTsec(row._t),
      type: typeInfoOf(it, isP2P).ar,
      amount: usdtOf(it, isP2P),
      balance: b == null ? '' : b,
      price: isP2P ? effUnitPrice(it) : (it.unitPriceOverride != null ? it.unitPriceOverride : ''),
      total: isP2P ? effTotalPrice(it) : (it.totalPriceOverride != null ? it.totalPriceOverride : ''),
      curNet: it.networkLabelOverride != null ? it.networkLabelOverride : (isP2P ? fiatSymOf(it) : (it.network || it.coin || '')),
      party: it.counterPart || '',
      status: statusOf(it, isP2P).ar,
      fee: isP2P ? effComm(it) : (it.fee || 0),
      reference: it.reference || '',
      note: it.note || '',
      id: opId(it, isP2P) || '',
    };
  });
}
const exportFileName = (ext) => `سجل-العمليات-${fmtD(Date.now())}.${ext}`;

function exportCSV() {
  if (!state.ledger.length) { toast('لا توجد عمليات ضمن الفلاتر الحالية للتصدير', 'err'); return; }
  const headers = ['التاريخ', 'النوع', 'الكمية USDT', 'السعر', 'المبلغ', 'العملة/الشبكة', 'الباقي من USDT', 'الطرف الآخر', 'الحالة', 'العمولة/الرسوم', 'الإشاري', 'الملاحظة', 'المعرّف'];
  const lines = [headers.join(',')];
  for (const r of ledgerRows()) {
    lines.push([csvCell(r.date), r.type, r.amount, r.price, r.total, csvCell(r.curNet), r.balance, csvCell(r.party), csvCell(r.status), r.fee, csvCell(r.reference), csvCell(r.note), csvCell(r.id)].join(','));
  }
  // علامة BOM في أوله فيقرأ Excel العربية بترميز UTF-8
  downloadBlob(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), exportFileName('csv'));
  toast(`تم تصدير ${fmt0(state.ledger.length)} عملية`);
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
  toast(`تم تصدير ${fmt0(state.ledger.length)} عملية إلى Excel`);
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
/** نوع طلب P2P (بيع/شراء) — وما سواه في عمود النوع حوالةٌ لا تُستورد كطلب */
const P2P_TYPE_RE = /^(sell|buy|بيع|شراء)$/i;
function mapHeaders(headerRow) {
  const normalized = headerRow.map((hh) => String(hh).replace(/\uFEFF/g, '').trim().toLowerCase());
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
    // الحوالات (إيداع، سحب، Pay، تحويل، فوري) لا تُستورد كطلبات؛ وبلا عمود نوعٍ أصلًا فالطلب بيع
    if (map.tradeType != null && !P2P_TYPE_RE.test(typeRaw)) { bad++; continue; }
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
    toast(`تم الاستيراد: ${fmt0(j.added)} جديد و ${fmt0(j.updated)} محدّث`);
    await loadOrders();
    allowHeal();
    renderAll();
  } catch (e) { toast(e.message, 'err'); }
}
