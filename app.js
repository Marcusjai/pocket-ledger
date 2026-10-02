'use strict';
const E = ExpenseEngine, S = LedgerStore;
const $ = id => document.getElementById(id);
const names = { Dining: '餐飲', Transport: '交通', Groceries: '日用品', Shopping: '購物', Bills: '帳單', Entertainment: '娛樂', Health: '健康', Other: '其他', Uncategorized: '待分類' };
const icons = { Dining: '食', Transport: '行', Groceries: '買', Shopping: '物', Bills: '單', Entertainment: '樂', Health: '健', Other: '·', Uncategorized: '?' };
const sources = { Cash: '現金', ApplePay: 'Apple Pay', Octopus: '八達通', BankTransfer: '銀行轉帳', FPS: 'FPS', PayMe: 'PayMe' };
const money = cents => (cents / 100).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let state, busy = false, editId, toastTimer, entryMode = 'expense';
const broadcast = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pocket-ledger') : null;
function escape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function notify(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4000);
}
function route(view) {
  if (view === 'reimburse') { setEntryMode('reimbursement'); view = 'add'; }
  if (!['dashboard', 'add', 'review', 'settings'].includes(view)) view = 'dashboard';
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== view; });
  document.querySelectorAll('nav button').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  const hash = view === 'add' && entryMode === 'reimbursement' ? '#reimburse' : '#' + view;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  window.scrollTo(0, 0);
  if (view === 'add') $(entryMode === 'reimbursement' ? 'reimbursement-amount' : 'amount').focus();
}
function setEntryMode(mode) {
  entryMode = mode;
  $('entry-form').hidden = mode !== 'expense'; $('reimbursement-form').hidden = mode !== 'reimbursement';
  $('mode-expense').setAttribute('aria-pressed', String(mode === 'expense'));
  $('mode-reimbursement').setAttribute('aria-pressed', String(mode === 'reimbursement'));
}
function repaymentBalance() {
  const id = $('reimbursement-expense').value;
  const expense = state.transactions.find(r => r.id === id && !E.isReimbursement(r));
  $('save-reimbursement').disabled = !expense; $('copy-expense-id').disabled = !expense;
  $('reimbursement-expense-id').textContent = expense?.id || '請先選擇原支出';
  if (!expense) { $('reimbursement-balance').textContent = '先記錄原支出。已全數收回嘅支出唔會出現喺選單。'; return; }
  const summary = E.reimbursementSummary(state.transactions, id);
  $('reimbursement-balance').textContent = `原支出 $${money(expense.amountCents)} · 已收回 $${money(summary.reimbursedCents)} · 尚未收回 $${money(summary.remainingCents)}`;
}
function repaymentOptions() {
  const selected = $('reimbursement-expense').value;
  const expenses = state.transactions.filter(r => !E.isReimbursement(r) && E.reimbursementSummary(state.transactions, r.id).remainingCents > 0).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  $('reimbursement-expense').innerHTML = '<option value="">選擇原本嘅支出（包括之前月份）</option>' + expenses.map(r => `<option value="${escape(r.id)}">${E.hkDay(r.timestamp)} · ${escape(r.merchant || r.note || sources[r.source])} · $${money(r.amountCents)}</option>`).join('');
  if (expenses.some(r => r.id === selected)) $('reimbursement-expense').value = selected;
  repaymentBalance();
}
function row(r) {
  const reimbursement = E.isReimbursement(r), category = E.categoryOf(r, state.transactions);
  const pending = state.outbox.some(op => (op.transaction?.id || op.id) === r.id);
  const date = new Date(r.timestamp).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const summary = reimbursement ? null : E.reimbursementSummary(state.transactions, r.id);
  const expense = reimbursement ? state.transactions.find(t => t.id === r.expenseId) : r;
  const title = reimbursement ? '朋友還款' + (r.payer ? ' · ' + r.payer : '') : r.merchant || r.note || sources[r.source];
  const detail = reimbursement ? `<p>原支出：${escape(expense.merchant || expense.note || sources[expense.source])} · ${E.hkDay(expense.timestamp)}</p>` : summary.reimbursedCents ? `<p>已收回 $${money(summary.reimbursedCents)} · 自付 $${money(summary.remainingCents)}</p>` : '';
  const controls = reimbursement ? `<span class="repayment-category">${names[category]} · 扣減支出</span><button data-original="${escape(expense.id)}">查看原支出 ↗</button>` : `<button data-edit="${escape(r.id)}" aria-label="修改 ${escape(title)} 分類">${names[category] || '待分類'} ↗</button>${summary.remainingCents > 0 ? `<button data-reimburse="${escape(r.id)}">記還款 ↗</button>` : '<span class="repayment-category">已全數收回</span>'}`;
  return `<div class="tx-row${reimbursement ? ' repayment-row' : ''}" data-record="${escape(r.id)}"><span class="tx-icon" aria-hidden="true">${reimbursement ? '還' : icons[category] || '·'}</span><div class="tx-info"><strong>${escape(title)}</strong><p>${escape(date)} · ${sources[r.source]}${pending ? ' · 未同步' : ''}</p>${detail}</div><div class="tx-value"><strong>${reimbursement ? '−' : ''}$${money(r.amountCents)}</strong>${controls}</div></div>`;
}
function empty(title, description) { return `<div class="empty"><strong>${title}</strong>${description}</div>`; }
async function refresh() { state = await S.read(); render(); }
function render() {
  const today = E.hkDay(new Date().toISOString());
  const month = $('month').value || today.slice(0, 7);
  const total = E.totals(state.transactions, month, today);
  $('month-total').textContent = money(total.totalCents); $('today-total').textContent = '$' + money(total.todayCents);
  $('month-gross').textContent = '$' + money(total.grossCents); $('month-reimbursed').textContent = '$' + money(total.reimbursedCents);
  $('month-count').textContent = total.count + ' 筆記錄'; $('month-caption').textContent = month;
  const categories = Object.entries(total.byCategory).filter(([, value]) => value).sort((a, b) => b[1] - a[1]);
  $('category-count').textContent = categories.length + ' 類';
  const categoryMax = Math.max(1, ...categories.map(([, value]) => Math.abs(value)));
  $('categories').innerHTML = categories.length ? categories.map(([category, value]) => `<div class="category-line"><span>${names[category]}</span><strong>$${money(value)}</strong></div><progress class="category-bar${value < 0 ? ' negative' : ''}" max="${categoryMax}" value="${Math.abs(value)}" aria-label="${names[category]}淨支出 $${money(value)}"></progress>`).join('') : empty(total.count ? '本月分類淨支出為零' : '由第一筆開始', total.count ? '已收還款已扣減。' : '記低一筆支出，分類就會喺度顯示。');
  const days = Object.entries(total.byDay).sort((a, b) => b[0].localeCompare(a[0]));
  const max = Math.max(1, ...days.map(([, n]) => Math.abs(n)));
  $('daily').innerHTML = days.length ? '<div class="daily-scroll">' + days.map(([date, n]) => `<div class="daily-row"><span>${date.slice(5).replace('-', '/')}</span><progress class="category-bar${n < 0 ? ' negative' : ''}" max="${max}" value="${Math.abs(n)}" aria-label="${date}淨支出 $${money(n)}"></progress><strong>$${money(n)}</strong></div>`).join('') + '</div>' : empty('今日有咩支出？', '每一日嘅記錄，會慢慢累積喺度。');
  const rows = state.transactions.filter(r => E.hkDay(r.timestamp).slice(0, 7) === month).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  $('list-count').textContent = rows.length + ' 筆';
  $('transaction-list').innerHTML = rows.length ? rows.map(row).join('') : empty('未有記錄', '撳「記現金」，幾秒就記低。');
  const review = state.transactions.filter(r => !E.isReimbursement(r) && r.needsReview).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  $('review-count').textContent = review.length + ' 筆'; $('review-badge').textContent = review.length; $('review-badge').hidden = !review.length;
  $('review-list').innerHTML = review.length ? '<article class="panel">' + review.map(row).join('') + '</article>' : '<article class="panel">' + empty('全部分好類', '遇到未識嘅商戶，會先放喺呢度。') + '</article>';
  const connected = Boolean(state.settings.endpoint && state.settings.token);
  let status = navigator.onLine ? (connected ? '已連接 Google Sheet' : '本機模式 · 記錄只儲存喺呢部裝置') : '離線模式 · 可以繼續記帳';
  if (state.outbox.length && connected) status += ' · ' + state.outbox.length + ' 個操作待同步';
  if (state.lastSync && connected) status += ' · 上次 ' + new Date(state.lastSync).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' });
  if (state.conflict) status = '分類有衝突 · 到設定選擇保留版本';
  if (state.rejection) status = '有還款未能入帳 · 到設定處理';
  $('status').textContent = busy ? '正在同步… 本機仍可記帳' : status;
  $('status').classList.toggle('error', Boolean(state.conflict || state.rejection));
  $('sync').disabled = busy;
  $('conflict-panel').hidden = !state.conflict;
  if (state.conflict) $('conflict-description').textContent = `${state.conflict.transaction.merchant || '呢筆交易'}：雲端分類係「${names[state.conflict.transaction.category]}」。請揀要保留嘅版本。`;
  $('rejection-panel').hidden = !state.rejection;
  if (state.rejection) {
    const op = state.outbox.find(x => x.operationId === state.rejection.operationId);
    $('rejection-description').textContent = `還款 $${op?.transaction.amount || ''}：${state.rejection.message}`;
  }
  $('fps-recipients').innerHTML = state.fpsRecipients.length ? state.fpsRecipients.map(r => {
    const pending = state.outbox.some(op => op.action === 'fpsRecipient' && op.key === r.key);
    return `<div class="fps-recipient-row"><strong>${escape(r.label || r.recipient)}</strong><p>${escape(r.recipient)} · ${r.match === 'domain' ? '電郵域名' : '完整 ID'} · ${names[r.category]}<br>${pending ? '設定未同步' : connected ? (r.enabled ? '已同步 · 自動記支出' : '已同步 · 每次詢問') : '本機設定 · 請連接並同步'}</p><button type="button" class="quiet" data-fps-edit="${escape(r.key)}">修改設定 ↗</button></div>`;
  }).join('') : '<p class="hint">未有已確認收款人。所有 FPS 轉帳先詢問，唔會直接記支出。</p>';
  repaymentOptions();
}
async function changed() { await refresh(); broadcast?.postMessage('changed'); }
async function synchronize(manual = false) {
  if (busy) return;
  if (!state.settings.endpoint || !state.settings.token) { if (manual) { route('settings'); notify('填好連接設定就可以同步'); } return; }
  if (!navigator.onLine) { if (manual) notify('目前離線，記錄已留喺本機'); return; }
  busy = true; render();
  try { await S.sync({ read: S.read, mutate: S.mutate, send: S.send }); if (manual) notify('同步完成'); }
  catch (err) { notify(err.message, true); }
  finally { busy = false; await changed(); }
}
function download(content, name, type) {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([content], { type }));
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 20000);
}
function fillSettings() { $('endpoint').value = state.settings.endpoint; $('token').value = state.settings.token; }
async function start() {
  for (const id of ['entry-category', 'edit-category', 'fps-category']) for (const category of E.CATEGORIES) {
    const option = document.createElement('option'); option.value = category; option.textContent = names[category]; $(id).append(option);
  }
  $('month').value = E.hkDay(new Date().toISOString()).slice(0, 7);
  $('fps-category').value = 'Bills';
  await refresh(); fillSettings();
  const base = new URL(location.href); base.search = ''; base.hash = 'add';
  $('cash-link').textContent = base.href;
  route(location.hash.slice(1));
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => route(b.dataset.view));
  window.addEventListener('hashchange', () => route(location.hash.slice(1)));
  $('quick-cash').onclick = () => { setEntryMode('expense'); document.querySelector('input[name=source][value=Cash]').checked = true; route('add'); };
  $('mode-expense').onclick = () => { setEntryMode('expense'); route('add'); };
  $('mode-reimbursement').onclick = () => route('reimburse');
  $('reimbursement-expense').onchange = repaymentBalance;
  $('copy-expense-id').onclick = async () => {
    try { await navigator.clipboard.writeText($('reimbursement-expense').value); notify('原支出 ID 已複製'); }
    catch (_) { notify('未能自動複製，請長按上面嘅 ID 複製', true); }
  };
  document.querySelectorAll('[data-category]').forEach(b => b.onclick = () => { $('entry-category').value = b.dataset.category; });
  $('month').onchange = render;
  $('sync').onclick = () => synchronize(true);
  $('entry-form').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
    try {
      const timestamp = $('entry-time').value ? new Date($('entry-time').value + '+08:00').toISOString() : new Date().toISOString();
      const input = { id: S.uid(), timestamp, source: document.querySelector('input[name=source]:checked').value, amount: $('amount').value, merchant: $('merchant').value, note: $('note').value, category: $('entry-category').value };
      await S.mutate(s => S.add(s, input)); await changed();
      $('entry-form').reset(); notify('已儲存 $' + money(E.cents(input.amount)) + ' · ' + sources[input.source]); $('amount').focus();
      synchronize();
    } catch (err) { notify(err.message, true); } finally { if (button) button.disabled = false; }
  };
  $('reimbursement-form').onsubmit = async event => {
    event.preventDefault(); const button = $('save-reimbursement'); button.disabled = true;
    try {
      const timestamp = $('reimbursement-time').value ? new Date($('reimbursement-time').value + '+08:00').toISOString() : new Date().toISOString();
      const input = { id: S.uid(), kind: 'reimbursement', expenseId: $('reimbursement-expense').value, amount: $('reimbursement-amount').value, source: $('reimbursement-source').value, payer: $('reimbursement-payer').value, note: $('reimbursement-note').value, timestamp };
      await S.mutate(s => S.add(s, input));
      $('reimbursement-form').reset(); $('month').value = E.hkDay(input.timestamp).slice(0, 7);
      await changed(); route('dashboard'); notify('已記還款 $' + money(E.cents(input.amount))); synchronize();
    } catch (err) { notify(err.message, true); } finally { repaymentBalance(); }
  };
  document.body.addEventListener('click', event => {
    const fpsEdit = event.target.closest('[data-fps-edit]');
    if (fpsEdit) {
      const r = state.fpsRecipients.find(x => x.key === fpsEdit.dataset.fpsEdit);
      $('fps-recipient').value = r.recipient; $('fps-match').value = r.match; $('fps-label').value = r.label; $('fps-category').value = r.category; $('fps-enabled').checked = r.enabled;
      $('fps-recipient-form').scrollIntoView({ block: 'start' }); return;
    }
    const repay = event.target.closest('[data-reimburse]');
    if (repay) { route('reimburse'); $('reimbursement-expense').value = repay.dataset.reimburse; repaymentBalance(); return; }
    const original = event.target.closest('[data-original]');
    if (original) {
      const r = state.transactions.find(t => t.id === original.dataset.original);
      $('month').value = E.hkDay(r.timestamp).slice(0, 7); render(); route('dashboard');
      document.querySelector(`[data-record="${r.id}"]`)?.scrollIntoView({ block: 'center' }); return;
    }
    const button = event.target.closest('[data-edit]'); if (!button) return;
    editId = button.dataset.edit; const r = state.transactions.find(t => t.id === editId);
    $('edit-merchant').textContent = (r.merchant || r.note || sources[r.source]) + ' · $' + money(r.amountCents);
    $('edit-category').value = r.category; $('remember').checked = false; $('remember').disabled = !r.merchantKey;
    $('category-dialog').showModal();
  });
  $('close-dialog').onclick = () => $('category-dialog').close();
  $('category-form').onsubmit = async event => {
    event.preventDefault();
    try { await S.mutate(s => S.categorize(s, editId, $('edit-category').value, $('remember').checked)); $('category-dialog').close(); await changed(); notify('分類已更新'); synchronize(); }
    catch (err) { notify(err.message, true); }
  };
  $('settings-form').onsubmit = async event => {
    event.preventDefault();
    if (busy) return notify('請等同步完成再修改設定', true);
    const endpoint = $('endpoint').value.trim(), token = $('token').value.trim();
    if (!S.validEndpoint(endpoint) || token.length < 32) return notify('請填入有效 /exec 網址及至少 32 字元嘅密碼', true);
    try {
      await S.mutate(s => {
        if (s.settings.endpoint && s.settings.endpoint !== endpoint && s.transactions.length) throw new Error('已有記錄嘅裝置只可連接原有資料庫。新資料庫請另用瀏覽器設定檔，並以備份匯入。');
        s.settings = { endpoint, token };
      }); await changed(); notify('設定已儲存'); synchronize(true);
    } catch (err) { notify(err.message, true); }
  };
  $('disconnect').onclick = async () => {
    if (busy) return notify('請等同步完成', true);
    await S.mutate(s => { s.settings.token = ''; }); await changed(); fillSettings(); notify('已中斷連接，本機記錄仍然保留');
  };
  $('fps-recipient-form').onsubmit = async event => {
    event.preventDefault();
    if (busy) return notify('請等同步完成再修改收款人', true);
    try {
      const input = { recipient: $('fps-recipient').value, match: $('fps-match').value, label: $('fps-label').value, category: $('fps-category').value, enabled: $('fps-enabled').checked };
      await S.mutate(s => S.rememberFpsRecipient(s, input));
      $('fps-recipient-form').reset(); $('fps-category').value = 'Bills'; await changed();
      notify('收款人設定已儲存，同步後生效'); synchronize();
    } catch (err) { notify(err.message, true); }
  };
  for (const [id, keep] of [['keep-local', true], ['keep-remote', false]]) $(id).onclick = async () => { await S.mutate(s => S.resolveConflict(s, keep)); await changed(); synchronize(true); };
  $('discard-rejected').onclick = async () => {
    try { await S.mutate(s => S.discardRejected(s)); await changed(); notify('已移除被拒絕嘅本機還款'); synchronize(true); }
    catch (err) { notify(err.message, true); }
  };
  $('export').onclick = async () => {
    const latest = await S.read();
    download(JSON.stringify({ schema: 2, exportedAt: new Date().toISOString(), transactions: latest.transactions.map(E.inputOf), rules: latest.rules, fpsRecipients: latest.fpsRecipients }, null, 2), 'pocket-ledger-' + E.hkDay(new Date().toISOString()) + '.json', 'application/json'); notify('備份已下載，不包含連接密碼');
  };
  $('csv').onclick = async () => {
    const latest = await S.read();
    const cell = v => { let s = String(v ?? ''); if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [['ID', 'Timestamp', 'Source', 'Amount', 'Currency', 'Merchant', 'Category', 'Note', 'Kind', 'ExpenseID', 'Payer'], ...latest.transactions.map(r => [r.id, r.timestamp, r.source, (E.isReimbursement(r) ? -1 : 1) * r.amountCents / 100, r.currency, r.merchant, E.categoryOf(r, latest.transactions), r.note, r.kind || 'expense', r.expenseId || '', r.payer || ''])];
    download('\ufeff' + rows.map(r => r.map(v => typeof v === 'number' ? v.toFixed(2) : cell(v)).join(',')).join('\r\n'), 'pocket-ledger.csv', 'text/csv;charset=utf-8');
  };
  $('import').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 10000000) throw new Error('備份檔案超過 10 MB');
      const data = JSON.parse(await file.text());
      const count = await S.mutate(s => S.restore(s, data));
      await changed(); notify('已還原 ' + count + ' 筆新記錄'); synchronize();
    } catch (err) { notify('還原失敗：' + err.message, true); } finally { event.target.value = ''; }
  };
  window.addEventListener('online', () => { refresh().then(() => synchronize()); });
  window.addEventListener('offline', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().then(() => synchronize()); });
  if (broadcast) broadcast.onmessage = () => refresh();
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      const showOfflineState = () => {
        $('offline-ready').textContent = registration.waiting ? '新版本已下載。請關閉所有袋住記分頁及主畫面 App，再開啟一次，完成離線更新。' : registration.installing && registration.active ? '正在下載離線更新，請保持連線…' : '離線功能已準備好。之後冇網絡都可以開 App 記帳。';
      };
      const watchInstall = () => { registration.installing?.addEventListener('statechange', showOfflineState); showOfflineState(); };
      registration.addEventListener('updatefound', watchInstall); watchInstall();
      await navigator.serviceWorker.ready; showOfflineState();
    }
    catch (_) { $('offline-ready').textContent = '未能準備離線功能。請用 HTTPS 網址，並確認瀏覽器容許儲存資料。'; }
  } else $('offline-ready').textContent = '此環境未支援離線快取；iPhone 請使用 HTTPS 網址。';
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  synchronize();
}
start().catch(err => { $('status').textContent = '無法開啟本機資料庫，請確認瀏覽器容許儲存資料。'; notify(err.message, true); });
