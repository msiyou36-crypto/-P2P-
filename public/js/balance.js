/* عمود «الباقي من USDT»: كشفُ حسابٍ يعرض الرصيد بعد كل عملية مكتملة بالـUSDT.
 *
 * الفكرة: تُجمع كل العمليات المكتملة (بيع −، شراء +، إيداع +، سحب −، Pay، تحويل،
 * فوري) بترتيب زمني تصاعدي في سلسلة تراكمية، ثم تُزاح السلسلة كلّها حتى يطابق
 * صفٌّ موثوق («مرساة») رقمًا معروفًا. المرساة بالأولوية:
 *   ١) ما كتبه المستخدم بيده على صفٍّ (balanceAt / zeroPoint) — وكلُّ دبّوسٍ يُحترم
 *   ٢) أحدث صفٍّ مثبَّت (balAfter) — الدفتر يواصل من حيث انتهى
 *   ٣) أحدث لقطة رصيدٍ يومية مستقرّة، ثم أحدث لقطة
 *   ٤) رصيد المحفظة الحالي (عمودٌ «يتحرّك» مع كل عملية جديدة حتى تُسجَّل لقطة)
 * رصيدٌ سالب مستحيل: نزولُ السلسلة تحت الصفر دليلٌ على دخلٍ لم يصل من المنصة، فما
 * لا تفسّره السلسلة يُترك «—» ويُسمّى المفقود ووقته بدل اختراع أصفار.
 * ما اكتمل وأكّدته قراءةُ رصيدٍ يُثبَّت في الخادم (balAfter) فلا يُعاد حسابه أبدًا. */
'use strict';

/** رصيد USDT الحالي (الفوري + التمويل)، أو null إن لم يُجلب بعد */
function currentUsdtBalance() {
  const assets = (state.balance && state.balance.assets) || null;
  if (!assets) return null;
  const u = assets.find((a) => String(a.asset).toUpperCase() === 'USDT');
  if (!u) return null;
  return num(u.free) + num(u.locked) + num(u.freeze) + num(u.withdrawing);
}

const balKey = (item, isP2P) => (isP2P ? 'o:' + item.orderNumber : 't:' + item.id);
const OUT_KINDS = new Set(['withdraw', 'pay-out', 'convert-out', 'spot-buy']);
/* لا يُحسب «الباقي» إلا على آخر ٩٠ يومًا: المنصة لا تُرجع مبيعات P2P الأقدم من ~٦ أشهر
   بينما تُرجع الإيداعات القديمة، فالسجل البعيد فيه دخلٌ بلا خرجه وأي رقم هناك مضلّل */
const CHAIN_WINDOW_MS = 90 * 86400000;
/* مهلةُ استقرار الرصيد: لقطةٌ قُرئت قبل مرور هذه المدة على آخر عملية لا تُعتمد،
   لأن المبلغ قد لا يكون غادر المحفظة بعدُ */
const SNAP_SETTLE_MS = 20 * 60000;
const anchorValue = (x) => (x.balanceAt != null ? x.balanceAt : (x.zeroPoint ? 0 : null));

/** سلسلةٌ بمرساة واحدة (الموضع ai والإزاحة off): تُقرأ في الاتجاهين وتنقطع عند أول سالب */
function fillChain(evts, last, map, off, ai, r2, st) {
  let lo = 0, hi = last;
  for (let i = ai; i <= last; i++) if (evts[i].bal - off < -0.02) { hi = i - 1; break; }
  for (let i = ai; i >= 0; i--) if (evts[i].bal - off < -0.02) { lo = i + 1; break; }
  for (let i = lo; i <= hi; i++) map.set(evts[i].k, r2(Math.max(evts[i].bal - off, 0)));
  let deepest = 0;   // أعمقُ نزولٍ خارج المدى المفسَّر = أقلُّ دخلٍ مفقود
  for (let i = 0; i <= last; i++) {
    if (i >= lo && i <= hi) continue;
    const v = evts[i].bal - off;
    if (v < deepest) deepest = v;
  }
  st.balBroke = hi < last || lo > 0;
  st.balBrokeAt = hi < last ? evts[hi + 1].t : (lo > 0 ? evts[lo - 1].t : 0);
  st.balBrokeMissing = r2(-deepest) || 0;
  st.balBrokeRows = (last - hi) + lo;
}

