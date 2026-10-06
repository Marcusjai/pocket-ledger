'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function worker(overrides = {}) {
  const handlers = {};
  const context = vm.createContext({
    URL, caches: {}, fetch: () => { throw new Error('Unexpected network request'); },
    self: { location: { origin: 'https://example.invalid' }, clients: { claim: async () => {} }, addEventListener: (type, callback) => { handlers[type] = callback; } },
    ...overrides
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
  return { handlers, assets: Array.from(vm.runInContext('ASSETS', context)), cache: vm.runInContext('CACHE', context) };
}

test('offline shell contains every versioned script and stylesheet in HTML', () => {
  const { assets, cache } = worker();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const resources = [...html.matchAll(/(?:src|href)="(\.\/[^"?]+\.(?:js|css)\?[^\"]+)"/g)].map(match => match[1]);
  assert.ok(resources.some(url => url.startsWith('./repayment-link.js?')));
  for (const url of resources) assert.ok(assets.includes(url), `Missing offline asset: ${url}`);
  for (const url of assets) {
    const file = url.split('?')[0];
    assert.ok(fs.existsSync(path.join(root, file)), `Missing asset file: ${file}`);
  }
  assert.notEqual(cache, 'pocket-ledger-shell-36d71b8a93ed');
  assert.match(html, /Pocket Ledger v1\.2\.1/);
});

test('installation caches the complete matching shell', async () => {
  let opened, cached, completed;
  const { handlers, assets, cache } = worker({ caches: { open: async name => { opened = name; return { addAll: async urls => { cached = Array.from(urls); } }; } } });
  handlers.install({ waitUntil: promise => { completed = promise; } });
  await completed;
  assert.equal(opened, cache);
  assert.deepEqual(cached, assets);
});

test('activation removes only older Pocket Ledger shell caches', async () => {
  let completed;
  const removed = [];
  const { handlers, cache } = worker({ caches: { keys: async () => ['pocket-ledger-shell-36d71b8a93ed', 'pocket-ledger-shell-repayment-prefill-1', 'other-app'], delete: async key => { removed.push(key); } } });
  handlers.activate({ waitUntil: promise => { completed = promise; } });
  await completed;
  assert.deepEqual(removed, ['pocket-ledger-shell-36d71b8a93ed']);
  assert.ok(!removed.includes(cache));
});

test('worker leaves cross-origin and non-GET transaction requests alone', () => {
  const { handlers } = worker();
  for (const request of [
    { url: 'https://script.google.com/macros/s/example/exec', method: 'POST' },
    { url: 'https://script.google.com/macros/s/example/exec', method: 'GET' },
    { url: 'https://example.invalid/local', method: 'POST' }
  ]) handlers.fetch({ request, respondWith: () => assert.fail('Must not intercept backend requests') });
});

test('navigation serves the cached HTML from the active release', async () => {
  let response;
  const { handlers } = worker({ caches: { match: async key => { assert.equal(key, './index.html'); return 'cached release HTML'; } } });
  handlers.fetch({ request: { url: 'https://example.invalid/#reimburse?amount=12.34', method: 'GET', mode: 'navigate' }, respondWith: promise => { response = promise; } });
  assert.equal(await response, 'cached release HTML');
});
