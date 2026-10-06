// الخادم من طرفٍ إلى طرف كما تكلّمه الواجهة: الدخول والصلاحيات، الطلبات والتعليقات،
// الاستيراد، الحذف والمقابر (تبقى بعد إعادة التشغيل)، المزامنة والحصّة، تثبيت «الباقي»،
// الأرشفة، جلب يوم، فحص الدخيل وسلّة المحذوف، الاستعادة من ملف، الصيانة، سجل الدخول.
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./helpers');

const NOW = Date.now();
const H = 3600000;
const ORDERS = [0, 1, 2, 3, 4].map((i) => T.rawOrder(i, NOW - (i + 1) * H));
const DEPOSITS = [{ id: 'dep1', txId: 'tx-dep-1', coin: 'USDT', network: 'TRX', amount: '500', status: 1, insertTime: NOW - 5 * H, address: 'TAddr' }];
const WITHDRAWS = [{ id: 'wd1', txId: 'tx-wd-1', coin: 'USDT', network: 'TRX', amount: '120', transactionFee: '1', status: 6, applyTime: new Date(NOW - 6 * H).toISOString().slice(0, 19).replace('T', ' '), address: 'TAddr2' }];
const PAYS = [{ transactionId: 'pay1', amount: '-25', currency: 'USDT', transactionTime: NOW - 7 * H, walletType: 1, receiverInfo: { name: 'Friend' } }];
const CONVERTS = [{ orderId: 'cvt1', fromAsset: 'USDT', toAsset: 'TRX', fromAmount: '30', toAmount: '240', orderStatus: 'SUCCESS', createTime: NOW - 8 * H }];

