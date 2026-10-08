/* شكل عرض العمليات: أربعة أشكالٍ لنفس القائمة (state.ledger بفلاترها وفرزها وصفحاتها):
 *   table  الجدول الكامل بكل خاناته القابلة للتحرير (الافتراضي)
 *   daily  الجدول نفسه مجمَّعًا بالأيام المحاسبية، فوق كل يومٍ ملخّصه (مرتّبٌ بالتاريخ دائمًا)
 *   cards  بطاقات على نمط بطاقات الطلبات في تطبيق Binance — الأنسب للهاتف
 *   tiles  مربّعات صغيرة متراصّة — لمسح يومٍ مزدحم بنظرة
 * البطاقات والمربعات تُجمَّع بالأيام أيضًا حين يكون الترتيب بالتاريخ. الاختيار يُحفظ في
 * المتصفح؛ والتصدير وبطاقات الأرقام والرسوم لا تتأثر به. */
'use strict';

const VIEWS = ['table', 'daily', 'cards', 'tiles'];
const VIEW_KEY = 'p2pView';
try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS.includes(v)) state.view = v; } catch {}

function setView(v) {
  if (!VIEWS.includes(v) || v === state.view) return;
  state.view = v;
  state.page = 1;
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
  renderLedger();
}

/** يرسم صفحة العمليات الحالية بالشكل المختار، مع العدد وأزرار الصفحات ومؤشّرات الفرز */
function renderLedger() {
  const view = state.view;
  if (view === 'daily' && state.sort.key !== '_t') state.sort = { key: '_t', dir: -1 };   // التجميع يلزمه ترتيب التاريخ
  sortLedger();
  const total = state.ledger.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const startIdx = (state.page - 1) * PAGE_SIZE;
  const slice = state.ledger.slice(startIdx, startIdx + PAGE_SIZE);
  const hasData = state.orders.length > 0 || state.transfers.length > 0;
  const tabular = view === 'table' || view === 'daily';
  const days = view !== 'table' && state.sort.key === '_t' ? dayGroups(state.ledger) : null;

  $('#emptyState').classList.toggle('hidden', hasData);
  $('#ledgerTable').style.display = hasData && tabular ? '' : 'none';
  const grid = $('#ledgerGrid');
  grid.classList.toggle('hidden', !hasData || tabular);
  grid.classList.toggle('is-tiles', view === 'tiles');
  $('#pager').style.display = total > PAGE_SIZE ? '' : 'none';
  $('#tableCount').textContent = total ? `${fmt0(total)} عملية` : (hasData ? 'لا نتائج مطابقة للفلاتر' : '');

  const mixed = distinctFiats(state.filtered).length > 1;
  if (tabular) { grid.textContent = ''; renderItems($('#tbody'), slice, startIdx, days, mixed); }
  else { $('#tbody').textContent = ''; renderItems(grid, slice, startIdx, days, mixed); }

  $('#pgInfo').textContent = `صفحة ${fmt0(state.page)} من ${fmt0(pages)}`;
  $('#pgPrev').disabled = state.page <= 1;
  $('#pgNext').disabled = state.page >= pages;
  syncViewControls();
}

/** عناصر الصفحة: صفوف الجدول أو البطاقات/المربعات، وفوق كل يومٍ ملخّصه إن كان التجميع */
function renderItems(box, slice, startIdx, days, mixed) {
  box.textContent = '';
  const tabular = box.id === 'tbody';
  const cols = $$('#ledgerTable thead th').length;
  let lastDay = null;
  slice.forEach((row, i) => {
    if (days) {
      const d = bizDayStart(row._t);
      if (d !== lastDay) {
        lastDay = d;
        // يومٌ بدأ في الصفحة السابقة يُكمَل هنا
        const cont = i === 0 && startIdx > 0 && bizDayStart(state.ledger[startIdx - 1]._t) === d;
        const head = dayHead(d, days.get(d), cont);
        if (tabular) {
          const tr = mk('tr', 'day-row');
          const td = mk('td');
          td.colSpan = cols;
          td.append(head);
          tr.append(td);
          box.append(tr);
        } else box.append(head);
      }
    }
    const n = startIdx + i + 1;
    if (tabular) box.append(ledgerTr(row, n, mixed));
    else box.append(state.view === 'tiles' ? opTile(row, !!days) : opCard(row, n));
  });
  if (!tabular && !slice.length) box.append(mk('div', 'op-empty', 'لا نتائج مطابقة للفلاتر'));
}

