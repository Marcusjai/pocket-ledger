'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const link = require('../repayment-link.js');
const engine = require('../engine.js');

const valid = [
  ['63', '63.00'], ['63.5', '63.50'], ['0.01', '0.01'], ['00063.50', '63.50'],
  ['HKD 1,234.50', '1234.50'], ['HK$63.00', '63.00'], ['hkd\u00a0123', '123.00'],
  ['  1,000,000.1  ', '1000000.10'], ['9,999,999.99', '9999999.99']
];
for (const [input, expected] of valid) test(`normalizes HKD amount ${JSON.stringify(input)}`, () => {
  assert.equal(link.amount(input), expected);
  assert.doesNotThrow(() => engine.cents(expected));
  assert.deepEqual(link.parse('#reimburse?amount=' + encodeURIComponent(input)), { view: 'reimburse', amount: expected });
});

const invalid = [
  '', ' ', '0', '0.00', '-1', '+1', '(1)', '.50', '1.', '1.234', '1e2', '1E+2',
  'NaN', 'Infinity', '10000000', '99,999,999.99', '1,23.45', '12,34', '1,0000',
  ',123', '1,,000', '1 000.00', '1.000,00', 'USD 63.00', '$63.00', 'HKD HK$63',
  'HKD 63.00 received', '63 and 64', '63/64', '63\u0000', '６３.００',
  '<script>1</script>', null, undefined, 63, {}, ['63']
];
for (const input of invalid) test(`rejects invalid or ambiguous amount ${JSON.stringify(input)}`, () => {
  assert.equal(link.amount(input), null);
});

test('preserves existing routes and plain repayment link', () => {
  for (const view of ['', 'dashboard', 'add', 'review', 'settings', 'reimburse', 'unknown', 'add?amount=63']) {
    assert.deepEqual(link.parse('#' + view), { view });
  }
});
test('uses standard percent/space encoding but never double-decodes', () => {
  assert.deepEqual(link.parse('reimburse?amount=HKD+1%2C234.50'), { view: 'reimburse', amount: '1234.50' });
  for (const value of ['%2B63', '63%', '%ZZ', '%C3%28', '%2536%2533', '63%26amount%3D64']) {
    assert.deepEqual(link.parse('reimburse?amount=' + value), { view: 'reimburse', invalid: true });
  }
});
test('rejects missing, duplicate, unknown and overlong payloads', () => {
  for (const payload of ['', 'amount', 'amount=', 'amount=0', 'amount=63&amount=64', 'amount=63&',
    'amount=63&payer=Alex', 'payer=Alex&amount=63', 'currency=USD&amount=63', 'Amount=63',
    'amount=63?amount=64', 'amount=63#dashboard', 'amount=' + '1'.repeat(257), 'amount=' + '%20'.repeat(257) + '63']) {
    assert.deepEqual(link.parse('reimburse?' + payload), { view: 'reimburse', invalid: true });
  }
});
test('accepted decimal amounts round-trip to identical integer cents', () => {
  for (const cents of [1, 9, 10, 29, 63, 99, 100, 101, 1005, 99999999, 999999998, 999999999]) {
    const raw = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    assert.equal(engine.cents(link.amount(raw)), cents);
  }
});
