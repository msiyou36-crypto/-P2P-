/* اليوم المحاسبي، الفلاتر، وبناء القائمة الموحّدة للجدول */
'use strict';

/* اليوم المحاسبي يُقفل الساعة الثانية ليلًا لا منتصف الليل (العمل يمتدّ بعد منتصف الليل
   ويُحسب على يومه) — كما في الخادم، وإلا اختفت عمليةُ الواحدة ليلًا من «اليوم» */
const DAY_CLOSE_H = 2;
/** بداية اليوم المحاسبي الذي تقع فيه اللحظة ms (بالتوقيت المحلي للمتصفّح) */
function bizDayStart(ms) {
  const d = new Date(ms);
  d.setHours(DAY_CLOSE_H, 0, 0, 0);
  if (d.getTime() > ms) d.setDate(d.getDate() - 1);
  return d.getTime();
}
/** بداية اليوم المحاسبي المسمّى «YYYY-MM-DD» */
const bizDayFrom = (s) => new Date(s + 'T00:00:00').setHours(DAY_CLOSE_H, 0, 0, 0);

/** «YYYY-MM-DD» لليوم المحاسبي الذي يبدأ عند ms (لحقلَي «من/إلى») */
const bizDayLabel = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

/** يعلّم زرّ الفترة المختار، ويُظهر حقلَي «من/إلى» مع «مخصّص» وحده */
function showRange(range) {
  $$('#rangeSeg button').forEach((b) => {
    const on = b.dataset.range === range;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#dateRange').classList.toggle('hidden', range !== 'custom');
}
/** فترةٌ مخصّصة من/إلى (الفارغ بلا حدّ) */
function setCustomRange(from, to) {
  $('#xFrom').value = from || '';
  $('#xTo').value = to || '';
  Object.assign(state.filters, { range: 'custom', from: from || null, to: to || null });
  state.page = 1;
  showRange('custom');
}

function rangeBounds() {
  const f = state.filters;
  const startOfToday = bizDayStart(Date.now());
  if (f.range === 'all') return [0, Infinity];
  if (f.range === '1') return [startOfToday, Infinity];
  if (f.range === 'custom') {
    const from = f.from ? bizDayFrom(f.from) : 0;
    const to = f.to ? bizDayFrom(f.to) + 86400000 - 1 : Infinity;
    return [from, to];
  }
  const days = Number(f.range);
  return [startOfToday - (days - 1) * 86400000, Infinity];
}

function statusMatchOrder(s, filter) {
  if (filter === 'all') return true;
  if (filter === 'COMPLETED') return s === 'COMPLETED';
  if (filter === 'CANCELLED') return isCancelled(s);
  if (filter === 'other') return s !== 'COMPLETED' && !isCancelled(s);
  return false;   // PENDING/FAILED خاصة بالحوالات
}
function statusMatchTx(s, filter) {
  if (filter === 'all') return true;
  if (filter === 'COMPLETED') return s === 'COMPLETED';
  if (filter === 'CANCELLED') return s === 'CANCELLED';
  if (filter === 'PENDING') return s === 'PENDING';
  if (filter === 'FAILED') return s === 'FAILED';
  return false;   // other خاص بالطلبات
}
function orderMatchesSearch(o, q) {
  return o.orderNumber.toLowerCase().includes(q)
    || (o.counterPart || '').toLowerCase().includes(q)
    || String(o.reference || '').toLowerCase().includes(q)
    || String(o.note || '').toLowerCase().includes(q)
    || String(o.amount).includes(q)
    || String(o.totalPrice).includes(q)
    || fmt0(o.totalPrice).replace(/,/g, '').includes(q.replace(/,/g, ''));
}
function txMatchesSearch(t, q) {
  return [t.txId, t.counterPart, t.address, t.coin, t.network, t.id, t.reference, t.note, t.amount]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

function applyFilters() {
  const f = state.filters;
  const [from, to] = rangeBounds();
  const q = f.q.trim().toLowerCase();
  const typeIsP2P = f.type === 'SELL' || f.type === 'BUY';
  const typeIsTx = ['deposit', 'withdraw', 'pay', 'convert', 'spot'].includes(f.type);
  const statusIsTx = f.status === 'PENDING' || f.status === 'FAILED';
  const statusIsOther = f.status === 'other';
  // الأرشفة فلترُ عرضٍ لا محو: المؤرشَف يخرج من الجدول ومن حساب «الباقي» معًا
  const arc = state.showArchive;

  state.filtered = state.orders.filter((o) => {
    if (!!o.archived !== arc) return false;
    if (o.createTime < from || o.createTime > to) return false;
    if (typeIsTx || statusIsTx) return false;
    if (typeIsP2P && o.tradeType !== f.type) return false;
    if (f.fiat !== 'all' && fiatCode(o) !== f.fiat) return false;
    if (!statusMatchOrder(o.orderStatus, f.status)) return false;
    if (q && !orderMatchesSearch(o, q)) return false;
    return true;
  });

  state.filteredTx = state.transfers.filter((t) => {
    if (!!t.archived !== arc) return false;
    if (t.time < from || t.time > to) return false;
    if (typeIsP2P || statusIsOther) return false;
    if (f.fiat !== 'all') return false;   // الحوالات بالـUSDT — لا تندرج تحت عملة محلية
    if (typeIsTx) {
      if (f.type === 'pay') { if (!isPayKind(t.kind)) return false; }
      else if (f.type === 'convert') { if (!isConvertKind(t.kind)) return false; }
      else if (f.type === 'spot') { if (!isSpotKind(t.kind)) return false; }
      else if (t.kind !== f.type) return false;
    }
    if (!statusMatchTx(t.status, f.status)) return false;
    if (q && !txMatchesSearch(t, q)) return false;
    return true;
  });

  buildLedger();
}

/** صفٌّ موحّد للجدول: حقول «_» للفرز، وraw السجل الأصلي */
function ledgerRow(item, kind) {
  if (kind === 'transfer') {
    return { _kind: 'transfer', raw: item, _t: item.time, _type: item.kind, _amount: item.amount, _price: null, _total: null, _status: item.status };
  }
  return { _kind: 'p2p', raw: item, _t: item.createTime, _type: item.tradeType, _amount: item.amount, _price: effUnitPrice(item), _total: effTotalPrice(item), _status: item.orderStatus };
}
function buildLedger() {
  const rows = [];
  for (const o of state.filtered) rows.push(ledgerRow(o, 'p2p'));
  for (const t of state.filteredTx) rows.push(ledgerRow(t, 'transfer'));
  state.ledger = rows;
}

/** فلتر العملة: يظهر فقط حين تتعدّد العملات في السجل */
function populateFiatFilter() {
  const sel = $('#fFiat');
  if (!sel) return;
  const codes = distinctFiats(state.orders).sort();
  const cur = state.filters.fiat;
  sel.textContent = '';
  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'كل العملات';
  sel.append(optAll);
  for (const c of codes) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = fiatName(c);
    sel.append(opt);
  }
  sel.style.display = codes.length > 1 ? '' : 'none';
  sel.value = (codes.includes(cur) || cur === 'all') ? cur : 'all';
  if (sel.value !== cur) state.filters.fiat = sel.value;
}
