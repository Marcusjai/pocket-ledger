/* Shared by the browser, Apps Script and tests. Amounts are integer cents. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ExpenseEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CATEGORIES = ['Dining', 'Transport', 'Groceries', 'Shopping', 'Bills', 'Entertainment', 'Health', 'FriendTransfer', 'Other', 'Uncategorized'];
  const SOURCES = ['Cash', 'ApplePay', 'Octopus', 'FPS', 'HaseCard'];
  const REPAYMENT_SOURCES = ['BankTransfer', 'FPS', 'PayMe', 'Cash'];
  const isReimbursement = r => r.kind === 'reimbursement';
  const FRIEND_TRANSFER = 'FriendTransfer'; // 轉俾朋友
  // Supported foreign currencies. Ambiguous bare ¥ is treated as JPY and flagged 待確認.
  const FX_ALIASES = [
    ['USD', /^(?:US\$|USD|U\.S\.\$)$/i],
    ['TRY', /^(?:TRY|TL|₺)$/i],
    ['JPY', /^(?:JPY|JP¥|JP￥|円)$/i],
    ['CNY', /^(?:RMB|CNY|CN¥|CN￥|人民幣|人民币)$/i],
    ['TWD', /^(?:NT\$|NTD|TWD)$/i],
    ['HKD', /^(?:HK\$|HKD)$/i]
  ];
  const ZERO_DECIMAL = ['JPY'];
  const YEN_CHOICES = ['JPY', 'CNY'];
  // Rough fallback HKD rates, used only when the live rate API fails; such records are marked 待確認.
  const FALLBACK_HKD_RATE = { USD: 7.78, TRY: 0.19, JPY: 0.051, CNY: 1.09, TWD: 0.24, HKD: 1 };
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
  function zonedTime(timestamp) {
    if (typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) fail('INVALID_TIMESTAMP', '時間必須係有時區嘅 ISO 8601');
    const parts = timestamp.slice(0, 19).split(/[-T:]/).map(Number);
    if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate() || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) fail('INVALID_TIMESTAMP', '交易日期或時間不正確');
    return new Date(timestamp).toISOString();
  }
  function fpsRecipient(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'FPS 收款人格式不正確');
    const recipient = text(input.recipient, 160, '收款人 ID').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    const match = input.match || 'exact';
    if (!recipient || !['exact', 'domain'].includes(match)) fail('INVALID_INPUT', '請輸入銀行短訊內嘅收款人 ID');
    if (match === 'domain' && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(recipient)) fail('INVALID_INPUT', '請輸入完整電郵域名，例如 hkelectric.com');
    if (typeof input.enabled !== 'boolean') fail('INVALID_INPUT', '請確認是否自動記支出');
    const label = text(input.label, 160, '收款人名稱');
    const category = input.category || 'Uncategorized';
    if (!CATEGORIES.includes(category)) fail('INVALID_CATEGORY', '分類不正確');
    return { key: match + ':' + recipient, match, recipient, label, category, enabled: input.enabled };
  }
  function matchFpsRecipient(recipient, recipients) {
    const key = String(recipient).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    const records = (recipients || []).map(fpsRecipient);
    // An exact recipient exception overrides a domain, including when disabled.
    return records.find(r => r.match === 'exact' && r.recipient === key) || records.find(r => r.match === 'domain' && key.includes('@') && key.slice(key.lastIndexOf('@') + 1) === r.recipient);
  }
  function parseFpsNotification(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '銀行通知格式不正確');
    const title = text(input.title, 160, '通知標題').normalize('NFKC').toLowerCase();
    const body = text(input.body, 2048, '通知內容').normalize('NFKC').replace(/[’]/g, "'").replace(/\s+/g, ' ');
    if (!/^#?hasesecure$/.test(title)) return null;
    const match = /^Hang Seng: You've transferred HKD((?:\d{1,7}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,2})?) to account\s*\/\s*Proxy ID (.{1,160}?) on (\d{4}-\d\d-\d\d) (\d\d:\d\d)\.(?: ENQ: \d{6,16})?$/i.exec(body);
    if (!match) return null;
    const amount = (cents(match[1].replace(/,/g, '')) / 100).toFixed(2);
    const recipient = match[2].trim();
    const timestamp = zonedTime(match[3] + 'T' + match[4] + ':00+08:00');
    // The notification date is stable on a retry and separates otherwise identical
    // transfers in the same bank-reported minute. Never replace it with Current Date.
    const notificationTimestamp = zonedTime(input.notificationTimestamp);
    return { recipient, amount, timestamp, notificationTimestamp, identity: JSON.stringify(['hang-seng-fps', body, notificationTimestamp]) };
  }
  // Parse a Wallet notification amount such as "US$29.99", "JPY 12,000", "₺1.234,50" or "¥1,200".
  function parseMoney(raw) {
    if (typeof raw !== 'string' || raw.length > 64) return null;
    const t = raw.normalize('NFKC').replace(/\u00a0/g, ' ').trim().replace(/^-\s*/, '-');
    const m = /^(-)?\s*([^\d\s.,-]{1,4}?\$?|[A-Za-z]{2,3}\$|[A-Za-z]{2}¥)\s*([\d.,]+)\s*([A-Za-z]{3})?$/.exec(t) || /^(-)?\s*()([\d.,]+)\s*([A-Za-z]{3}|₺|円|TL)$/.exec(t);
    if (!m) return null;
    const negative = !!m[1];
    let symbol = (m[2] || m[4] || '').trim();
    let currency = null, ambiguous = false;
    if (symbol === '¥' || symbol === '￥') { currency = 'JPY'; ambiguous = true; }
    else if (symbol === '$') return null; // bare $ is not identifiable
    else for (const [code, re] of FX_ALIASES) if (re.test(symbol)) { currency = code; break; }
    if (!currency) return null;
    const amount = normaliseNumber(m[3], currency);
    if (amount == null) return null;
    return { currency, amount, ambiguous, negative };
  }
  function normaliseNumber(n, currency) {
    let s = n;
    if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,50 / NT$1.234
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    if (ZERO_DECIMAL.includes(currency) && s.includes('.')) {
      if (!/\.0{1,2}$/.test(s)) return null;
      s = s.replace(/\.0+$/, '');
    }
    const v = Number(s);
    if (!Number.isFinite(v) || v <= 0 || v > 9999999.99) return null;
    return ZERO_DECIMAL.includes(currency) ? String(Math.round(v)) : v.toFixed(2);
  }
  // rate = HKD per 1 unit of currency, or null when unavailable.
  function convertToHkd(parsed, rate) {
    const live = typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
    const used = parsed.currency === 'HKD' ? 1 : live ? rate : FALLBACK_HKD_RATE[parsed.currency];
    const hkdCents = Math.max(1, Math.round(Number(parsed.amount) * used * 100));
    const pending = parsed.ambiguous || (parsed.currency !== 'HKD' && !live);
    const fx = parsed.currency === 'HKD' ? null : { currency: parsed.currency, amount: parsed.amount, rate: Number(used.toPrecision(6)), source: live ? 'open.er-api.com' : 'fallback', pending, ambiguous: !!parsed.ambiguous, estimated: parsed.currency !== 'HKD' && !live, ...(parsed.ambiguous ? { yen: true } : {}) };
    return { amount: (hkdCents / 100).toFixed(2), fx };
  }
  // Rate candidates for an ambiguous ¥ amount. rates: { JPY: number|null, CNY: number|null }.
  function yenAlternatives(rates) {
    const out = {};
    for (const c of YEN_CHOICES) {
      const r = rates && rates[c];
      const live = typeof r === 'number' && Number.isFinite(r) && r > 0;
      out[c] = { rate: Number((live ? r : FALLBACK_HKD_RATE[c]).toPrecision(6)), estimated: !live };
    }
    return out;
  }
  // HK$ preview for each ¥ choice, from stored/fresh alternatives (falls back to built-in rates).
  function yenPreview(fx, alternatives) {
    const alt = alternatives || (fx && fx.alternatives) || yenAlternatives({});
    return YEN_CHOICES.map(c => ({ currency: c, label: c === 'CNY' ? 'RMB' : c, rate: alt[c].rate, estimated: alt[c].estimated, amountCents: Math.max(1, Math.round(Number(fx.amount) * alt[c].rate * 100)) }));
  }
  // Resolve an ambiguous ¥ record to JPY or CNY. Keeps the original fingerprint so create retries stay idempotent.
  function applyCurrency(record, currency, rate, now, operationId, rows) {
    const code = String(currency || '').toUpperCase() === 'RMB' ? 'CNY' : String(currency || '').toUpperCase();
    if (!YEN_CHOICES.includes(code)) fail('INVALID_CURRENCY', '只可以揀 JPY 或 RMB');
    if (!record || !record.fx) fail('NOT_FOUND', '呢筆唔係外幣記錄');
    if (!isYen(record.fx)) fail('NOT_AMBIGUOUS', '呢筆外幣記錄已確認幣種');
    const live = typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
    const used = Number((live ? rate : FALLBACK_HKD_RATE[code]).toPrecision(6));
    const amountCents = Math.max(1, Math.round(Number(record.fx.amount) * used * 100));
    if (rows) {
      const reimbursed = rows.filter(r => isReimbursement(r) && r.expenseId === record.id).reduce((n, r) => n + r.amountCents, 0);
      if (amountCents < reimbursed) fail('OVER_REIMBURSEMENT', '新港幣金額少過已收回嘅還款，請先修改還款');
    }
    const fx = { currency: code, amount: record.fx.amount, rate: used, source: live ? 'open.er-api.com' : 'fallback', pending: !live, ambiguous: false, estimated: !live, yen: true, ...(record.fx.alternatives ? { alternatives: record.fx.alternatives } : {}) };
    const note = String(record.note || '').replace(/(?:^| · )[A-Z]{3} [\d.]+ @[\d.]+(?: 待確認| 估算(?:匯率)?)*$/, '');
    const label = code + ' ' + fx.amount + ' @' + used + (live ? '' : ' 估算');
    return { ...record, amountCents, fx, note: note ? note + ' · ' + label : label, needsReview: record.category === 'Uncategorized', version: record.version + 1, updatedAt: now || new Date().toISOString(), lastOperationId: operationId || record.lastOperationId || '' };
  }
  // Records from a bare ¥ stay re-editable (JPY/RMB) after resolution; legacy ambiguous records count too.
  function isYen(fx) { return !!(fx && (fx.yen === true || fx.ambiguous === true)); }
  // Badges for the transaction list. Old records with only pending/source still map correctly.
  function fxBadges(fx) {
    if (!fx) return [];
    const estimated = fx.estimated === true || (fx.estimated == null && fx.source === 'fallback');
    const ambiguous = fx.ambiguous === true || (fx.ambiguous == null && fx.pending === true && !estimated);
    const out = [];
    if (ambiguous) out.push({ kind: 'pending', label: '待確認' });
    if (estimated) out.push({ kind: 'estimated', label: '估算' });
    return out;
  }
  // Hang Seng Bank app push: only online / Alipay ("card-not-present") purchases. Other card alerts are
  // ignored so Apple Pay purchases (already recorded via the Wallet trigger) are not counted twice.
  const MERCHANT_ALIASES = [[/^ALIPAY\s*HK$/i, 'Alipay'], [/^ALIPAY$/i, 'Alipay']];
  function parseHaseCardNotification(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '銀行通知格式不正確');
    const app = text(input.app, 160, 'App 名稱').normalize('NFKC');
    const title = text(input.title, 160, '通知標題').normalize('NFKC');
    if (!/hang\s*seng|恒生/i.test(app + ' ' + title)) return null;
    const body = text(input.body, 2048, '通知內容').normalize('NFKC').replace(/[’]/g, "'").replace(/\s+/g, ' ');
    const m = /^You made a card-not-present transaction of (.{1,32}?) at (.{1,120}?) on (\d{2})\/(\d{2})\/(\d{4}) with credit card ending (\d{4})\.(?: .*)?$/i.exec(body);
    if (!m) return null;
    const money = parseMoney(m[1]);
    if (!money || money.negative) return null;
    const [dd, mm, yyyy] = [Number(m[3]), Number(m[4]), Number(m[5])];
    const check = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (check.getUTCFullYear() !== yyyy || check.getUTCMonth() !== mm - 1 || check.getUTCDate() !== dd) return null;
    const date = `${m[5]}-${m[4]}-${m[3]}`;
    const rawMerchant = m[2].trim();
    const merchant = (MERCHANT_ALIASES.find(([re]) => re.test(rawMerchant)) || [null, rawMerchant])[1];
    const notificationTimestamp = input.notificationTimestamp ? zonedTime(input.notificationTimestamp) : '';
    const timestamp = notificationTimestamp || zonedTime(date + 'T00:00:00+08:00');
    return { rawAmount: m[1].trim(), money, merchant, rawMerchant, date, last4: m[6], timestamp, dateOnly: !notificationTimestamp, identity: JSON.stringify(['hang-seng-card', body, notificationTimestamp]) };
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
    const kind = input.kind || 'expense';
    if (!['expense', 'reimbursement'].includes(kind)) fail('INVALID_KIND', '記錄種類不正確');
    const reimbursement = kind === 'reimbursement';
    const expenseId = text(input.expenseId, 128, '原支出 ID');
    if (reimbursement && !/^[A-Za-z0-9_.:-]{8,128}$/.test(expenseId)) fail('INVALID_EXPENSE', '請選擇原本嘅支出');
    if (!reimbursement && expenseId) fail('INVALID_KIND', '還款必須使用 reimbursement 種類');
    const payer = reimbursement ? text(input.payer, 160, '還款人') : '';
    const source = input.source || 'Cash';
    if (!(reimbursement ? REPAYMENT_SOURCES : SOURCES).includes(source)) fail('INVALID_SOURCE', '付款／收款方式不正確');
    const currency = text(input.currency || 'HKD', 3, '貨幣').toUpperCase();
    // V1 deliberately refuses FX rather than adding unlike currencies together.
    if (currency !== 'HKD') fail('UNSUPPORTED_CURRENCY', '此版本只記錄 HKD，外幣交易請先核對港幣入帳金額');
    let timestamp = input.timestamp;
    if (!timestamp && (source !== 'Cash' || reimbursement)) fail('INVALID_TIMESTAMP', '請提供包含時區嘅交易／收款時間');
    timestamp = timestamp || now || new Date().toISOString();
    const canonicalTime = zonedTime(timestamp);
    const merchant = reimbursement ? '' : text(input.merchant, 160, '商戶').normalize('NFKC').replace(/\s+/g, ' ');
    const note = text(input.note, 500, '備註');
    const account = text(input.account, 64, '卡別名');
    const amountCents = cents(input.amount);
    const classification = reimbursement ? { category: 'Uncategorized', needsReview: false } : classify(merchant, note, source, input.category, rules);
    let fx = null;
    if (input.fx && !reimbursement) {
      const f = input.fx;
      if (!FX_ALIASES.some(([c]) => c === f.currency && c !== 'HKD') || typeof f.amount !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(f.amount) || !(f.rate > 0)) fail('INVALID_INPUT', '外幣資料不正確');
      fx = { currency: f.currency, amount: f.amount, rate: f.rate, source: String(f.source || ''), pending: !!(f.pending || f.ambiguous || f.estimated), ambiguous: !!f.ambiguous, estimated: !!f.estimated, ...(f.yen || f.ambiguous ? { yen: true } : {}) };
      if (fx.yen && f.alternatives) fx.alternatives = yenAlternatives({ JPY: f.alternatives.JPY && !f.alternatives.JPY.estimated ? f.alternatives.JPY.rate : null, CNY: f.alternatives.CNY && !f.alternatives.CNY.estimated ? f.alternatives.CNY.rate : null });
      if (fx.pending) classification.needsReview = true;
    }
    const key = merchantKey(merchant);
    // Preserve v1 expense fingerprints so existing IDs and queued retries remain valid.
    const fingerprint = JSON.stringify(reimbursement ? ['reimbursement', expenseId, source, canonicalTime, amountCents, currency, merchantKey(payer), account] : [source, canonicalTime, amountCents, currency, key, account]);
    return { id, kind, ...(reimbursement ? { expenseId, payer } : {}), timestamp: canonicalTime, source, amountCents, currency, merchant, merchantKey: key, account, note, ...classification, ...(fx ? { fx } : {}), fingerprint, version: 1, updatedAt: now || new Date().toISOString(), lastOperationId: '' };
  }
  function insert(rows, input, rules, now) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '交易格式不正確');
    const previous = rows.find(r => r.id === input.id);
    const stableInput = previous && !input.timestamp && (input.source || 'Cash') === 'Cash' && !isReimbursement(input) ? { ...input, timestamp: previous.timestamp } : input;
    const record = prepare(stableInput, rules, now);
    const sameId = rows.find(r => r.id === record.id);
    if (sameId) {
      if (sameId.fingerprint !== record.fingerprint) fail('ID_CONFLICT', '同一 ID 對應咗另一筆交易');
      return { status: 'duplicate', transaction: sameId };
    }
    const sameEvent = record.source !== 'Cash' && rows.find(r => r.fingerprint === record.fingerprint);
    if (sameEvent) return { status: 'duplicate', transaction: sameEvent };
    if (isReimbursement(record)) {
      const expense = rows.find(r => r.id === record.expenseId);
      if (!expense) fail('EXPENSE_NOT_FOUND', '搵唔到原支出，請先同步並選擇原本嘅支出');
      if (isReimbursement(expense) || expense.currency !== record.currency) fail('INVALID_EXPENSE', '還款只可連接原本嘅港幣支出');
      if (record.amountCents > reimbursementSummary(rows, expense.id).remainingCents) fail('OVER_REIMBURSEMENT', '累計還款不可超過原支出。請核對其他裝置有冇已記錄呢筆還款');
      record.merchant = expense.merchant; record.merchantKey = expense.merchantKey; record.category = expense.category;
    }
    return { status: 'inserted', transaction: record };
  }
  function reimbursementSummary(rows, expenseId) {
    const expense = rows.find(r => r.id === expenseId && !isReimbursement(r));
    if (!expense) fail('EXPENSE_NOT_FOUND', '搵唔到原支出');
    const reimbursedCents = rows.filter(r => isReimbursement(r) && r.expenseId === expenseId).reduce((sum, r) => sum + r.amountCents, 0);
    return { reimbursedCents, remainingCents: expense.amountCents - reimbursedCents };
  }
  function categoryOf(record, rows) {
    if (!isReimbursement(record)) return record.category;
    const expense = rows.find(r => r.id === record.expenseId && !isReimbursement(r));
    if (!expense) fail('CORRUPT_RECORD', '還款缺少原支出，請檢查備份或同步資料');
    return expense.category;
  }
  function hkDay(timestamp) { return new Date(Date.parse(timestamp) + 8 * 3600000).toISOString().slice(0, 10); }
  function totals(rows, month, day) {
    const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    const byDay = {};
    const records = new Map(rows.map(r => [r.id, r]));
    let totalCents = 0, todayCents = 0, count = 0, grossCents = 0, reimbursedCents = 0;
    for (const r of rows) {
      if (r.currency !== 'HKD' || !Number.isSafeInteger(r.amountCents)) fail('CORRUPT_RECORD', '交易貨幣或金額不正確');
      const reimbursement = isReimbursement(r), amount = reimbursement ? -r.amountCents : r.amountCents;
      const expense = reimbursement ? records.get(r.expenseId) : r;
      if (!expense || isReimbursement(expense)) fail('CORRUPT_RECORD', '還款缺少原支出');
      const date = hkDay(r.timestamp);
      if (date === day) todayCents += amount;
      if (date.slice(0, 7) !== month) continue;
      if (reimbursement) reimbursedCents += r.amountCents; else grossCents += r.amountCents;
      totalCents += amount; count++;
      byCategory[expense.category] = (byCategory[expense.category] || 0) + amount;
      byDay[date] = (byDay[date] || 0) + amount;
    }
    return { totalCents, todayCents, count, grossCents, reimbursedCents, byCategory, byDay };
  }
  function inputOf(r) { return { id: r.id, kind: r.kind || 'expense', ...(isReimbursement(r) ? { expenseId: r.expenseId, payer: r.payer } : {}), timestamp: r.timestamp, source: r.source, amount: (r.amountCents / 100).toFixed(2), currency: r.currency, merchant: r.merchant, account: r.account, note: r.note, category: r.category, ...(r.fx ? { fx: r.fx } : {}) }; }
  return { CATEGORIES, FRIEND_TRANSFER, FALLBACK_HKD_RATE, parseMoney, convertToHkd, fxBadges, yenAlternatives, yenPreview, applyCurrency, isYen, YEN_CHOICES, SOURCES, REPAYMENT_SOURCES, isReimbursement, reimbursementSummary, categoryOf, merchantKey, cents, zonedTime, fpsRecipient, matchFpsRecipient, parseFpsNotification, parseHaseCardNotification, classify, prepare, insert, hkDay, totals, inputOf, fail };
});
