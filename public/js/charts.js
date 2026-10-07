/* بطاقات الأرقام والرسمان البيانيان (SVG يدوي): حجم التداول ومتوسط سعر البيع.
 * التخطيط شبكةٌ من أربعة أعمدة: الصفّ الأول أرقام P2P الرئيسية بخطٍّ أكبر، والثاني أرقام
 * المحفظة؛ والرسمان تحتها كلٌّ بعرض عمودين، فتصطفّ الحوافّ كلها. */
'use strict';

/* ============================ بطاقات الأرقام ============================ */

/** بطاقة رقم: أيقونة بلونها، العنوان، الرقم ووحدته، وسطرٌ تحته. size: 'lg' للصفّ الرئيسي */
function tileCard(t) {
  const card = document.createElement('div');
  card.className = 'card kpi' + (t.size === 'lg' ? ' kpi-lg' : '');
  card.style.setProperty('--c', t.color);
  const top = document.createElement('div');
  top.className = 'kpi-top';
  const icon = document.createElement('span');
  icon.className = 'kpi-icon';
  icon.append(svgIcon(t.icon));
  const label = document.createElement('span');
  label.className = 'kpi-label';
  label.textContent = t.label;
  top.append(icon, label);
  const v = document.createElement('div');
  v.className = 'kpi-value';
  const n = document.createElement('span');
  n.className = 'kpi-num';
  n.textContent = t.value;
  v.append(n);
  if (t.unit) {
    const u = document.createElement('span');
    u.className = 'kpi-unit';
    u.textContent = t.unit;
    v.append(u);
  }
  const s = document.createElement('div');
  s.className = 'kpi-sub';
  s.textContent = t.sub;
  s.title = t.sub;
  card.append(top, v, s);
  return card;
}

