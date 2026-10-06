// بوّابة الحظر: بعد أول 429/418 من المنصة يُغلق الخادم كلَّ طلبٍ إليها حتى ينقضي Retry-After —
// لا رصيدَ عند فتح الصفحة، ولا مزامنةً من مستخدمٍ آخر، ولا فحصًا — فلا يُطيل أحدٌ الحظر.
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./helpers');

const T0 = Date.now() - 2 * 86400000;
const ORDERS = [];
for (let i = 0; i < 150; i++) ORDERS.push(T.rawOrder(i, T0 + i * 600000));

async function runMode(mode) {
  // الطلب الثالث لطلبات P2P يعود محظورًا: 429 مع Retry-After دقيقتان، أو 418 بلا ترويسة (نصف ساعة افتراضًا)
  const onC2C = (n) => (n === 3 ? { status: mode === '429' ? 429 : 418, headers: mode === '429' ? { 'Retry-After': '120' } : {}, body: { code: -1003, msg: 'Too many requests' } } : null);
  const mock = await T.startMock({ orders: ORDERS, page: 100, mode: 'C', onC2C });
  const srv = await T.startServer({ name: 'ban' });
  try {
    const token = await T.login('admin');
    const api = T.api(token);

    // ١) المزامنة تصطدم بالحظر عند الطلب الثالث وتتوقف فورًا
    const r = await T.stream(token, '/api/sync');
    T.check(`${mode}: المزامنة تتوقف بخطأ حظر`, r.error && /حظر/.test(r.error), r.lines.slice(-2));
    const h1 = await mock.hits();
    T.check(`${mode}: ثلاثة طلبات P2P فقط وصلت المنصة`, h1.c2cCalls === 3, h1.hits);
    const o = JSON.parse(fs.readFileSync(path.join(srv.dir, 'orders__p2p.json'), 'utf8'));
    T.check(`${mode}: ما وصل قبل الحظر محفوظ`, Object.keys(o).filter((k) => k.startsWith('ORD')).length >= 100, Object.keys(o).length);

    // ٢) كل ما بعده مغلق على الخادم — بلا طلبٍ واحد جديد إلى المنصة
    const bal = (await api('/api/balance')).json;
    T.check(`${mode}: الرصيد يُرفض من البوّابة مع المدة الباقية`, bal.error && /بقي \d+ دقيقة/.test(bal.error), bal);
    const who = (await api('/api/diag/whoami')).json;
    T.check(`${mode}: whoami يُرفض`, who.error && /بقي/.test(who.error), who);
    const r2 = await api('/api/sync', { method: 'POST' });
    T.check(`${mode}: مزامنة ثانية تُرفض قبل أن تبدأ (429)`, r2.status === 429 && /بقي/.test(r2.json.error || ''), r2);
    const sc = await T.stream(token, '/api/diag/foreign-ops', { days: 3 });
    T.check(`${mode}: الفحص يُرفض`, /بقي/.test(sc.error || ''), sc.lines.slice(-1));
    const dy = (await api('/api/sync/day', { body: { day: new Date().toISOString().slice(0, 10) } })).json;
    T.check(`${mode}: جلب يوم يُرفض`, dy.error && /بقي/.test(dy.error), dy);
    const h2 = await mock.hits();
    T.check(`${mode}: لا طلب جديد واحد وصل المنصة في الأثناء`, h2.total === h1.total, { before: h1.total, after: h2.total });

    // ٣) الواجهة تعرف المدة الباقية من الخادم، والسجل يقول من زامن
    const q = (await api('/api/sync/quota')).json;
    const expect = mode === '429' ? 120 : 1800;
    T.check(`${mode}: الحصّة تُبلّغ blockedFor ≈ ${expect}s`, q.blockedFor > expect - 15 && q.blockedFor <= expect, q);
    const log = (await api('/api/auth/log')).json;
    const syncEv = (log.events || []).filter((e) => e.kind === 'sync');
    T.check(`${mode}: سجل الدخول يقيّد مَن زامن`, syncEv.length === 1 && syncEv[0].role === 'admin', log.events);
  } finally {
    await srv.stop();
    await mock.close();
  }
}

(async () => {
  for (const mode of ['429', '418']) await runMode(mode);
  T.finish();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
