'use strict';
// Independent, dependency-free service-worker regression tests. These execute
// the production worker in a VM with a deterministic Cache/HTTP-cache model;
// they do not claim to validate a native browser's service-worker lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const base = 'https://example.invalid/pocket-ledger/';
const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const oldHtml = '<!doctype html><title>Pocket Ledger</title><p>Pocket Ledger v1.2.0</p>';
const oldCache = 'pocket-ledger-shell-36d71b8a93ed';

function environment(options = {}) {
  const handlers = {};
  const buckets = new Map();
  const networkCalls = [];
  const addAllCalls = [];
  const deletions = [];
  const opens = [];
  let claims = 0;
  let skips = 0;
  const key = request => new URL(typeof request === 'string' ? request : request.url, base).href;
  const normalize = (input, init) => new Request(key(input), init);
  const bodyFor = request => {
    const url = new URL(request.url);
    const relative = url.pathname.slice(new URL(base).pathname.length) || 'index.html';
    if (relative === 'index.html') return options.serverHtml ?? index;
    return fs.readFileSync(path.join(root, relative));
  };
  const network = async input => {
    const request = input instanceof Request ? input : normalize(input);
    networkCalls.push(request);
    if (options.offline) throw new TypeError('Network unavailable');
    if (options.failPath && new URL(request.url).pathname.endsWith(options.failPath)) {
      return new Response('not found', { status: 404 });
    }
    const htmlRequest = request.url === base || request.url === base + 'index.html';
    // A fresh old HTTP response is a valid result of a default-cache fetch.
    const body = options.staleHttpCache && htmlRequest && request.cache !== 'reload'
      ? oldHtml : bodyFor(request);
    return new Response(body, { headers: { 'content-type': htmlRequest ? 'text/html' : 'application/octet-stream' } });
  };
  const put = (name, request, body) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    buckets.get(name).set(key(request), body instanceof Response ? body : new Response(body));
  };
  const caches = {
    open: async name => {
      opens.push(name);
      if (options.openFailure) throw new Error('Cache open failed');
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name);
      return {
        addAll: async inputs => {
          const requests = Array.from(inputs, input => input instanceof Request ? input : normalize(input));
          addAllCalls.push(requests);
          // Cache.addAll commits as one batch only after every response succeeds.
          const fetched = await Promise.all(requests.map(async request => {
            const response = await network(request);
            if (!response.ok) throw new TypeError('Cache.addAll received an unsuccessful response');
            return [key(request), response];
          }));
          for (const [url, response] of fetched) bucket.set(url, response);
          if (options.dropIndexAfterAdd) bucket.delete(base + 'index.html');
        },
        match: async request => bucket.get(key(request))?.clone(),
        put: async (request, response) => bucket.set(key(request), response.clone())
      };
    },
    keys: async () => [...buckets.keys()],
    delete: async name => { deletions.push(name); return buckets.delete(name); },
    match: async () => assert.fail('Worker must never use global caches.match')
  };
  const context = vm.createContext({
    URL, Request: function (input, init) { return normalize(input, init); }, Response,
    fetch: network, caches,
    self: {
      location: { origin: new URL(base).origin, href: base + 'sw.js' },
      clients: { claim: async () => { claims++; } },
      skipWaiting: async () => { skips++; },
      addEventListener: (name, handler) => { handlers[name] = handler; }
    }
  });
  vm.runInContext(source, context);
  const cache = vm.runInContext('CACHE', context);
  const release = vm.runInContext('RELEASE', context);
  const assets = Array.from(vm.runInContext('ASSETS', context));
  const lifecycle = name => {
    let pending;
    handlers[name]({ waitUntil: promise => { pending = promise; } });
    assert.ok(pending, `${name} must extend its lifetime`);
    return pending;
  };
  const dispatch = (url, mode = 'navigate', method = 'GET') => {
    let response;
    handlers.fetch({ request: { url: new URL(url, base).href, method, mode }, respondWith: promise => { response = promise; } });
    return response;
  };
  return { options, cache, release, assets, put, buckets, networkCalls, addAllCalls, deletions, opens,
    install: () => lifecycle('install'), activate: () => lifecycle('activate'), dispatch,
    claims: () => claims, skips: () => skips };
}

