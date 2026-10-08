/* الجدول الموحّد: الفرز، صفّ الجدول، الخانات القابلة للتحرير (إشاري، ملاحظة، سعر، مبلغ،
   تسمية الشبكة — تستعملها البطاقات أيضًا)، ونوافذ تفاصيل الطلب والحوالة بما فيها مرساة
   الرصيد والأرشفة. اختيار شكل العرض (جدول/يومي/بطاقات/مربعات) والرسم في js/views.js */
'use strict';

function sortLedger() {
  const { key, dir } = state.sort;
  state.ledger.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

/* ============================ الخانات القابلة للتحرير ============================ */

const annotateUrl = (kind) => (kind === 'transfer' ? '/api/transfers/annotate' : '/api/orders/annotate');
const idOf = (entity, kind) => (kind === 'transfer' ? entity.id : entity.orderNumber);
const flashSaved = (el) => { if (el) { el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 900); } };
const stopRowClick = (input) => {
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
};

/** حقل الإشاري/الملاحظة (في الجدول والبطاقات): يكتب فيه المسؤول و«مستخدم 2» */
function annotInput(entity, field, kind) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'note-input';
  input.value = entity[field] || '';
  input.placeholder = field === 'reference' ? 'إشاري…' : 'ملاحظة…';
  input.setAttribute('aria-label', field === 'reference' ? 'الإشاري' : 'الملاحظة');
  stopRowClick(input);
  if (canAnnotate()) {
    input.title = field === 'reference' ? 'الإشاري — يُحفظ تلقائيًا' : 'الملاحظة — تُحفظ تلقائيًا';
    input.addEventListener('change', () => saveAnnotation(kind, entity, field, input.value, input));
  } else {
    input.readOnly = true;
    input.classList.add('readonly');
    input.title = 'الكتابة للمسؤول و«مستخدم 2» فقط';
  }
  return input;
}
function annotCell(entity, field, kind) {
  const td = document.createElement('td');
  td.className = 'col-note ' + (field === 'note' ? 'is-note' : 'is-ref');
  td.append(annotInput(entity, field, kind));
  return td;
}
async function saveAnnotation(kind, entity, field, value, inputEl) {
  entity[field] = value;
  try {
    await postJSON(annotateUrl(kind), { id: idOf(entity, kind), note: entity.note || '', reference: entity.reference || '' });
    flashSaved(inputEl);
  } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
}

/** حقل تعديل السعر/المبلغ (في الجدول والبطاقات، لمن يملك التعديل) — يبقى بعد المزامنة */
function makePriceInput(entity, field, kind) {
  const overKey = field === 'unitPrice' ? 'unitPriceOverride' : 'totalPriceOverride';
  const cur = field === 'unitPrice' ? effUnitPrice(entity) : effTotalPrice(entity);
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'num-input';
  input.value = cur ? String(cur) : '';
  input.placeholder = '—';
  input.title = 'اضغط للتعديل — يُحفظ تلقائيًا ويبقى بعد المزامنة';
  input.setAttribute('aria-label', field === 'unitPrice' ? 'السعر' : 'المبلغ');
  if (entity[overKey] != null) input.classList.add('is-edited');
  stopRowClick(input);
  input.addEventListener('change', () => savePriceEdit(entity, field, input, kind || 'order'));
  return input;
}
/** خانة السعر/المبلغ في الجدول */
function priceCell(entity, field, display, kind) {
  const td = document.createElement('td');
  td.className = 'num strong editable';
  const overKey = field === 'unitPrice' ? 'unitPriceOverride' : 'totalPriceOverride';
  const edited = entity[overKey] != null;
  if (!canAnnotate()) {
    td.textContent = edited ? fmt2p(entity[overKey]) : display;
    if (edited) td.classList.add('is-edited');
    return td;
  }
  td.append(makePriceInput(entity, field, kind));
  return td;
}
async function savePriceEdit(entity, field, inputEl, kind) {
  const overKey = field === 'unitPrice' ? 'unitPriceOverride' : 'totalPriceOverride';
  const raw = String(inputEl.value || '').trim().replace(/,/g, '');
  const body = { id: idOf(entity, kind) };
  if (raw === '') { body[field] = ''; delete entity[overKey]; }   // فارغ = الرجوع لقيمة المنصة
  else {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) { toast('قيمة غير صالحة', 'err'); return; }
    body[field] = v;
    entity[overKey] = v;
  }
  try {
    await postJSON(annotateUrl(kind), body);
    flashSaved(inputEl);
    inputEl.classList.toggle('is-edited', entity[overKey] != null);
    renderTiles();
    renderPriceChart();
  } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
}

