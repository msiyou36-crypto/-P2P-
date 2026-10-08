/*
 * عميل Binance: التوقيع، بوّابة الحظر، حدود الوزن، وجلبُ السجلّات التي تُرجعها
 * المنصة ناقصةً إن سُئلت بسذاجة (طلبات P2P وعمليات Pay).
 *
 * ctx في الدوال أدناه = { base, offset, creds }:
 *   base   عنوان الخادم (https://api.binance.com …)
 *   offset فرق التوقيت مع المنصة بالمللي ثانية (من timeOffset)
 *   creds  { apiKey, apiSecret }
 */
'use strict';

const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayLabel = (ms) => new Date(ms).toISOString().slice(0, 10);

/** خطأ يُعرض نصّه للمستخدم كما هو (غيره يُعرض كخطأ داخلي) */
function userError(message) { const e = new Error(message); e.isUser = true; return e; }

/* ===== بوّابة الحظر =====
 * 429/418 معناهما: كفّ عن الطلب حتى ترفع المنصةُ الحظر عن العنوان. الاستمرار بعدهما
 * (ولو بطلب رصيدٍ عند فتح الصفحة، أو مزامنةٍ من مستخدمٍ آخر) يُطيل الحظر. فبعد أول
 * ردٍّ منهما يُغلق الخادمُ كلَّ طلبٍ إلى المنصة من كل المستخدمين حتى ينقضي Retry-After
 * (أو ٣٠ دقيقة لـ418 ودقيقتان لـ429 إن لم تُرسله). */
let blockedUntil = 0;
const banLeft = () => Math.max(0, blockedUntil - Date.now());
const banMessage = (left) => `المنصة حظرت هذا العنوان مؤقتًا — أُوقفت كل الطلبات إليها حتى ينقضي الحظر (بقي ${Math.ceil(left / 60000)} دقيقة)؛ التكرار يُطيله`;
function gateBinance() {
  const left = banLeft();
  if (left > 0) throw userError(banMessage(left));
}
function noteBan(r) {
  const ra = Number(r.headers.get('retry-after'));
  const secs = Number.isFinite(ra) && ra > 0 ? ra : (r.status === 418 ? 1800 : 120);
  blockedUntil = Math.max(blockedUntil, Date.now() + secs * 1000);
  console.error(`المنصة ردّت HTTP ${r.status} — أُغلقت الطلبات إلى المنصة ${Math.ceil(secs / 60)} دقيقة`);
}
const banHitText = (status) => 'المنصة حظرت الطلبات مؤقتًا بسبب كثرتها (HTTP ' + status + ') — أُوقفت كل الطلبات إليها تلقائيًا حتى ينقضي الحظر؛ لا تكرّر الضغط فالتكرار يُطيله';

/* ===== حدود الوزن =====
 * المنصة تُخبرنا في كل ردٍّ بما استُهلك من حدّ الدقيقة على الحساب (UID) وعلى العنوان
 * (IP). نقرأهما ونتمهّل قبل بلوغ أيّ الحدّين بدل أن نصطدم به فنُحظر. */
const UID_LIMIT = 180000;    // حدّ وزن الحساب في الدقيقة لنقاط sapi
const IP_LIMIT = 12000;      // حدّ وزن العنوان في الدقيقة لنقاط sapi (مشتركٌ مع كل ما على العنوان)
let lastUidWeight = 0;
let lastIpWeight = 0;

/** يتمهّل ٢٥ ثانية إن اقترب أحد الحدّين */
async function coolIfHeavy(cost) {
  const heavy = (lastUidWeight && lastUidWeight + cost > UID_LIMIT * 0.6) || (lastIpWeight && lastIpWeight > IP_LIMIT * 0.5);
  if (heavy) {
    await sleep(25000);
    lastUidWeight = 0;
    lastIpWeight = 0;
  }
}

/* ===== الطلبات ===== */

