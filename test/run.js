// يشغّل كل ملفات *.test.js بالتتابع (تشترك في المنفذين 3145/3146) ويلخّص النتيجة.
//   node test/run.js            كل الاختبارات
//   node test/run.js core       ملفٌ بعينه (بادئة الاسم)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.startsWith(filter)).sort();
if (!files.length) { console.error('لا اختبارات تطابق: ' + filter); process.exit(1); }

const results = [];
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', env: process.env });
  results.push({ f, ok: r.status === 0, secs: Math.round((Date.now() - t0) / 1000) });
}
console.log('\n===== الخلاصة =====');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.f} (${r.secs}s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
