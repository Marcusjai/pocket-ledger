'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const link = require('../repayment-link.js');

// Read the exact pasteable pattern so docs and tests cannot silently diverge.
// ICU's (?i) is represented by JavaScript's i flag; the remaining syntax is shared.
const doc = readFileSync(join(__dirname, '../docs/repayment-shortcut.md'), 'utf8');
const pattern = doc.match(/```regex\n([^\n]+)\n```/)[1];
const regex = new RegExp(pattern.replace(/^\(\?i\)/, ''), 'gi');
const base = 'https://marcusjai.github.io/pocket-ledger/#reimburse';
const notification = amount => `Hang Seng: You've received a transfer of ${amount} from EXAMPLE to your account XXX-XXX on 2026-01-01.`;
function shortcutURL(body) {
  const matches = [...body.matchAll(regex)];
  return matches.length === 1 ? base + '?amount=' + encodeURIComponent(matches[0][1]) : base;
}

const accepted = [
  ['HKD12', '12.00'], ['HKD 1234', '1234.00'], ['HK$1,234.50', '1234.50'],
  ['HK$ 123.4', '123.40'], ['HKD0.01', '0.01'], ['HKD0.1', '0.10'],
  ['HKD0.10', '0.10'], ['HKD12.5', '12.50'], ['HKD9999999.99', '9999999.99'],
  ['HKD9,999,999.99', '9999999.99'], ['HKD999,999', '999999.00'],
];
for (const [value, normalized] of accepted) {
  test(`extract and parse ${value}`, () => {
    const url = shortcutURL(notification(value));
    assert.notEqual(url, base);
    const rawAmount = decodeURIComponent(url.split('?amount=')[1]);
    assert.match(rawAmount, /^[0-9,.]+$/);
    assert.equal(link.amount(rawAmount), normalized);
    assert.deepEqual(link.parse(new URL(url).hash), { view: 'reimburse', amount: normalized });
  });
}

const rejected = [
  'HKD123.456', 'HKD12,34.50', 'HKD1,2345', 'HKD1,234.567',
  'HKD0', 'HKD0.0', 'HKD0.00', 'HKD-12.34', 'HKD -12.34', 'HKD+12', '-HKD12',
  'HKD1e3', 'HKD10E+2', 'HKD.50', 'HKD12.', 'HKD12 34', 'HKD12/34',
  'HKD10,000,000', 'HKD10000000', 'HKD999,999,999', 'HKD01.50',
  'USD12.34', 'CNY12.34', 'CNH12.34', '$12.34', 'HKD１２.３４',
  'HKD12.34USD', 'HKD12.34 USD', 'HKD12.34 / USD2', 'HKD12.34e2',
];
for (const value of rejected) {
  test(`manual fallback for ${value}`, () => {
    const url = shortcutURL(notification(value));
    assert.equal(url, base);
    assert.deepEqual(link.parse(new URL(url).hash), { view: 'reimburse' });
  });
}

const ambiguousOrOther = [
  '', 'The message has changed.',
  "Hang Seng: You've transferred HKD12.34 to EXAMPLE.",
  "Hang Seng: You've received a transfer. Your balance is HKD12.34.",
  notification('HKD12.34') + ' Balance HKD100.00.',
  notification('HKD12.34') + ' Balance HK$100.00.',
  notification('HKD12.34') + ' ' + notification('HKD56.78'),
  notification('HKD12.34') + '\n' + notification('HKD56.78'),
  notification('HKD12.345') + ' ' + notification('HKD56.78'),
  notification('HKD12.34') + ' ' + notification('HKD56.789'),
  notification('HKD12.34 or HKD56.78'),
  notification('HKD12.34') + ' received a transfer pending.',
  'Balance HKD100.00. ' + notification('HKD12.34'),
  notification('HKD12.34').replace('from', 'for'),
  notification('HKD12.34').replace('a transfer of', 'a transfer worth'),
];
for (const [i, body] of ambiguousOrOther.entries()) {
  test(`manual fallback for ambiguous or different notification ${i + 1}`, () => {
    assert.equal(shortcutURL(body), base);
  });
}

test('curly apostrophe and case-insensitive matching', () => {
  const url = shortcutURL(notification('HKD12.34').replace("You've", 'You’ve').toUpperCase());
  assert.deepEqual(link.parse(new URL(url).hash), { view: 'reimburse', amount: '12.34' });
});
test('encode only the captured amount and carry no sender or account data', () => {
  assert.equal(shortcutURL(notification('HKD1,234.50')), base + '?amount=1%2C234.50');
});
