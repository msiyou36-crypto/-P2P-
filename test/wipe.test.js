// تصفير السستم: في P3P وحده، وللمسؤول وحده، وبكتابة «حذف الكل». يُحذف كل ما في مخزن الحساب
// ومعه مفتاح المنصة، وتبقى كلمات السر وبقية الإعدادات — ولو أُعيد تشغيل الخادم.
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./helpers');

const NOW = Date.now();
const H = 3600000;
const ORDERS = [0, 1, 2].map((i) => T.rawOrder(i, NOW - (i + 1) * 2 * H));
const DEPOSITS = [{ id: 'dep1', txId: 'tx-dep-1', coin: 'USDT', network: 'TRX', amount: '500', status: 1, insertTime: NOW - 3 * H, address: 'TAddr' }];
const WORD = 'حذف الكل';
const NEW_ADMIN = 'newpass99';
// كل ما يكتبه السستم في مخزن الحساب (السلّة trash لا تُكتب إلا من أداة الفحص، فغيابها هنا مقصود)
const DATA_FILES = ['orders__p3p', 'transfers__p3p', 'gone__orders__p3p', 'balsnap__p3p', 'loginlog__p3p', 'syncusage__p3p'];

(async () => {
  const mock = await T.startMock({ orders: ORDERS, deposits: DEPOSITS });
  let srv = await T.startServer({ name: 'wipe', account: 'p3p' });
  const exists = (k) => fs.existsSync(path.join(srv.dir, k + '.json'));
  try {
    // ١) سستمٌ فيه بيانات: مزامنة (المستخدم ثم المسؤول)، إشاري، حذفٌ يُقبر، لقطة رصيد، سجل دخول
    const user = await T.login('user');
    const ru = await T.stream(user, '/api/sync', { kinds: ['deposit'] });
    T.check('المستخدم زامن الإيداع', ru.done && ru.done.depAdded === 1, ru.done || ru.error);
    let admin = await T.login('admin');
    let api = T.api(admin);
    const ra = await T.stream(admin, '/api/sync');
    T.check('المسؤول زامن الطلبات', ra.done && ra.done.added === 3, ra.done || ra.error);
    await api('/api/orders/annotate', { body: { id: 'ORD100001', reference: '#555', note: 'ملاحظة' } });
    await api('/api/orders?id=ORD100000', { method: 'DELETE' });
    T.check('الرصيد يُقرأ قبل التصفير', (await api('/api/balance')).status === 200);
    T.check('تغيير كلمة سر المسؤول', (await api('/api/auth/password', { body: { adminPassword: NEW_ADMIN } })).status === 200);
    T.check('كل ملفات البيانات موجودة قبل التصفير', DATA_FILES.every(exists), DATA_FILES.filter((k) => !exists(k)));

    // ٢) من لا يحقّ له، أو بلا كلمة التأكيد: لا شيء يُحذف
    const user2 = await T.login('user2');
    T.check('المستخدم لا يصفّر', (await T.api(user)('/api/system/wipe', { body: { confirm: WORD } })).status === 403);
    T.check('مستخدم 2 لا يصفّر', (await T.api(user2)('/api/system/wipe', { body: { confirm: WORD } })).status === 403);
    T.check('بلا كلمة التأكيد: 400', (await api('/api/system/wipe', { body: {} })).status === 400);
    T.check('بكلمةٍ خاطئة: 400', (await api('/api/system/wipe', { body: { confirm: 'حذف' } })).status === 400);
    T.check('البيانات باقية بعد المحاولات المرفوضة', (await api('/api/orders')).json.orders.length === 2 && DATA_FILES.every(exists));

    // ٣) التصفير
    const w = await api('/api/system/wipe', { body: { confirm: WORD } });
    T.check('المسؤول يصفّر بكتابة «حذف الكل»', w.status === 200 && w.json.ok, w);
    T.check('لا طلبات', (await api('/api/orders')).json.orders.length === 0);
    T.check('لا إيداع ولا سحب', (await api('/api/transfers')).json.transfers.length === 0);
    T.check('حُذفت كل ملفات البيانات', DATA_FILES.every((k) => !exists(k)), DATA_FILES.filter(exists));
    T.check('سجل الدخول فارغ', (await api('/api/auth/log')).json.events.length === 0);
    T.check('لا لقطات رصيد', Object.keys((await api('/api/balance/snapshots')).json.snapshots).length === 0);
    const st = (await api('/api/settings')).json;
    T.check('حُذف مفتاح Binance', st.apiKeyMasked === '' && st.hasSecret === false, st);
    T.check('صُفّر وقت آخر مزامنة', st.lastSync == null && Object.values(st.lastSyncBy).every((v) => v == null), st);
    T.check('بقي مدى الجلب وعدد المزامنات', st.rangeHours === 72 && st.syncQuota === 3, st);
    T.check('الرصيد يطلب مفتاحًا', (await api('/api/balance')).status === 400);
    const rs = await T.stream(admin, '/api/sync');
    T.check('المزامنة لا تعمل بلا مفتاح', rs.status === 400 && !(await api('/api/orders')).json.orders.length, rs);
    T.check('الجلسة باقية بعد التصفير', (await api('/api/account')).status === 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(srv.dir, 'config__p3p.json'), 'utf8'));
    T.check('كلمات السر محفوظة في الإعدادات', !!(cfg.auth.admin.hash && cfg.auth.user.hash && cfg.auth.user2.hash) && cfg.accounts.p3p.apiKey === '' && cfg.accounts.p3p.apiSecret === '');

    // ٤) بعد إعادة التشغيل: يبقى فارغًا، وكلمات السر هي المحفوظة لا كلمات البيئة
    await srv.stop();
    srv = await T.startServer({ dir: srv.dir, keepConfig: true, account: 'p3p' });
    const status = await (await fetch('http://127.0.0.1:' + (Number(process.env.TEST_PORT) || 3145) + '/api/auth/status')).json();
    T.check('لا يرجع لشاشة الإعداد الأولى', status.configured === true && status.hasUser && status.hasUser2, status);
    let oldOk = true;
    try { await T.login('admin'); } catch { oldOk = false; }
    T.check('كلمة سر البيئة القديمة لا تعمل', !oldOk);
    admin = await T.login('admin', NEW_ADMIN);
    api = T.api(admin);
    T.check('كلمة السر الجديدة تعمل بعد التصفير وإعادة التشغيل', !!admin);
    T.check('المستخدمان يدخلان', !!(await T.login('user')) && !!(await T.login('user2')));
    T.check('ما زال فارغًا بلا مفتاح', (await api('/api/orders')).json.orders.length === 0 && (await api('/api/settings')).json.apiKeyMasked === '');
    await srv.stop();

    // ٥) سستم P2P: الأمر مرفوض ولا يمسّ شيئًا
    srv = await T.startServer({ name: 'wipe-p2p', account: 'p2p' });
    const p2p = T.api(await T.login('admin'));
    const r2 = await p2p('/api/system/wipe', { body: { confirm: WORD } });
    T.check('P2P: التصفير مرفوض', r2.status === 403, r2);
    T.check('P2P: المفتاح باقٍ', (await p2p('/api/settings')).json.apiKeyMasked !== '');
  } finally {
    await srv.stop();
    await mock.close();
  }
  T.finish();
})().catch((e) => { console.error(e); process.exit(1); });
