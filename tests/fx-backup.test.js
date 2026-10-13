'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const E = require('../engine.js');
globalThis.ExpenseEngine = E;
globalThis.crypto ||= require('node:crypto').webcrypto;
const S = require('../store.js');
const alt = { JPY: { rate: 0.052, estimated: false }, CNY: { rate: 1.08, estimated: false } };
const rec = (id, amount, fx) => E.prepare({ id, source: 'ApplePay', currency: 'HKD', amount, merchant: 'Shop', timestamp: '2026-10-13T13:00:00+08:00', account: 'hsbc-wallet', category: 'Shopping', fx }, [], 'n');
const records = [
  rec('hsbc-a-00000001', '233.32', { currency: 'USD', amount: '29.99', rate: 7.78, source: 'open.er-api.com' }),
  rec('hsbc-b-00000002', '61.20', { currency: 'JPY', amount: '1200', rate: 0.051, pending: true, ambiguous: true, alternatives: alt }),
  rec('hsbc-c-00000003', '48.00', { currency: 'TRY', amount: '250.00', rate: 0.19, source: 'fallback', estimated: true }),
  rec('hsbc-d-00000004', '12.00', undefined),
];
test('inputOf (backup export) includes fx details', () => {
  assert.deepEqual(E.inputOf(records[1]).fx, records[1].fx);
  assert.equal('fx' in E.inputOf(records[3]), false);
});
test('backup → restore keeps fx, flags, badges and ¥ alternatives', () => {
  const backup = JSON.parse(JSON.stringify({ schema: 2, transactions: records.map(E.inputOf), rules: [] }));
  const s = S.initial();
  assert.equal(S.restore(s, backup), 4);
  const by = id => s.transactions.find(t => t.id === id);
  for (const r of records) assert.deepEqual(by(r.id).fx, r.fx, r.id);
  assert.deepEqual(E.fxBadges(by('hsbc-b-00000002').fx).map(b => b.label), ['待確認']);
  assert.deepEqual(E.fxBadges(by('hsbc-c-00000003').fx).map(b => b.label), ['估算']);
  assert.equal(by('hsbc-b-00000002').amountCents, 6120);
  // The restored ¥ record can still be corrected, and the queued create carries fx to the server.
  S.fxSetCurrency(s, 'hsbc-b-00000002', 'RMB');
  assert.equal(by('hsbc-b-00000002').amountCents, 129600);
  assert.deepEqual(s.outbox.find(o => o.action === 'create' && o.transaction.id === 'hsbc-a-00000001').transaction.fx.currency, 'USD');
});
test('restoring the same backup twice does not duplicate (fingerprint unchanged by fx)', () => {
  const backup = { schema: 2, transactions: records.map(E.inputOf), rules: [] };
  const s = S.initial(); S.restore(s, backup);
  assert.equal(S.restore(s, backup), 0);
});
test('restore rejects malformed fx', () => {
  const bad = { ...E.inputOf(records[0]), fx: { currency: 'XXX', amount: '1', rate: 1 } };
  assert.throws(() => S.restore(S.initial(), { schema: 2, transactions: [bad], rules: [] }), /外幣/);
});