function renderTiles() {
  const wrap = $('#tiles');
  wrap.textContent = '';
  const completed = state.filtered.filter((o) => o.orderStatus === 'COMPLETED');
  const sells = completed.filter((o) => o.tradeType === 'SELL');
  const buys = completed.filter((o) => o.tradeType === 'BUY');
  const paySales = state.filteredTx.filter(isPaySale);   // Pay إرسال بمبلغ محلي تُعامَل كبيع
  const sellAmt = sells.reduce((s, o) => s + grossUSDT(o), 0) + paySales.reduce((s, t) => s + (t.amount || 0), 0);
  const buyAmt = buys.reduce((s, o) => s + grossUSDT(o), 0);
  const commission = completed.reduce((s, o) => s + effComm(o), 0);

  // المقبوضات ومتوسط السعر بعملةٍ واحدة أبدًا (لا تُجمع عملات مختلفة)
  const fiats = Array.from(new Set([...distinctFiats(completed), ...paySales.map(payFiatCode).filter(Boolean)]));
  const useFiat = state.filters.fiat !== 'all'
    ? state.filters.fiat
    : (dominantFiat(sells) || (paySales[0] && payFiatCode(paySales[0])) || dominantFiat(completed));
  const fiatSells = sells.filter((o) => fiatCode(o) === useFiat);
  const payFiatSales = paySales.filter((t) => payFiatCode(t) === useFiat);
  const sellFiat = fiatSells.reduce((s, o) => s + effTotalPrice(o), 0) + payFiatSales.reduce((s, t) => s + effTotalPrice(t), 0);
  const fiatSellAmt = fiatSells.reduce((s, o) => s + o.amount, 0) + payFiatSales.reduce((s, t) => s + (t.amount || 0), 0);
  const avgPrice = fiatSellAmt > 0 ? sellFiat / fiatSellAmt : 0;
  const sym = symForCode(useFiat) || 'العملة';
  const multi = state.filters.fiat === 'all' && fiats.length > 1;
  const sellCount = sells.length + payFiatSales.length;

  const dep = state.filteredTx.filter((t) => t.kind === 'deposit' && t.status === 'COMPLETED' && t.coin === 'USDT');
  const wd = state.filteredTx.filter((t) => t.kind === 'withdraw' && t.status === 'COMPLETED' && t.coin === 'USDT');
  const depSum = dep.reduce((s, t) => s + t.amount, 0);
  const wdSum = wd.reduce((s, t) => s + t.amount, 0);
  const nOps = state.filtered.length + state.filteredTx.length;

  // الصفّ الأول: P2P (الأهمّ للبائع، بخطٍّ أكبر)؛ الثاني: المحفظة والرسوم والعدد
  const tiles = [
    { size: 'lg', icon: 'up', color: 'var(--sell)', label: 'مبيعات', value: fmt2(sellAmt), unit: 'USDT', sub: `${fmt0(sells.length)} طلب P2P${paySales.length ? ' · ' + fmt0(paySales.length) + ' Pay' : ''}` },
    { size: 'lg', icon: 'cash', color: 'var(--accent-text)', label: 'مقبوضات البيع', value: fmt0(sellFiat), unit: sym, sub: multi ? `بعملة ${sym} · اختر العملة للتفصيل` : `${fmt0(sellCount)} عملية بيع` },
    { size: 'lg', icon: 'trend', color: 'var(--accent-text)', label: 'متوسط سعر البيع', value: avgPrice ? fmt2p(avgPrice) : '—', unit: avgPrice ? `${sym}/USDT` : '', sub: multi ? `بعملة ${sym}` : 'مرجّح بالكمية' },
    { size: 'lg', icon: 'down', color: 'var(--buy-text)', label: 'مشتريات', value: fmt2(buyAmt), unit: 'USDT', sub: `${fmt0(buys.length)} طلب مكتمل` },
    { icon: 'in', color: 'var(--good)', label: 'إجمالي الإيداع', value: fmt2(depSum), unit: 'USDT', sub: `${fmt0(dep.length)} عملية مكتملة` },
    { icon: 'out', color: 'var(--critical)', label: 'إجمالي السحب', value: fmt2(wdSum), unit: 'USDT', sub: `${fmt0(wd.length)} عملية مكتملة` },
    { icon: 'percent', color: 'var(--warn)', label: 'العمولات', value: fmt2(commission), unit: 'USDT', sub: 'رسوم المنصة' },
    { icon: 'hash', color: 'var(--ink-2)', label: 'عدد العمليات', value: fmt0(nOps), unit: '', sub: `${fmt0(state.filtered.length)} P2P · ${fmt0(state.filteredTx.length)} حوالة` },
  ];
  for (const t of tiles) wrap.append(tileCard(t));
}

/* ============================ أدوات الرسم ============================ */

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const c = m * Math.pow(10, exp);
    if (c >= v) return c;
  }
  return Math.pow(10, exp + 1);
}
function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

