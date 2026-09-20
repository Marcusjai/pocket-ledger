/* Shared by the browser, Apps Script and tests. Amounts are integer cents. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ExpenseEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CATEGORIES = ['Dining', 'Transport', 'Groceries', 'Shopping', 'Bills', 'Entertainment', 'Health', 'Other', 'Uncategorized'];
  const SOURCES = ['Cash', 'ApplePay', 'Octopus'];
  const BUILTINS = [
    ['Dining', /^(mcdonalds|麥當勞|kfc|肯德基|starbucks|星巴克|cafe de coral|大家樂|fairwood|大快活|pret a manger)(\b|\s|$)/i],
    ['Transport', /^(mtr|港鐵|kmb|九巴|citybus|城巴|uber|taxi|的士|tram|電車)(\b|\s|$)/i],
    ['Groceries', /^(parknshop|百佳|wellcome|惠康|market place|759|aeon supermarket)(\b|\s|$)/i],
    ['Bills', /^(clp|中電|hk electric|港燈|towngas|煤氣)(\b|\s|$)/i],
    ['Health', /^(watsons|屈臣氏|mannings|萬寧)(\b|\s|$)/i],
    ['Entertainment', /^(netflix|spotify|cinema|戲院)(\b|\s|$)/i]
  ];
  function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
  function text(value, max, name) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT', name + ' 格式不正確');
    return value.trim();
  }
  function merchantKey(value) {
    return String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[’'`]/g, '').replace(/&/g, 'n').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  function cents(value) {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) fail('INVALID_AMOUNT', '請輸入最多兩位小數嘅正數金額');
    const parts = raw.split('.');
    const result = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result <= 0 || result > 999999999) fail('INVALID_AMOUNT', '金額必須大過零');
    return result;
  }
  function classify(merchant, note, source, explicit, rules) {
    const key = merchantKey(merchant);
    if (explicit && explicit !== 'Auto') {
      if (!CATEGORIES.includes(explicit)) fail('INVALID_CATEGORY', '分類不正確');
      return { category: explicit, needsReview: explicit === 'Uncategorized' };
    }
    const custom = (rules || []).find(r => r.merchantKey === key && key);
    if (custom && CATEGORIES.includes(custom.category)) return { category: custom.category, needsReview: custom.category === 'Uncategorized' };
    for (const [category, match] of BUILTINS) if (match.test(key)) return { category, needsReview: false };
    if (source === 'Cash' && !key) {
      const n = merchantKey(note);
      if (/(午餐|早餐|晚餐|食飯|咖啡|lunch|dinner|breakfast|coffee)/i.test(n)) return { category: 'Dining', needsReview: false };
      if (/(巴士|地鐵|的士|bus|taxi|train)/i.test(n)) return { category: 'Transport', needsReview: false };
    }
    return { category: 'Uncategorized', needsReview: true };
  }
  function prepare(input, rules, now) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '交易格式不正確');
    const id = text(input.id, 128, 'ID');
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(id)) fail('INVALID_ID', '每筆交易需要穩定而獨立嘅 ID（8–128 個字元）');
    const source = input.source || 'Cash';
    if (!SOURCES.includes(source)) fail('INVALID_SOURCE', '付款方式不正確');
    const currency = text(input.currency || 'HKD', 3, '貨幣').toUpperCase();
    // V1 deliberately refuses FX rather than adding unlike currencies together.
    if (currency !== 'HKD') fail('UNSUPPORTED_CURRENCY', '此版本只記錄 HKD，外幣交易請先核對港幣入帳金額');
    let timestamp = input.timestamp;
    if (!timestamp && source !== 'Cash') fail('INVALID_TIMESTAMP', 'Wallet／八達通交易需要原始交易時間');
    timestamp = timestamp || now || new Date().toISOString();
    if (typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) fail('INVALID_TIMESTAMP', '時間必須係有時區嘅 ISO 8601');
    const parts = timestamp.slice(0, 19).split(/[-T:]/).map(Number);
    if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate() || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) fail('INVALID_TIMESTAMP', '交易日期或時間不正確');
    const canonicalTime = new Date(timestamp).toISOString();
    const merchant = text(input.merchant, 160, '商戶').normalize('NFKC').replace(/\s+/g, ' ');
    const note = text(input.note, 500, '備註');
    const account = text(input.account, 64, '卡別名');
    const amountCents = cents(input.amount);
    const classification = classify(merchant, note, source, input.category, rules);
    const key = merchantKey(merchant);
    const fingerprint = JSON.stringify([source, canonicalTime, amountCents, currency, key, account]);
    return { id, timestamp: canonicalTime, source, amountCents, currency, merchant, merchantKey: key, account, note, ...classification, fingerprint, version: 1, updatedAt: now || new Date().toISOString(), lastOperationId: '' };
  }
  function insert(rows, input, rules, now) {
    const previous = rows.find(r => r.id === input.id);
    const stableInput = previous && !input.timestamp && input.source !== 'ApplePay' && input.source !== 'Octopus' ? { ...input, timestamp: previous.timestamp } : input;
    const record = prepare(stableInput, rules, now);
    const sameId = rows.find(r => r.id === record.id);
    if (sameId) {
      if (sameId.fingerprint !== record.fingerprint) fail('ID_CONFLICT', '同一 ID 對應咗另一筆交易');
      return { status: 'duplicate', transaction: sameId };
    }
    const sameEvent = record.source !== 'Cash' && rows.find(r => r.fingerprint === record.fingerprint);
    if (sameEvent) return { status: 'duplicate', transaction: sameEvent };
    return { status: 'inserted', transaction: record };
  }
  function hkDay(timestamp) { return new Date(Date.parse(timestamp) + 8 * 3600000).toISOString().slice(0, 10); }
  function totals(rows, month, day) {
    const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    const byDay = {};
    let totalCents = 0, todayCents = 0, count = 0;
    for (const r of rows) {
      if (r.currency !== 'HKD' || !Number.isSafeInteger(r.amountCents)) fail('CORRUPT_RECORD', '交易貨幣或金額不正確');
      const date = hkDay(r.timestamp);
      if (date === day) todayCents += r.amountCents;
      if (date.slice(0, 7) !== month) continue;
      totalCents += r.amountCents; count++;
      byCategory[r.category] = (byCategory[r.category] || 0) + r.amountCents;
      byDay[date] = (byDay[date] || 0) + r.amountCents;
    }
    return { totalCents, todayCents, count, byCategory, byDay };
  }
  function inputOf(r) { return { id: r.id, timestamp: r.timestamp, source: r.source, amount: (r.amountCents / 100).toFixed(2), currency: r.currency, merchant: r.merchant, account: r.account, note: r.note, category: r.category }; }
  return { CATEGORIES, SOURCES, merchantKey, cents, classify, prepare, insert, hkDay, totals, inputOf, fail };
});
