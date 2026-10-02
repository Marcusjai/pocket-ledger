/* Deploy as a Web App: execute as Me; access Anyone. All data operations require API_TOKEN. */
function output_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return output_({ ok: true, service: 'Pocket Ledger', version: 2, release: '1.2.0', capabilities: ['reimbursements', 'fps-notifications'], message: 'POST with token required. No transaction data is exposed by GET.' }); }
function doPost(e) {
  let lock;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 16384) return output_({ ok: false, error: { code: 'INVALID_INPUT', message: 'Request missing or too large' } });
    let request;
    try { request = JSON.parse(raw); } catch (_) { return output_({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }); }
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('API_TOKEN');
    if (!secret || secret.length < 32) return output_({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'Set API_TOKEN (32+ random characters) in Script Properties' } });
    if (!request || typeof request.token !== 'string' || !equalToken_(request.token, secret)) return output_({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token incorrect' } });
    const sheetId = props.getProperty('SPREADSHEET_ID');
    if (!sheetId) throw new Error('Missing SPREADSHEET_ID');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return output_({ ok: false, error: { code: 'BUSY', message: 'Please retry with the same transaction ID' } });
    const repo = sheetRepo_(SpreadsheetApp.openById(sheetId));
    const response = ExpenseApi.handle(request, repo, new Date().toISOString());
    SpreadsheetApp.flush();
    return output_(response);
  } catch (err) {
    // Never echo tokens, bodies or internal Google exceptions to anonymous callers.
    return output_({ ok: false, error: { code: err.code || 'SERVER_ERROR', message: err.code ? err.message : 'Server error; check Script Properties and Sheet access, then retry the same ID' } });
  } finally { if (lock) lock.releaseLock(); }
}
function equalToken_(a, b) {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) mismatch |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return mismatch === 0;
}
function cellText_(value) {
  const s = String(value == null ? '' : value);
  return /^[\s]*[=+\-@]/.test(s) ? "'" + s : s;
}
function sheetRepo_(ss) {
  const headers = ['ID', 'Timestamp', 'Source', 'Amount', 'Currency', 'Merchant', 'Category', 'Note', 'NeedsReview', 'Version', 'UpdatedAt', 'RecordJSON'];
  function sheet(name, head) {
    let s = ss.getSheetByName(name);
    if (!s) s = ss.insertSheet(name);
    if (!s.getLastRow()) { s.appendRow(head); s.setFrozenRows(1); }
    const actual = s.getRange(1, 1, 1, head.length).getValues()[0];
    if (actual.join('|') !== head.join('|')) ExpenseEngine.fail('SCHEMA_MISMATCH', name + ' 欄名不符；請使用新空白試算表');
    return s;
  }
  const tx = sheet('Transactions', headers);
  // Append display columns without moving or replacing the existing v1 data / RecordJSON.
  const extraHeaders = ['Kind', 'ExpenseID', 'Payer'];
  const extra = tx.getRange(1, 13, 1, 3).getValues()[0];
  if (extra.some((v, i) => v !== '' && v !== extraHeaders[i])) ExpenseEngine.fail('SCHEMA_MISMATCH', 'Transactions M:O 已有其他欄名，請先備份並移開呢三欄');
  if (extra.join('|') !== extraHeaders.join('|')) tx.getRange(1, 13, 1, 3).setValues([extraHeaders]);
  const rs = sheet('Rules', ['MerchantKey', 'Category', 'RuleJSON']);
  function read(s, col) {
    if (s.getLastRow() <= 1) return [];
    if (s.getLastRow() > 10001) ExpenseEngine.fail('CAPACITY', '資料超過此版本上限，請先備份');
    return s.getRange(2, col, s.getLastRow() - 1, 1).getValues().map(r => JSON.parse(r[0]));
  }
  let cachedRows, cachedRules, cachedRecipients;
  // A separate table keeps expense eligibility independent of category rules.
  // Create it only when the FPS feature is used; leave existing Sheet data intact.
  const fpsSheet = () => sheet('FPSRecipients', ['Key', 'Recipient', 'Match', 'Label', 'Category', 'Enabled', 'RecipientJSON']);
  const repo = {
    transactions: () => cachedRows || (cachedRows = read(tx, 12)),
    rules: () => cachedRules || (cachedRules = read(rs, 3)),
    fpsRecipients: () => cachedRecipients || (cachedRecipients = read(fpsSheet(), 7)),
    notificationDigest: value => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''),
    saveFpsRecipient: function (r) {
      const recipients = repo.fpsRecipients();
      const index = recipients.findIndex(x => x.key === r.key);
      if (index < 0 && recipients.length >= 1000) ExpenseEngine.fail('CAPACITY', 'FPS 收款人上限為 1,000 個');
      const row = index < 0 ? recipients.length + 2 : index + 2;
      fpsSheet().getRange(row, 1, 1, 7).setValues([[r.key, r.recipient, r.match, r.label, r.category, r.enabled, JSON.stringify(r)].map(v => typeof v === 'string' ? cellText_(v) : v)]);
      if (index < 0) recipients.push(r); else recipients[index] = r;
    },
    save: function (r) {
      const rows = repo.transactions();
      const index = rows.findIndex(x => x.id === r.id);
      const row = index < 0 ? rows.length + 2 : index + 2;
      const values = [r.id, r.timestamp, r.source, (ExpenseEngine.isReimbursement(r) ? -1 : 1) * r.amountCents / 100, r.currency, r.merchant, r.category, r.note, r.needsReview, r.version, r.updatedAt, JSON.stringify(r), r.kind || 'expense', r.expenseId || '', r.payer || ''].map(v => typeof v === 'string' ? cellText_(v) : v);
      tx.getRange(row, 1, 1, headers.length + extraHeaders.length).setValues([values]);
      tx.getRange(row, 4, 1, 1).setNumberFormat('0.00');
      if (index < 0) rows.push(r); else rows[index] = r;
    },
    saveRule: function (r) {
      const rules = repo.rules();
      const index = rules.findIndex(x => x.merchantKey === r.merchantKey);
      const row = index < 0 ? rules.length + 2 : index + 2;
      rs.getRange(row, 1, 1, 3).setValues([[cellText_(r.merchantKey), r.category, JSON.stringify(r)]]);
      if (index < 0) rules.push(r); else rules[index] = r;
    }
  };
  return repo;
}
