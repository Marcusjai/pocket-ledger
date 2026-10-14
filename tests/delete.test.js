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
const T = '2026-10-14T09:03:00+08:00';
function ledger() {
  const s = S.initial();
  S.add(s, { id: 'oct-aaaaaaaa', source: 'Octopus', amount: '85.80', merchant: '車費・港鐵', timestamp: T, category: 'Transport' });
  S.add(s, { id: 'oct-bbbbbbbb', source: 'Octopus', amount: '11.00', merchant: '車費・港鐵', timestamp: '2026-10-14T09:46:00+08:00', category: 'Transport' });
  return s;
}
const synced = s => { for (const r of s.transactions) r.version = 1; s.outbox = []; return s; };

test('edit dialog has a 刪除 button; confirm once; undo toast 還原', () => {
  assert.match(html, /<dialog id="category-dialog">[\s\S]*id="delete-record"[^>]*>刪除呢筆記錄<\/button>[\s\S]*<\/dialog>/);
  assert.equal((app.match(/confirm\(/g) || []).length, 1);
  assert.match(app, /label: '還原'/);
});
test('delete hides record from totals and lists, queues one delete op, keeps $11.00', () => {
  const s = synced(ledger());
  const res = S.setDeleted(s, 'oct-aaaaaaaa');
  assert.equal(res.record.deleted, true); assert.equal(res.record.version, 2);
  assert.deepEqual(s.outbox.map(o => [o.action, o.id, o.deleted]), [['delete', 'oct-aaaaaaaa', true]]);
  const t = E.totals(s.transactions, '2026-10', '2026-10-14');
  assert.equal(t.totalCents, 1100); assert.equal(t.count, 1);
  assert.equal(s.transactions.find(r => r.id === 'oct-bbbbbbbb').deleted, undefined);
});
test('undo restores and queues a restore op', () => {
  const s = synced(ledger());
  S.setDeleted(s, 'oct-aaaaaaaa'); S.setDeleted(s, 'oct-aaaaaaaa', false);
  assert.equal(s.transactions.find(r => r.id === 'oct-aaaaaaaa').deleted, false);
  assert.deepEqual(s.outbox.map(o => o.deleted), [true, false]);
  assert.equal(E.totals(s.transactions, '2026-10', '2026-10-14').totalCents, 9680);
});
test('a server snapshot tombstone removes the record on another device; stale snapshot does not resurrect a pending delete', () => {
  const other = synced(ledger());
  const tomb = { ...other.transactions[0], deleted: true, version: 2 };
  S.merge(other, { transactions: [tomb, other.transactions[1]], rules: [] });
  assert.equal(other.transactions.find(r => r.id === 'oct-aaaaaaaa').deleted, true);
  const me = synced(ledger()); S.setDeleted(me, 'oct-aaaaaaaa');
  S.merge(me, { transactions: [{ ...me.transactions[0], deleted: false, version: 1 }], rules: [] });
  assert.equal(me.transactions.find(r => r.id === 'oct-aaaaaaaa').deleted, true);
});
test('delete queued behind an unsynced create survives the create ack', () => {
  const s = ledger();
  S.setDeleted(s, 'oct-aaaaaaaa');
  const create = s.outbox.find(o => o.action === 'create' && o.transaction.id === 'oct-aaaaaaaa');
  const remote = E.insert([], create.transaction, []).transaction;
  S.acknowledge(s, create, remote);
  assert.equal(s.transactions.find(r => r.id === 'oct-aaaaaaaa').deleted, true);
});
test('deleting an expense hides its repayments; prompt warns; undo restores them', () => {
  const s = S.initial();
  S.add(s, { id: 'exp-aaaaaaaa', source: 'ApplePay', amount: '300.00', merchant: 'Dinner', timestamp: T, category: 'Dining' });
  S.add(s, { id: 'rei-aaaaaaaa', kind: 'reimbursement', expenseId: 'exp-aaaaaaaa', amount: '100.00', source: 'FPS', payer: 'Amy', timestamp: '2026-10-14T12:00:00+08:00' });
  const ctx = { E, sources: {}, money: c => (c / 100).toFixed(2) }; vm.createContext(ctx);
  vm.runInContext(app.slice(app.indexOf('function deletePrompt'), app.indexOf('function notify')) + ';this.p = deletePrompt;', ctx);
  assert.match(ctx.p(s.transactions[0], s.transactions), /1 筆朋友還款，會一齊隱藏/);
  const res = S.setDeleted(s, 'exp-aaaaaaaa');
  assert.deepEqual(res.linked, ['rei-aaaaaaaa']);
  assert.equal(E.totals(s.transactions, '2026-10', '2026-10-14').count, 0);
  assert.throws(() => S.add(s, { id: 'rei-bbbbbbbb', kind: 'reimbursement', expenseId: 'exp-aaaaaaaa', amount: '1.00', source: 'FPS', timestamp: T }), /原支出/);
  S.setDeleted(s, 'exp-aaaaaaaa', false);
  assert.equal(E.totals(s.transactions, '2026-10', '2026-10-14').totalCents, 20000);
});