/** يجمّع الطلبات المكتملة في سلال زمنية (يوم/أسبوع/شهر حسب المدى) */
function makeBuckets(completed) {
  if (!completed.length) return { unit: 'day', buckets: [] };
  let min = Infinity, max = -Infinity;
  for (const o of completed) {
    if (o.createTime < min) min = o.createTime;
    if (o.createTime > max) max = o.createTime;
  }
  const spanDays = (max - min) / 86400000;
  const unit = spanDays <= 92 ? 'day' : spanDays <= 550 ? 'week' : 'month';
  const keyOf = (t) => {
    const d = new Date(t);
    if (unit === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };
  const next = (t) => {
    const d = new Date(t);
    if (unit === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  };
  const labelOf = (t) => {
    const d = new Date(t);
    if (unit === 'month') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };
  const titleOf = (t) => {
    const d = new Date(t);
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (unit === 'day') return iso;
    if (unit === 'week') return 'أسبوع يبدأ ' + iso;
    return 'شهر ' + `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  };
  const map = new Map();
  const start = keyOf(min), end = keyOf(max);
  for (let t = start; t <= end && map.size < 500; t = next(t)) {
    map.set(t, { t, label: labelOf(t), title: titleOf(t), sell: 0, buy: 0, sellFiat: 0, sellAmt: 0 });
  }
  for (const o of completed) {
    const b = map.get(keyOf(o.createTime));
    if (!b) continue;
    if (o.tradeType === 'SELL') { b.sell += o.amount; b.sellFiat += o.totalPrice; b.sellAmt += o.amount; }
    else b.buy += o.amount;
  }
  return { unit, buckets: Array.from(map.values()) };
}

/* تلميحة الرسوم */
const tooltipEl = () => $('#tooltip');
function showTooltip(evt, title, rows) {
  const tt = tooltipEl();
  tt.textContent = '';
  const t = document.createElement('div');
  t.className = 'tt-title';
  t.textContent = title;
  tt.append(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    if (r.color) {
      const k = document.createElement('i');
      k.className = 'tt-key';
      k.style.background = r.color;
      row.append(k);
    }
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = r.value;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = r.name;
    row.append(val, name);
    tt.append(row);
  }
  tt.classList.remove('hidden');
  positionTooltip(evt);
}
function positionTooltip(evt) {
  const tt = tooltipEl();
  const pad = 14;
  const r = tt.getBoundingClientRect();
  let x = evt.clientX - r.width - pad;
  if (x < 8) x = evt.clientX + pad;
  let y = evt.clientY - r.height - 10;
  if (y < 8) y = evt.clientY + 16;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}
function hideTooltip() { tooltipEl().classList.add('hidden'); }

/** محاور الرسم: الشبكة الأفقية مع أرقامها */
function drawGrid(svg, pad, pw, ph, valueAt) {
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ph - (i / 4) * ph;
    svg.append(svgEl('line', { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, class: i === 0 ? 'base-line' : 'grid-line' }));
    const txt = svgEl('text', { x: pad.l - 6, y: y + 4, class: 'axis-text', 'text-anchor': 'end' });
    txt.textContent = compactNum(valueAt(i / 4));
    svg.append(txt);
  }
}
function emptyChart(el, text) {
  const note = document.createElement('div');
  note.className = 'chart-note';
  note.textContent = text;
  el.append(note);
}

/* ============================ حجم التداول ============================ */

function renderVolChart() {
  const el = $('#volChart');
  el.textContent = '';
  const completed = state.filtered.filter((o) => o.orderStatus === 'COMPLETED');
  const { buckets } = makeBuckets(completed);
  // الرقم في رأس البطاقة: حجم الفترة كلها (بيعًا وشراءً)
  const volume = buckets.reduce((s, b) => s + b.sell + b.buy, 0);
  $('#volTotal').textContent = volume ? fmt2(volume) : '—';
  if (!buckets.length || buckets.every((b) => b.sell === 0 && b.buy === 0)) return emptyChart(el, 'لا توجد طلبات مكتملة في هذا النطاق');
  const w = Math.max(el.clientWidth || 0, 320), h = 250;
  const pad = { t: 14, r: 8, b: 26, l: 52 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const yMax = niceMax(Math.max(...buckets.map((b) => b.sell + b.buy)));
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  drawGrid(svg, pad, pw, ph, (f) => yMax * f);
  const n = buckets.length;
  const band = pw / n;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const GAP = 2;
  const stride = Math.max(1, Math.ceil(n / 6));
  const barGroups = [];
  buckets.forEach((b, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - barW / 2;
    const hSell = (b.sell / yMax) * ph;
    const hBuy = (b.buy / yMax) * ph;
    const group = [];
    const baseY = pad.t + ph;
    if (b.sell > 0) {
      const topmost = !(b.buy > 0);
      const y = baseY - hSell;
      const shape = topmost
        ? svgEl('path', { d: roundedTopRect(x, y, barW, hSell, 4), fill: 'var(--sell)', class: 'bar' })
        : svgEl('rect', { x, y, width: barW, height: hSell, fill: 'var(--sell)', class: 'bar' });
      svg.append(shape);
      group.push(shape);
    }
    if (b.buy > 0) {
      const gap = b.sell > 0 && hBuy > GAP + 1 ? GAP : 0;
      const hb = Math.max(hBuy - gap, 1);
      const y = baseY - hSell - gap - hb;
      const shape = svgEl('path', { d: roundedTopRect(x, y, barW, hb, 4), fill: 'var(--buy)', class: 'bar' });
      svg.append(shape);
      group.push(shape);
    }
    barGroups.push(group);
    if (i % stride === 0) {
      const txt = svgEl('text', { x: cx, y: h - 8, class: 'axis-text', 'text-anchor': 'middle' });
      txt.textContent = b.label;
      svg.append(txt);
    }
  });
  buckets.forEach((b, i) => {
    const hit = svgEl('rect', { x: pad.l + band * i, y: pad.t, width: band, height: ph, fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) => {
      $$('#volChart .bar').forEach((bar) => bar.classList.add('dim'));
      barGroups[i].forEach((bar) => bar.classList.remove('dim'));
      const rows = [];
      if (b.sell > 0) rows.push({ color: 'var(--sell)', value: fmt2(b.sell) + ' USDT', name: 'بيع' });
      if (b.buy > 0) rows.push({ color: 'var(--buy)', value: fmt2(b.buy) + ' USDT', name: 'شراء' });
      if (rows.length === 2) rows.push({ color: '', value: fmt2(b.sell + b.buy) + ' USDT', name: 'الإجمالي' });
      if (!rows.length) rows.push({ color: '', value: '0', name: 'لا حركة' });
      showTooltip(evt, b.title, rows);
    });
    hit.addEventListener('pointerleave', () => {
      $$('#volChart .bar').forEach((bar) => bar.classList.remove('dim'));
      hideTooltip();
    });
    svg.append(hit);
  });
  el.append(svg);
}

/* ============================ متوسط سعر البيع ============================ */

function renderPriceChart() {
  const el = $('#priceChart');
  el.textContent = '';
  const completedAll = state.filtered.filter((o) => o.orderStatus === 'COMPLETED');
  const useFiat = state.filters.fiat !== 'all'
    ? state.filters.fiat
    : (dominantFiat(completedAll.filter((o) => o.tradeType === 'SELL')) || dominantFiat(completedAll));
  const completed = completedAll.filter((o) => fiatCode(o) === useFiat);
  const { buckets } = makeBuckets(completed);
  const fiat = symForCode(useFiat) || 'العملة';

  const pts = [];
  buckets.forEach((b, i) => { if (b.sellAmt > 0) pts.push({ i, title: b.title, price: b.sellFiat / b.sellAmt }); });
  // رأس البطاقة: آخر متوسط، ومدى الفترة (أدنى وأعلى)
  const prices = pts.map((p) => p.price);
  $('#priceLast').textContent = pts.length ? fmt2p(pts[pts.length - 1].price) : '—';
  $('#priceUnit').textContent = pts.length ? `${fiat}/USDT` : '';
  $('#priceRange').textContent = pts.length > 1 ? `أدنى ${fmt2p(Math.min(...prices))} · أعلى ${fmt2p(Math.max(...prices))}` : '';
  if (!pts.length) return emptyChart(el, 'لا توجد مبيعات مكتملة في هذا النطاق');
  const w = Math.max(el.clientWidth || 0, 320), h = 250;
  const pad = { t: 16, r: 14, b: 26, l: 52 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  let lo = Math.min(...pts.map((p) => p.price));
  let hi = Math.max(...pts.map((p) => p.price));
  let span = hi - lo;
  if (span <= 0) span = Math.max(hi * 0.02, 1);
  lo -= span * 0.25;
  hi += span * 0.25;
  const n = buckets.length;
  const band = pw / n;
  const X = (i) => pad.l + band * i + band / 2;
  const Y = (p) => pad.t + ph - ((p - lo) / (hi - lo)) * ph;
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  drawGrid(svg, pad, pw, ph, (f) => lo + (hi - lo) * f);
  const stride = Math.max(1, Math.ceil(n / 6));
  buckets.forEach((b, i) => {
    if (i % stride === 0) {
      const txt = svgEl('text', { x: X(i), y: h - 8, class: 'axis-text', 'text-anchor': 'middle' });
      txt.textContent = b.label;
      svg.append(txt);
    }
  });
  const line = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${X(p.i).toFixed(1)},${Y(p.price).toFixed(1)}`).join(' ');
  // تعبئةٌ متدرّجة تحت الخطّ تُبرز الاتجاه دون أن تُزاحم الشبكة
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'priceFill', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svgEl('stop', { offset: '0%', style: 'stop-color:var(--sell);stop-opacity:0.28' }), svgEl('stop', { offset: '100%', style: 'stop-color:var(--sell);stop-opacity:0' }));
  defs.append(grad);
  svg.append(defs);
  const base = (pad.t + ph).toFixed(1);
  svg.append(svgEl('path', { d: `${line} L${X(pts[pts.length - 1].i).toFixed(1)},${base} L${X(pts[0].i).toFixed(1)},${base} Z`, fill: 'url(#priceFill)', stroke: 'none' }));
  svg.append(svgEl('path', { d: line, fill: 'none', stroke: 'var(--sell)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  if (pts.length <= 45) for (const p of pts) svg.append(svgEl('circle', { cx: X(p.i), cy: Y(p.price), r: 2.5, fill: 'var(--sell)' }));
  for (const p of [pts[0], pts[pts.length - 1]]) {
    svg.append(svgEl('circle', { cx: X(p.i), cy: Y(p.price), r: 4.5, fill: 'var(--sell)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  }
  const last = pts[pts.length - 1];
  const endTxt = svgEl('text', { x: Math.min(X(last.i), pad.l + pw - 4), y: Math.max(Y(last.price) - 10, pad.t + 10), class: 'end-label', 'text-anchor': 'end' });
  endTxt.textContent = fmt2p(last.price);
  svg.append(endTxt);
  const hoverLine = svgEl('line', { y1: pad.t, y2: pad.t + ph, x1: -9, x2: -9, class: 'hover-line' });
  const hoverDot = svgEl('circle', { cx: -9, cy: -9, r: 5, fill: 'var(--sell)', stroke: 'var(--surface)', 'stroke-width': 2 });
  svg.append(hoverLine, hoverDot);
  const hit = svgEl('rect', { x: pad.l, y: pad.t, width: pw, height: ph, fill: 'transparent' });
  hit.addEventListener('pointermove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    let nearest = pts[0], bd = Infinity;
    for (const p of pts) { const dd = Math.abs(X(p.i) - mx); if (dd < bd) { bd = dd; nearest = p; } }
    hoverLine.setAttribute('x1', X(nearest.i));
    hoverLine.setAttribute('x2', X(nearest.i));
    hoverDot.setAttribute('cx', X(nearest.i));
    hoverDot.setAttribute('cy', Y(nearest.price));
    showTooltip(evt, nearest.title, [{ color: 'var(--sell)', value: fmt2p(nearest.price), name: fiat + '/USDT' }]);
  });
  hit.addEventListener('pointerleave', () => {
    hoverDot.setAttribute('cx', -9);
    hoverDot.setAttribute('cy', -9);
    hoverLine.setAttribute('x1', -9);
    hoverLine.setAttribute('x2', -9);
    hideTooltip();
  });
  svg.append(hit);
  el.append(svg);
}
