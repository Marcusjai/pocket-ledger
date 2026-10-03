/* Pure service logic. Repository writes are protected by the Apps Script lock. */
var ExpenseApi = (function () {
  'use strict';
  function handle(request, repo, now) {
    const E = ExpenseEngine;
    const action = request.action || 'create';
    if (action === 'list') {
      const rows = repo.transactions();
      if (request.protocolVersion !== 2 && rows.some(E.isReimbursement)) E.fail('UPGRADE_REQUIRED', '資料包含朋友還款，請更新袋住記至 v1.1.0 或以上');
      return { ok: true, protocolVersion: 2, transactions: rows.map(r => E.isReimbursement(r) ? { ...r, category: E.categoryOf(r, rows) } : r), rules: repo.rules(), fpsRecipients: repo.fpsRecipients(), serverTime: now };
    }
    if (action === 'fpsRecipient') {
      const recipient = E.fpsRecipient(request);
      repo.saveFpsRecipient(recipient);
      return { ok: true, status: 'updated', fpsRecipient: recipient };
    }
    if (action === 'fps' || action === 'fpsConfirm') {
      const notification = E.parseFpsNotification(request);
      if (!notification) return { ok: true, status: 'ignored' };
      if (request.confirmedExpense != null && typeof request.confirmedExpense !== 'boolean') E.fail('INVALID_INPUT', 'confirmedExpense 必須係布林值');
      const digest = repo.notificationDigest(notification.identity);
      if (!/^[a-f0-9]{64}$/.test(digest)) E.fail('SERVER_ERROR', '未能建立銀行通知 ID');
      const id = 'fps-' + digest;
      const rows = repo.transactions();
      const previous = rows.find(r => r.id === id);
      if (previous) return { ok: true, status: 'duplicate', transaction: previous };
      const known = E.matchFpsRecipient(notification.recipient, repo.fpsRecipients());
      const preview = { id, amount: notification.amount, currency: 'HKD', recipient: notification.recipient, label: known?.label || notification.recipient, timestamp: notification.timestamp };
      if (!known?.enabled && request.confirmedExpense !== true && action !== 'fpsConfirm') return { ok: true, status: 'needs_confirmation', preview, prompt: 'Record HK$' + preview.amount + ' to ' + preview.label + ' as an expense?' };
      const input = { id, kind: 'expense', source: 'FPS', currency: 'HKD', amount: notification.amount, timestamp: notification.timestamp, account: 'hase-' + digest.slice(0, 48), merchant: known?.label || notification.recipient, category: known?.category || 'Uncategorized', note: 'Hang Seng transfer to ' + notification.recipient };
      const result = E.insert(rows, input, repo.rules(), now);
      if (result.status === 'inserted') {
        if (rows.length >= 10000) E.fail('CAPACITY', '此版本上限為 10,000 筆交易；請先備份及封存');
        repo.save(result.transaction);
      }
      return { ok: true, ...result };
    }
    if (action === 'create' || action === 'reimburse') {
      const rows = repo.transactions();
      const input = request.transaction || request;
      if (action === 'create' && E.isReimbursement(input)) E.fail('INVALID_ACTION', '還款請使用 reimburse 操作');
      if (action === 'reimburse' && input.kind && !E.isReimbursement(input)) E.fail('INVALID_KIND', 'reimburse 操作只接受還款');
      const result = E.insert(rows, action === 'reimburse' ? { ...input, kind: 'reimbursement' } : input, repo.rules(), now);
      if (result.status === 'inserted') {
        if (rows.length >= 10000) E.fail('CAPACITY', '此版本上限為 10,000 筆交易；請先備份及封存');
        repo.save(result.transaction);
      }
      return { ok: true, ...result };
    }
    if (action === 'categorize') {
      if (!E.CATEGORIES.includes(request.category)) E.fail('INVALID_CATEGORY', '分類不正確');
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(request.operationId || '')) E.fail('INVALID_ID', '缺少操作 ID');
      const record = repo.transactions().find(r => r.id === request.id);
      if (!record) E.fail('NOT_FOUND', '搵唔到交易');
      if (E.isReimbursement(record)) E.fail('INVALID_ACTION', '還款分類跟隨原支出，請修改原支出分類');
      const refreshLinked = category => {
        for (const r of repo.transactions().filter(r => E.isReimbursement(r) && r.expenseId === record.id)) {
          if (r.category !== category) repo.save({ ...r, category });
        }
      };
      if (record.lastOperationId === request.operationId) {
        // Repair a rule write if an earlier request saved the record but failed before saving the rule.
        if (request.remember && record.merchantKey) repo.saveRule({ merchantKey: record.merchantKey, category: record.category });
        refreshLinked(record.category);
        return { ok: true, status: 'duplicate', transaction: record };
      }
      if (request.version !== record.version) return { ok: false, error: { code: 'VERSION_CONFLICT', message: '另一部裝置已修改此分類' }, transaction: record };
      const updated = { ...record, category: request.category, needsReview: request.category === 'Uncategorized', version: record.version + 1, updatedAt: now, lastOperationId: request.operationId };
      repo.save(updated);
      refreshLinked(updated.category);
      if (request.remember && record.merchantKey) repo.saveRule({ merchantKey: record.merchantKey, category: request.category });
      return { ok: true, status: 'updated', transaction: updated };
    }
    if (action === 'rule') {
      if (typeof request.merchantKey !== 'string' || !request.merchantKey || request.merchantKey.length > 320 || E.merchantKey(request.merchantKey) !== request.merchantKey) E.fail('INVALID_INPUT', '商戶規則格式不正確');
      if (!E.CATEGORIES.includes(request.category)) E.fail('INVALID_CATEGORY', '分類不正確');
      const rule = { merchantKey: request.merchantKey, category: request.category };
      repo.saveRule(rule);
      return { ok: true, status: 'updated', rule };
    }
    E.fail('INVALID_ACTION', '不支援此操作');
  }
  return { handle };
})();
if (typeof module === 'object' && module.exports) module.exports = ExpenseApi;