/** خانة «العملة/الشبكة» (للمسؤول: تسميةٌ يدوية تبقى بعد المزامنة) */
function labelCell(entity, kind, display) {
  const td = document.createElement('td');
  td.className = 'editable';
  const edited = entity.networkLabelOverride != null;
  if (!canEdit()) {
    td.textContent = edited ? entity.networkLabelOverride : display;
    if (edited) td.classList.add('is-edited');
    return td;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'label-input';
  input.value = edited ? entity.networkLabelOverride : display;
  input.placeholder = '—';
  input.title = 'اضغط للتعديل — يُحفظ تلقائيًا ويبقى بعد المزامنة';
  if (edited) input.classList.add('is-edited');
  stopRowClick(input);
  input.addEventListener('change', () => saveLabelEdit(entity, input, kind, display));
  td.append(input);
  return td;
}
async function saveLabelEdit(entity, inputEl, kind, defaultDisplay) {
  const val = String(inputEl.value || '').trim();
  const body = { id: idOf(entity, kind) };
  if (val === '' || val === defaultDisplay) { body.networkLabel = ''; delete entity.networkLabelOverride; }
  else { body.networkLabel = val; entity.networkLabelOverride = val; }
  try {
    await postJSON(annotateUrl(kind), body);
    flashSaved(inputEl);
    inputEl.classList.toggle('is-edited', entity.networkLabelOverride != null);
  } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
}

/* ============================ صفّ الجدول ============================ */

/** صفّ جدولٍ لعملية (n رقمها التسلسلي؛ mixed: عملاتٌ محلية متعدّدة في المعروض) */
function ledgerTr(row, n, mixed) {
  const isP2P = row._kind === 'p2p';
  const it = row.raw;
  const kind = isP2P ? 'order' : 'transfer';
  const tr = document.createElement('tr');

  tdText(tr, fmt0(n), 'col-idx');
  tdText(tr, fmtDT(row._t));
  const tdType = document.createElement('td');
  const ki = typeInfoOf(it, isP2P);
  tdType.append(chip(ki.ar, ki.color));
  tr.append(tdType);

  // عمليةٌ قُوّمت بالـUSDT يدويًا تُعرض بقيمتها تلك — فهي ما دخل الدفتر فعلًا
  const tdAmt = tdText(tr, fmt2(usdtOf(it, isP2P)), 'num strong');
  if (!isP2P && it.usdtValue != null) {
    tdAmt.classList.add('is-edited');
    tdAmt.title = `قوّمتَها بالـUSDT يدويًا — الأصل ${fmt2(it.amount)} ${it.coin || ''}`;
  }
  if (isP2P) {
    tr.append(priceCell(it, 'unitPrice', fmt2p(effUnitPrice(it)), kind));
    tr.append(priceCell(it, 'totalPrice', mixed ? fmt0(effTotalPrice(it)) + ' ' + fiatSymOf(it) : fmt0(effTotalPrice(it)), kind));
  } else {
    tr.append(priceCell(it, 'unitPrice', it.unitPriceOverride != null ? fmt2p(it.unitPriceOverride) : '—', kind));
    tr.append(priceCell(it, 'totalPrice', it.totalPriceOverride != null ? fmt0(it.totalPriceOverride) : '—', kind));
  }
  const coinLabel = !isP2P && it.usdtValue != null ? 'USDT' : (it.network || it.coin || '—');
  tr.append(labelCell(it, kind, isP2P ? fiatSymOf(it) : coinLabel));

  const bal = balOf(it, isP2P);
  const tdBal = tdText(tr, bal == null ? '—' : fmt2(bal), 'num col-bal');
  if (it.balAfter != null) tdBal.title = 'رقم مثبَّت — ثُبِّت ساعة اكتمال العملية ولا يتغيّر';
  if (it.balanceAt != null || it.zeroPoint) {
    tdBal.classList.add('is-zeropoint');
    tdBal.title = `نقطة التثبيت — أنت كتبت أن رصيدك بعد هذه العملية كان ${fmt2(it.balanceAt != null ? it.balanceAt : 0)} USDT، والعمود كلّه محسوب منها`;
  }
  tdText(tr, it.counterPart || '—');
  const tdSt = document.createElement('td');
  const si = statusOf(it, isP2P);
  tdSt.append(chip(si.ar, si.color));
  tr.append(tdSt);
  tr.append(annotCell(it, 'reference', kind));
  tr.append(annotCell(it, 'note', kind));
  const tdId = document.createElement('td');
  tdId.className = 'mono col-id';
  const fullId = opId(it, isP2P);
  tdId.textContent = tinyId(fullId);
  tdId.title = fullId;
  tr.append(tdId);

  tr.addEventListener('click', () => openOp(it, isP2P));
  return tr;
}

/** إعادة رسم كل شيء من الحالة الحالية (الفلاتر ← الباقي ← البطاقات ← الرسوم ← العمليات) */
function renderAll() {
  applyFilters();
  state.balMap = computeBalanceMap();
  renderBalance();   // البطاقة تعرض تنبيهات «الباقي» المحسوبة للتوّ
  renderTiles();
  renderVolChart();
  renderPriceChart();
  renderLedger();
  scheduleFreeze();   // ما اكتمل يُثبَّت باقيه في الخادم مرّةً واحدة
  const ls = state.settings.lastSync;
  $('#lastSync').textContent = ls ? 'آخر مزامنة: ' + fmtDT(ls) : 'لم تتم مزامنة بعد';
}

/* وضع الأرشيف: الجدولُ نفسه يعرض المؤرشَف وحده، بنفس الفلاتر والفرز والتفاصيل */
function setArchiveView(on) {
  state.showArchive = !!on && canEdit();
  state.page = 1;
  $('#archiveBar').classList.toggle('hidden', !state.showArchive);
  renderAll();
}

/* ============================ نوافذ التفاصيل ============================
 * ملخّصٌ كبير أعلاها (النوع والحالة والمبلغ وأرقامه الأساسية)، ثم أقسامٌ بعناوين:
 * المعلومات، ثم ملاحظاتك (الإشاري والملاحظة)، ثم أدوات المسؤول (تثبيت الباقي، الاحتساب
 * بالـUSDT، الأرشفة) — وهذه للمسؤول وحده فلا يرى غيرُه أزرارًا معطّلة. */

/** الملخّص: النوع والحالة، ثم المبلغ كبيرًا، ثم أرقامٌ صغيرة [[العنوان، القيمة]…] (الفارغ يُترك) */
function detailHero(typeChip, statusChip, color, amount, unit, stats) {
  const hero = mk('div', 'd-hero');
  hero.style.setProperty('--k', color);
  const top = mk('div', 'd-hero-top');
  top.append(typeChip, statusChip);
  const amt = mk('div', 'd-hero-amt');
  amt.append(mk('span', 'num', amount), mk('span', 'unit', unit));
  hero.append(top, amt);
  const list = stats.filter(Boolean);
  if (list.length) {
    const grid = mk('div', 'd-stats');
    for (const [k, v] of list) {
      const s = mk('div', 'd-stat');
      s.append(mk('span', 'k', k), mk('span', 'v', v));
      grid.append(s);
    }
    hero.append(grid);
  }
  return hero;
}
/** قسمٌ بعنوان؛ محتواه صفوفٌ في إطار (الفارغ منها يُترك) */
function detailSection(title, items, cls) {
  const sec = mk('section', 'd-sec');
  const box = mk('div', cls || 'detail-rows');
  box.append(...items.filter(Boolean));
  sec.append(mk('h4', 'd-sec-title', title), box);
  return sec;
}
/** الإشاري أو الملاحظة: حقلٌ عنوانه فوقه، يُحفظ تلقائيًا (للمسؤول و«مستخدم 2») */
function annotField(entity, field, kind) {
  const lab = mk('label', 'field', field === 'reference' ? 'الإشاري' : 'الملاحظة');
  const input = document.createElement(field === 'note' ? 'textarea' : 'input');
  if (field === 'note') input.rows = 2; else input.type = 'text';
  input.className = 'd-annot';
  input.value = entity[field] || '';
  input.placeholder = field === 'reference' ? 'علامة أو مرجع خاص بك' : 'ملاحظتك على العملية';
  if (canAnnotate()) input.addEventListener('change', () => saveAnnotation(kind, entity, field, input.value, input));
  else { input.readOnly = true; input.classList.add('readonly'); }
  lab.append(input);
  return lab;
}
/** صفّ أداةٍ للمسؤول: عنوانٌ وشرحه، وأزرارها جانبه */
function toolRow(title, hint, ...actions) {
  const row = mk('div', 'dz-row');
  const text = mk('div', 'dz-text');
  text.append(mk('b', null, title), mk('span', null, hint));
  const acts = mk('div', 'dz-actions');
  acts.append(...actions);
  row.append(text, acts);
  return row;
}

/** حقل رقمٍ وزرّا «تثبيت» و«إلغاء» (الثاني يظهر حين توجد قيمةٌ تُلغى) */
function numberActionRow(label, hint, current, placeholder, labels, onSet, onClear) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = 'any';
  inp.min = '0';
  inp.dir = 'ltr';
  inp.inputMode = 'decimal';
  inp.className = 'd-num';
  inp.placeholder = placeholder;
  inp.setAttribute('aria-label', label);
  if (current != null) inp.value = String(current);
  const btn = mk('button', 'btn accent', labels[0]);
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const v = Number(inp.value);
    if (inp.value.trim() === '' || !Number.isFinite(v) || v < 0) { toast('اكتب رقمًا صحيحًا (صفر فأكثر)', 'err'); return; }
    btn.disabled = true;
    try { await onSet(v); } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
    btn.disabled = false;
  });
  const actions = [inp, btn];
  if (current != null) {
    const clr = mk('button', 'btn', labels[1]);
    clr.type = 'button';
    clr.addEventListener('click', async () => {
      clr.disabled = true;
      try { await onClear(); } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); clr.disabled = false; }
    });
    actions.push(clr);
  }
  return toolRow(label, hint, ...actions);
}

