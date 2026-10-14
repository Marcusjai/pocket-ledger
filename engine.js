/* Shared by the browser, Apps Script and tests. Amounts are integer cents. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.ExpenseEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const CATEGORIES = ['Dining', 'Transport', 'Groceries', 'Shopping', 'Bills', 'Entertainment', 'Health', 'FriendTransfer'];
    const SOURCES = ['Cash', 'ApplePay', 'Octopus', 'FPS', 'HaseCard'];
    const REPAYMENT_SOURCES = ['BankTransfer', 'FPS', 'PayMe', 'Cash'];
    const isReimbursement = r => r.kind === 'reimbursement';
    const FRIEND_TRANSFER = 'FriendTransfer'; // 轉帳朋友
     // Supported foreign currencies. Ambiguous bare ¥ is treated as JPY and flagged 待確.
     const FX_ALIASES = [
           ['USD', /^(?:US\$|USD|U\.S\.\$)$/i],
           ['TRY', /^(?:TRY|TL|₺)$/i],
           ['JPY', /^(?:JPY|JP\|¥|JP円)$/i],
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

     function text(val, maxLen, name) {
           if (typeof val !== 'string') fail('INVALID_TEXT', `${name}必須為字串`);
           const cleaned = val.trim();
           if (!cleaned) fail('EMPTY_TEXT', `${name}不能為空`);
           if (cleaned.length > maxLen) fail('TEXT_TOO_LONG', `${name}長度不能超過 ${maxLen} 個字`);
           return cleaned;
     }

     function cents(val) {
           if (typeof val === 'number' && Number.isFinite(val)) {
                   if (!Number.isInteger(val)) fail('INVALID_CENTS', '金額不可包含小數分位');
                   if (val <= 0) fail('INVALID_CENTS', '額必須大於 0');
                   return val;
           }
           if (typeof val === 'string' && /^\d+(\.\d{1,2})?$/.test(val.trim())) {
                   const parsed = Math.round(Number(val.trim()) * 100);
                   if (parsed <= 0) fail('INVALID_CENTS', '金額必須大於 0');
                   return parsed;
           }
           fail('INVALID_CENTS', '金額格式不確');
     }

     function zonedTime(val) {
           if (typeof val !== 'string' || !val.trim()) fail('INVALID_DATETIME', '日期時間不能為空');
           const iso = val.trim();
           const d = new Date(iso);
           if (Number.isNaN(d.getTime())) fail('INVALID_DATETIME', '日期時間格式不正確');
           const localIso = d.toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' }).replace(' ', 'T');
           const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$/.exec(localIso);
           if (!match) fail('INVALID_DATETIME', '日期時間轉換失敗');
           return {
                   dateStr: match[1],
                   timeStr: match[2].slice(0, 5),
                   iso: `${match[1]}T${match[2]}+08:00`
           };
     }

     function parseFpsNotification(input) {
           if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '銀行通知格式不正確');
           const title = text(input.title, 160, '通知標題').normalize('NFKC').toLowerCase();
           const body = text(input.body, 2048, '通知內容').normalize('NFKC').replace(/['`]/g, "").replace(/\s+/g, ' ');
           if (!/^(?:#?hasesecures?|hang seng(?: personal banking| hk)?)$/i.test(title)) return null;
           let amount, recipient, dateStr, timeStr;
           const matchOut = /^Hang Seng: You've transferred HKD((?:\d{1,7}|\d{1,3}(?:\,\d{3}){1,2})(?:\.\d{1,2})?) to (?:account\s*|\s*Proxy ID) (.*) on (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\./.exec(body);
                   const matchIn = /^Payer (.*) has transferred HKD((?:\d{1,7}|\d{1,3}(?:\,\d{3}){1,2})(?:\.\d{1,2})?) to (?:your account\s*|\s*account\s*|\s*Proxy ID)\s*(.*?) on (\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/.exec(body);
           if (matchOut) {
                   amount = (cents(matchOut[1].replace(/,/g, '')) / 100).toFixed(2);
                   recipient = matchOut[2].trim();
                   dateStr = matchOut[3];
                   timeStr = matchOut[4];
           } else if (matchIn) {
                   amount = (cents(matchIn[2].replace(/,/g, '')) / 100).toFixed(2);
                   recipient = matchIn[1].trim();
                   dateStr = matchIn[4];
                   timeStr = matchIn[5];
           } else {
                   return null;
           }
           const timestamp = zonedTime(dateStr + 'T' + timeStr + ':00+08:00');
           // The notification date is stable on a retry and separates otherwise identical
      // transfers in the same bank-reported minute. Never replace it with Current Date.
      const notificationTimestamp = zonedTime(input.notificationTimestamp);
           return { recipient, amount, timestamp, notificationTimestamp, identity: JSON.stringify(['hang-seng-fps', body, notificationTimestamp]) };
     }

     function parseHaseCardNotification(input) {
           if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '銀行通知格式不正確');
           const app = text(input.app, 160, 'App 名稱').normalize('NFKC');
           const title = text(input.title, 160, '通知標題').normalize('NFKC');
           if (!/^(?:#?hasesecures?|hang seng(?: personal banking| hk)?)$/i.test(title) && !/hang\s*seng|恒生/i.test(app + ' ' + title)) return null;
           const body = text(input.body, 2048, '通知內容').normalize('NFKC').replace(/['`]/g, "").replace(/\s+/g, ' ');
           const match = /^Hang Seng Credit Card:\s*(?:A transaction of|An authorization of|Transaction:)\s*([A-Z]{3}|\$|HKD|RMB|USD|JPY|TWD|NTD|CNY|CN¥|CN￥|NT\$|US\$|U\.S\.\$|TRY|TL|₺|JP\|¥|JP円)\s*([\d,]+(?:\.\d{1,2})?)\s*at\s*(.+?)\s*was made on\s*(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})\./i.exec(body);
           if (!match) return null;
           const rawCurr = match[1].trim();
           const rawAmt = match[2].replace(/,/g, '');
           const merchant = match[3].trim();
           const timestamp = zonedTime(match[4] + 'T' + match[5] + ':00+08:00');
           const notificationTimestamp = zonedTime(input.notificationTimestamp);
           let currency = 'HKD';
           let amount = rawAmt;
           let foreign = null;
           for (const [code, re] of FX_ALIASES) {
                   if (re.test(rawCurr)) {
                             if (code !== 'HKD') {
                                         currency = code;
                                         foreign = { currency: code, amount: rawAmt };
                             }
                             break;
                   }
           }
           return {
                   merchant,
                   amount,
                   currency,
                   foreign,
                   timestamp,
                   notificationTimestamp,
                   identity: JSON.stringify(['hang-seng-card', body, notificationTimestamp])
           };
     }

     function autoCategory(merchant) {
           if (typeof merchant !== 'string') return 'Dining';
           const m = merchant.trim();
           for (const [cat, re] of BUILTINS) {
                   if (re.test(m)) return cat;
           }
           return 'Dining';
     }

     function prepare(input) {
           if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '輸入資料格不正確');
           const kind = input.kind === 'reimbursement' ? 'reimbursement' : 'expense';
           const centsVal = cents(input.amount);
           const category = kind === 'reimbursement' ? 'Reimbursement' : (CATEGORIES.includes(input.category) ? input.category : autoCategory(input.merchant || ''));
           const source = SOURCES.includes(input.source) ? input.source : 'Cash';
           const note = input.note ? text(input.note, 200, '備註') : '';
           const merchant = input.merchant ? text(input.merchant, 100, '商戶') : '';
           const timestamp = zonedTime(input.timestamp || new Date().toISOString());
           const currency = text(input.currency || 'HKD', 3, '貨幣').toUpperCase();
           let fx = null;
           if (input.fx) {
                   const f = input.fx;
                   if (!FX_ALIASES.some(([c, re]) => c === f.currency || re.test(f.currency)) || f.currency === 'HKD' || typeof f.amount !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(f.amount) || Number(f.amount) <= 0) {
                             fail('INVALID_FX', '外幣交易資料不正確');
                   }
                   fx = { currency: f.currency, amount: f.amount };
           }
           return {
                   kind,
                   cents: centsVal,
                   category,
                   source,
                   note,
                   merchant,
                   currency,
                   fx,
                   timestamp: timestamp.iso,
                   date: timestamp.dateStr,
                   time: timestamp.timeStr
           };
     }

     function setDeleted(records, deleted) {
           if (!Array.isArray(records)) fail('INVALID_INPUT', '記錄列表必須陣列');
           const changed = [];
           const bump = (r, del, extra) => ({ ...r, deleted: del, updatedAt: new Date().toISOString(), ...extra });
           for (const record of records) {
                   if (!record || typeof record !== 'object') continue;
                   if (Boolean(record.deleted) !== deleted) changed.push(bump(record, deleted, {}));
           }
           return changed;
     }

     return {
           CATEGORIES,
           SOURCES,
           REPAYMENT_SOURCES,
           FX_ALIASES,
           ZERO_DECIMAL,
           YEN_CHOICES,
           FALLBACK_HKD_RATE,
           isReimbursement,
           FRIEND_TRANSFER,
           cents,
           zonedTime,
           text,
           parseFpsNotification,
           parseHaseCardNotification,
           autoCategory,
           prepare,
           setDeleted
     };
});
