'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const E = require('../engine.js');
globalThis.ExpenseEngine = E;
const S = require('../store.js');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

const yenRecord = (alt = { JPY: { rate: 0.052, estimated: false }, CNY: { rate: 1.08, estimated: false } }) => ({
  ...E.prepare({ id: 'hsbc-20261013130000000-123456', source: 'ApplePay', currency: 'HKD', amount: '61.20', merchant: 'Shop', timestamp: '2026-10-13T13:00:00+08:00', account: 'hsbc-wallet', category: 'Shopping', note: 'JPY 1200 @0.051 待確認',
    fx: { currency: 'JPY', amount: '1200', rate: 0.051, source: 'open.er-api.com', pending: true, ambiguous: true, estimated: false, alternatives: alt } }, [], '2026-10-13T05:00:00.000Z')
});
const state = rec => ({ ...S.initial(), transactions: [rec] });

// Pull the pure render helpers out of app.js without booting the whole UI.
function helpers() {
  const src = app.slice(app.indexOf('const fxChoiceLabel'), app.indexOf('function renderFxChoices'));
  const ctx = { E }; vm.createContext(ctx);
  vm.runInContext(src + ';this.fxChoicesHtml = fxChoicesHtml;', ctx);
  return ctx;
}

test('edit dialog shows two side-by-side buttons labelled with converted HK$', () => {
  const out = helpers().fxChoicesHtml(yenRecord());
  const buttons = [...out.matchAll(/<button[^>]*data-fx-currency="(\w+)"[^>]*>([^<]*)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(buttons, [['JPY', 'JPY ≈ HK$62'], ['RMB', 'RMB ≈ HK$1,296']]);
  assert.doesNotMatch(out, /<select/);
  assert.match(html, /id="fx-choices"[^>]*hidden/);
  assert.match(css, /\.fx-choice-row\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.equal(helpers().fxChoicesHtml({ ...yenRecord(), fx: { ...yenRecord().fx, ambiguous: false, yen: undefined } }), "");
  // A resolved ¥ record still offers both buttons, current one ticked.
  const resolved = helpers().fxChoicesHtml({ ...yenRecord(), fx: { ...yenRecord().fx, currency: "CNY", ambiguous: false, yen: true } });
  assert.match(resolved, /fx-choice current"[^>]*data-fx-currency="RMB">✓ RMB/);
  assert.match(resolved, /data-fx-currency="JPY">JPY/);
});

test('JPY -> RMB locally: HKD amount and rate update immediately, 待確認 removed, op queued', () => {
  const s = state(yenRecord());
  assert.deepEqual(E.fxBadges(s.transactions[0].fx).map(b => b.label), ['待確認']);
  S.fxSetCurrency(s, 'hsbc-20261013130000000-123456', 'RMB');
  const r = s.transactions[0];
  assert.equal(r.amountCents, 129600); assert.equal(r.fx.currency, 'CNY'); assert.equal(r.fx.rate, 1.08);
  assert.deepEqual(E.fxBadges(r.fx), []);
  assert.equal(s.outbox.length, 1); assert.equal(s.outbox[0].action, 'fxSetCurrency'); assert.equal(s.outbox[0].currency, 'RMB');
  // Mis-tap can be fixed: change back to JPY.
  S.fxSetCurrency(s, r.id, "JPY");
  assert.equal(r.fx.currency, "JPY"); assert.equal(r.amountCents, 6240); assert.equal(r.fx.yen, true);
  assert.deepEqual(E.fxBadges(r.fx), []); assert.equal(s.outbox.length, 2);
  const usd = { ...yenRecord(), id: "u1", fx: { currency: "USD", amount: "10", rate: 7.8, ambiguous: false, pending: false, estimated: false } };
  s.transactions.push(usd);
  assert.throws(() => S.fxSetCurrency(s, "u1", "JPY"), /已確認/);
});

test('no live alternative rate -> fallback and 估算 badge', () => {
  const s = state(yenRecord({ JPY: { rate: 0.051, estimated: true }, CNY: { rate: 1.09, estimated: true } }));
  S.fxSetCurrency(s, 'hsbc-20261013130000000-123456', 'JPY');
  assert.deepEqual(E.fxBadges(s.transactions[0].fx).map(b => b.label), ['估算']);
  // Old ¥ records without stored alternatives still get a preview from built-in rates.
  const old = yenRecord(); delete old.fx.alternatives;
  assert.ok(E.yenPreview(old.fx).every(o => o.estimated));
});

test('server acknowledgement replaces local row with authoritative fresh-rate result', () => {
  const s = state(yenRecord());
  S.fxSetCurrency(s, 'hsbc-20261013130000000-123456', 'RMB');
  const op = s.outbox[0];
  const remote = E.applyCurrency(yenRecord(), 'CNY', 1.1, 'n', op.operationId);
  S.acknowledge(s, op, remote);
  assert.equal(s.outbox.length, 0); assert.equal(s.transactions[0].amountCents, 132000); assert.equal(s.transactions[0].fx.rate, 1.1);
});

test('badge pills contain the words 待確認 and 估算 (not colour only)', () => {
  assert.deepEqual(E.fxBadges({ ambiguous: true, estimated: true }).map(b => b.label), ['待確認', '估算']);
  assert.match(app, />\$\{b\.label\}<\/button>/);
  assert.match(css, /\.tx-value \.fx-badge-pending/);
});