/* مرساةٌ بيد المستخدم: يكتب رصيده الحقيقي بعد عمليةٍ يعرفها، فيُحسب العمود كلّه منها.
   لا تحتاج منصةً ولا مفتاحًا — وهي المخرج حين يتعذّر جلب الرصيد. */
function zeroPointRow(entity, kind) {
  const cur = entity.balanceAt != null ? entity.balanceAt : (entity.zeroPoint ? 0 : null);
  const send = async (val) => {
    await postJSON(annotateUrl(kind), { id: idOf(entity, kind), balanceAt: val });
    try { await api('/api/balance/unfreeze', { method: 'POST' }); } catch {}   // المرساة أوثق من كل مثبَّت سابق
    await Promise.all([loadOrders(), loadTransfers()]);
    renderAll();
  };
  return numberActionRow('تثبيت الباقي',
    'اكتب رصيد USDT الحقيقي بعد هذه العملية (الفوري + التمويل معًا)، فيُحسب العمود كلّه منها — ما بعدها بالجمع وما قبلها بالطرح. اكتب صفرًا إن كنت أفرغت محفظتك بعدها.',
    cur, 'مثلًا 1250.75', ['تثبيت', 'إلغاء التثبيت'],
    async (v) => { await send(v); closeAllModals(); toast(`ثُبِّت الرصيد على ${fmt2(v)} USDT — أُعيد حساب العمود ✓`); },
    async () => { await send(null); closeAllModals(); toast('أُلغي التثبيت — أُعيد حساب العمود'); });
}

