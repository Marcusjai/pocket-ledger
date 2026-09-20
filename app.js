'use strict';
const E = ExpenseEngine, S = LedgerStore;
const $ = id => document.getElementById(id);
const names = { Dining: '餐飲', Transport: '交通', Groceries: '日用品', Shopping: '購物', Bills: '帳單', Entertainment: '娛樂', Health: '健康', Other: '其他', Uncategorized: '待分類' };
const icons = { Dining: '食', Transport: '行', Groceries: '買', Shopping: '物', Bills: '單', Entertainment: '樂', Health: '健', Other: '·', Uncategorized: '?' };
const sources = { Cash: '現金', ApplePay: 'Apple Pay', Octopus: '八達通' };
const money = cents => (cents / 100).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let state, busy = false, editId, toastTimer;
const broadcast = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pocket-ledger') : null;
function escape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function notify(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4000);
}
function route(view) {
  if (!['dashboard', 'add', 'review', 'settings'].includes(view)) view = 'dashboard';
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== view; });
  document.querySelectorAll('nav button').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  window.scrollTo(0, 0);
  if (view === 'add') $('amount').focus();
}
function row(r) {
  const pending = state.outbox.some(op => (op.transaction?.id || op.id) === r.id);
  const date = new Date(r.timestamp).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `<div class="tx-row"><span class="tx-icon" aria-hidden="true">${icons[r.category] || '·'}</span><div class="tx-info"><strong>${escape(r.merchant || r.note || sources[r.source])}</strong><p>${escape(date)} · ${sources[r.source]}${pending ? ' · 未同步' : ''}</p></div><div class="tx-value"><strong>$${money(r.amountCents)}</strong><button data-edit="${escape(r.id)}" aria-label="修改 ${escape(r.merchant || r.note || sources[r.source])} 分類">${names[r.category] || '待分類'} ↗</button></div></div>`;
}
function empty(title, description) { return `<div class="empty"><strong>${title}</strong>${description}</div>`; }
async function refresh() { state = await S.read(); render(); }
function render() {
  const today = E.hkDay(new Date().toISOString());
  const month = $('month').value || today.slice(0, 7);
  const total = E.totals(state.transactions, month, today);
  $('month-total').textContent = money(total.totalCents); $('today-total').textContent = '$' + money(total.todayCents);
  $('month-count').textContent = total.count + ' 筆記錄'; $('month-caption').textContent = month;
  const categories = Object.entries(total.byCategory).filter(([, value]) => value).sort((a, b) => b[1] - a[1]);
  $('category-count').textContent = categories.length + ' 類';
  $('categories').innerHTML = categories.length ? categories.map(([category, value]) => `<div class="category-line"><span>${names[category]}</span><strong>$${money(value)}</strong></div><progress class="category-bar" max="${total.totalCents}" value="${value}" aria-label="${names[category]}佔本月支出"></progress>`).join('') : empty('由第一筆開始', '記低一筆支出，分類就會喺度顯示。');
  const days = Object.entries(total.byDay).sort((a, b) => b[0].localeCompare(a[0]));
  const max = Math.max(1, ...days.map(([, n]) => n));
  $('daily').innerHTML = days.length ? '<div class="daily-scroll">' + days.map(([date, n]) => `<div class="daily-row"><span>${date.slice(5).replace('-', '/')}</span><progress class="category-bar" max="${max}" value="${n}" aria-label="${date}支出"></progress><strong>$${money(n)}</strong></div>`).join('') + '</div>' : empty('今日有咩支出？', '每一日嘅記錄，會慢慢累積喺度。');
  const rows = state.transactions.filter(r => E.hkDay(r.timestamp).slice(0, 7) === month).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  $('list-count').textContent = rows.length + ' 筆';
  $('transaction-list').innerHTML = rows.length ? rows.map(row).join('') : empty('未有記錄', '撳「記現金」，幾秒就記低。');
  const review = state.transactions.filter(r => r.needsReview).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  $('review-count').textContent = review.length + ' 筆'; $('review-badge').textContent = review.length; $('review-badge').hidden = !review.length;
  $('review-list').innerHTML = review.length ? '<article class="panel">' + review.map(row).join('') + '</article>' : '<article class="panel">' + empty('全部分好類', '遇到未識嘅商戶，會先放喺呢度。') + '</article>';
  const connected = Boolean(state.settings.endpoint && state.settings.token);
  let status = navigator.onLine ? (connected ? '已連接 Google Sheet' : '本機模式 · 記錄只儲存喺呢部裝置') : '離線模式 · 可以繼續記帳';
  if (state.outbox.length && connected) status += ' · ' + state.outbox.length + ' 個操作待同步';
  if (state.lastSync && connected) status += ' · 上次 ' + new Date(state.lastSync).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' });
  if (state.conflict) status = '分類有衝突 · 到設定選擇保留版本';
  $('status').textContent = busy ? '正在同步… 本機仍可記帳' : status;
  $('status').classList.toggle('error', Boolean(state.conflict));
  $('sync').disabled = busy;
  $('conflict-panel').hidden = !state.conflict;
  if (state.conflict) $('conflict-description').textContent = `${state.conflict.transaction.merchant || '呢筆交易'}：雲端分類係「${names[state.conflict.transaction.category]}」。請揀要保留嘅版本。`;
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
  for (const id of ['entry-category', 'edit-category']) for (const category of E.CATEGORIES) {
    const option = document.createElement('option'); option.value = category; option.textContent = names[category]; $(id).append(option);
  }
  $('month').value = E.hkDay(new Date().toISOString()).slice(0, 7);
  await refresh(); fillSettings();
  const base = new URL(location.href); base.search = ''; base.hash = 'add';
  $('cash-link').textContent = base.href;
  route(location.hash.slice(1));
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => route(b.dataset.view));
  window.addEventListener('hashchange', () => route(location.hash.slice(1)));
  $('quick-cash').onclick = () => { document.querySelector('input[name=source][value=Cash]').checked = true; route('add'); };
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
  document.body.addEventListener('click', event => {
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
  for (const [id, keep] of [['keep-local', true], ['keep-remote', false]]) $(id).onclick = async () => { await S.mutate(s => S.resolveConflict(s, keep)); await changed(); synchronize(true); };
  $('export').onclick = async () => {
    const latest = await S.read();
    download(JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(), transactions: latest.transactions.map(E.inputOf), rules: latest.rules }, null, 2), 'pocket-ledger-' + E.hkDay(new Date().toISOString()) + '.json', 'application/json'); notify('備份已下載，不包含連接密碼');
  };
  $('csv').onclick = async () => {
    const latest = await S.read();
    const cell = v => { let s = String(v ?? ''); if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [['ID', 'Timestamp', 'Source', 'Amount', 'Currency', 'Merchant', 'Category', 'Note'], ...latest.transactions.map(r => [r.id, r.timestamp, r.source, (r.amountCents / 100).toFixed(2), r.currency, r.merchant, r.category, r.note])];
    download('\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n'), 'pocket-ledger.csv', 'text/csv;charset=utf-8');
  };
  $('import').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 10000000) throw new Error('備份檔案超過 10 MB');
      const data = JSON.parse(await file.text());
      if (data.schema !== 1 || !Array.isArray(data.transactions) || data.transactions.length > 10000 || !Array.isArray(data.rules)) throw new Error('備份格式不正確');
      if (data.rules.length > 10000 || data.rules.some(r => typeof r.merchantKey !== 'string' || r.merchantKey.length > 320 || !E.CATEGORIES.includes(r.category))) throw new Error('分類規則格式不正確');
      let count = 0;
      await S.mutate(s => {
        for (const input of data.transactions) { if (S.add(s, input).status === 'inserted') count++; }
        for (const r of data.rules) S.rememberRule(s, r);
      }); await changed(); notify('已還原 ' + count + ' 筆新記錄'); synchronize();
    } catch (err) { notify('還原失敗：' + err.message, true); } finally { event.target.value = ''; }
  };
  window.addEventListener('online', () => { refresh().then(() => synchronize()); });
  window.addEventListener('offline', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().then(() => synchronize()); });
  if (broadcast) broadcast.onmessage = () => refresh();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); await navigator.serviceWorker.ready; $('offline-ready').textContent = '離線功能已準備好。之後冇網絡都可以開 App 記現金。'; }
    catch (_) { $('offline-ready').textContent = '未能準備離線功能。請用 HTTPS 網址，並確認瀏覽器容許儲存資料。'; }
  } else $('offline-ready').textContent = '此環境未支援離線快取；iPhone 請使用 HTTPS 網址。';
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  synchronize();
}
start().catch(err => { $('status').textContent = '無法開啟本機資料庫，請確認瀏覽器容許儲存資料。'; notify(err.message, true); });