/** مراسٍ متعدّدة: كلُّ مرساةٍ تحكم ما بعدها حتى التالية، وأقدمها تحكم ما قبلها */
function fillSegments(evts, last, map, anchors, r2, st) {
  let unexplained = 0, deepest = 0, brokeAt = 0;
  const miss = (i, off) => { unexplained++; const v = evts[i].bal - off; if (v < deepest) deepest = v; if (!brokeAt) brokeAt = evts[i].t; };
  const first = anchors[0];
  let lo = 0;
  for (let i = first.i; i >= 0; i--) if (evts[i].bal - first.off < -0.02) { lo = i + 1; break; }
  for (let i = 0; i < lo; i++) miss(i, first.off);
  for (let i = lo; i < first.i; i++) map.set(evts[i].k, r2(Math.max(evts[i].bal - first.off, 0)));
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k];
    const end = k + 1 < anchors.length ? anchors[k + 1].i - 1 : last;
    let hi = end;
    for (let i = a.i; i <= end; i++) if (evts[i].bal - a.off < -0.02) { hi = i - 1; break; }
    for (let i = a.i; i <= hi; i++) map.set(evts[i].k, r2(Math.max(evts[i].bal - a.off, 0)));
    for (let i = hi + 1; i <= end; i++) miss(i, a.off);
  }
  st.balBroke = unexplained > 0;
  st.balBrokeAt = brokeAt;
  st.balBrokeMissing = r2(-deepest) || 0;
  st.balBrokeRows = unexplained;
}