test('review: every precache fetch bypasses a fresh stale HTTP shell and uses the worker subdirectory', async () => {
  const env = environment({ staleHttpCache: true });
  env.put(oldCache, './index.html', oldHtml);
  await env.install();
  assert.equal(env.addAllCalls.length, 1);
  assert.equal(env.addAllCalls[0].length, env.assets.length);
  for (const request of env.addAllCalls[0]) {
    assert.equal(request.cache, 'reload');
    assert.ok(request.url.startsWith(base), request.url);
    assert.equal(request.method, 'GET');
  }
  const cachedHtml = env.buckets.get(env.cache).get(base + 'index.html');
  assert.equal(await cachedHtml.clone().text(), index);
  assert.equal(await env.buckets.get(oldCache).get(base + 'index.html').clone().text(), oldHtml);
  assert.deepEqual(env.deletions, []);
  assert.equal(env.skips(), 0, 'Installing must not replace an in-use page');
});

test('review: the production HTML and SW share an exact release marker and visible v1.2.2', () => {
  const env = environment();
  const markers = [...index.matchAll(/<meta name="pocket-ledger-release" content="([^"]+)">/g)];
  assert.equal(markers.length, 1);
  assert.equal(markers[0][1], env.release);
  assert.match(index, /Pocket Ledger v1\.2\.2/);
  assert.notEqual(env.cache, oldCache);
  assert.notEqual(env.cache, 'pocket-ledger-shell-repayment-prefill-1');
});

for (const [label, html] of [
  ['old release without a marker', oldHtml],
  ['wrong release marker', '<meta name="pocket-ledger-release" content="wrong-release">'],
  ['a marker whose release is merely a matching prefix', null]
]) {
  test(`review: installation rejects ${label}, removes the candidate, and preserves active/other caches`, async () => {
    const env = environment();
    env.options.serverHtml = html ?? `<meta name="pocket-ledger-release" content="${env.release}-future">`;
    env.put(oldCache, './index.html', oldHtml);
    env.put('unrelated-app', './keep', 'unrelated cached data');
    await assert.rejects(env.install(), /release does not match/);
    assert.deepEqual(env.deletions, [env.cache]);
    assert.ok(!env.buckets.has(env.cache));
    assert.equal(await env.buckets.get(oldCache).get(base + 'index.html').clone().text(), oldHtml);
    assert.ok(env.buckets.has('unrelated-app'));
    assert.equal(env.claims(), 0);
    assert.equal(env.skips(), 0);
  });
}

test('review: missing cached index prevents successful installation', async () => {
  const env = environment({ dropIndexAfterAdd: true });
  env.put(oldCache, './index.html', oldHtml);
  await assert.rejects(env.install(), /release does not match/);
  assert.ok(!env.buckets.has(env.cache));
  assert.ok(env.buckets.has(oldCache));
});

test('review: one unavailable asset rejects the complete update and leaves the active cache untouched', async () => {
  const env = environment({ failPath: '/icons/icon-512.png' });
  env.put(oldCache, './index.html', oldHtml);
  await assert.rejects(env.install(), /unsuccessful response/);
  assert.deepEqual(env.deletions, [env.cache]);
  assert.ok(!env.buckets.has(env.cache));
  assert.equal(await env.buckets.get(oldCache).get(base + 'index.html').clone().text(), oldHtml);
});

test('review: offline installation fails without deleting any existing release', async () => {
  const env = environment({ offline: true });
  env.put(oldCache, './index.html', oldHtml);
  await assert.rejects(env.install(), /Network unavailable/);
  assert.deepEqual(env.deletions, [env.cache]);
  assert.ok(env.buckets.has(oldCache));
});

