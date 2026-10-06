/*
 * توحيد ما تُرجعه المنصة (وما يأتي من الاستيراد) في شكلين ثابتين:
 *
 *   الطلب (P2P):  { orderNumber, tradeType: 'SELL'|'BUY', asset, fiat, fiatSymbol, amount,
 *                   takerAmount, totalPrice, unitPrice, commission, counterPart, orderStatus,
 *                   advertisementRole, createTime, note, reference, source }
 *   الحوالة:       { id, kind, coin, network, amount, fee, status, statusCode, address, txId,
 *                   time, completeTime, note, reference, source, ... حقول خاصة بالنوع }
 *
 * kind للحوالة: deposit | withdraw | pay-in | pay-out | convert-in | convert-out | spot-buy | spot-sell
 * source: 'binance' (من المنصة) | 'manual' (إضافة يدوية) | 'import' (ملف)
 * وتُضاف لاحقًا من المستخدم حقولُ التعليق: note, reference, unitPriceOverride, totalPriceOverride,
 * networkLabelOverride, zeroPoint, archived, usdtValue, balanceAt, balAfter (انظر ANNOT في server.js).
 */
'use strict';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/** المنصة تُرجع وقت السحب نصًّا بتوقيت UTC: "YYYY-MM-DD HH:MM:SS" */
function parseUTC(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

/* ---------- طلبات P2P ---------- */

function normalizeOrder(raw, source) {
  // العمولة الحقيقية = الفرق بين amount وtakerAmount؛ حقل commission يرجع «0» غالبًا
  const amt = num(raw.amount);
  const takerAmt = num(raw.takerAmount);
  const feeFromDiff = (takerAmt > 0 && Math.abs(amt - takerAmt) < amt * 0.05) ? Math.abs(amt - takerAmt) : 0;
  const o = {
    orderNumber: String(raw.orderNumber || '').trim(),
    tradeType: String(raw.tradeType).toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    asset: String(raw.asset || 'USDT').trim() || 'USDT',
    fiat: String(raw.fiat || '').trim(),
    fiatSymbol: String(raw.fiatSymbol || raw.fiat || '').trim(),
    amount: amt,
    takerAmount: takerAmt,
    totalPrice: num(raw.totalPrice),
    unitPrice: num(raw.unitPrice),
    commission: Math.max(num(raw.commission), feeFromDiff),
    counterPart: String(raw.counterPartNickName || raw.counterPart || '').trim(),
    orderStatus: String(raw.orderStatus || 'COMPLETED').toUpperCase(),
    advertisementRole: String(raw.advertisementRole || ''),
    createTime: Number(raw.createTime) || Date.now(),
    note: String(raw.note || ''),
    reference: String(raw.reference || ''),
    source,
  };
  if (!o.orderNumber) o.orderNumber = 'M' + o.createTime + Math.floor(Math.random() * 1000);
  if (!o.unitPrice && o.amount > 0) o.unitPrice = o.totalPrice / o.amount;
  if (!o.totalPrice && o.amount > 0 && o.unitPrice > 0) o.totalPrice = o.amount * o.unitPrice;
  return o;
}

/* ---------- الإيداع والسحب ---------- */

// إيداع: 0 قيد الانتظار، 1 ناجح، 6 مُضاف لا يُسحب، 7 خطأ، 8 بانتظار التأكيد
function depositStatusNorm(code) {
  if (code === 1) return 'COMPLETED';
  if (code === 7) return 'FAILED';
  return 'PENDING';
}
// سحب: 0 إرسال بريد، 1 ملغى، 2 بانتظار الموافقة، 3 مرفوض، 4 قيد المعالجة، 5 فشل، 6 مكتمل
function withdrawStatusNorm(code) {
  if (code === 6) return 'COMPLETED';
  if (code === 1) return 'CANCELLED';
  if (code === 3 || code === 5) return 'FAILED';
  return 'PENDING';
}

function normalizeTransfer(raw, kind) {
  const code = Number(raw.status);
  if (kind === 'deposit') {
    return {
      id: 'D' + String(raw.id || raw.txId || ('' + (raw.insertTime || '') + (raw.amount || ''))),
      kind: 'deposit',
      coin: String(raw.coin || 'USDT').trim() || 'USDT',
      network: String(raw.network || '').trim(),
      amount: num(raw.amount),
      fee: 0,
      status: depositStatusNorm(code),
      statusCode: Number.isFinite(code) ? code : null,
      address: String(raw.address || ''),
      txId: String(raw.txId || ''),
      time: Number(raw.insertTime) || Date.now(),
      completeTime: Number(raw.completeTime) || 0,
      walletType: raw.walletType,
      note: String(raw.note || ''),
      reference: String(raw.reference || ''),
      source: 'binance',
    };
  }
  return {
    id: 'W' + String(raw.id || raw.txId || ''),
    kind: 'withdraw',
    coin: String(raw.coin || 'USDT').trim() || 'USDT',
    network: String(raw.network || '').trim(),
    amount: num(raw.amount),
    fee: num(raw.transactionFee),
    status: withdrawStatusNorm(code),
    statusCode: Number.isFinite(code) ? code : null,
    address: String(raw.address || ''),
    txId: String(raw.txId || ''),
    time: parseUTC(raw.applyTime),
    completeTime: raw.completeTime ? parseUTC(raw.completeTime) : 0,
    walletType: raw.walletType,
    note: String(raw.note || ''),
    reference: String(raw.reference || ''),
    source: 'binance',
  };
}

/* ---------- Binance Pay ---------- */

// نوع المحفظة في Binance Pay: 1 تمويل، 2 فوري، 3 ورقية، 4/6 بطاقة، 5 Earn
const PAY_WALLET_AR = {
  1: 'محفظة التمويل (Funding)', 2: 'الحساب الفوري (Spot)', 3: 'محفظة العملة الورقية (Fiat)',
  4: 'بطاقة الدفع', 5: 'محفظة Earn', 6: 'بطاقة الدفع',
};

/** المبلغ الموجب = استلام (pay-in)، والسالب = إرسال (pay-out) */
function normalizePay(raw) {
  const amt = num(raw.amount);
  const isOut = amt < 0;
  const other = isOut ? (raw.receiverInfo || {}) : (raw.payerInfo || {});   // الطرف الآخر
  const tid = String(raw.transactionId || '').trim();
  const wt = Number(raw.walletType);
  return {
    id: 'PAY' + (tid || (raw.transactionTime || '') + '' + raw.amount),
    kind: isOut ? 'pay-out' : 'pay-in',
    coin: String(raw.currency || 'USDT').trim() || 'USDT',
    network: '',
    amount: Math.abs(amt),
    fee: 0,
    status: 'COMPLETED',   // النقطة تُرجع المكتمل فقط
    statusCode: null,
    address: '',
    txId: tid,
    counterPart: String(other.name || other.binanceId || other.accountId || '').trim(),
    orderType: String(raw.orderType || '').trim(),
    time: Number(raw.transactionTime) || Date.now(),
    completeTime: Number(raw.transactionTime) || 0,
    walletType: Number.isFinite(wt) ? wt : null,
    walletName: PAY_WALLET_AR[wt] || '',
    note: '',
    reference: '',
    source: 'binance',
  };
}

/* ---------- تداول السوق الفوري (نتتبّع جانب USDT فقط) ---------- */

function normalizeSpotTrade(raw, symbol) {
  const base = String(symbol).replace(/USDT$/i, '').toUpperCase();
  const isBuy = !!raw.isBuyer;   // شراء العملة الأساسية = صرف USDT
  const t = Number(raw.time) || Date.now();
  return {
    id: 'SPT' + String(symbol).toUpperCase() + '-' + String(raw.id),
    kind: isBuy ? 'spot-buy' : 'spot-sell',
    coin: 'USDT',
    network: base,   // العملة المقابلة تظهر في عمود العملة/الشبكة
    amount: num(raw.quoteQty),
    fee: String(raw.commissionAsset || '').toUpperCase() === 'USDT' ? num(raw.commission) : 0,
    status: 'COMPLETED',
    statusCode: null,
    address: '',
    txId: String(raw.orderId || raw.id || ''),
    counterPart: '',
    symbol: String(symbol).toUpperCase(),
    baseQty: num(raw.qty),
    unitPrice: num(raw.price),
    time: t,
    completeTime: t,
    note: '',
    reference: '',
    source: 'binance',
  };
}

/* ---------- التحويل بين العملات (Convert) ---------- */

/** USDT مصدرًا = convert-out، ووجهةً = convert-in؛ المبلغ المحفوظ هو قيمة USDT */
function normalizeConvert(raw) {
  const from = String(raw.fromAsset || '').trim().toUpperCase();
  const to = String(raw.toAsset || '').trim().toUpperCase();
  const fromAmt = num(raw.fromAmount);
  const toAmt = num(raw.toAmount);
  const usdtIsFrom = from === 'USDT';
  const usdtIsTo = to === 'USDT';
  const t = Number(raw.createTime) || Date.now();
  const other = usdtIsFrom ? to : from;
  return {
    id: 'CVT' + String(raw.orderId || raw.quoteId || (t + '' + fromAmt)),
    kind: usdtIsTo ? 'convert-in' : 'convert-out',
    coin: (usdtIsFrom || usdtIsTo) ? 'USDT' : from,
    network: (usdtIsFrom || usdtIsTo) ? other : to,
    amount: usdtIsTo ? toAmt : fromAmt,
    fee: 0,
    status: String(raw.orderStatus || '') === 'SUCCESS' ? 'COMPLETED' : 'PENDING',
    statusCode: null,
    address: '',
    txId: String(raw.orderId || ''),
    counterPart: '',
    fromAsset: from,
    fromAmount: fromAmt,
    toAsset: to,
    toAmount: toAmt,
    time: t,
    completeTime: t,
    note: '',
    reference: '',
    source: 'binance',
  };
}

/** مجموعة الحوالة (للفحص والاستعادة) */
const TX_GROUP = {
  deposit: 'deposit', withdraw: 'withdraw', 'pay-in': 'pay', 'pay-out': 'pay',
  'convert-in': 'convert', 'convert-out': 'convert', 'spot-buy': 'spot', 'spot-sell': 'spot',
};

/* ---------- ملف التصدير (Excel/CSV من النظام نفسه) → سجلّات ---------- */

const AR_TX_KIND = {
  'إيداع': 'deposit', 'سحب': 'withdraw', 'استلام Pay': 'pay-in', 'إرسال Pay': 'pay-out',
  'تحويل (→USDT)': 'convert-in', 'تحويل (USDT→)': 'convert-out', 'شراء فوري': 'spot-buy', 'بيع فوري': 'spot-sell',
};
const AR_STATUS = { 'مكتمل': 'COMPLETED', 'ملغى': 'CANCELLED', 'ملغي': 'CANCELLED', 'فشل': 'FAILED', 'مرفوض': 'FAILED' };

/** وقت التصدير "YYYY-MM-DD HH:MM[:SS]" بتوقيت الجهاز كما صُدِّر */
function parseExportTime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

/** صفوف ملف التصدير (كائنات بأحرف الأعمدة) → {orders, transfers, depwd}.
 *  الإيداع والسحب لا يُستعادان من الملف (معرّفهما الداخلي ليس فيه، والمنصة تُرجعهما كاملَين). */
function rowsToRecords(rows) {
  if (!rows.length) return { orders: [], transfers: [], depwd: 0 };
  const hdr = rows[0];
  const col = (names) => Object.keys(hdr).find((c) => names.some((n) => String(hdr[c] || '').trim().toLowerCase().startsWith(n.toLowerCase())));
  const C = {
    date: col(['التاريخ']), type: col(['النوع']), amount: col(['الكمية']), price: col(['السعر']), total: col(['المبلغ']),
    cur: col(['العملة']), party: col(['الطرف']), status: col(['الحالة']), fee: col(['العمولة']),
    ref: col(['الإشاري']), note: col(['الملاحظة']), id: col(['المعرّف', 'المعرف']),
  };
  if (!C.type || !C.id || !C.date) throw new Error('الملف ليس ملف تصدير من هذا النظام (الأعمدة غير معروفة)');
  const orders = [], transfers = [];
  let depwd = 0;
  for (const r of rows.slice(1)) {
    const type = String(r[C.type] || '').trim();
    const id = String(r[C.id] || '').trim();
    const time = parseExportTime(r[C.date]);
    if (!id || !time) continue;
    const status = AR_STATUS[String(r[C.status] || '').trim()] || 'COMPLETED';
    const g = (c) => (c ? String(r[c] || '').trim() : '');
    if (type === 'بيع' || type === 'شراء') {
      orders.push({
        orderNumber: id, tradeType: type === 'بيع' ? 'SELL' : 'BUY', amount: num(g(C.amount)), unitPrice: num(g(C.price)),
        totalPrice: num(g(C.total)), fiat: g(C.cur), counterPart: g(C.party), orderStatus: status, commission: num(g(C.fee)),
        createTime: time, note: g(C.note), reference: g(C.ref),
      });
      continue;
    }
    const kind = AR_TX_KIND[type];
    if (!kind) continue;
    if (kind === 'deposit' || kind === 'withdraw') { depwd++; continue; }
    const tid = kind.startsWith('pay') ? 'PAY' + id : kind.startsWith('convert') ? 'CVT' + id : id;
    transfers.push({
      id: tid, kind, coin: 'USDT', network: kind.startsWith('convert') ? g(C.cur) : '', amount: num(g(C.amount)), fee: num(g(C.fee)),
      status, statusCode: null, address: '', txId: id, counterPart: kind.startsWith('pay') ? g(C.party) : '',
      time, completeTime: time, note: g(C.note), reference: g(C.ref), source: 'import',
    });
  }
  return { orders, transfers, depwd };
}

module.exports = {
  num, normalizeOrder, normalizeTransfer, normalizePay, normalizeSpotTrade, normalizeConvert,
  TX_GROUP, rowsToRecords,
};