/* ============================ التجميع بالأيام ============================ */

/** ملخّص كل يوم محاسبي (يبدأ الثانية ليلًا) من القائمة كاملة لا من الصفحة وحدها */
function dayGroups(ledger) {
  const map = new Map();
  for (const row of ledger) {
    const d = bizDayStart(row._t);
    let g = map.get(d);
    if (!g) map.set(d, (g = { n: 0, sell: 0, sellAmt: 0, buy: 0, fiat: {}, dep: 0, wd: 0, lastT: -Infinity, lastBal: null }));
    g.n++;
    const it = row.raw;
    const isP2P = row._kind === 'p2p';
    if (isP2P && it.orderStatus === 'COMPLETED') {
      if (it.tradeType === 'SELL') {
        g.sell += grossUSDT(it);
        g.sellAmt += it.amount || 0;
        const sym = fiatSymOf(it);
        g.fiat[sym] = (g.fiat[sym] || 0) + effTotalPrice(it);
      } else g.buy += grossUSDT(it);
    } else if (!isP2P && it.status === 'COMPLETED') {
      if (isPaySale(it)) {   // Pay إرسالٌ بمبلغ محلي يُحسب بيعًا، كما في بطاقات الأرقام
        g.sell += it.amount || 0;
        g.sellAmt += it.amount || 0;
        const sym = symForCode(payFiatCode(it));
        g.fiat[sym] = (g.fiat[sym] || 0) + effTotalPrice(it);
      } else if (String(it.coin || '').toUpperCase() === 'USDT') {
        if (it.kind === 'deposit') g.dep += it.amount || 0;
        else if (it.kind === 'withdraw') g.wd += it.amount || 0;
      }
    }
    const b = balOf(it, isP2P);
    if (b != null && row._t > g.lastT) { g.lastT = row._t; g.lastBal = b; }
  }
  return map;
}

function dayTitle(d) {
  const today = bizDayStart(Date.now());
  const rel = d === today ? 'اليوم · ' : (d === bizDayStart(today - 1) ? 'أمس · ' : '');
  return rel + new Date(d).toLocaleDateString('ar', { weekday: 'long' }) + ' ' + fmtDT(d).slice(0, 10);
}

/** رأس اليوم: تاريخه وعدد عملياته ومبيعاته ومقبوضاته ومتوسط سعره وباقيه آخر اليوم */
function dayHead(d, g, cont) {
  const box = mk('div', 'day-head');
  box.append(mk('b', 'dh-date', dayTitle(d) + (cont ? ' (تابع)' : '')));
  const add = (text, cls) => box.append(mk('span', cls, text));
  add(`${fmt0(g.n)} عملية`);
  if (g.sell) add(`بيع ${fmt2(g.sell)} USDT`);
  const syms = Object.keys(g.fiat);
  for (const s of syms) add(`مقبوضات ${fmt0(g.fiat[s])} ${s}`);
  if (syms.length === 1 && g.sellAmt > 0) add(`متوسط السعر ${fmt2p(g.fiat[syms[0]] / g.sellAmt)}`);
  if (g.buy) add(`شراء ${fmt2(g.buy)} USDT`);
  if (g.dep) add(`إيداع ${fmt2(g.dep)} USDT`);
  if (g.wd) add(`سحب ${fmt2(g.wd)} USDT`);
  if (g.lastBal != null) add(`الباقي آخر اليوم ${fmt2(g.lastBal)}`, 'dh-bal');
  return box;
}

/* ============================ البطاقات والمربعات ============================ */

/** تفتح التفاصيل بالنقر أو بـEnter/المسافة (البطاقة قابلةٌ للتركيز بلوحة المفاتيح) */
function makeOpenable(node, it, isP2P) {
  node.tabIndex = 0;
  node.setAttribute('aria-label', `${typeInfoOf(it, isP2P).ar} ${fmt2(usdtOf(it, isP2P))} ${unitOf(it, isP2P)} — ${fmtDT(isP2P ? it.createTime : it.time)} — اضغط للتفاصيل`);
  node.addEventListener('click', () => openOp(it, isP2P));
  node.addEventListener('keydown', (e) => {
    if (e.target === node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openOp(it, isP2P); }
  });
}

