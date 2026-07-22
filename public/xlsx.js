/*
 * مولّد ملفات Excel (.xlsx) بلغة JavaScript خالصة — بدون أي مكتبة خارجية.
 * يبني حزمة OOXML مضغوطة بطريقة ZIP "التخزين" (بلا ضغط) مع CRC32،
 * فينتج ملف Excel حقيقي بجدول منسّق (RTL، عناوين عريضة، حدود، تجميد الصف الأول).
 * الواجهة: XLSXMini.download(filename, sheetName, columns, rows)
 *   columns: [{ header, width, type: 'text' | 'number' }]
 *   rows:    مصفوفة من المصفوفات (قيم الخلايا بترتيب الأعمدة)
 */
'use strict';

(function () {
  /* ---------- CRC32 ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = ~0;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (~c) >>> 0;
  }

  const ENC = new TextEncoder();
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  /* ---------- بناء ZIP (طريقة التخزين) ---------- */
  function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = ENC.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const size = data.length;
      const lfh = new Uint8Array([].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0)
      ));
      chunks.push(lfh, nameBytes, data);
      const cdh = new Uint8Array([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
      ));
      central.push(cdh, nameBytes);
      offset += lfh.length + nameBytes.length + data.length;
    }
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const eocd = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralSize), u32(offset), u16(0)
    ));
    const all = chunks.concat(central, [eocd]);
    let total = 0;
    for (const c of all) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of all) { out.set(c, pos); pos += c.length; }
    return out;
  }

  /* ---------- مساعدات XML ---------- */
  // إزالة محارف التحكم غير المسموح بها في XML 1.0 (يُسمح بـ Tab/LF/CR فقط)
  const BAD_XML = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');
  function xesc(s) {
    return String(s == null ? '' : s)
      .replace(BAD_XML, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colLetter(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  const CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const WB_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // الأنماط: خط عادي، وخط عريض أبيض للعناوين، تعبئة داكنة للعنوان، حدود رفيعة، تنسيق أرقام بفواصل الآلاف
  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.########"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="4">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A19"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F6FC"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function workbookXml(sheetName) {
    const name = xesc(String(sheetName || 'Sheet1').replace(/[\[\]\:\*\?\/\\]/g, ' ').slice(0, 31)) || 'Sheet1';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';
  }

  function buildSheet(columns, rows) {
    const cols = columns.map((c, i) =>
      '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 14) + '" customWidth="1"/>'
    ).join('');

    let header = '';
    columns.forEach((c, i) => {
      header += '<c r="' + colLetter(i + 1) + '1" s="1" t="inlineStr"><is><t xml:space="preserve">' + xesc(c.header) + '</t></is></c>';
    });
    let body = '<row r="1" ht="20" customHeight="1">' + header + '</row>';

    rows.forEach((row, ri) => {
      const r = ri + 2;
      const striped = (ri % 2) === 1;      // تخطيط كل صف ثانٍ
      const sText = striped ? 4 : 2;
      const sNum = striped ? 5 : 3;
      let cells = '';
      columns.forEach((c, i) => {
        const ref = colLetter(i + 1) + r;
        const v = row[i];
        if (c.type === 'number') {
          const nv = (v === '' || v == null || isNaN(v)) ? null : Number(v);
          cells += (nv == null)
            ? '<c r="' + ref + '" s="' + sText + '"/>'
            : '<c r="' + ref + '" s="' + sNum + '"><v>' + nv + '</v></c>';
        } else {
          cells += '<c r="' + ref + '" s="' + sText + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(v) + '</t></is></c>';
        }
      });
      body += '<row r="' + r + '">' + cells + '</row>';
    });

    const dim = 'A1:' + colLetter(columns.length || 1) + (rows.length + 1);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="' + dim + '"/>' +
      '<sheetViews><sheetView rightToLeft="1" tabSelected="1" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + cols + '</cols>' +
      '<sheetData>' + body + '</sheetData>' +
      // بلا «جدول» حقيقي وبلا فلتر تلقائي — كلاهما يسبّب خطأ
      // «This action won't work on multiple selections» عند نسخ صف/عمود كامل.
      '</worksheet>';
  }

  function build(sheetName, columns, rows) {
    const files = [
      { name: '[Content_Types].xml', data: ENC.encode(CONTENT_TYPES) },
      { name: '_rels/.rels', data: ENC.encode(RELS) },
      { name: 'xl/workbook.xml', data: ENC.encode(workbookXml(sheetName)) },
      { name: 'xl/_rels/workbook.xml.rels', data: ENC.encode(WB_RELS) },
      { name: 'xl/styles.xml', data: ENC.encode(STYLES) },
      { name: 'xl/worksheets/sheet1.xml', data: ENC.encode(buildSheet(columns, rows)) },
    ];
    return zipStore(files);
  }

  function download(filename, sheetName, columns, rows) {
    const bytes = build(sheetName, columns, rows);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.XLSXMini = { build, download };
})();