test('review: a failed attempt can retry successfully using a clean candidate', async () => {
  const env = environment({ serverHtml: oldHtml });
  env.put(oldCache, './index.html', oldHtml);
  await assert.rejects(env.install(), /release does not match/);
  env.options.serverHtml = index;
  await env.install();
  assert.equal(await env.buckets.get(env.cache).get(base + 'index.html').clone().text(), index);
  assert.ok(env.buckets.has(oldCache));
});

test('review: navigation and static files use only this worker cache even while older caches remain', async () => {
  const env = environment({ offline: true });
  env.put(oldCache, './index.html', oldHtml);
  env.put(oldCache, './app.js?v=repayment-prefill-1', 'stale script');
  env.put('unrelated-app', './index.html', 'other app HTML');
  env.put(env.cache, './index.html', index);
  env.put(env.cache, './app.js?v=repayment-prefill-1', 'correct script');
  assert.equal(await (await env.dispatch('./#reimburse?amount=12.34')).text(), index);
  assert.equal(await (await env.dispatch('./app.js?v=repayment-prefill-1', 'cors')).text(), 'correct script');
  assert.equal(env.networkCalls.length, 0);
  assert.deepEqual(env.opens, [env.cache, env.cache]);
});

test('review: installed shell supports offline navigation and every listed shell asset', async () => {
  const env = environment();
  await env.install();
  const fetchCount = env.networkCalls.length;
  env.options.offline = true;
  assert.equal(await (await env.dispatch('./index.html?from=shortcut#reimburse?amount=12.34')).text(), index);
  for (const asset of env.assets) assert.equal((await env.dispatch(asset, 'cors')).status, 200, asset);
  assert.equal(env.networkCalls.length, fetchCount);
});

test('review: activation removes only old app-shell caches after a successful installation', async () => {
  const env = environment();
  env.put(oldCache, './index.html', oldHtml);
  env.put('pocket-ledger-shell-repayment-prefill-1', './index.html', oldHtml);
  env.put('ledger-records', './keep', 'keep records');
  env.put('unrelated-app', './keep', 'keep other data');
  await env.install();
  assert.deepEqual(env.deletions, []);
  await env.activate();
  assert.deepEqual(env.deletions.sort(), [oldCache, 'pocket-ledger-shell-repayment-prefill-1'].sort());
  assert.ok(env.buckets.has(env.cache));
  assert.ok(env.buckets.has('ledger-records'));
  assert.ok(env.buckets.has('unrelated-app'));
  assert.equal(env.claims(), 1);
  assert.equal(env.skips(), 0);
});

test('review: cross-origin backend GET/POST and same-origin writes are not intercepted', () => {
  const env = environment();
  for (const [url, method] of [
    ['https://script.google.com/macros/s/example/exec', 'GET'],
    ['https://script.google.com/macros/s/example/exec', 'POST'],
    ['https://script.googleusercontent.com/macros/echo?example=1', 'GET'],
    [base + 'write', 'POST'], [base + 'write', 'PUT'], [base + 'write', 'DELETE']
  ]) assert.equal(env.dispatch(url, 'cors', method), undefined, `${method} ${url}`);
  assert.equal(env.networkCalls.length, 0);
  assert.deepEqual(env.opens, []);
});

test('review: an unmatched same-origin request falls back to the network without populating any cache', async () => {
  const env = environment();
  env.put(oldCache, './app.js?v=unlisted', 'must not leak an old cached match');
  env.put(env.cache, './index.html', index);
  const result = await env.dispatch('./app.js?v=unlisted', 'cors');
  assert.equal(await result.text(), fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  assert.equal(env.networkCalls.length, 1);
  assert.ok(!env.buckets.get(env.cache).has(base + 'app.js?v=unlisted'));
});

test('review: missing own navigation entry uses network rather than another release cache', async () => {
  const env = environment();
  env.put(oldCache, './index.html', oldHtml);
  const response = await env.dispatch('./index.html');
  assert.equal(await response.text(), index);
  assert.equal(env.networkCalls.length, 1);
});