/** فرق التوقيت مع المنصة (يُضاف إلى timestamp كل طلب موقّع) */
async function timeOffset(base) {
  gateBinance();
  let r;
  try {
    r = await fetch(base + '/api/v3/time', { signal: AbortSignal.timeout(15000) });
  } catch {
    throw userError('تعذّر الاتصال بالمنصة — تحقّق من الإنترنت، أو جرّب تغيير عنوان الخادم من الإعدادات');
  }
  if (r.status === 451 || r.status === 403) {
    throw userError('الوصول إلى المنصة محجوب من هذه المنطقة (HTTP ' + r.status + ') — جرّب VPN أو غيّر عنوان الخادم من الإعدادات');
  }
  if (r.status === 429 || r.status === 418) { noteBan(r); throw userError(banHitText(r.status)); }
  if (!r.ok) throw userError('استجابة غير متوقعة من المنصة (HTTP ' + r.status + ')');
  const j = await r.json();
  return Number(j.serverTime) - Date.now();
}

/** طلب موقّع (HMAC-SHA256) بمفاتيح ctx.creds — GET افتراضًا وPOST لبعض نقاط الرصيد؛
 *  يُرجع JSON الردّ أو يرمي userError */
async function signedGet(ctx, endpoint, params, method = 'GET') {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set('recvWindow', '30000');
  qs.set('timestamp', String(Date.now() + ctx.offset));
  const signature = crypto.createHmac('sha256', ctx.creds.apiSecret).update(qs.toString()).digest('hex');
  const url = ctx.base + endpoint + '?' + qs.toString() + '&signature=' + signature;

  gateBinance();
  let r;
  try {
    r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': ctx.creds.apiKey }, signal: AbortSignal.timeout(30000) });
  } catch {
    throw userError('انقطع الاتصال أثناء الجلب — أعد المحاولة');
  }
  const uw = Number(r.headers.get('x-sapi-used-uid-weight-1m'));
  if (Number.isFinite(uw) && uw > 0) lastUidWeight = uw;
  const iw = Number(r.headers.get('x-sapi-used-ip-weight-1m'));
  if (Number.isFinite(iw) && iw > 0) lastIpWeight = iw;
  if (r.status === 429 || r.status === 418) noteBan(r);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    const code = j && typeof j.code === 'number' ? j.code : null;
    if (code === -2014 || code === -2015) throw userError('المنصة رفضت مفتاح API — تأكّد من صحة المفتاح ومن تفعيل صلاحية «إتاحة القراءة»');
    if (code === -1022) throw userError('التوقيع غير صحيح — تأكّد من المفتاح السري (Secret Key)');
    if (code === -1021) throw userError('فرق توقيت بين جهازك والمنصة — أعد المحاولة، وإن تكرر اضبط ساعة الجهاز');
    if (r.status === 429 || r.status === 418) throw userError(banHitText(r.status));
    if (r.status === 451 || r.status === 403) throw userError('الوصول محجوب من هذه المنطقة — جرّب VPN أو غيّر عنوان الخادم من الإعدادات');
    throw userError('خطأ من المنصة: ' + (j && (j.msg || j.message) ? (j.msg || j.message) : 'HTTP ' + r.status));
  }
  if (j && j.success === false) throw userError('خطأ من المنصة: ' + (j.message || j.code || 'غير معروف'));
  return j || {};
}

/** نوافذ زمنية بطول win تغطّي المدى [minStart, now]، الأحدث أولًا */
function makeWindows(now, minStart, win) {
  const windows = [];
  for (let end = now; end > minStart; end -= win) {
    windows.push([Math.max(end - win + 1, minStart), end]);
  }
  return windows;
}