(async () => {
  const mock = await T.startMock({ orders: ORDERS, deposits: DEPOSITS, withdraws: WITHDRAWS, pays: PAYS, converts: CONVERTS });
  let srv = await T.startServer({ name: 'core' });
  try {
    /* ---- الدخول والصلاحيات ---- */
    const status = (await T.api()('/api/auth/status')).json;
    T.check('الحالة: مضبوطٌ من البيئة ويُعلن الحساب المقفول', status.configured && status.hasUser && status.hasUser2 && status.account && status.account.id === 'p2p', status);
    let bad = null;
    try { await T.login('admin', 'wrong'); } catch (e) { bad = e.message; }
    T.check('كلمة سر خاطئة تُرفض', /غير صحيحة/.test(bad || ''), bad);
    const admin = T.api(await T.login('admin'));
    const user = T.api(await T.login('user'));
    const user2 = T.api(await T.login('user2'));
    T.check('بلا دخول: الطلبات ممنوعة (401)', (await T.api()('/api/orders')).status === 401);
    T.check('مستخدم: يقرأ الطلبات', (await user('/api/orders')).status === 200);
    T.check('مستخدم: لا يضيف طلبًا (403)', (await user('/api/orders', { body: { amount: 1, totalPrice: 1 } })).status === 403);
    T.check('مستخدم: لا يعلّق (403)', (await user('/api/orders/annotate', { body: { id: 'x' } })).status === 403);

    /* ---- طلبات: إضافة يدوية، تعليق، استيراد ---- */
    const add = (await admin('/api/orders', { body: { tradeType: 'SELL', amount: 50, unitPrice: 8000, totalPrice: 400000, fiat: 'SDG', counterPart: 'Manual', orderNumber: 'MAN1', createTime: NOW - 10 * H } })).json;
    T.check('إضافة يدوية', add.result === 'added' && add.order.source === 'manual', add);
    const an = (await user2('/api/orders/annotate', { body: { id: 'MAN1', note: 'ملاحظة', reference: '#1', unitPrice: '8100', balanceAt: 999 } })).json;
    T.check('مستخدم 2: يكتب الملاحظة والإشاري والسعر، ولا يمسّ المرساة', an.order.note === 'ملاحظة' && an.order.reference === '#1' && an.order.unitPriceOverride === 8100 && an.order.balanceAt == null, an.order);
    const an2 = (await admin('/api/orders/annotate', { body: { id: 'MAN1', balanceAt: 999, archived: true } })).json;
    T.check('المسؤول: يضع المرساة والأرشفة', an2.order.balanceAt === 999 && an2.order.archived === true, an2.order);
    await admin('/api/orders/annotate', { body: { id: 'MAN1', archived: false } });
    const bulk = (await admin('/api/orders/bulk', { body: { orders: [
      { orderNumber: 'MAN1', tradeType: 'SELL', amount: 50, unitPrice: 8000, totalPrice: 400000, fiat: 'ج.س', orderStatus: 'COMPLETED', createTime: NOW - 10 * H },
      { orderNumber: 'IMP1', tradeType: 'BUY', amount: 20, unitPrice: 8000, totalPrice: 160000, fiat: 'ج.س', orderStatus: 'TRADING', createTime: NOW - 11 * H },
      { orderNumber: 'BAD', tradeType: 'BUY', amount: 0, totalPrice: 0 },
    ] } })).json;
    T.check('الاستيراد: جديدٌ ومحدَّث ومتجاهَل', bulk.added === 1 && bulk.updated === 1 && bulk.skipped === 1, bulk);
    let list = (await admin('/api/orders')).json.orders;
    const man1 = list.find((o) => o.orderNumber === 'MAN1');
    T.check('الاستيراد يحفظ تعليقات الصفّ الموجود', man1 && man1.note === 'ملاحظة' && man1.reference === '#1' && man1.unitPriceOverride === 8100 && man1.balanceAt === 999, man1);
    const bulk2 = (await admin('/api/orders/bulk', { body: { orders: [{ orderNumber: 'IMP1', tradeType: 'BUY', amount: 20, unitPrice: 8000, totalPrice: 160000, fiat: 'ج.س', orderStatus: 'COMPLETED', createTime: NOW - 11 * H }] } })).json;
    list = (await admin('/api/orders')).json.orders;
    T.check('الاستيراد يحدّث حالة طلبٍ معلّق إلى مكتمل', bulk2.updated === 1 && list.find((o) => o.orderNumber === 'IMP1').orderStatus === 'COMPLETED', bulk2);

    /* ---- المزامنة ---- */
    const sy = await T.stream((await T.login('admin')), '/api/sync');
    T.check('المزامنة: الطلبات والحوالات بكل أنواعها', sy.done && sy.done.added === 5 && sy.done.depAdded === 1 && sy.done.wdAdded === 1 && sy.done.payAdded === 1 && sy.done.cvtAdded === 1 && !sy.error, sy.done || sy.error);
    const tx = (await admin('/api/transfers')).json.transfers;
    T.check('الحوالات موحّدة الشكل', tx.length === 4 && tx.every((t) => t.id && t.kind && t.status && t.time) && tx.find((t) => t.kind === 'withdraw').fee === 1 && tx.find((t) => t.kind === 'pay-out').counterPart === 'Friend', tx);
    T.check('آخر مزامنة سُجّلت', (await admin('/api/settings')).json.lastSync > NOW - 60000);
    const utok = await T.login('user');
    const us = await T.stream(utok, '/api/sync');
    const q = (await T.api(utok)('/api/sync/quota')).json;
    T.check('مستخدم: المزامنة تُخصم من حصّته', us.done && q.quota === 3 && q.used === 1 && q.left === 2, q);
    await admin('/api/settings', { body: { syncQuota: 0 } });
    const us2 = await T.stream(utok, '/api/sync');
    T.check('حصّة صفر: المزامنة ممنوعة على المستخدم (429)', us2.status === 429 && /غير مسموحة/.test(us2.error || ''), us2);
    await admin('/api/settings', { body: { syncQuota: 3, rangeHours: 24 } });
    const st = (await admin('/api/settings')).json;
    T.check('الإعدادات: المفتاح مُقنَّع والمدى محفوظ', /…/.test(st.apiKeyMasked) && st.hasSecret && st.rangeHours === 24 && st.syncQuota === 3, st);

    /* ---- الرصيد واللقطات ---- */
    const bal = (await user('/api/balance')).json;
    const today = Object.keys(bal.snapshots || {}).length;
    T.check('الرصيد: الفوري + التمويل معًا مع لقطة اليوم', bal.usdtFunding === 60 && bal.usdtSpot === 40 && bal.assets.find((a) => a.asset === 'USDT').free === 100 && today >= 1, bal);

    /* ---- تثبيت «الباقي» ---- */
    const f1 = (await user('/api/balance/freeze', { body: { orders: { ORD100000: 123.456 }, transfers: { Ddep1: 50 } } })).json;
    const f2 = (await user('/api/balance/freeze', { body: { orders: { ORD100000: 999 } } })).json;
    const frozen = (await admin('/api/orders')).json.orders.find((o) => o.orderNumber === 'ORD100000');
    T.check('التثبيت: أول قيمة نهائية ولا تُكتب فوقها', f1.frozen === 2 && f2.frozen === 0 && frozen.balAfter === 123.456, { f1, f2, bal: frozen.balAfter });
    const uf = (await admin('/api/balance/unfreeze', { method: 'POST' })).json;
    T.check('إلغاء التثبيت يمسح الكل', uf.cleared === 2, uf);

    /* ---- الحذف والمقابر: المحذوف لا يعود بعد إعادة التشغيل ---- */
    const del = (await admin('/api/orders?id=ORD100004', { method: 'DELETE' })).json;
    T.check('حذف طلب', del.ok === true, del);
    await srv.stop();
    srv = await T.startServer({ name: 'core', dir: srv.dir, keepConfig: true });
    const admin2 = T.api(await T.login('admin'));
    const after = (await admin2('/api/orders')).json.orders;
    T.check('بعد إعادة التشغيل: المحذوف مقبور والباقي محفوظ', !after.find((o) => o.orderNumber === 'ORD100004') && after.length === 6, after.map((o) => o.orderNumber));
    const grave = JSON.parse(fs.readFileSync(path.join(srv.dir, 'gone__orders__p2p.json'), 'utf8'));
    T.check('المقبرة تحوي المعرّف', grave.includes('ORD100004'), grave);
    // المنصة أرجعته من جديد → الدليل الطازج يُخرجه من المقبرة
    const sy2 = await T.stream((await T.login('admin')), '/api/sync');
    const back = (await admin2('/api/orders')).json.orders.find((o) => o.orderNumber === 'ORD100004');
    T.check('ما أرجعته المنصة يخرج من المقبرة', sy2.done && !!back, sy2.done);

    /* ---- جلب يوم ---- */
    const day = new Date(ORDERS[2].createTime);   // يومُ الطلب الثالث (بتوقيت UTC: اليوم المحاسبي يبدأ منتصف ليل UTC)
    const dayStr = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
    const dy = (await admin2('/api/sync/day', { body: { day: dayStr } })).json;
    T.check('جلب يوم: يسأل عن كل الأنواع ويُبلّغ بالمحفوظ', dy.ok && dy.found && dy.found.p2p >= 1 && dy.stored >= 1, dy);
    T.check('جلب يوم: صيغة خاطئة تُرفض', (await admin2('/api/sync/day', { body: { day: 'x' } })).status === 400);

    /* ---- فحص الدخيل وسلّة المحذوف ---- */
    await admin2('/api/orders', { body: { tradeType: 'SELL', amount: 5, unitPrice: 8000, totalPrice: 40000, fiat: 'SDG', orderNumber: 'ALIEN', createTime: NOW - 30 * 60000 } });
    const sc = await T.stream((await T.login('admin')), '/api/diag/foreign-ops', { days: 3 });
    T.check('الفحص: ما لم تُرجعه المنصة يُعرض، وما أرجعته لا', sc.done && sc.done.orders.map((o) => o.id).sort().join() === 'ALIEN,IMP1,MAN1' && sc.done.fetched.orders === 5 && sc.done.calls.length >= 2, sc.done && sc.done.orders);
    const fd = (await admin2('/api/diag/foreign-ops/delete', { body: { orders: ['ALIEN'] } })).json;
    T.check('حذف المحدَّد من الفحص', fd.deleted === 1 && !(await admin2('/api/orders')).json.orders.find((o) => o.orderNumber === 'ALIEN'), fd);
    const un = (await admin2('/api/diag/foreign-ops/undo', { method: 'POST' })).json;
    T.check('استرجاع آخر حذف', un.restored === 1 && !!(await admin2('/api/orders')).json.orders.find((o) => o.orderNumber === 'ALIEN'), un);

    /* ---- الأرشفة بتاريخ ---- */
    const ar = (await admin2('/api/archive/before', { body: { before: NOW - 9 * H } })).json;
    const arch = (await admin2('/api/orders')).json.orders.filter((o) => o.archived).map((o) => o.orderNumber).sort();
    T.check('أرشفة كل ما قبل تاريخ (طلبات وحوالات)', ar.orders === 2 && ar.transfers === 0 && arch.join() === 'IMP1,MAN1', { ar, arch });
    const ar2 = (await admin2('/api/archive/before', { body: { before: NOW - 9 * H, undo: true } })).json;
    T.check('إرجاع من الأرشيف', ar2.orders === 2 && !(await admin2('/api/orders')).json.orders.some((o) => o.archived), ar2);

    /* ---- الاستعادة من ملف تصدير ---- */
    await admin2('/api/orders?id=MAN1', { method: 'DELETE' });
    const csv = '﻿التاريخ,النوع,الكمية USDT,السعر,المبلغ,العملة/الشبكة,الطرف الآخر,الحالة,العمولة/الرسوم,الإشاري,الملاحظة,المعرّف\n'
      + '2026-10-05 12:28:35,بيع,260.21,8460,2200950,ج.س,Rania76,مكتمل,0,,,MAN1\n'
      + '2026-10-05 12:30:00,استلام Pay,10,,,USDT,Someone,مكتمل,0,,,paynew\n'
      + '2026-10-05 12:31:00,إيداع,10,,,TRX,,مكتمل,0,,,ignored\n';
    const pv = (await admin2('/api/restore/preview', { raw: csv })).json;
    T.check('معاينة الاستعادة: يعرض الناقص فقط', pv.missingOrders.length === 1 && pv.missingOrders[0].orderNumber === 'MAN1' && pv.missingTransfers.length === 1 && pv.inFile.depwd === 1, pv);
    const ap = (await admin2('/api/restore/apply', { body: { orders: pv.missingOrders, transfers: pv.missingTransfers } })).json;
    await srv.stop();
    srv = await T.startServer({ name: 'core', dir: srv.dir, keepConfig: true });
    const admin3 = T.api(await T.login('admin'));
    const restored = (await admin3('/api/orders')).json.orders.find((o) => o.orderNumber === 'MAN1');
    T.check('الاستعادة تُخرج الصفّ من المقبرة ويبقى بعد إعادة التشغيل', ap.restored === 2 && restored && restored.source === 'import', ap);

    /* ---- الصيانة وسجل الدخول وهوية المفتاح ---- */
    await admin3('/api/maintenance', { body: { on: true, message: 'صيانة', link: 'https://example.com' } });
    const m = (await T.api()('/api/maintenance')).json;
    T.check('وضع الصيانة يُقرأ بلا دخول', m.on === true && m.message === 'صيانة' && /127\.0\.0\.1/.test(m.system), m);
    await admin3('/api/maintenance', { body: { on: false } });
    const who = (await admin3('/api/diag/whoami')).json;
    T.check('هوية المفتاح (UID)', who.uid === '582097756' && who.accountName === 'حوالات P2P', who);
    const log = (await admin3('/api/auth/log')).json.events;
    T.check('سجل الدخول: دخولٌ ومزامنةٌ وفحصٌ وجلبُ يوم', log.some((e) => !e.kind && e.role === 'user2') && log.some((e) => e.kind === 'sync' && e.role === 'user') && log.some((e) => e.kind === 'scan') && log.some((e) => e.kind === 'day'), log.map((e) => e.role + ':' + (e.kind || 'login')));

    /* ---- بيانات الحساب الآخر في قاعدة هذا السستم ---- */
    fs.writeFileSync(path.join(srv.dir, 'orders__p3p.json'), JSON.stringify({ X1: { orderNumber: 'X1' } }));
    const fg = (await admin3('/api/system/foreign')).json;
    T.check('مفاتيح الحساب الآخر تُعرض', fg.count === 1 && fg.items[0].key === 'orders__p3p' && fg.items[0].rows === 1 && fg.otherName === 'حوالات P3P', fg);
    const fdel = (await admin3('/api/system/foreign', { method: 'DELETE' })).json;
    T.check('وتُحذف بأمر صريح', fdel.deleted === 1 && !fs.existsSync(path.join(srv.dir, 'orders__p3p.json')), fdel);
  } finally {
    await srv.stop();
    await mock.close();
  }
  T.finish();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
