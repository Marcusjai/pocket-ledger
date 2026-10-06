'use strict';
// Deterministic simulated-DOM integration, not a real-browser/IndexedDB test.
// Executes the real app, parser, engine and store domain functions. The adapter
// implements only the DOM methods used here and a transactional in-memory store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const EXPENSE = 'synthetic-expense-0001';
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class Element {
  constructor(tag = '', attributes = '', content = '') {
    this.tag = tag;
    this.id = /\bid="([^"]+)"/.exec(attributes)?.[1] || '';
    this.hidden = /(?:^|\s)hidden(?:\s|$|>)/.test(attributes);
    this.disabled = false;
    this.checked = /(?:^|\s)checked(?:\s|$|>)/.test(attributes);
    this.attributes = {};
    this.dataset = {};
    for (const [, key, value] of attributes.matchAll(/data-([a-z]+)="([^"]*)"/g)) this.dataset[key] = value;
    this.className = /\bclass="([^"]+)"/.exec(attributes)?.[1] || '';
    this.classList = { toggle() {} };
    this.listeners = {};
    this._value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '';
    this.textContent = '';
    this.innerHTML = content;
    this.defaultValue = this.value;
  }
  get value() { return this._value; }
  set value(value) { this._value = this.tag === 'select' && !this.options.some(o => o.value === String(value)) ? '' : String(value); }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = value;
    if (this.tag === 'select') {
      this.options = [...value.matchAll(/<option\s+[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => ({ value: m[1], textContent: m[2] }));
      this._value = this.options[0]?.value || '';
    }
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(option) { (this.options ||= []).push(option); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); this['on' + type]?.(event); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.onclick?.({ target: this }); }
}

