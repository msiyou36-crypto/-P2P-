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

/* ============================ نوافذ التفاصيل ============================ */

/** زرّان بجانب حقل رقم: «تثبيت» و«إلغاء»، للمسؤول */
function numberActionRow(label, hint, current, placeholder, labels, onSet, onClear) {
  const wrap = document.createElement('div');
  wrap.className = 'zero-toggle';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = 'any';
  inp.min = '0';
  inp.dir = 'ltr';
  inp.className = 'num-input';
  inp.placeholder = placeholder;
  inp.disabled = !canEdit();
  if (current != null) inp.value = String(current);
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = labels[0];
  btn.disabled = !canEdit();
  const clr = document.createElement('button');
  clr.className = 'btn';
  clr.textContent = labels[1];
  clr.disabled = !canEdit() || current == null;
  wrap.append(inp, btn, clr);
  btn.addEventListener('click', async () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || v < 0) { toast('اكتب رقمًا صحيحًا (صفر فأكثر)', 'err'); return; }
    btn.disabled = true;
    try { await onSet(v); } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
    btn.disabled = false;
  });
  clr.addEventListener('click', async () => {
    clr.disabled = true;
    try { await onClear(); } catch (e) { toast('تعذّر الحفظ: ' + e.message, 'err'); }
  });
  return detailRow(label, wrap, { hint });
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
  const wrap = document.createElement('div');
  wrap.className = 'zero-toggle';
  const on = !!entity.archived;
  const btn = iconButton('btn' + (on ? '' : ' danger'), on ? 'undo' : 'archive', on ? 'إرجاع من الأرشيف' : 'أرشفة (إخفاء من الجدول)');
  btn.disabled = !canEdit();
  wrap.append(btn);
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
  return detailRow('الأرشيف', wrap, {
    hint: 'الأرشفة تُخرجها من الجدول ومن الحساب معًا: لا تدخل الأرقام ولا عمود «الباقي من USDT» وكأنها لم تكن. والسجلّ محفوظ، فتُرجعها متى شئت. للحذف النهائي استخدم زر الحذف.',
  });
}

function annotDetailRow(entity, field, kind, label) {
  const input = document.createElement(field === 'note' ? 'textarea' : 'input');
  if (field === 'note') input.rows = 2; else input.type = 'text';
  input.className = 'detail-annot';
  input.value = entity[field] || '';
  input.placeholder = field === 'reference' ? 'علامة/مرجع خاص بك' : 'ملاحظتك على العملية';
  if (canAnnotate()) input.addEventListener('change', () => saveAnnotation(kind, entity, field, input.value, input));
  else { input.readOnly = true; input.classList.add('readonly'); }
  return detailRow(label, input);
}

/** نافذة تفاصيل العملية (طلبًا كانت أو حوالة) */
const openOp = (it, isP2P) => (isP2P ? openDetails(it) : openTransferDetails(it));

function openDetails(o) {
  state.detailsOrder = o;
  const body = $('#detailsBody');
  body.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'detail-rows';
  const ti = TYPE_INFO[o.tradeType];
  const si = statusInfo(o.orderStatus);
  const fiat = fiatSymOf(o);
  wrap.append(detailRow('النوع', chip(ti.ar + ' ' + o.asset, ti.color)));
  wrap.append(detailRow('الحالة', chip(si.ar, si.color)));
  const feeVal = effComm(o);
  wrap.append(detailRow('الكمية (شاملة العمولة)', fmt2(o.amount + feeVal) + ' ' + o.asset));
  if (feeVal > 0) {
    wrap.append(detailRow('الرسوم', fmt2(feeVal) + ' ' + o.asset));
    wrap.append(detailRow('الكمية المُحرّرة', fmt2(o.amount) + ' ' + o.asset));
  }
  wrap.append(detailRow('السعر', fmt2p(effUnitPrice(o)) + (fiat ? ' ' + fiat : '')));
  wrap.append(detailRow('المبلغ بالعملة المحلية', fmt0(effTotalPrice(o)) + (fiat ? ' ' + fiat : '')));
  wrap.append(detailRow('الطرف الآخر', o.counterPart || '—'));
  if (o.advertisementRole) wrap.append(detailRow('دورك في الطلب', o.advertisementRole === 'MAKER' ? 'معلن (Maker)' : 'منفّذ (Taker)'));
  wrap.append(detailRow('وقت الإنشاء', fmtDTsec(o.createTime)));
  const noSpan = document.createElement('span');
  noSpan.className = 'mono';
  noSpan.textContent = o.orderNumber;
  wrap.append(detailRow('رقم الطلب', noSpan, { copy: o.orderNumber }));
  wrap.append(detailRow('المصدر', SOURCE_AR[o.source] || o.source));
  wrap.append(annotDetailRow(o, 'reference', 'order', 'الإشاري'));
  wrap.append(annotDetailRow(o, 'note', 'order', 'الملاحظة'));
  if (o.orderStatus === 'COMPLETED') wrap.append(zeroPointRow(o, 'order'));
  if (canEdit()) wrap.append(archiveRow(o, 'order'));
  body.append(wrap);
  openModal('#mDetails');
}