function computeBalanceMap() {
  // نافذة التسعين يومًا تمتدّ إلى أقدم مرساةٍ كتبها المستخدم إن كانت أقدم منها
  let cutoff = Date.now() - CHAIN_WINDOW_MS;
  let anchorT = 0;
  for (const o of state.orders) {
    if (o.orderStatus === 'COMPLETED' && !o.archived && anchorValue(o) != null) anchorT = anchorT ? Math.min(anchorT, o.createTime) : o.createTime;
  }
  for (const t of state.transfers) {
    if (t.status === 'COMPLETED' && !t.archived && anchorValue(t) != null && !isInternalKind(t.kind)) anchorT = anchorT ? Math.min(anchorT, t.time) : t.time;
  }
  if (anchorT && anchorT < cutoff) cutoff = anchorT;
  state.balAnchorOld = !!(anchorT && anchorT < Date.now() - CHAIN_WINDOW_MS);

  const evts = [];
  for (const o of state.orders) {
    if (o.orderStatus !== 'COMPLETED' || o.archived || o.createTime < cutoff) continue;
    const v = grossUSDT(o);
    evts.push({ k: balKey(o, true), t: o.createTime, d: o.tradeType === 'SELL' ? -v : v, zero: !!o.zeroPoint, at: anchorValue(o), frozen: o.balAfter });
  }
  for (const t of state.transfers) {
    if (t.status !== 'COMPLETED' || t.archived || t.time < cutoff) continue;
    // بالـUSDT وحده — إلا عمليةً بعملة أخرى قوّمها المستخدم بالـUSDT يدويًا (usdtValue شاملٌ للرسوم)
    const uv = t.usdtValue;
    if (uv == null && String(t.coin || '').toUpperCase() !== 'USDT') continue;
    if (isInternalKind(t.kind)) continue;
    const isOut = OUT_KINDS.has(t.kind);
    const v = uv != null ? uv : (isOut ? (t.amount || 0) + (t.fee || 0) : (t.amount || 0));
    evts.push({ k: balKey(t, false), t: t.time, d: isOut ? -v : v, zero: !!t.zeroPoint, at: anchorValue(t), frozen: t.balAfter });
  }
  // عملية بكمية غير معقولة (غالبًا مبلغ محلي في خانة الكمية) تُفسد العمود كله — نسمّيها
  state.balAbsurd = null;
  for (const e of evts) {
    if (Math.abs(e.d) >= 100000 && (!state.balAbsurd || Math.abs(e.d) > Math.abs(state.balAbsurd.d))) state.balAbsurd = e;
  }
  const cur = currentUsdtBalance();
  state.balNeedsWallet = false;
  state.balFloating = false;
  state.balSettledTo = 0;
  state.balBroke = false;
  state.balBrokeAt = 0;
  state.balBrokeMissing = 0;
  state.balBrokeRows = 0;
  if (!evts.length) { state.balGap = 0; state.balGapAt = 0; return new Map(); }
  evts.sort((a, b) => a.t - b.t);
  let run = 0;
  for (const e of evts) { run += e.d; e.bal = run; }
  const last = evts.length - 1;
  const map = new Map();
  const r2 = (v) => Math.round(v * 1e8) / 1e8;   // ثماني خانات: دقّة المنصة بلا ضجيج الفاصلة العائمة

  /* أرقامٌ مثبَّتة لا يفسّرها الدفتر (الفرق بين مثبَّتين ≠ مجموع ما بينهما) تُصلَّح
     تلقائيًا (healFrozen). زوجٌ يتخلّله دبّوسٌ يدوي لا يُفحص: القفزة عنده مقصودة. */
  state.balFrozenBroken = false;
  const crossesAnchor = (from, to) => { for (let j = from + 1; j <= to; j++) if (evts[j].at != null) return true; return false; };
  for (let i = 0, pf = -1; i <= last; i++) {
    if (evts[i].frozen == null) continue;
    if (pf >= 0 && !crossesAnchor(pf, i) && Math.abs((evts[i].frozen - evts[pf].frozen) - (evts[i].bal - evts[pf].bal)) > 0.02) {
      state.balFrozenBroken = true;
      break;
    }
    pf = i;
  }

  // لقطةٌ يومية كمرساة: موضعها في السلسلة، مع تفضيل المستقرّة
  const anchorAtSnap = (s) => { for (let j = last; j >= 0; j--) if (evts[j].t <= s.at) return j; return null; };
  const snaps = (state.balSnaps || []).slice().sort((a, b) => a.at - b.at);
  const snapAnchor = (needSettled) => {
    for (let s = snaps.length - 1; s >= 0; s--) {
      const i = anchorAtSnap(snaps[s]);
      if (i == null) continue;
      if (needSettled && snaps[s].at - evts[i].t < SNAP_SETTLE_MS) continue;
      return { i, off: evts[i].bal - snaps[s].bal };
    }
    return null;
  };

  const anchors = [];
  for (let i = 0; i <= last; i++) if (evts[i].at != null) anchors.push({ i, off: evts[i].bal - evts[i].at });
  let a = anchors.length ? anchors[anchors.length - 1] : null;
  for (let i = last; i >= 0 && !a; i--) if (evts[i].frozen != null) a = { i, off: evts[i].bal - evts[i].frozen };
  if (!a) a = snapAnchor(true) || snapAnchor(false);

  if (a) {
    if (anchors.length) fillSegments(evts, last, map, anchors, r2, state);
    else fillChain(evts, last, map, a.off, a.i, r2, state);
    // حدُّ التثبيت: ما شملته آخرُ قراءةِ رصيدٍ يقينًا (أو ما قبل آخر دبّوس)
    let settled = snaps.length ? snaps[snaps.length - 1].at - SNAP_SETTLE_MS : 0;
    for (let i = last; i >= 0; i--) if (evts[i].zero) { settled = Math.max(settled, evts[i].t); break; }
    state.balSettledTo = settled;
    if (cur == null) { state.balGap = 0; state.balGapAt = 0; return map; }
    const gap = r2((evts[last].bal - a.off) - cur);   // موجب = خرجٌ ناقص، سالب = دخلٌ ناقص
    state.balGap = Math.abs(gap) > 1 ? Math.abs(gap) : 0;
    state.balGapOut = gap > 0;
    state.balGapAt = state.balGap ? evts[a.i].t : 0;
    return map;
  }

  // بلا لقطةٍ ولا دبّوس: لا يبقى إلا رصيد المحفظة نُثبّت عليه، وبدونه «—»
  if (cur == null) { state.balGap = 0; state.balGapAt = 0; state.balNeedsWallet = true; return new Map(); }
  state.balFloating = true;
  const off = cur - run;
  // أحدثُ نزولٍ تحت الصفر = نقطة تصفير مؤكَّدة نجعلها الأساس بدل الرصيد الحالي
  let zIdx = -1;
  for (let i = last; i >= 0 && zIdx < 0; i--) if (evts[i].bal + off < 0) zIdx = i;
  if (zIdx < 0) {
    for (let i = 0; i <= last; i++) map.set(evts[i].k, r2(evts[i].bal + off));
    state.balGap = 0; state.balGapAt = 0;
    return map;
  }
  const base = evts[zIdx].bal;
  fillChain(evts, last, map, base, zIdx, r2, state);
  const gap = r2((evts[last].bal - base) - cur);
  state.balGap = Math.abs(gap) > 1 ? Math.abs(gap) : 0;
  state.balGapOut = gap > 0;
  state.balGapAt = state.balGap ? evts[zIdx].t : 0;
  return map;
}

