// المزامنة الانتقائية: كل نوعٍ يُجلب وحده من نقطته وحدها ويُختم وقتُه وحده؛ وما يُجلب
// لاحقًا يُحفظ بوقته في المنصة (فيقع في مكانه من الجدول)؛ وبلا اختيار = الكل.
'use strict';
const T = require('./helpers');

const NOW = Date.now();
const H = 3600000;
// طلبات عند −٢ و−٤ و−٦ ساعات، والإيداع عند −٣ ساعات: يقع بين الأول والثاني زمنًا
const ORDERS = [0, 1, 2].map((i) => T.rawOrder(i, NOW - (i + 1) * 2 * H));
const DEPOSITS = [{ id: 'dep1', txId: 'tx-dep-1', coin: 'USDT', network: 'TRX', amount: '500', status: 1, insertTime: NOW - 3 * H, address: 'TAddr' }];
const WITHDRAWS = [{ id: 'wd1', txId: 'tx-wd-1', coin: 'USDT', network: 'TRX', amount: '120', transactionFee: '1', status: 6, applyTime: new Date(NOW - 5 * H).toISOString().slice(0, 19).replace('T', ' ') }];
const PAYS = [{ transactionId: 'pay1', amount: '-25', currency: 'USDT', transactionTime: NOW - 7 * H, walletType: 1, receiverInfo: { name: 'Friend' } }];
const CONVERTS = [{ orderId: 'cvt1', fromAsset: 'USDT', toAsset: 'TRX', fromAmount: '30', toAmount: '240', orderStatus: 'SUCCESS', createTime: NOW - 8 * H }];

(async () => {
  const mock = await T.startMock({ orders: ORDERS, deposits: DEPOSITS, withdraws: WITHDRAWS, pays: PAYS, converts: CONVERTS });
  const srv = await T.startServer({ name: 'kinds' });
  try {
    const token = await T.login('admin');
    const api = T.api(token);
    /** ما طلبه الخادم من المنصة منذ اللقطة السابقة */
    let last = await mock.hits();
    const newHits = async () => {
      const h = await mock.hits();
      const d = {};
      for (const [k, v] of Object.entries(h.hits)) if (k !== '/__hits' && v - (last.hits[k] || 0) > 0) d[k] = v - (last.hits[k] || 0);
      last = h;
      return Object.keys(d).sort();
    };

    // ١) الإيداع وحده
    const r1 = await T.stream(token, '/api/sync', { kinds: ['deposit'] });
    let hits = await newHits();
    T.check('الإيداع وحده: لا يسأل المنصة إلا عن التوقيت والإيداع', hits.join() === '/api/v3/time,/sapi/v1/capital/deposit/hisrec', hits);
    T.check('الإيداع وحده: أُضيف الإيداع ولم يُضف طلب', r1.done && r1.done.depAdded === 1 && r1.done.added === 0 && r1.done.kinds.join() === 'deposit', r1.done || r1.error);
    let st = (await api('/api/settings')).json;
    T.check('يُختم وقت الإيداع وحده', st.lastSyncBy.deposit > NOW - 60000 && st.lastSyncBy.p2p == null && st.lastSyncBy.pay == null, st.lastSyncBy);
    const depAt = st.lastSyncBy.deposit;

    // ٢) طلبات P2P وحدها بعده
    const r2 = await T.stream(token, '/api/sync', { kinds: ['p2p'] });
    hits = await newHits();
    T.check('P2P وحده: التوقيت وطلبات P2P فقط', hits.join() === '/api/v3/time,/sapi/v1/c2c/orderMatch/listUserOrderHistory', hits);
    T.check('P2P وحده: أُضيفت الطلبات الثلاثة', r2.done && r2.done.added === 3 && r2.done.depAdded === 0, r2.done || r2.error);
    st = (await api('/api/settings')).json;
    T.check('وقت P2P يُختم ووقت الإيداع يبقى كما هو', st.lastSyncBy.p2p >= depAt && st.lastSyncBy.deposit === depAt && st.lastSyncBy.withdraw == null, st.lastSyncBy);

    // ٣) ما جُلب أولًا لا يتقدّم: كل سجلٍّ بوقته في المنصة، فالإيداع يقع بين الطلبات
    const orders = (await api('/api/orders')).json.orders;
    const transfers = (await api('/api/transfers')).json.transfers;
    const timeline = [...orders.map((o) => ({ id: o.orderNumber, t: o.createTime })), ...transfers.map((x) => ({ id: x.id, t: x.time }))]
      .sort((a, b) => b.t - a.t).map((x) => x.id);
    T.check('الإيداع المجلوب أولًا يقع في مكانه بتاريخه بين الطلبات', timeline.join() === 'ORD100000,Ddep1,ORD100001,ORD100002', timeline);

    // ٤) نوعان معًا
    const r3 = await T.stream(token, '/api/sync', { kinds: ['convert', 'pay'] });
    hits = await newHits();
    T.check('Pay والتحويل معًا: نقطتاهما فقط', hits.join() === '/api/v3/time,/sapi/v1/convert/tradeFlow,/sapi/v1/pay/transactions', hits);
    T.check('Pay والتحويل: الأنواع بترتيبها الثابت', r3.done && r3.done.kinds.join() === 'pay,convert' && r3.done.payAdded === 1 && r3.done.cvtAdded === 1, r3.done || r3.error);

    // ٥) بلا قائمة = الكل (كما كانت المزامنة قبل الاختيار)
    const r4 = await T.stream(token, '/api/sync');
    hits = await newHits();
    T.check('بلا قائمة: كل الأنواع', r4.done && r4.done.kinds.join() === 'p2p,deposit,withdraw,pay,convert,spot' && r4.done.wdAdded === 1, r4.done || r4.error);
    T.check('بلا قائمة: يسأل كل النقاط', ['/sapi/v1/capital/withdraw/history', '/api/v3/myTrades', '/sapi/v1/c2c/orderMatch/listUserOrderHistory'].every((p) => hits.includes(p)), hits);
    st = (await api('/api/settings')).json;
    T.check('بعد الكل: كل الأنواع مختومة', Object.values(st.lastSyncBy).every((v) => v > NOW - 120000), st.lastSyncBy);

    // ٦) قائمة فارغة أو أنواع مجهولة تُرفض قبل الخصم من حصّة المستخدم
    const utok = await T.login('user');
    const e1 = await T.stream(utok, '/api/sync', { kinds: [] });
    T.check('قائمة فارغة تُرفض (400)', e1.status === 400 && /نوعًا واحدًا/.test(e1.error || ''), e1);
    const e2 = await T.stream(utok, '/api/sync', { kinds: ['bogus'] });
    T.check('نوعٌ مجهول يُرفض (400)', e2.status === 400, e2);
    const q = (await T.api(utok)('/api/sync/quota')).json;
    T.check('الرفض لا يُخصم من الحصّة', q.used === 0, q);
    T.check('ولا يصل المنصة', (await newHits()).length === 0);

    // ٧) سجل الدخول يقول ما زُومِن
    const syncs = (await api('/api/auth/log')).json.events.filter((e) => e.kind === 'sync');
    T.check('سجل الدخول يقيّد الأنواع المختارة، والكل بلا قائمة', syncs.length === 4 && syncs.some((e) => (e.kinds || []).join() === 'deposit') && syncs.some((e) => !e.kinds), syncs);
  } finally {
    await srv.stop();
    await mock.close();
  }
  T.finish();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
