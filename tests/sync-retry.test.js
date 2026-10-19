'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../engine.js');
const S = require('../store.js');

const config = { endpoint: 'https://script.google.com/macros/s/abc_DEF-123/exec', token: 't' };
const ok = body => ({ ok: true, status: 200, json: async () => body });
const htmlPage = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
const scripted = steps => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fetchImpl };
};
const waits = [];
const wait = async ms => { waits.push(ms); };

test('first-request network failure after opening the app is retried silently', async () => {
  waits.length = 0;
  const { calls, fetchImpl } = scripted([new TypeError('Load failed'), ok({ ok: true, transactions: [], rules: [] })]);
  const res = await S.send(config, { action: 'list', operationId: 'op-1' }, { fetchImpl, wait });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operationId, calls[1].operationId, 'retry must reuse the same operationId');
  assert.deepEqual(waits, [1500]);
});

test('Apps Script cold-start HTML page and 5xx are retried', async () => {
  waits.length = 0;
  const { calls, fetchImpl } = scripted([htmlPage, { ok: false, status: 503 }, ok({ ok: true })]);
  assert.equal((await S.send(config, { action: 'list' }, { fetchImpl, wait })).ok, true);
  assert.equal(calls.length, 3);
});

test('a real outage still reports the connection error after three attempts', async () => {
  const { calls, fetchImpl } = scripted([new TypeError('Load failed')]);
  await assert.rejects(S.send(config, { action: 'list' }, { fetchImpl, wait }), /連線失敗/);
  assert.equal(calls.length, 3);
});

test('client errors and timeouts are not retried', async () => {
  const notFound = scripted([{ ok: false, status: 404 }]);
  await assert.rejects(S.send(config, { action: 'list' }, { fetchImpl: notFound.fetchImpl, wait }), /伺服器暫時未能回應/);
  assert.equal(notFound.calls.length, 1);
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const slow = scripted([abort]);
  await assert.rejects(S.send(config, { action: 'list' }, { fetchImpl: slow.fetchImpl, wait }), /同步逾時/);
  assert.equal(slow.calls.length, 1);
});