/** الباقي المعروض: المثبَّت على الصفّ أوّلًا، ثم المحسوب */
function balOf(item, isP2P) {
  if (item.balAfter != null) return item.balAfter;
  const v = state.balMap && state.balMap.get(balKey(item, isP2P));
  return v == null ? null : v;
}

/* ===== التثبيت في الخادم =====
 * ما اكتمل وأكّدته قراءةُ رصيدٍ يُكتب على صفّه مرّةً واحدة فلا يتحرّك بعدها. */
let _freezeTimer = null;
function scheduleFreeze() {
  if (_freezeTimer) clearTimeout(_freezeTimer);
  _freezeTimer = setTimeout(() => { _freezeTimer = null; freezeSettled(); }, 1200);
}
/* إصلاحٌ ذاتي: أرقامٌ مثبَّتة فاسدة تُمسح ويُعاد حسابها مرّةً في الجلسة */
let _healed = false;
async function healFrozen() {
  if (_healed || !state.auth.token) return;
  _healed = true;
  try {
    const j = await api('/api/balance/unfreeze', { method: 'POST' });
    await Promise.all([loadOrders(), loadTransfers()]);
    renderAll();
    if (j.cleared) toast(`صُحّح عمود «الباقي من USDT» — أُعيد حساب ${fmt0(j.cleared)} رقم`);
  } catch (e) { console.error('heal: ' + e.message); }
}
async function freezeSettled() {
  if (state.balFrozenBroken) { await healFrozen(); return; }
  if (!state.auth.token || state.balFloating || state.balNeedsWallet) return;
  if (!state.balMap || !state.balMap.size || !state.balSettledTo) return;
  const o = {}, t = {};
  let n = 0;
  for (const x of state.orders) {
    if (x.balAfter != null || x.orderStatus !== 'COMPLETED' || x.createTime > state.balSettledTo) continue;
    const v = state.balMap.get(balKey(x, true));
    if (v == null) continue;
    o[x.orderNumber] = v; n++;
  }
  for (const x of state.transfers) {
    if (x.balAfter != null || x.status !== 'COMPLETED' || x.time > state.balSettledTo) continue;
    const v = state.balMap.get(balKey(x, false));
    if (v == null) continue;
    t[x.id] = v; n++;
  }
  if (!n) return;
  try {
    await postJSON('/api/balance/freeze', { orders: o, transfers: t });
    for (const x of state.orders) if (x.balAfter == null && o[x.orderNumber] != null) x.balAfter = o[x.orderNumber];
    for (const x of state.transfers) if (x.balAfter == null && t[x.id] != null) x.balAfter = t[x.id];
  } catch (e) { console.error('freeze: ' + e.message); }
}

/* ============================ بطاقة الرصيد ============================ */

