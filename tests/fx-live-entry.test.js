'use strict';
// Manual foreign-currency entries follow the live HKD exchange rate (synthetic rate payloads only).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path');
const R = require('../fx-rates.js');
const E = require('../engine.js');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');

const payload = rates => ({ result: 'success', base_code: 'HKD', time_last_update_unix: 1760745600, rates: { HKD: 1, ...rates } });
const okFetch = (body, calls = []) => async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => body }; };
const memory = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; };

test('HKD per unit is the inverse of the HKD-based API rate', () => {
  assert.equal(R.hkdPer(payload({ USD: 0.128 }), 'USD'), 7.8125);
  assert.equal(R.hkdPer(payload({ JPY: 19.6 }), 'JPY'), 0.0510204);
  assert.equal(R.hkdPer(payload({ USD: 0 }), 'USD'), null);
  assert.equal(R.hkdPer({}, 'USD'), null);
});

test('liveRate fetches once, then reuses the cached rate within the hour', async () => {
  const calls = [], storage = memory(), now = Date.UTC(2026, 9, 18, 6);
  const first = await R.liveRate('USD', { fetchImpl: okFetch(payload({ USD: 0.128, CNY: 0.92 }), calls), storage, now });
  assert.deepEqual([first.rate, first.cached], [7.8125, false]);
  assert.equal(calls[0].url, 'https://open.er-api.com/v6/latest/HKD');
  assert.equal(calls[0].init.credentials, 'omit');
  const second = await R.liveRate('CNY', { fetchImpl: okFetch(payload({}), calls), storage, now: now + 30 * 60 * 1000 });
  assert.deepEqual([second.rate, second.cached, calls.length], [1.08696, true, 1]);
  const third = await R.liveRate('USD', { fetchImpl: okFetch(payload({ USD: 0.125 }), calls), storage, now: now + 61 * 60 * 1000 });
  assert.deepEqual([third.rate, calls.length], [8, 2]);
});

test('offline: recent cached rate is reused; otherwise no live rate', async () => {
  const storage = memory(), now = Date.UTC(2026, 9, 18, 6);
  await R.liveRate('USD', { fetchImpl: okFetch(payload({ USD: 0.128 })), storage, now });
  const failing = async () => { throw new TypeError('offline'); };
  assert.equal((await R.liveRate('USD', { fetchImpl: failing, storage, now: now + 5 * 3600e3 })).rate, 7.8125);
  assert.equal((await R.liveRate('USD', { fetchImpl: failing, storage, now: now + 49 * 3600e3 })).rate, null);
  assert.equal((await R.liveRate('USD', { fetchImpl: failing, storage: memory(), now })).rate, null);
  const bad = async () => ({ ok: true, json: async () => ({ result: 'error' }) });
  assert.equal((await R.liveRate('USD', { fetchImpl: bad, storage: memory(), now })).rate, null);
});

test('converted record keeps the original amount and rate; failed lookup is flagged 估算', () => {
  const live = E.convertToHkd({ currency: 'USD', amount: '10.00' }, 7.8125);
  const r = E.prepare({ id: 'manual-fx-0000001', source: 'Cash', currency: 'HKD', amount: live.amount, timestamp: '2026-10-18T14:00:00+08:00', category: 'Dining', fx: live.fx }, [], 'n');
  assert.equal(r.amountCents, 7813);
  assert.deepEqual([r.fx.currency, r.fx.amount, r.fx.rate, r.fx.estimated], ['USD', '10.00', 7.8125, false]);
  assert.deepEqual(E.fxBadges(r.fx), []);
  const est = E.convertToHkd({ currency: 'USD', amount: '10.00' }, null);
  const e = E.prepare({ id: 'manual-fx-0000002', source: 'Cash', currency: 'HKD', amount: est.amount, timestamp: '2026-10-18T14:00:00+08:00', category: 'Dining', fx: est.fx }, [], 'n');
  assert.equal(e.amountCents, 7780);
  assert.deepEqual(E.fxBadges(e.fx).map(b => b.label), ['估算']);
});

test('page allows the rate API and ships the rate script offline', () => {
  assert.match(html, /connect-src [^;]*https:\/\/open\.er-api\.com/);
  assert.match(html, /<select id="entry-currency"[^>]*>.*value="USD".*value="JPY".*value="CNY">RMB.*value="TWD".*value="TRY"/);
  assert.match(html, /src="\.\/fx-rates\.js\?v=fx-live-1"><\/script><script defer src="\.\/app\.js/);
  assert.match(sw, /'\.\/fx-rates\.js\?v=fx-live-1'/);
});