/* تقويمُ عمليةٍ بعملةٍ أخرى بالـUSDT لتدخل «الباقي» */
function usdtValueRow(t) {
  const send = async (val) => {
    await postJSON('/api/transfers/annotate', { id: t.id, usdtValue: val });
    if (val == null) delete t.usdtValue; else t.usdtValue = val;
    renderAll();
  };
  return numberActionRow('احتساب بالـUSDT',
    `هذه العملية بعملة ${t.coin || '—'}، فلا تُغيّر رصيد USDT ولا تدخل «الباقي». اكتب قيمتها بالـUSDT لتُحتسب — وتصير عملتها USDT في الجدول. احذر الازدواج إن كنت قد حوّلت الـUSDT إلى هذه العملة أصلًا، فذلك التحويل خصمها مرّة.`,
    t.usdtValue != null ? t.usdtValue : null, 'مثلًا 309.38743608', ['احتسب', 'لا تحتسب'],
    async (v) => { await send(v); closeAllModals(); toast(`احتُسبت بـ ${fmt2(v)} USDT ✓`); },
    async () => { await send(null); closeAllModals(); toast('لم تعد تُحتسب في «الباقي»'); });
}

/* الأرشفة: إخراجُ صفٍّ من الجدول ومن الحساب معًا دون محوه (للمسؤول) */
function archiveRow(entity, kind) {
  const on = !!entity.archived;
  const btn = iconButton('btn' + (on ? '' : ' danger'), on ? 'undo' : 'archive', on ? 'إرجاع من الأرشيف' : 'أرشفة');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await postJSON(annotateUrl(kind), { id: idOf(entity, kind), archived: !on });
      if (on) delete entity.archived; else entity.archived = true;
      closeAllModals();
      renderAll();
      toast(on ? 'أُرجعت إلى الجدول ✓' : 'أُرسلت إلى الأرشيف — تجدها في القائمة ← الأرشيف');
    } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); btn.disabled = false; }
  });
  return toolRow('الأرشيف', on
    ? 'هذه العملية في الأرشيف: خارج الجدول وخارج الحساب. أرجعها متى شئت.'
    : 'تُخرجها من الجدول ومن الحساب معًا: لا تدخل الأرقام ولا «الباقي من USDT» وكأنها لم تكن، والسجلّ محفوظ فتُرجعها متى شئت.'
      + (kind === 'order' ? ' للحذف النهائي زرّ «حذف الطلب» أسفل النافذة.' : ''), btn);
}

