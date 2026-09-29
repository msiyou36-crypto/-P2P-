/*
 * قارئ Excel (.xlsx) بلا أي حزمة — يكفي ملفات التصدير التي يُنتجها النظام نفسه
 * (وأمثالها): يفكّ ضغط ZIP يدويًا (سجلّات الملفات المحلية + inflateRaw)، ثم يقرأ
 * السلاسل المشتركة والورقة الأولى بالتعابير النمطية. يُرجع صفوفًا: كل صف كائن
 * {A: '...', B: '...'} بأحرف الأعمدة.
 */
'use strict';
const zlib = require('zlib');

/** يفكّ ZIP إلى خريطة {مسار: Buffer} بالمرور على سجلّات الملفات المحلية */
function unzip(buf) {
  const files = {};
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const flags = buf.readUInt16LE(p + 6);
    const method = buf.readUInt16LE(p + 8);
    let csize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    let dataStart = p + 30 + nameLen + extraLen;
    let data;
    if (flags & 8) {
      /* واصفُ البيانات بعد المحتوى: الحجم غير معروف مقدّمًا، فنبحث عن توقيعه */
      let q = dataStart;
      for (;;) {
        const i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), q);
        if (i < 0) throw new Error('ZIP: واصف بيانات مفقود');
        csize = buf.readUInt32LE(i + 8);
        if (dataStart + csize === i) { data = buf.subarray(dataStart, i); p = i + 16; break; }
        q = i + 4;
      }
    } else {
      data = buf.subarray(dataStart, dataStart + csize);
      p = dataStart + csize;
    }
    files[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
  }
  if (!Object.keys(files).length) throw new Error('الملف ليس ملف Excel (.xlsx) صالحًا');
  return files;
}

const unesc = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");

/** الصفوف كخريطة أعمدة؛ أول ورقة في المصنّف */
function parseXlsx(buf) {
  const files = unzip(buf);
  let shared = [];
  if (files['xl/sharedStrings.xml']) {
    const x = files['xl/sharedStrings.xml'].toString('utf8');
    shared = [...x.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('لا توجد ورقة في الملف');
  const xml = files[sheetName].toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = cm[1], attrs = cm[2] || '', body = cm[3] || '';
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const inline = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      let val = inline != null ? unesc(inline) : (v != null ? unesc(v) : '');
      if (/t="s"/.test(attrs) && v != null) val = shared[Number(v)] != null ? shared[Number(v)] : '';
      cells[col] = val;
    }
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

/** CSV بسيط (يفهم الاقتباس والفواصل داخل الحقول) إلى صفوفٍ بنفس شكل الأعمدة */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const letters = (i) => { let n = i + 1, out = ''; while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); } return out; };
  return rows.filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(r.map((v, i) => [letters(i), v])));
}

module.exports = { parseXlsx, parseCsv };