/** ما يُعرض للحوالة تحت قيمتها: الأصل المقوَّم، التحويل، الصفقة، الشبكة، الرسوم، المبلغ والسعر اليدويّان */
function transferRows(t) {
  const out = [];
  if (t.usdtValue != null) out.push(['الأصل', `${fmt2(t.amount)} ${t.coin || ''}`]);
  if (isConvertKind(t.kind) && t.fromAsset && t.toAsset) out.push(['التحويل', `${fmt2(t.fromAmount)} ${t.fromAsset} إلى ${fmt2(t.toAmount)} ${t.toAsset}`]);
  else if (isSpotKind(t.kind)) out.push(['الصفقة', `${fmt2(t.baseQty)} ${t.network || ''} بسعر ${fmt2p(t.unitPrice)}`]);
  else if (t.network) out.push(['الشبكة', t.networkLabelOverride || t.network]);
  if (t.kind === 'withdraw' && t.fee) out.push(['الرسوم', `${fmt2(t.fee)} ${t.coin || ''}`]);
  const fc = payFiatCode(t);
  if (t.totalPriceOverride != null) out.push(['المبلغ', `${fmt0(t.totalPriceOverride)}${fc ? ' ' + symForCode(fc) : ''}`]);
  if (t.unitPriceOverride != null) out.push(['السعر', fmt2p(t.unitPriceOverride)]);
  return out;
}

/** بطاقة عملية: النوع والحالة، القيمة بالـUSDT، المبلغ والسعر (قابلان للتعديل)، الطرف الآخر،
 *  الباقي، الإشاري والملاحظة، ثم الوقت والرقم والمعرّف */
function opCard(row, n) {
  const isP2P = row._kind === 'p2p';
  const it = row.raw;
  const kind = isP2P ? 'order' : 'transfer';
  const ki = typeInfoOf(it, isP2P);
  const si = statusOf(it, isP2P);
  const card = mk('article', 'op-card' + (isVoid(it, isP2P) ? ' is-muted' : ''));
  card.style.setProperty('--k', ki.color);

  const head = mk('div', 'op-head');
  head.append(chip(isP2P ? `${ki.ar} ${it.asset || 'USDT'}` : ki.ar, ki.color), chip(si.ar, si.color));
  const amount = mk('div', 'op-amount');
  amount.append(mk('span', 'op-num', fmt2(usdtOf(it, isP2P))), mk('span', 'unit', unitOf(it, isP2P)));

  const rows = mk('div', 'op-rows');
  const addRow = (label, value, cls) => {
    const r = mk('div', 'op-row');
    const v = mk('span', 'v' + (cls ? ' ' + cls : ''));
    if (value instanceof Node) v.append(value); else v.textContent = value;
    r.append(mk('span', 'k', label), v);
    rows.append(r);
    return v;
  };
  if (isP2P) {
    const sym = fiatSymOf(it);
    if (canAnnotate()) {
      addRow('المبلغ', makePriceInput(it, 'totalPrice', kind)).append(mk('span', 'unit', sym));
      addRow('السعر', makePriceInput(it, 'unitPrice', kind));
    } else {
      addRow('المبلغ', `${fmt0(effTotalPrice(it))} ${sym}`, it.totalPriceOverride != null ? 'is-edited' : '');
      addRow('السعر', fmt2p(effUnitPrice(it)), it.unitPriceOverride != null ? 'is-edited' : '');
    }
    if (effComm(it) > 0) addRow('العمولة', `${fmt2(effComm(it))} USDT`);
  } else {
    for (const [label, value] of transferRows(it)) addRow(label, value);
  }
  if (it.counterPart) addRow('الطرف الآخر', it.counterPart);
  const bal = balOf(it, isP2P);
  const pinned = it.balanceAt != null || it.zeroPoint;
  const vb = addRow('الباقي من USDT', bal == null ? '—' : fmt2(bal), 'is-bal' + (pinned ? ' is-zeropoint' : ''));
  if (pinned) vb.title = 'نقطة التثبيت — العمود كلّه محسوب منها';

  const notes = mk('div', 'op-notes');
  notes.append(annotInput(it, 'reference', kind), annotInput(it, 'note', kind));
  const fullId = opId(it, isP2P);
  const foot = mk('div', 'op-foot');
  const idEl = mk('span', 'mono', tinyId(fullId));
  idEl.title = fullId;
  foot.append(mk('span', 'op-time', fmtDTsec(row._t)), mk('span', 'op-n', '#' + fmt0(n)), idEl);

  card.append(head, amount, rows, notes, foot);
  makeOpenable(card, it, isP2P);
  return card;
}

