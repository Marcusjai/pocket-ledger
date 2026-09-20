(function (root, factory) {
  const api = factory(root.ExpenseEngine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LedgerStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  const initial = () => ({ schema: 1, transactions: [], rules: [], outbox: [], settings: { endpoint: '', token: '' }, lastSync: '', conflict: null, syncLease: null });
  const uid = () => crypto.randomUUID();
  let connection;
  async function open() {
    if (connection) return connection;
    connection = await new Promise((resolve, reject) => {
      const r = indexedDB.open('pocket-ledger-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('state');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('請關閉其他記帳分頁再試'));
    });
    connection.onversionchange = () => { connection.close(); connection = null; };
    return connection;
  }
  async function mutate(fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const request = store.get('ledger');
      let result, error;
      request.onsuccess = () => {
        try {
          const state = request.result || initial();
          result = fn(state);
          store.put(state, 'ledger');
        } catch (e) { error = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(error || tx.error || new Error('無法儲存記錄'));
    });
  }
  async function read() { return mutate(s => structuredClone(s)); }
  function add(state, input) {
    const result = E.insert(state.transactions, input, state.rules);
    if (result.status === 'inserted') {
      state.transactions.push(result.transaction);
      state.outbox.push({ action: 'create', operationId: uid(), transaction: E.inputOf(result.transaction) });
    }
    return result;
  }
  function categorize(state, id, category, remember) {
    if (!E.CATEGORIES.includes(category)) throw new Error('分類不正確');
    const r = state.transactions.find(t => t.id === id);
    if (!r) throw new Error('搵唔到交易');
    state.outbox.push({ action: 'categorize', operationId: uid(), id, version: r.version, category, remember: Boolean(remember) });
    r.category = category; r.needsReview = category === 'Uncategorized'; r.version++;
    if (remember && r.merchantKey) {
      state.rules = state.rules.filter(x => x.merchantKey !== r.merchantKey);
      state.rules.push({ merchantKey: r.merchantKey, category });
    }
  }
  function rememberRule(state, rule) {
    if (typeof rule.merchantKey !== 'string' || !rule.merchantKey || rule.merchantKey.length > 320 || E.merchantKey(rule.merchantKey) !== rule.merchantKey || !E.CATEGORIES.includes(rule.category)) throw new Error('分類規則格式不正確');
    state.rules = state.rules.filter(r => r.merchantKey !== rule.merchantKey);
    state.rules.push({ merchantKey: rule.merchantKey, category: rule.category });
    state.outbox.push({ action: 'rule', operationId: uid(), merchantKey: rule.merchantKey, category: rule.category });
  }
  const target = op => op.action === 'create' ? op.transaction.id : op.id;
  function acknowledge(state, op, remote) {
    state.outbox = state.outbox.filter(x => x.operationId !== op.operationId);
    const oldId = target(op);
    const pending = state.outbox.filter(x => target(x) === oldId);
    let version = remote.version;
    for (const next of pending) {
      if (next.action === 'categorize') { next.id = remote.id; next.version = version++; }
    }
    const latest = pending.filter(x => x.action === 'categorize').at(-1);
    const row = latest ? { ...remote, category: latest.category, needsReview: latest.category === 'Uncategorized', version } : remote;
    state.transactions = state.transactions.filter(t => t.id !== oldId && t.id !== remote.id);
    state.transactions.push(row);
  }
  function merge(state, snapshot) {
    const dirty = new Set(state.outbox.map(target));
    const map = new Map(state.transactions.map(r => [r.id, r]));
    for (const r of snapshot.transactions) if (!dirty.has(r.id)) map.set(r.id, r);
    state.transactions = [...map.values()];
    const rules = new Map(snapshot.rules.map(r => [r.merchantKey, r]));
    for (const op of state.outbox) if (op.action === 'rule') rules.set(op.merchantKey, { merchantKey: op.merchantKey, category: op.category });
    for (const op of state.outbox) if (op.action === 'categorize' && op.remember) {
      const r = state.transactions.find(t => t.id === op.id);
      if (r && r.merchantKey) rules.set(r.merchantKey, { merchantKey: r.merchantKey, category: op.category });
    }
    state.rules = [...rules.values()];
  }
  function resolveConflict(state, keepLocal) {
    const c = state.conflict;
    if (!c) return;
    const op = state.outbox.find(x => x.operationId === c.operationId);
    if (op && keepLocal) { op.version = c.transaction.version; }
    else if (op) acknowledge(state, op, c.transaction);
    state.conflict = null;
  }
  async function sync(io) {
    const owner = uid();
    let acquired = false;
    await io.mutate(s => {
      if (s.syncLease && s.syncLease.expires > Date.now()) throw new Error('另一個分頁正在同步，請稍後再試');
      s.syncLease = { owner, expires: Date.now() + 60000 }; acquired = true;
    });
    try {
      const config = (await io.read()).settings;
      if (!config.endpoint || !config.token) throw new Error('先喺設定連接 Google Sheet');
      if ((await io.read()).conflict) throw new Error('請先處理分類衝突');
      const send = async op => {
        const response = await io.send(config, op);
        if (!response || typeof response.ok !== 'boolean') throw new Error('伺服器回應不正確，記錄仍保留喺本機');
        return response;
      };
      let count = 0;
      while (true) {
        const op = (await io.read()).outbox[0];
        if (!op) break;
        if (++count > 1000) throw new Error('已同步 1,000 個操作，請再同步以繼續');
        await io.mutate(s => {
          if (!s.syncLease || s.syncLease.owner !== owner) throw new Error('同步鎖已到期，請重試');
          s.syncLease.expires = Date.now() + 60000;
        });
        const response = await send(op);
        if (!response.ok) {
          if (response.error.code === 'VERSION_CONFLICT') await io.mutate(s => { s.conflict = { operationId: op.operationId, transaction: response.transaction }; });
          throw new Error(response.error.message);
        }
        if (op.action === 'rule') {
          if (!response.rule || response.rule.merchantKey !== op.merchantKey || response.rule.category !== op.category) throw new Error('分類規則未獲確認，請重試');
          await io.mutate(s => { s.outbox = s.outbox.filter(x => x.operationId !== op.operationId); });
        } else {
          if (!response.transaction || !response.transaction.id) throw new Error('同步未獲確認，請重試');
          await io.mutate(s => acknowledge(s, op, response.transaction));
        }
      }
      const snapshot = await send({ action: 'list' });
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      if (!Array.isArray(snapshot.transactions) || !Array.isArray(snapshot.rules)) throw new Error('同步資料格式不正確');
      await io.mutate(s => { merge(s, snapshot); s.lastSync = new Date().toISOString(); });
    } finally {
      if (acquired) await io.mutate(s => { if (s.syncLease && s.syncLease.owner === owner) s.syncLease = null; });
    }
  }
  function validEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'script.google.com' && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
    } catch (_) { return false; }
  }
  async function send(config, op) {
    if (!validEndpoint(config.endpoint)) throw new Error('請填入 Google Apps Script /exec 網址');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...op, token: config.token }), mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: controller.signal
      });
      if (!res.ok) throw new Error('伺服器暫時未能回應');
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('同步逾時。記錄仍保留，重試唔會重複入帳');
      if (err instanceof SyntaxError || err instanceof TypeError) throw new Error('連線失敗。檢查網絡及部署為「任何人」；本機記錄會保留');
      throw err;
    } finally { clearTimeout(timeout); }
  }
  return { initial, uid, read, mutate, add, categorize, rememberRule, acknowledge, merge, resolveConflict, sync, send, validEndpoint };
});