function renderBalance() {
  const valEl = $('#walletUsdt'), subEl = $('#walletSub'), extraEl = $('#walletExtra'), updEl = $('#walletUpdated');
  if (!valEl) return;
  if (state.balanceLoading) { subEl.textContent = 'جارٍ جلب الرصيد من المنصة…'; return; }
  // سببُ فراغ عمود «الباقي» يُقال هنا، فالمستخدم يرى «—» في العمود ولا يعرف أن سببها هذه البطاقة
  const colHint = state.balAnchorOld
    ? ' ونقطة التثبيت (📌) عندك على عملية قديمة جدًّا؛ ما بعدها لا تفسّره السلسلة فيبقى «—». الحل: افتح أحدث عملية واكتب رصيدك الحقيقي بعدها في «تثبيت الباقي».'
    : (state.balNeedsWallet
      ? ' عمود «الباقي من USDT» فارغ لهذا السبب — أول قراءة ناجحة للرصيد تُسجَّل لقطةً لليوم، وبها يشتغل العمود ويثبت تلقائيًا بعدها.'
      : '');
  if (state.balanceError) {
    valEl.textContent = '—'; subEl.textContent = '⚠ ' + state.balanceError + colHint; extraEl.textContent = ''; updEl.textContent = '';
    return;
  }
  if (!state.balance) {
    valEl.textContent = '—';
    subEl.textContent = 'اضغط «⟳ تحديث الرصيد» لعرض رصيدك الحالي في الحساب الفوري ومحفظة التمويل معًا.' + colHint;
    return;
  }
  const assets = state.balance.assets || [];
  const usdt = assets.find((a) => String(a.asset).toUpperCase() === 'USDT');
  const free = usdt ? num(usdt.free) : 0;
  const held = usdt ? num(usdt.locked) + num(usdt.freeze) + num(usdt.withdrawing) : 0;
  valEl.textContent = fmt2(free + held);
  const b = state.balance;
  const split = b.spotIncluded
    ? `فوري ${fmt2(b.usdtSpot || 0)} · تمويل ${fmt2(b.usdtFunding || 0)}`
    : `⚠ التمويل فقط — تعذّر جلب الحساب الفوري: ${b.spotError || 'خطأ'}`;
  let gap = '';
  if (state.balAbsurd) {
    const a = state.balAbsurd;
    gap = ` · ⚠ توجد عملية بتاريخ ${fmtDT(a.t)} كميتها ${fmt2(Math.abs(a.d))} USDT — رقم غير معقول (غالبًا مبلغ بالعملة المحلية كُتب في خانة الكمية). صحّح كميتها أو احذفها، فهي تُفسد عمود «الباقي» كله.`;
  } else if (state.balBroke) {
    const when = state.balBrokeAt ? ` عند ${fmtDT(state.balBrokeAt)}` : '';
    gap = ` · ⚠ ينقص السجلَّ دخلٌ (إيداع أو شراء أو استلام Pay) لا يقلّ عن ${fmt2(state.balBrokeMissing)} USDT${when} — والرصيد لا ينزل تحت الصفر، فما بعد تلك اللحظة لا يُعرف باقيه: تُرك فارغًا («—») بدل رقمٍ مخترَع (${fmt0(state.balBrokeRows)} صفوف). ابحث عنه في تطبيق Binance وأضفه من «الإضافة اليدوية»، أو جرّب «🔍 فحص المزامنة» لذلك اليوم.`;
  } else if (state.balAnchorOld) {
    gap = ' · ℹ نقطة التثبيت (📌) عندك على عملية قديمة جدًّا، فالحساب يمتدّ شهورًا وسجلُّ المنصة البعيد ناقص. الأفضل: افتح أحدث عملية واكتب رصيدك الحقيقي بعدها في «تثبيت الباقي» — يُحسب العمود منها ويستقيم.';
  } else if (state.balFloating) {
    gap = ' · ℹ أرقام عمود «الباقي من USDT» مثبَّتة على رصيدك الحالي مؤقتًا، فتتغيّر كلّما دخلت عملية جديدة. أول قراءة ناجحة للرصيد تُسجَّل لقطةً لهذا اليوم، وبمجرّد دخول يومٍ جديد تثبت أرقام اليوم الماضي ولا تعود تتحرّك.';
  } else if (state.balGap > 1) {
    const when = state.balGapAt ? ` بعد ${fmtDT(state.balGapAt)}` : '';
    const what = state.balGapOut ? 'خرج (بيع أو سحب)' : 'دخل (إيداع أو شراء)';
    gap = ` · ⚠ عمليات ${what} بمقدار ${fmt2(state.balGap)} USDT ناقصة من السجل${when} — أرقام العمود صحيحة، والفرق كله في هذه العمليات وحدها. ابحث عنها في تطبيق Binance بعد هذا الوقت وأضفها من «الإضافة اليدوية»، أو افحصها من «🔍 فحص المزامنة».`;
  }
  subEl.textContent = `${split} · متاح ${fmt2(free)}${held > 0 ? ` · مُجمّد/قيد التنفيذ ${fmt2(held)}` : ''} USDT${gap}`;
  const others = assets
    .filter((a) => String(a.asset).toUpperCase() !== 'USDT' && num(a.free) + num(a.locked) + num(a.freeze) > 0)
    .map((a) => `${a.asset} ${fmt2(num(a.free) + num(a.locked) + num(a.freeze))}`);
  extraEl.textContent = others.length ? 'أصول أخرى: ' + others.slice(0, 8).join(' · ') : '';
  updEl.textContent = state.balance.updatedAt ? 'آخر تحديث: ' + fmtDT(state.balance.updatedAt) : '';
}

async function refreshBalance() {
  if (state.balanceLoading) return;
  state.balanceLoading = true;
  state.balanceError = null;
  renderBalance();
  const btn = $('#btnRefreshBal');
  if (btn) btn.disabled = true;
  try {
    state.balance = await api('/api/balance');
    if (state.balance.snapshots) setBalSnaps(state.balance.snapshots);   // كل قراءة ناجحة تُسجَّل لقطةً لليوم
  } catch (e) {
    state.balanceError = e.message;
  } finally {
    state.balanceLoading = false;
    if (btn) btn.disabled = false;
    state.balMap = computeBalanceMap();   // «الباقي» مثبّت على الرصيد، فتُعاد الخريطة قبل العرض
    renderBalance();
    renderTable();
  }
}
