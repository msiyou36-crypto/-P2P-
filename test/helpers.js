/*
 * أدوات الاختبار: منصّة Binance وهمية، وتشغيل الخادم على مجلد بيانات مؤقت، ودوال
 * للطلبات. الاختبارات تشغّل الخادم الحقيقي (server.js) كعمليةٍ مستقلة وتكلّمه عبر HTTP
 * كما تفعل الواجهة، فتختبر السلوك لا التفاصيل الداخلية.
 *
 *   const T = require('./helpers');
 *   const mock = await T.startMock({ orders, page: 50, mode: 'A' });
 *   const srv = await T.startServer({ name: 'x' });
 *   const token = await T.login('admin', 'test1234');
 *   const api = T.api(token);  const r = await api('/api/orders');  // { status, json }
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_PORT = Number(process.env.TEST_PORT) || 3145;
const MOCK_PORT = SERVER_PORT + 1;
const BASE = 'http://127.0.0.1:' + SERVER_PORT;
const MOCK_BASE = 'http://127.0.0.1:' + MOCK_PORT;

const PASSWORDS = { admin: 'test1234', user: 'user1234', user2: 'user2abc' };

/* ---------- عدّاد النجاح/الفشل ---------- */
let fails = 0, passes = 0;
function check(label, ok, got) {
  if (ok) { passes++; console.log('PASS ' + label); }
  else { fails++; console.log('FAIL ' + label + ' → ' + JSON.stringify(got).slice(0, 400)); }
}
function finish() {
  console.log(fails ? `\n${fails} FAILED (${passes} passed)` : `\nALL PASSED (${passes})`);
  process.exit(fails ? 1 : 0);
}

/* ---------- منصّة وهمية ----------
 * opts.orders   طلبات P2P خام (orderNumber, tradeType, amount, totalPrice, unitPrice, createTime …)
 * opts.page     حجم الصفحة الحقيقي (الافتراضي 100)
 * opts.mode     A: الصفحة تُهمل (تعيد الأولى) · B: ترقيم سليم · C: الثانية فارغة
 *               D: الفترة مُهملة (أحدث صفحة دائمًا) · T: كالثالثة لكن total كاذب
 * opts.deposits / withdraws / pays / converts   سجلّات خام لبقية النقاط
 * opts.onC2C(callNo)  يُرجع { status, headers, body } ليحلّ محلّ الردّ (لمحاكاة 429/418)
 */
function startMock(opts = {}) {
  const page = opts.page || 100;
  const mode = opts.mode || 'B';
  const hits = {};
  let c2cCalls = 0;
  const inWin = (t, s, e) => t >= s && t <= e;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits[u.pathname] = (hits[u.pathname] || 0) + 1;
    const send = (obj, status = 200, headers = {}) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'x-sapi-used-uid-weight-1m': '10', 'x-sapi-used-ip-weight-1m': '7' }, headers));
      res.end(JSON.stringify(obj));
    };
    const s = Number(u.searchParams.get('startTime') || u.searchParams.get('startTimestamp')) || 0;
    const e = Number(u.searchParams.get('endTime') || u.searchParams.get('endTimestamp')) || Infinity;
    switch (u.pathname) {
      case '/api/v3/time': return send({ serverTime: Date.now() });
      case '/__hits': return send({ hits, c2cCalls, total: Object.entries(hits).filter(([k]) => k !== '/__hits').reduce((a, [, v]) => a + v, 0) });
      case '/sapi/v1/c2c/orderMatch/listUserOrderHistory': {
        c2cCalls++;
        if (opts.onC2C) { const o = opts.onC2C(c2cCalls, u); if (o) return send(o.body || {}, o.status || 200, o.headers || {}); }
        const tt = u.searchParams.get('tradeType');
        const pg = Number(u.searchParams.get('page')) || 1;
        const mine = (opts.orders || []).filter((o) => o.tradeType === tt);
        const win = mine.filter((o) => inWin(o.createTime, s, e)).sort((a, b) => b.createTime - a.createTime);
        let data, total = win.length;
        if (mode === 'A') data = win.slice(0, page);
        else if (mode === 'B') data = win.slice((pg - 1) * page, pg * page);
        else if (mode === 'C') data = pg === 1 ? win.slice(0, page) : [];
        else if (mode === 'T') { data = pg === 1 ? win.slice(0, page) : []; total = 999999; }
        else data = mine.slice().sort((a, b) => b.createTime - a.createTime).slice(0, page);   // D
        return send({ code: '000000', data, total, success: true });
      }
      case '/sapi/v1/capital/deposit/hisrec': return send((opts.deposits || []).filter((d) => inWin(d.insertTime, s, e)));
      case '/sapi/v1/capital/withdraw/history': return send((opts.withdraws || []).filter((w) => inWin(Date.parse(w.applyTime + 'Z'), s, e)));
      case '/sapi/v1/pay/transactions': return send({ code: '000000', data: (opts.pays || []).filter((p) => inWin(p.transactionTime, s, e)), success: true });
      case '/sapi/v1/convert/tradeFlow': return send({ list: (opts.converts || []).filter((c) => inWin(c.createTime, s, e)) });
      case '/api/v3/myTrades': return send([]);
      case '/sapi/v1/asset/get-funding-asset': return send([{ asset: 'USDT', free: '60', locked: '0', freeze: '0', withdrawing: '0' }, { asset: 'TRX', free: '12', locked: '0', freeze: '0', withdrawing: '0' }]);
      case '/sapi/v3/asset/getUserAsset': return send([{ asset: 'USDT', free: '40', locked: '0', freeze: '0', withdrawing: '0' }]);
      case '/api/v3/account': return send({ uid: 582097756, accountType: 'SPOT' });
      default: res.writeHead(404); res.end('{}');
    }
  });
  return new Promise((resolve) => srv.listen(MOCK_PORT, '127.0.0.1', () => resolve({
    hits: async () => (await (await fetch(MOCK_BASE + '/__hits')).json()),
    close: () => new Promise((r) => srv.close(r)),
  })));
}