/* ===== طلبات P2P: listUserOrderHistory =====
 * النقطة تُرجع صفحةً واحدة مبتورة: الوثائق تقول مئة صفٍّ، والواقع خمسون، والترقيم
 * بالصفحات لا يُعوَّل عليه (الصفحة التالية قد تُعيد الأولى أو تأتي فارغة). القاعدة:
 *   - سقفُ الصفحة يُتعلَّم: أكبرُ صفحةٍ رأيناها في العملية (يُشارَك في budget) هو السقف،
 *     وكلُّ صفحةٍ بلغته تُعامَل على أنها مبتورة.
 *   - بعد صفحةٍ ممتلئة نطلب التالية؛ فإن أتت بجديد واصلنا، وإن تكرّرت أو فرغت شطرنا
 *     النافذة نصفين وأعدنا السؤال — حتى تعود الصفحة ناقصةً فنعلم أننا استوعبنا النافذة.
 *   - مجموعُ المنصة (total) يُستأنس به لصفحةٍ أخرى بعد صفحةٍ قصيرة، ويُهمل إن كذب.
 *   - إن كانت الصفوف خارج الفترة المطلوبة فالمنصة تُهمل الفترة أصلًا (windowsIgnored)
 *     ونتوقف بدل أن نستهلك مئات الطلبات بلا طائل.
 * onRaw يُستدعى لكل طلبٍ مرّةً واحدة. budget = { left } (اختياري) رصيدُ طلباتٍ مشترك بين
 * كل النوافذ والأنواع في العملية الواحدة؛ الأنصافُ الأحدث تُفحص قبل الأقدم، فإن نفد الرصيد
 * ضاع القديم المحفوظ أصلًا لا الجديد. trace (اختياري) يسجّل كل طلبٍ للفحص. */
const C2C_MIN_WIN = 15 * 60000;
const C2C_MAX_CALLS = 400;
const C2C_MAX_PAGES = 60;        // للنافذة الواحدة
const C2C_GAP_MS = 600;          // مئةُ طلبٍ في الدقيقة سقفًا
const C2C_SLACK = 6 * 3600000;   // هامشٌ لو رتّبت المنصة بوقت الإكمال لا الإنشاء
const C2C_CAP_MIN = 20;          // قبل معرفة السقف: صفحةٌ بعشرين فأكثر قد تكون مبتورة

async function fetchC2C(ctx, tradeType, s, e, onRaw, budget, trace) {
  const stack = [[s, e]];
  const seen = new Set();
  let calls = 0, truncated = false, windowsIgnored = false, budgetOut = false;
  const st = budget || {};
  if (!(st.maxRows > 0)) st.maxRows = 0;
  const exhausted = () => calls >= C2C_MAX_CALLS || (budget && budget.left <= 0);
  while (stack.length) {
    if (exhausted()) { truncated = true; budgetOut = true; break; }
    const [ws, we] = stack.pop();
    const winIds = new Set();   // ما أعادته المنصة لهذه النافذة (للمقارنة بمجموعها)
    let page = 1, ended = false, prevFull = false;
    for (;;) {
      calls++;
      if (budget) budget.left--;
      await coolIfHeavy(1);
      const j = await signedGet(ctx, '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
        { tradeType, startTimestamp: ws, endTimestamp: we, page, rows: 100 });
      const rows = Array.isArray(j.data) ? j.data : [];
      const total = j.total != null && Number.isFinite(Number(j.total)) ? Number(j.total) : null;
      let fresh = 0, outside = 0;
      for (const raw of rows) {
        const t = Number(raw.createTime) || 0;
        if (t && (t < ws - C2C_SLACK || t > we + C2C_SLACK)) outside++;
        const id = String(raw.orderNumber || '');
        if (!id) continue;
        winIds.add(id);
        if (seen.has(id)) continue;
        seen.add(id); fresh++;
        onRaw(raw);
      }
      st.maxRows = Math.max(st.maxRows, rows.length);
      const cap = Math.max(C2C_CAP_MIN, st.maxRows);
      if (trace) trace.push({ type: tradeType, from: ws, to: we, page, rows: rows.length, cap, total, fresh, outside });
      if (rows.length >= 20 && outside * 2 > rows.length) { windowsIgnored = true; break; }
      if (rows.length < cap) {
        const wantMore = total != null && !st.totalUnreliable && total > winIds.size;
        if (wantMore && rows.length > 0 && (page === 1 || fresh > 0) && page < C2C_MAX_PAGES && !exhausted()) {
          prevFull = false; page++; await sleep(C2C_GAP_MS); continue;   // المجموع يعد بمزيد
        }
        if (prevFull) ended = rows.length > 0 && fresh > 0;   // بعد صفحةٍ ممتلئة: ناقصةٌ بجديد = نهاية، وإلا اشطر
        else { if (wantMore && page > 1 && fresh === 0) st.totalUnreliable = true; ended = true; }
        break;
      }
      prevFull = true;
      if (!fresh || page >= C2C_MAX_PAGES || exhausted()) break;   // صفحةٌ ممتلئة مكرّرة: اشطر النافذة
      page++;
      await sleep(C2C_GAP_MS);
    }
    if (windowsIgnored) { truncated = true; break; }
    if (!ended) {
      if (we - ws > C2C_MIN_WIN) { const mid = Math.floor((ws + we) / 2); stack.push([ws, mid], [mid + 1, we]); }
      else truncated = true;
    }
    await sleep(C2C_GAP_MS);
  }
  if (exhausted() && stack.length) { truncated = true; budgetOut = true; }
  return { count: seen.size, calls, truncated, windowsIgnored, budgetOut, cap: Math.max(C2C_CAP_MIN, st.maxRows) };
}

