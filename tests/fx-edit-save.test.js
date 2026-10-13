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
const alt = { JPY: { rate: 0.052, estimated: false }, CNY: { rate: 1.08, estimated: false } };
const yen = () => E.prepare({ id: 'hsbc-b-00000002', source: 'ApplePay', currency: 'HKD', amount: '61.20', merchant: 'Lawson', timestamp: '2026-10-13T10:20:00+08:00', account: 'hsbc-wallet', category: 'Groceries', fx: { currency: 'JPY', amount: '1200', rate: 0.051, pending: true, ambiguous: true, alternatives: alt } }, [], 'n');
function helpers() {
  const src = app.slice(app.indexOf('const fxChoiceLabel'), app.indexOf('let fxSelection'));
  const ctx = { E }; vm.createContext(ctx);
  vm.runInContext(src + ';this.h = { fxChoicesHtml, editHeader, fxOriginal };', ctx);
  return ctx.h;
}

test('selecting a currency only marks the button (aria-pressed); no store change, no queue', () => {
  const h = helpers(), r = yen(), s = { ...S.initial(), transactions: [r] }, before = JSON.stringify(s);
  const out = h.fxChoicesHtml(r, 'RMB');
  assert.match(out, /class="secondary fx-choice selected" aria-pressed="true" data-fx-currency="RMB">✓ RMB ≈ HK\$1,296/);
  assert.match(out, /aria-pressed="false" data-fx-currency="JPY">JPY ≈ HK\$62/);
  assert.equal(JSON.stringify(s), before);
  // The click handler must not touch the store.
  const handler = app.slice(app.indexOf("$('fx-choice-row').addEventListener"), app.indexOf("$('close-dialog')"));
  assert.doesNotMatch(handler, /S\.mutate|fxSetCurrency|synchronize/);
});
test('cancel clears the selection without touching the store', () => {
  const cancel = /\$\('close-dialog'\)\.onclick = \(\) => \{([^}]*)\}/.exec(app)[1];
  assert.match(cancel, /fxSelection = null/); assert.doesNotMatch(cancel, /S\.|synchronize/);
});
test('save applies currency + category together and queues fxSetCurrency exactly once', () => {
  const s = { ...S.initial(), transactions: [yen()] };
  const r = S.saveEdit(s, 'hsbc-b-00000002', { category: 'Shopping', remember: false, currency: 'RMB' });
  assert.equal(r.amountCents, 129600); assert.equal(r.category, 'Shopping'); assert.deepEqual(E.fxBadges(r.fx), []);
  assert.deepEqual(s.outbox.map(o => o.action), ['fxSetCurrency', 'categorize']);
  assert.equal(s.outbox.filter(o => o.action === 'fxSetCurrency').length, 1);
  assert.equal(s.outbox[1].version, r.version - 1, 'categorize version follows the currency change');
});
test('save with currency only and unchanged category queues just fxSetCurrency', () => {
  const s = { ...S.initial(), transactions: [yen()] };
  S.saveEdit(s, 'hsbc-b-00000002', { category: 'Groceries', remember: false, currency: 'JPY' });
  assert.deepEqual(s.outbox.map(o => o.action), ['fxSetCurrency']);
});
test('save without currency choice behaves like the old category save', () => {
  const s = { ...S.initial(), transactions: [yen()] };
  S.saveEdit(s, 'hsbc-b-00000002', { category: 'Groceries', remember: false, currency: null });
  assert.deepEqual(s.outbox.map(o => o.action), ['categorize']); assert.equal(s.transactions[0].fx.ambiguous, true);
});
test('dialog title/button renamed', () => {
  assert.match(html, /<h2>修改記錄<\/h2>/); assert.match(html, /<button type="submit" class="primary">儲存<\/button>/);
});
test('header shows original amount first with sensible symbols', () => {
  const h = helpers();
  const rec = (currency, amount, cents) => ({ amountCents: cents, fx: { currency, amount } });
  assert.equal(h.editHeader(rec('JPY', '1200', 6120), 'Lawson'), '¥1,200・暫計 HK$61.20\nLawson');
  assert.equal(h.fxOriginal({ currency: 'USD', amount: '29.99' }), 'US$29.99');
  assert.equal(h.fxOriginal({ currency: 'TRY', amount: '1234.5' }), '₺1,234.50');
  assert.equal(h.fxOriginal({ currency: 'CNY', amount: '88.5' }), 'RMB 88.50');
  assert.equal(h.fxOriginal({ currency: 'TWD', amount: '350' }), 'NT$350.00');
  assert.equal(h.editHeader({ amountCents: 1230 }, 'MTR'), 'MTR · HK$12.30');
});
test('badges sit in the right-hand value column under the original-currency line', () => {
  const v = app.indexOf('<div class="tx-value">'), l = app.indexOf('<small class="fx-line">'), b = app.indexOf('</small><span class="fx-badges">');
  assert.ok(v > 0 && v < l && l < b, 'value column → fx line → badges');
  assert.doesNotMatch(app.slice(app.indexOf('<div class="tx-info">'), app.indexOf('<div class="tx-value">')), /fx-badge/);
});
