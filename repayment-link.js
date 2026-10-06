/* A repayment link carries one HKD amount, never a transaction or credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepaymentLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function amount(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    const match = /^(?:(?:HKD|HK\$)\s*)?(\d{1,7}|\d{1,3}(?:,\d{3}){1,2})(?:\.(\d{1,2}))?$/i.exec(value.trim());
    if (!match) return null;
    const cents = Number(match[1].replace(/,/g, '')) * 100 + Number((match[2] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 999999999) return null;
    return (cents / 100).toFixed(2);
  }
  function parse(fragment) {
    const raw = String(fragment || '').replace(/^#/, '');
    const separator = raw.indexOf('?');
    const view = separator < 0 ? raw : raw.slice(0, separator);
    // Preserve the existing routing of every other page, including unknown links.
    if (view !== 'reimburse' || separator < 0) return { view: raw };
    const invalid = { view, invalid: true };
    if (raw.length > 256) return invalid;
    const params = raw.slice(separator + 1).split('&');
    // Reject duplicates and extra payload fields instead of guessing what to use.
    if (params.length !== 1 || !params[0].startsWith('amount=')) return invalid;
    let decoded;
    try { decoded = decodeURIComponent(params[0].slice(7).replace(/\+/g, ' ')); }
    catch (_) { return invalid; }
    const normalized = amount(decoded);
    return normalized === null ? invalid : { view, amount: normalized };
  }
  return { amount, parse };
});