function openTransferDetails(t) {
  const body = $('#txDetailsBody');
  body.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'detail-rows';
  const ki = TX_KIND[t.kind] || { ar: t.kind, color: 'var(--muted)' };
  const si = txStatusInfo(t.status);
  const isPay = isPayKind(t.kind);
  wrap.append(detailRow('النوع', chip(ki.ar + ' ' + (t.coin || ''), ki.color)));
  wrap.append(detailRow('الحالة', chip(si.ar, si.color)));
  if (isConvertKind(t.kind) && t.fromAsset && t.toAsset) {
    wrap.append(detailRow('حوّلت من', fmt2(t.fromAmount) + ' ' + t.fromAsset));
    wrap.append(detailRow('إلى', fmt2(t.toAmount) + ' ' + t.toAsset));
    wrap.append(detailRow('قيمة USDT', fmt2(t.amount) + ' USDT'));
  } else {
    wrap.append(detailRow('الكمية', fmt2(t.amount) + ' ' + (t.coin || '')));
  }
  if (t.counterPart) wrap.append(detailRow(t.kind === 'pay-in' ? 'من' : 'إلى', t.counterPart));
  if (isPay && t.orderType) wrap.append(detailRow('نوع Pay', t.orderType));
  if (t.kind === 'withdraw') {
    wrap.append(detailRow('رسوم الشبكة', fmt2(t.fee) + ' ' + (t.coin || '')));
    wrap.append(detailRow('الإجمالي المخصوم', fmt2(t.amount + (t.fee || 0)) + ' ' + (t.coin || '')));
  }
  if (t.network) wrap.append(detailRow('الشبكة', t.network));
  const walletLabel = isPay ? (t.walletName || '') : (t.walletType != null ? WALLET_AR[t.walletType] : '');
  if (walletLabel) wrap.append(detailRow('المحفظة', walletLabel));
  if (t.address) {
    const addr = document.createElement('span');
    addr.className = 'mono';
    addr.textContent = t.address;
    wrap.append(detailRow('العنوان', addr, { copy: t.address }));
  }
  if (t.txId) {
    const tx = document.createElement('span');
    tx.className = 'mono';
    tx.textContent = shortId(t.txId);
    wrap.append(detailRow('معرّف العملية (TxID)', tx, { copy: t.txId }));
  }
  wrap.append(detailRow('وقت الإنشاء', fmtDTsec(t.time)));
  if (t.completeTime) wrap.append(detailRow('وقت الاكتمال', fmtDTsec(t.completeTime)));
  wrap.append(detailRow('المصدر', SOURCE_AR[t.source] || t.source || 'من المنصة'));
  if (String(t.coin || '').toUpperCase() !== 'USDT' || t.usdtValue != null) wrap.append(usdtValueRow(t));
  wrap.append(annotDetailRow(t, 'reference', 'transfer', 'الإشاري'));
  wrap.append(annotDetailRow(t, 'note', 'transfer', 'الملاحظة'));
  if (t.status === 'COMPLETED') wrap.append(zeroPointRow(t, 'transfer'));
  if (canEdit()) wrap.append(archiveRow(t, 'transfer'));
  body.append(wrap);
  openModal('#mTransfer');
}