/** نافذة تفاصيل العملية (طلبًا كانت أو حوالة) */
const openOp = (it, isP2P) => (isP2P ? openDetails(it) : openTransferDetails(it));

function openDetails(o) {
  state.detailsOrder = o;
  const body = $('#detailsBody');
  body.textContent = '';
  const ti = TYPE_INFO[o.tradeType];
  const si = statusInfo(o.orderStatus);
  const fiat = fiatSymOf(o);
  const inFiat = (v) => v + (fiat ? ' ' + fiat : '');
  const fee = effComm(o);
  $('#mDetailsSub').textContent = fmtDTsec(o.createTime);
  // المبلغ الكبير شاملٌ العمولة (ما خرج من محفظتك في البيع)، والمحرَّر بعدها في الأرقام تحته
  body.append(detailHero(chip(ti.ar + ' ' + o.asset, ti.color), chip(si.ar, si.color), ti.color,
    fmt2(o.amount + fee), o.asset, [
      ['السعر', inFiat(fmt2p(effUnitPrice(o)))],
      ['المبلغ', inFiat(fmt0(effTotalPrice(o)))],
      fee > 0 && ['الرسوم', fmt2(fee) + ' ' + o.asset],
      fee > 0 && ['المُحرَّرة', fmt2(o.amount) + ' ' + o.asset],
    ]));
  body.append(detailSection('معلومات الطلب', [
    detailRow('الطرف الآخر', o.counterPart || '—'),
    o.advertisementRole && detailRow('دورك في الطلب', o.advertisementRole === 'MAKER' ? 'معلن (Maker)' : 'منفّذ (Taker)'),
    detailRow('رقم الطلب', mk('span', 'mono', o.orderNumber), { copy: o.orderNumber }),
    detailRow('المصدر', SOURCE_AR[o.source] || o.source),
  ]));
  body.append(detailSection('ملاحظاتك', [annotField(o, 'reference', 'order'), annotField(o, 'note', 'order')], 'd-annots'));
  if (canEdit()) {
    body.append(detailSection('أدوات المسؤول', [
      o.orderStatus === 'COMPLETED' && zeroPointRow(o, 'order'),
      archiveRow(o, 'order'),
    ], 'd-tools'));
  }
  openModal('#mDetails');
  body.scrollTop = 0;   // كل عمليةٍ تُفتح من أعلاها لا من حيث توقّف التمرير في سابقتها
}

