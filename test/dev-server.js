// خادم تطويري للمعاينة: بيانات عيّنة ومنصّة Binance وهمية — بلا مفاتيح حقيقية ولا إنترنت.
//   node test/dev-server.js   → http://127.0.0.1:3147
//   كلمات السر: مسؤول test1234 · مستخدم user1234 · مستخدم 2 user2abc
// المزامنة والرصيد والفحص تعمل على المنصّة الوهمية (منفذ 3148) فيمكن تجربة الواجهة كاملة.
'use strict';
process.env.TEST_PORT = process.env.TEST_PORT || '3147';

const fs = require('fs');
const path = require('path');
const T = require('./helpers');
const N = require('../lib/normalize.js');

const NOW = Date.now();
const H = 3600000;
const PARTIES = ['Rania76', '121PARADISE', 'Al7nkal', '__ABRAHAM_BUSIN', 'PRESTIGE_STORE'];
const orders = [];
for (let i = 0; i < 160; i++) {
  const amt = 20 + ((i * 37) % 230);
  const price = 8200 + ((i * 13) % 120);
  orders.push(T.rawOrder(i, NOW - Math.floor(i * 2.3 * H), {
    tradeType: i % 9 === 0 ? 'BUY' : 'SELL', amount: String(amt), unitPrice: String(price), totalPrice: String(Math.round(amt * price)),
    counterPartNickName: PARTIES[i % PARTIES.length], takerAmount: String(amt - 0.05),
    orderStatus: i === 1 ? 'TRADING' : (i === 7 ? 'CANCELLED_BY_SYSTEM' : 'COMPLETED'),
  }));
}
const deposits = [0, 1, 2, 3].map((i) => ({ id: 'dep' + i, txId: 'tx-dep-' + i, coin: 'USDT', network: 'TRX', amount: String(2000 + i * 500), status: 1, insertTime: NOW - (30 + i * 90) * H, address: 'TAddr' + i }));
const withdraws = [0, 1].map((i) => ({ id: 'wd' + i, txId: 'tx-wd-' + i, coin: 'USDT', network: 'BSC', amount: String(300 + i * 100), transactionFee: '1', status: 6, applyTime: new Date(NOW - (50 + i * 120) * H).toISOString().slice(0, 19).replace('T', ' '), address: 'bnbAddr' + i }));
const pays = [{ transactionId: 'pay0', amount: '-25', currency: 'USDT', transactionTime: NOW - 70 * H, walletType: 1, receiverInfo: { name: 'HannibalOfHouseBarca' } },
  { transactionId: 'pay1', amount: '10', currency: 'USDT', transactionTime: NOW - 20 * H, walletType: 1, payerInfo: { name: 'من سيف' } }];
const converts = [{ orderId: 'cvt0', fromAsset: 'USDT', toAsset: 'TRX', fromAmount: '30', toAmount: '240', orderStatus: 'SUCCESS', createTime: NOW - 100 * H }];

(async () => {
  await T.startMock({ orders, deposits, withdraws, pays, converts, page: 50, mode: 'C' });
  const dir = T.freshDataDir('dev');
  fs.writeFileSync(path.join(dir, 'config__p2p.json'), JSON.stringify({
    active: 'p2p', auth: {}, syncQuota: 3,
    accounts: { p2p: { apiKey: 'demo-key', apiSecret: 'demo-secret', baseUrl: T.MOCK_BASE, rangeHours: 720, lastSync: NOW - 3 * H } },
  }, null, 1));
  // عيّنة محفوظة مسبقًا (كما لو زامن المستخدم من قبل): نصف الطلبات والحوالات كلها
  const om = {}, tm = {};
  for (const raw of orders.slice(40)) { const o = N.normalizeOrder(raw, 'binance'); om[o.orderNumber] = o; }
  om[orders[45].orderNumber].reference = '#116734'; om[orders[45].orderNumber].note = 'تم البيع';
  for (const raw of deposits) { const t = N.normalizeTransfer(raw, 'deposit'); tm[t.id] = t; }
  for (const raw of withdraws) { const t = N.normalizeTransfer(raw, 'withdraw'); tm[t.id] = t; }
  for (const raw of pays) { const t = N.normalizePay(raw); tm[t.id] = t; }
  for (const raw of converts) { const t = N.normalizeConvert(raw); tm[t.id] = t; }
  fs.writeFileSync(path.join(dir, 'orders__p2p.json'), JSON.stringify(om, null, 1));
  fs.writeFileSync(path.join(dir, 'transfers__p2p.json'), JSON.stringify(tm, null, 1));

  Object.assign(process.env, {
    DATA_DIR: dir, ACCOUNT: 'p2p', PORT: process.env.TEST_PORT, HOST: '127.0.0.1',
    ADMIN_PASSWORD: T.PASSWORDS.admin, USER_PASSWORD: T.PASSWORDS.user, USER2_PASSWORD: T.PASSWORDS.user2,
  });
  console.log('منصّة وهمية على ' + T.MOCK_BASE + ' · بيانات العيّنة في ' + dir);
  require('../server.js');
})().catch((e) => { console.error(e); process.exit(1); });
