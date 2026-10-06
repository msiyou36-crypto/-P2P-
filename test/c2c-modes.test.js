// جلبُ طلبات P2P: أربعة عيوب محتملة في نقطة listUserOrderHistory، بسقف صفحة ٥٠ ثم ١٠٠،
// وكلٌّ منها يجب أن يُستوعب أو يُعلَن — لا يُترك صامتًا:
//   A: الصفحة التالية تُكرّر الأولى     → القسمة تستوعب الكل
//   B: ترقيمٌ سليم                      → يعمل بلا قسمةٍ زائدة
//   C: الصفحة الثانية فارغة             → القسمة تستوعب الكل
//   D: الفترة مُهملة، أحدثُ صفحةٍ دائمًا → يُحفظ ما يُعطى ويُعلَن البتر بلا استهلاك مئات الطلبات
//   T: كالثالثة لكن المجموع (total) كاذب → لا يُضلّلنا
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./helpers');

const T0 = Date.now() - 4 * 86400000;
const ORDERS = [];
for (let i = 0; i < 230; i++) ORDERS.push(T.rawOrder(i, T0 + Math.floor(i * (3 * 86400000) / 230)));

async function runMode(mode, page) {
  const mock = await T.startMock({ orders: ORDERS, page, mode });
  const srv = await T.startServer({ name: 'modes', rangeHours: 120 });
  try {
    const token = await T.login('admin');
    const t0 = Date.now();
    const r = await T.stream(token, '/api/sync');
    const o = JSON.parse(fs.readFileSync(path.join(srv.dir, 'orders__p2p.json'), 'utf8'));
    const stored = Object.keys(o).filter((k) => k.startsWith('ORD')).length;
    const h = await mock.hits();
    // فحص المزامنة القديم يستعمل الجلب نفسه بسقف أربعين طلبًا
    const d = (await T.api(token)('/api/diag/p2p?days=5')).json;
    const diag = { fromPlatform: d.fromPlatform ? d.fromPlatform.length : -1, warnings: d.warnings || [], calls: (await mock.hits()).c2cCalls - h.c2cCalls };
    return { stored, warn: r.warnings, calls: h.c2cCalls, secs: Math.round((Date.now() - t0) / 1000), diag };
  } finally {
    await srv.stop();
    await mock.close();
  }
}

(async () => {
  for (const page of (process.env.PAGES || '50,100').split(',').map(Number)) {
    for (const mode of (process.env.MODES || 'ABCDT').split('')) {
      const r = await runMode(mode, page);
      console.log(`mode ${mode} (page ${page}):`, JSON.stringify({ stored: r.stored, calls: r.calls, secs: r.secs, warnings: r.warn.length }));
      if (mode === 'D') {
        T.check(`${mode}/${page}: يحفظ ما تعطيه المنصة (${page})`, r.stored === page, r);
        T.check(`${mode}/${page}: يُعلن البتر`, r.warn.length >= 1 && /تُهمل الفترة/.test(r.warn[0]), r.warn);
        T.check(`${mode}/${page}: يتوقف مبكرًا`, r.calls < 40, r.calls);
        T.check(`${mode}/${page}: الفحص يعرض ${page} ويحذّر`, r.diag.fromPlatform === page && r.diag.warnings.length >= 1 && r.diag.calls <= 40, r.diag);
      } else {
        T.check(`${mode}/${page}: كل ٢٣٠ طلبًا حُفظت`, r.stored === 230, r);
        T.check(`${mode}/${page}: بلا تحذير`, r.warn.length === 0, r.warn);
        T.check(`${mode}/${page}: عدد الطلبات محدود`, r.calls < 200, r.calls);
        T.check(`${mode}/${page}: الفحص يعرض ٢٣٠ ضمن رصيده`, r.diag.fromPlatform === 230 && r.diag.warnings.length === 0 && r.diag.calls <= 40, r.diag);
      }
    }
  }
  T.finish();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