function openTransferDetails(t) {
  const body = $('#txDetailsBody');
  body.textContent = '';
  const ki = TX_KIND[t.kind] || { ar: t.kind, color: 'var(--muted)' };
  const si = txStatusInfo(t.status);
  const isPay = isPayKind(t.kind);
  const coin = t.coin || '';
  const conv = isConvertKind(t.kind) && t.fromAsset && t.toAsset;
  const walletLabel = isPay ? (t.walletName || '') : (t.walletType != null ? WALLET_AR[t.walletType] : '');
  $('#mTransferSub').textContent = fmtDTsec(t.time);
  body.append(detailHero(chip(ki.ar + (coin ? ' ' + coin : ''), ki.color), chip(si.ar, si.color), ki.color,
    fmt2(t.amount), conv ? 'USDT' : coin, [
      conv && ['حوّلت من', fmt2(t.fromAmount) + ' ' + t.fromAsset],
      conv && ['إلى', fmt2(t.toAmount) + ' ' + t.toAsset],
      t.kind === 'withdraw' && ['رسوم الشبكة', fmt2(t.fee) + ' ' + coin],
      t.kind === 'withdraw' && ['الإجمالي المخصوم', fmt2(t.amount + (t.fee || 0)) + ' ' + coin],
      t.usdtValue != null && ['قيمتها بالـUSDT', fmt2(t.usdtValue) + ' USDT'],
      t.unitPriceOverride != null && ['السعر', fmt2p(t.unitPriceOverride)],
      t.totalPriceOverride != null && ['المبلغ', fmt0(t.totalPriceOverride)],
    ]));
  body.append(detailSection('معلومات الحوالة', [
    t.counterPart && detailRow(t.kind === 'pay-in' ? 'من' : 'إلى', t.counterPart),
    isPay && t.orderType && detailRow('نوع Pay', t.orderType),
    t.network && detailRow('الشبكة', t.network),
    walletLabel && detailRow('المحفظة', walletLabel),
    t.address && detailRow('العنوان', mk('span', 'mono', t.address), { copy: t.address }),
    t.txId && detailRow('معرّف العملية (TxID)', mk('span', 'mono', shortId(t.txId)), { copy: t.txId }),
    t.completeTime && detailRow('وقت الاكتمال', fmtDTsec(t.completeTime)),
    detailRow('المصدر', SOURCE_AR[t.source] || t.source || 'من المنصة'),
  ]));
  body.append(detailSection('ملاحظاتك', [annotField(t, 'reference', 'transfer'), annotField(t, 'note', 'transfer')], 'd-annots'));
  if (canEdit()) {
    body.append(detailSection('أدوات المسؤول', [
      (String(coin).toUpperCase() !== 'USDT' || t.usdtValue != null) && usdtValueRow(t),
      t.status === 'COMPLETED' && zeroPointRow(t, 'transfer'),
      archiveRow(t, 'transfer'),
    ], 'd-tools'));
  }
  openModal('#mTransfer');
  body.scrollTop = 0;
}