/** سطرٌ واحد تحت قيمة المربّع: المبلغ المحلي، أو اتجاه التحويل، أو الشبكة */
function tileSub(it, isP2P) {
  if (isP2P) return `${fmt0(effTotalPrice(it))} ${fiatSymOf(it)}`;
  if (it.totalPriceOverride != null) return `${fmt0(it.totalPriceOverride)} ${payFiatCode(it) ? symForCode(payFiatCode(it)) : ''}`.trim();
  if (isConvertKind(it.kind) && it.toAsset) return `${it.fromAsset} إلى ${it.toAsset}`;
  return it.network || it.coin || '—';
}

/** مربّع عملية: النوع والوقت، القيمة، سطرٌ تحتها، الطرف الآخر، الحالة والإشاري */
function opTile(row, grouped) {
  const isP2P = row._kind === 'p2p';
  const it = row.raw;
  const ki = typeInfoOf(it, isP2P);
  const si = statusOf(it, isP2P);
  const tile = mk('article', 'op-tile' + (isVoid(it, isP2P) ? ' is-muted' : ''));
  tile.style.setProperty('--k', ki.color);
  const top = mk('div', 'tile-top');
  // المربّع ضيّق: «تحويل (USDT→)» يكفيه «تحويل» والاتجاه في السطر تحت القيمة. ومجمَّعًا
  // بالأيام يكفي الوقت؛ وإلا فالشهر واليوم معه
  top.append(chip(ki.ar.replace(/\s*\(.*\)$/, ''), ki.color), mk('span', 'tile-time', fmtDT(row._t).slice(grouped ? 11 : 5)));
  const party = mk('div', 'tile-party', it.counterPart || '—');
  if (it.counterPart) party.title = it.counterPart;
  const foot = mk('div', 'tile-foot');
  foot.append(chip(si.ar, si.color));
  if (it.reference) {
    const r = mk('span', 'tile-ref', it.reference);
    r.title = 'الإشاري: ' + it.reference;
    foot.append(r);
  }
  tile.append(top, mk('div', 'tile-num', fmt2(usdtOf(it, isP2P))), mk('div', 'tile-unit', unitOf(it, isP2P)),
    mk('div', 'tile-sub', tileSub(it, isP2P)), party, foot);
  makeOpenable(tile, it, isP2P);
  return tile;
}

/* ============================ أزرار الشكل والترتيب ============================ */

function syncViewControls() {
  $$('#viewSeg button').forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  // البطاقات والمربعات بلا رؤوس أعمدة، فلها قائمة ترتيب؛ و«يومي» مرتّبٌ بالتاريخ دائمًا
  const grid = state.view === 'cards' || state.view === 'tiles';
  $('#sortWrap').classList.toggle('hidden', !grid);
  if (grid) {
    const sel = $('#sortSel');
    const v = `${state.sort.key}:${state.sort.dir}`;
    sel.value = [...sel.options].some((o) => o.value === v) ? v : '';
  }
  $$('#ledgerTable th').forEach((th) => {
    const on = th.dataset.sort === state.sort.key;
    th.classList.toggle('sorted-asc', on && state.sort.dir === 1);
    th.classList.toggle('sorted-desc', on && state.sort.dir === -1);
    if (th.classList.contains('sortable')) th.setAttribute('aria-sort', on ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  });
}

function wireViewControls() {
  $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  // مجموعة أزرارٍ واحدة: الأسهم تنقل بينها (في العربية اليسارُ هو التالي)
  $('#viewSeg').addEventListener('keydown', (e) => {
    const step = { ArrowLeft: 1, ArrowRight: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const v = VIEWS[(VIEWS.indexOf(state.view) + step + VIEWS.length) % VIEWS.length];
    setView(v);
    $(`#viewSeg button[data-view="${v}"]`).focus();
  });
  $('#sortSel').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [key, dir] = e.target.value.split(':');
    state.sort = { key, dir: Number(dir) };
    state.page = 1;
    renderLedger();
  });
}
