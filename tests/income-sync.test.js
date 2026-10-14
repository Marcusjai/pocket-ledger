'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const E = require('../engine.js');
globalThis.ExpenseEngine = E;
globalThis.crypto ||= require('node:crypto').webcrypto;
const S = require('../store.js');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const inc = { id: 'inc-aaaaaaaaaaaa', kind: 'income', source: 'FPS', amount: '62.00', payer: 'AU-YEUNG W*** K**', account: 'hase-in-668', timestamp: '2026-10-14T12:30:00+08:00' };
function ledger() {
  const s = S.initial();
  S.add(s, { id: 'fps-aaaaaaaa', source: 'FPS', amount: '124.00', merchant: 'Dinner', timestamp: '2026-10-13T20:00:00+08:00', category: 'Dining' });
  S.add(s, inc); s.outbox = [];
  return s;
}
function helpers(state) {
  const ctx = { E, state, names: { Dining: '餐飲' }, icons: {}, sources: { FPS: 'FPS' }, money: c => (c / 100).toLocaleString('en-HK', { minimumFractionDigits: 2 }), escape: x => String(x) };
  vm.createContext(ctx);
  vm.runInContext(app.slice(app.indexOf('function offlineText'), app.indexOf('function empty(')) + ';this.h = { offlineText, row };', ctx);
  return ctx.h;
}
test('收款 is not spend, shows green +$62.00 收款 with 對應支出', () => {
  const s = ledger();
  assert.equal(E.totals(s.transactions, '2026-10', '2026-10-14').totalCents, 12400);
  const html = helpers(s).row(s.transactions.find(t => t.id === inc.id));
  assert.match(html, /income-amount">\+\$62\.00 收款/); assert.match(html, /data-link-income="inc-aaaaaaaaaaaa"/);
  assert.throws(() => S.categorize(s, inc.id, 'Dining'), /收款唔使分類/);
});
test('link 收款 to FPS expense → 已收還款・對應 <date> <expense>, queued once', () => {
  const s = ledger();
  S.linkIncome(s, inc.id, 'fps-aaaaaaaa');
  const r = s.transactions.find(t => t.id === inc.id);
  assert.equal(r.kind, 'reimbursement'); assert.equal(r.linkedIncome, true);
  assert.deepEqual(s.outbox.map(o => [o.action, o.id, o.expenseId]), [['linkIncome', inc.id, 'fps-aaaaaaaa']]);
  assert.match(helpers(s).row(r), /已收還款・對應 10\/13 Dinner/);
  assert.equal(E.totals(s.transactions, '2026-10', '2026-10-14').totalCents, 6200);
});
test('network failure: calm bar text with N kept changes and 重試 button in the status bar', () => {
  assert.equal(helpers(ledger()).offlineText(3), '暫時連唔到，你啱啱嘅 3 個修改已經保留，連返會自動同步');
  assert.match(html, /<div class="status-bar"><div id="status"[^>]*>[^<]*<\/div><button type="button" id="retry-sync"[^>]*hidden>重試<\/button><\/div>/);
  assert.match(app, /if \(err\.offline\) syncIssue = true; else/);
});
test('sync marks connection errors offline and keeps the outbox', async () => {
  let st = ledger(); S.add(st, { id: 'cash-aaaaaaaa', amount: '5', merchant: 'x' });
  const io = { read: async () => structuredClone(st), mutate: async fn => fn(st), send: async () => { throw Object.assign(new Error('連線失敗'), { offline: true }); } };
  st.settings = { endpoint: 'https://script.google.com/macros/s/x/exec', token: 'x'.repeat(32) };
  await assert.rejects(S.sync(io), e => e.offline === true);
  assert.equal(st.outbox.length, 1);
  const busy = { ...io, send: async () => ({ ok: false, error: { code: 'BUSY', message: 'busy' } }) };
  await assert.rejects(S.sync(busy), e => e.offline === true);
});