function makeDOM() {
  const elements = new Map(), all = [];
  for (const match of HTML.matchAll(/<(\w+)([^>]*\bid="[^"]+"[^>]*)>/g)) {
    const [opening, tag, attributes] = match;
    const end = HTML.indexOf('</' + tag + '>', match.index + opening.length);
    const content = end < 0 ? '' : HTML.slice(match.index + opening.length, end);
    const el = new Element(tag, attributes, content);
    elements.set(el.id, el); all.push(el);
  }
  const nav = [...HTML.matchAll(/<button([^>]*\bdata-view="[^"]+"[^>]*)>/g)].map(m => new Element('button', m[1]));
  const radios = [...HTML.matchAll(/<input([^>]*\bname="source"[^>]*)>/g)].map(m => new Element('input', m[1]));
  for (const id of ['entry-form', 'reimbursement-form']) {
    const form = elements.get(id);
    const ids = [...form.innerHTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    form.reset = () => { for (const id of ids) { const el = elements.get(id); if (['input', 'select'].includes(el?.tag)) el.value = el.defaultValue; } };
  }
  const document = {
    body: new Element('body'), hidden: false, listeners: {},
    getElementById: id => elements.get(id),
    createElement: tag => new Element(tag),
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelectorAll(selector) {
      if (selector === '.view') return all.filter(el => el.className.split(' ').includes('view'));
      if (selector === 'nav button' || selector === '[data-view]') return nav;
      if (selector === '[data-category]') return [];
      throw new Error('Unimplemented test selector: ' + selector);
    },
    querySelector(selector) {
      if (selector === 'input[name=source]:checked') return radios.find(r => r.checked);
      if (selector === 'input[name=source][value=Cash]') return radios.find(r => r.value === 'Cash');
      if (selector.startsWith('[data-record=')) return null;
      throw new Error('Unimplemented test selector: ' + selector);
    }
  };
  return { document, elements, nav };
}

async function harness(fragment = 'dashboard', options = {}) {
  const dom = makeDOM();
  let hash = '#' + fragment;
  const entries = [hash]; let position = 0;
  const window = { listeners: {}, scrollTo() {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  const emitHash = () => { for (const fn of window.listeners.hashchange || []) fn(); };
  const location = {
    get href() { return 'https://synthetic.invalid/' + hash; },
    get hash() { return hash; },
    set hash(value) { const next = value.startsWith('#') ? value : '#' + value; if (next === hash) return; hash = next; entries.splice(position + 1); entries.push(hash); position++; emitHash(); }
  };
  const history = {
    replaceState(_state, _title, next) { hash = next; entries[position] = next; },
    back() { if (position > 0) { hash = entries[--position]; emitHash(); } },
    forward() { if (position < entries.length - 1) { hash = entries[++position]; emitHash(); } }
  };
  const context = vm.createContext({ document: dom.document, window, location, history,
    navigator: { onLine: true }, URL, Blob, crypto, structuredClone, console,
    setTimeout: () => 1, clearTimeout() {},
    fetch() { throw new Error('Network forbidden in simulated-DOM tests'); }
  });
  for (const file of ['engine.js', 'store.js', 'repayment-link.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  const S = context.LedgerStore;
  let ledger = structuredClone(S.initial()), writes = 0, nextMutation = null;
  S.read = async () => { if (options.initialRead) await options.initialRead; return structuredClone(ledger); };
  S.mutate = async fn => {
    if (nextMutation) { const pending = nextMutation; nextMutation = null; await pending.promise; }
    const draft = structuredClone(ledger), result = fn(draft);
    ledger = draft; writes++;
    return result;
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), context, { filename: 'app.js' });
  await tick();
  const el = id => dom.elements.get(id);
  return {
    ...dom, context, el, location, history, entries,
    run: code => vm.runInContext(code, context),
    ledger: () => structuredClone(ledger), writes: () => writes,
    route: value => { location.hash = value; },
    field(name, value, event = true) {
      el('reimbursement-' + name).value = value;
      if (event) el('reimbursement-form').dispatch(name === 'expense' || name === 'source' ? 'change' : 'input');
      if (name === 'expense') el('reimbursement-expense').onchange?.();
    },
    async seed(amount = '200.00') {
      S.add(ledger, { id: EXPENSE, amount, source: 'Cash', category: 'Dining', merchant: 'Synthetic only', timestamp: '2026-10-06T12:00:00Z' });
      await vm.runInContext('refresh()', context);
    },
    pauseMutation() { nextMutation = defer(); return nextMutation; },
    submit() { return el('reimbursement-form').onsubmit({ preventDefault() {} }); },
  };
}

const draft = h => Object.fromEntries(['expense', 'amount', 'payer', 'note', 'time', 'source'].map(field => [field, h.el('reimbursement-' + field).value]));
const blank = { expense: '', amount: '', payer: '', note: '', time: '', source: 'BankTransfer' };

test('cold valid link only fills amount and consumes payload without writes', async () => {
  const h = await harness('reimburse?amount=HK%24%201%2C234.50');
  assert.deepEqual(draft(h), { ...blank, amount: '1234.50' });
  assert.equal(h.location.hash, '#reimburse');
  assert.equal(h.el('reimbursement-form').hidden, false);
  assert.equal(h.el('entry-form').hidden, true);
  assert.equal(h.el('save-reimbursement').disabled, true);
  assert.equal(h.writes(), 0);
  assert.deepEqual(h.ledger().transactions, []);
});

test('open-page link preserves independent expense draft', async () => {
  const h = await harness('add');
  h.el('amount').value = '77.70'; h.el('note').value = 'Synthetic expense';
  h.route('reimburse?amount=63');
  assert.equal(h.el('reimbursement-amount').value, '63.00');
  h.el('mode-expense').click();
  assert.equal(h.el('amount').value, '77.70');
  assert.equal(h.el('note').value, 'Synthetic expense');
  assert.equal(h.writes(), 0);
});

test('invalid payloads strip fragment and hand off manually without writes', async () => {
  for (const payload of ['amount=', 'amount=USD63', 'amount=%', 'amount=63&amount=64', 'amount=63&token=synthetic', 'amount=0', 'amount=%3Cscript%3E', '', 'amount=' + '1'.repeat(300)]) {
    const h = await harness('reimburse?' + payload);
    assert.equal(h.location.hash, '#reimburse', payload);
    assert.deepEqual(draft(h), blank, payload);
    assert.match(h.el('repayment-link-message').textContent, /格式未能確認/);
    assert.equal(h.el('repayment-link-actions').hidden, true);
    assert.equal(h.writes(), 0);
  }
});

test('plain route has no handoff notice', async () => {
  const h = await harness('reimburse');
  assert.deepEqual(draft(h), blank);
  assert.equal(h.el('repayment-link-notice').hidden, true);
});

test('every individual existing field and edited-cleared draft blocks overwrite', async () => {
  for (const [name, value] of [['expense', EXPENSE], ['amount', '12'], ['payer', 'Synthetic'], ['note', 'Draft'], ['time', '2026-10-06T12:34'], ['source', 'FPS']]) {
    const h = await harness('reimburse'); await h.seed();
    // A pre-existing value must also be detected when no DOM input event fired.
    h.field(name, value, false); h.route('reimburse?amount=63');
    assert.equal(h.el('reimbursement-' + name).value, value);
    assert.equal(h.el('repayment-link-actions').hidden, false, name);
    assert.equal(h.writes(), 0);
  }
  const h = await harness('reimburse');
  h.field('payer', 'Synthetic'); h.field('payer', ''); h.route('reimburse?amount=63');
  assert.deepEqual(draft(h), blank);
  assert.equal(h.el('repayment-link-actions').hidden, false);
});

test('keep preserves full draft; explicit discard resets full draft then prefills', async () => {
  const h = await harness('reimburse'); await h.seed();
  const existing = { expense: EXPENSE, amount: '55', payer: 'Synthetic', note: 'Draft', time: '2026-10-06T12:34', source: 'PayMe' };
  for (const [field, value] of Object.entries(existing)) h.field(field, value);
  h.route('reimburse?amount=63'); assert.deepEqual(draft(h), existing);
  h.el('keep-repayment-draft').click(); assert.deepEqual(draft(h), existing);
  assert.equal(h.el('repayment-link-notice').hidden, true);
  h.route('reimburse?amount=64'); h.el('replace-repayment-draft').click();
  assert.deepEqual(draft(h), { ...blank, amount: '64.00' });
  assert.equal(h.el('save-reimbursement').disabled, true);
  assert.equal(h.writes(), 0);
});

test('repeated link never saves and latest pending amount wins', async () => {
  const h = await harness('reimburse?amount=63');
  h.route('reimburse?amount=63');
  assert.equal(h.el('repayment-link-actions').hidden, false);
  h.route('reimburse?amount=64'); h.field('note', 'Edit while deciding');
  h.el('replace-repayment-draft').click();
  assert.deepEqual(draft(h), { ...blank, amount: '64.00' });
  assert.equal(h.writes(), 0);
});

test('navigation, invalid link and mode switch dismiss stale pending replacement', async () => {
  const h = await harness('reimburse?amount=63');
  for (const destination of ['settings', 'reimburse?amount=USD63', 'add']) {
    h.route('reimburse?amount=64'); h.route(destination);
    h.el('replace-repayment-draft').click();
    assert.equal(h.el('reimbursement-amount').value, '63.00');
    assert.equal(h.el('repayment-link-actions').hidden, true);
  }
  h.el('mode-expense').click(); h.el('mode-reimbursement').click();
  assert.equal(h.el('repayment-link-notice').hidden, true);
});

test('Back/Forward returns consumed routes without replaying handoff', async () => {
  const h = await harness();
  h.route('reimburse?amount=63'); h.field('amount', '62.00'); h.route('settings');
  h.history.back(); assert.equal(h.location.hash, '#reimburse');
  assert.equal(h.el('reimbursement-amount').value, '62.00');
  assert.equal(h.el('repayment-link-notice').hidden, true);
  h.history.back(); assert.equal(h.location.hash, '#dashboard');
  h.history.forward(); assert.equal(h.location.hash, '#reimburse');
  assert.equal(h.el('reimbursement-amount').value, '62.00');
  assert(h.entries.every(hash => !hash.includes('amount=')));
  assert.equal(h.writes(), 0);
});

test('only explicit valid save writes a repayment and resets for next handoff', async () => {
  const h = await harness(); await h.seed();
  h.route('reimburse?amount=63.25');
  assert.equal(h.el('save-reimbursement').disabled, true);
  h.field('expense', EXPENSE);
  assert.equal(h.writes(), 0);
  await h.submit();
  assert.equal(h.writes(), 1);
  assert.equal(h.location.hash, '#dashboard');
  const payments = h.ledger().transactions.filter(r => r.kind === 'reimbursement');
  assert.equal(payments.length, 1); assert.equal(payments[0].amountCents, 6325);
  assert.equal(payments[0].expenseId, EXPENSE);
  h.route('reimburse?amount=64');
  assert.deepEqual(draft(h), { ...blank, amount: '64.00' });
  assert.equal(h.el('repayment-link-actions').hidden, true);
});

test('missing original expense and oversized repayment fail without writing', async () => {
  const h = await harness('reimburse?amount=100.01'); await h.seed('100');
  await h.submit(); assert.equal(h.writes(), 0);
  assert.match(h.el('toast').textContent, /請選擇原本嘅支出/);
  h.field('expense', EXPENSE); await h.submit();
  assert.match(h.el('toast').textContent, /累計還款不可超過原支出/);
  assert.equal(h.writes(), 0);
  assert.equal(h.el('reimbursement-amount').value, '100.01');
  h.field('amount', '99.99'); await h.submit();
  assert.equal(h.writes(), 1);
});

async function pausedSave() {
  const h = await harness(); await h.seed();
  h.route('reimburse?amount=63'); h.field('expense', EXPENSE);
  const pending = h.pauseMutation(), saved = h.submit();
  return { h, pending, saved };
}

test('pending save rejects repeated submit and retains newest handoff after success', async () => {
  const { h, pending, saved } = await pausedSave();
  await h.submit();
  h.route('reimburse?amount=64'); h.route('reimburse?amount=65');
  assert.equal(h.el('repayment-link-actions').hidden, true);
  pending.resolve(); await saved;
  assert.equal(h.writes(), 1);
  assert.equal(h.location.hash, '#reimburse');
  assert.deepEqual(draft(h), { ...blank, amount: '65.00' });
  assert.equal(h.el('save-reimbursement').disabled, true);
  assert.equal(h.ledger().transactions.filter(r => r.kind === 'reimbursement').length, 1);
});

test('pending save respects newer navigation and discards stale pending handoff', async () => {
  const { h, pending, saved } = await pausedSave();
  h.route('reimburse?amount=64'); h.route('settings');
  pending.resolve(); await saved;
  assert.equal(h.location.hash, '#settings');
  assert.equal(h.el('settings').hidden, false);
  h.el('replace-repayment-draft').click();
  assert.deepEqual(draft(h), blank);
  assert.equal(h.writes(), 1);
});

test('pending save keeps newer user edits and offers conflict against newer link', async () => {
  const { h, pending, saved } = await pausedSave();
  h.field('amount', '62'); h.field('note', 'Newer edit');
  h.route('reimburse?amount=64');
  pending.resolve(); await saved;
  assert.equal(h.el('reimbursement-amount').value, '62');
  assert.equal(h.el('reimbursement-note').value, 'Newer edit');
  assert.equal(h.el('repayment-link-actions').hidden, false);
  assert.equal(h.location.hash, '#reimburse');
  assert.equal(h.ledger().transactions.find(r => r.kind === 'reimbursement').amountCents, 6300);
  h.el('keep-repayment-draft').click();
  assert.equal(h.el('reimbursement-note').value, 'Newer edit');
});

test('failed delayed save preserves full draft and allows latest pending replacement', async () => {
  const { h, pending, saved } = await pausedSave();
  h.route('reimburse?amount=64');
  pending.reject(new Error('Synthetic write failure')); await saved;
  assert.equal(h.writes(), 0);
  assert.deepEqual(draft(h), { ...blank, expense: EXPENSE, amount: '63.00' });
  assert.match(h.el('toast').textContent, /Synthetic write failure/);
  assert.equal(h.el('repayment-link-actions').hidden, false);
  h.el('replace-repayment-draft').click();
  assert.deepEqual(draft(h), { ...blank, amount: '64.00' });
});

test('delayed initial storage read consumes only latest link after readiness', async () => {
  const ready = defer();
  const h = await harness('reimburse?amount=63', { initialRead: ready.promise });
  h.route('reimburse?amount=64');
  ready.resolve(); await tick();
  assert.equal(h.location.hash, '#reimburse');
  assert.equal(h.el('reimbursement-amount').value, '64.00');
  assert.equal(h.writes(), 0);
});

test('failed startup shows storage error without any transaction', async () => {
  const ready = defer();
  const h = await harness('reimburse?amount=63', { initialRead: ready.promise });
  ready.reject(new Error('Synthetic storage unavailable')); await tick();
  assert.match(h.el('status').textContent, /無法開啟本機資料庫/);
  assert.match(h.el('toast').textContent, /Synthetic storage unavailable/);
  assert.equal(h.writes(), 0);
  assert.deepEqual(h.ledger().transactions, []);
});

test('refresh keeps existing selected draft and does not replay consumed handoff', async () => {
  const h = await harness(); await h.seed();
  h.route('reimburse?amount=63'); h.field('expense', EXPENSE); h.field('amount', '62');
  await h.run('refresh()');
  assert.deepEqual(draft(h), { ...blank, expense: EXPENSE, amount: '62' });
  assert.equal(h.el('repayment-link-notice').hidden, true);
  assert.equal(h.writes(), 0);
});