/** نصّ التحذير حين تعود نتيجة fetchC2C مبتورة */
const c2cWarn = (g) => (g.windowsIgnored
  ? `المنصة تُهمل الفترة المحدَّدة وتُرجع أحدث ${g.cap || 100} طلب فقط — لا تُجدي القسمة، فزامن قبل أن يتراكم أكثر من ذلك بين مزامنتين`
  : g.budgetOut
    ? 'نفد رصيد الطلبات لهذه العملية — الأحدثُ وصل والأقدمُ قد ينقص؛ قلّل مدى المزامنة في الإعدادات أو زامن مرةً أخرى لاحقًا'
    : `المنصة تُرجع ${g.cap || 100} صفًّا فقط في كل سؤال ولم تكفِ القسمة — قد تبقى طلبات لم تصل`);

/* ===== Binance Pay: /sapi/v1/pay/transactions =====
 * مئة سجلٍّ للطلب بلا ترقيم صفحات، فالشطرُ الزمني هو الوسيلة الوحيدة لتجاوزها:
 * نافذةٌ عادت ممتلئة تُشطر نصفين ويُعاد السؤال حتى تعود ناقصة. وزنُ النقطة على
 * الحساب ٣٠٠٠ (ستون طلبًا في الدقيقة سقفًا مطلقًا) فنمشي على ثلث الحدّ. */
const PAY_PAGE = 100;
const PAY_WEIGHT = 3000;
const PAY_GAP_MS = 3000;     // عشرون طلبًا في الدقيقة
const PAY_MAX_CALLS = 24;    // سقفٌ لكل نافذة

/** يجلب عمليات Pay في [ws, we]؛ onRaw لكل سجل. يُرجع { capped } */
async function fetchPay(ctx, ws, we, onRaw) {
  const parts = [[ws, we]];
  let calls = 0;
  while (parts.length && calls < PAY_MAX_CALLS) {
    const [s, e] = parts.pop();
    calls++;
    const j = await signedGet(ctx, '/sapi/v1/pay/transactions', { startTime: s, endTime: e, limit: PAY_PAGE });
    const rows = Array.isArray(j.data) ? j.data : [];
    for (const raw of rows) onRaw(raw);
    // نافذة دقيقة واحدة لا تُشطر أكثر
    if (rows.length >= PAY_PAGE && e - s > 60000) {
      const mid = Math.floor((s + e) / 2);
      parts.push([mid + 1, e], [s, mid]);
    }
    await sleep(PAY_GAP_MS);
    await coolIfHeavy(PAY_WEIGHT);
  }
  return { capped: parts.length > 0 };
}

module.exports = {
  sleep, dayLabel, userError,
  banLeft, banMessage,
  timeOffset, signedGet, coolIfHeavy, makeWindows,
  fetchC2C, c2cWarn, fetchPay,
};