/* ---------- الخادم ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDataDir(name) {
  const dir = path.join(os.tmpdir(), 'p2p-log-tests', name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** يكتب إعدادات الحساب المقفول ويشغّل الخادم؛ يُرجع { dir, stop } */
async function startServer(o = {}) {
  const account = o.account || 'p2p';
  const dir = o.dir || freshDataDir(o.name || 'srv');
  if (!o.keepConfig) {
    const cfg = { active: account, auth: {}, accounts: { [account]: { apiKey: 'k', apiSecret: 's', baseUrl: MOCK_BASE, rangeHours: o.rangeHours || 72 } }, syncQuota: o.syncQuota != null ? o.syncQuota : 3 };
    fs.writeFileSync(path.join(dir, 'config__' + account + '.json'), JSON.stringify(cfg, null, 1));
  }
  const env = Object.assign({}, process.env, {
    DATA_DIR: dir, ACCOUNT: account, PORT: String(SERVER_PORT), HOST: '127.0.0.1',
    ADMIN_PASSWORD: PASSWORDS.admin, USER_PASSWORD: PASSWORDS.user, USER2_PASSWORD: PASSWORDS.user2,
  }, o.env || {});
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: o.verbose ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(BASE + '/api/auth/status')).ok; } catch {}
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('الخادم لم يبدأ');
  return {
    dir,
    stop: async () => { proc.kill(); await sleep(400); },
  };
}

/* ---------- الطلبات ---------- */

async function login(role, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, password: password || PASSWORDS[role] }) });
  const j = await r.json();
  if (!r.ok) throw new Error('login failed: ' + j.error);
  return j.token;
}

/** api(token)(path, { method, body, raw, headers }) → { status, json } */
function api(token) {
  return async (p, opt = {}) => {
    const headers = Object.assign({}, opt.headers);
    if (token) headers['X-Auth-Token'] = token;
    let body;
    if (opt.raw != null) { body = opt.raw; }
    else if (opt.body != null) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opt.body); }
    const r = await fetch(BASE + p, { method: opt.method || (body != null ? 'POST' : 'GET'), headers, body });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, json };
  };
}

/** بثّ NDJSON (المزامنة والفحص) → مصفوفة الأسطر المفكوكة */
async function stream(token, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth-Token'] = token;
  const r = await fetch(BASE + p, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) { let j = {}; try { j = JSON.parse(text); } catch {} return { status: r.status, lines: [], error: j.error || text }; }
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const err = lines.find((l) => l.error);
  return { status: r.status, lines, done: lines.find((l) => l.done), error: err && err.error, warnings: lines.filter((l) => l.warn).map((l) => l.msg) };
}

/** طلب P2P خام كما تُرجعه المنصة */
function rawOrder(i, t, extra = {}) {
  const amt = 10 + (i % 50);
  return Object.assign({ orderNumber: 'ORD' + String(100000 + i), tradeType: 'SELL', amount: String(amt), totalPrice: String(amt * 8200), unitPrice: '8200', fiat: 'SDG', asset: 'USDT', orderStatus: 'COMPLETED', createTime: t, counterPartNickName: 'Ran***' }, extra);
}

module.exports = { MOCK_BASE, PASSWORDS, check, finish, startMock, startServer, freshDataDir, login, api, stream, rawOrder };
