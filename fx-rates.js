/* Live HKD exchange rates for manual foreign-currency entries (browser only). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FxRates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Same free, key-less source the sync backend uses. Base HKD returns units of each currency per 1 HKD.
  const URL_HKD = 'https://open.er-api.com/v6/latest/HKD';
  const STORAGE_KEY = 'pocket-ledger-fx-rates';
  const MAX_AGE_MS = 60 * 60 * 1000; // re-fetch at most hourly; the source itself updates about once a day
  const STALE_OK_MS = 48 * 60 * 60 * 1000;
  const TIMEOUT_MS = 6000;

  function read(storage) {
    try { const v = JSON.parse(storage && storage.getItem(STORAGE_KEY)); return v && v.rates && typeof v.fetchedAt === 'number' ? v : null; }
    catch (_) { return null; }
  }
  function write(storage, value) { try { storage && storage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch (_) { /* storage unavailable */ } }

  // HKD per 1 unit of `currency`, from an API payload { rates: { USD: 0.1285, ... } } with base HKD.
  function hkdPer(payload, currency) {
    const perHkd = payload && payload.rates && payload.rates[currency];
    return typeof perHkd === 'number' && Number.isFinite(perHkd) && perHkd > 0 ? Number((1 / perHkd).toPrecision(6)) : null;
  }

  // Resolves { rate, updated, cached } for a fresh-enough rate, or { rate: null } when no live rate is available.
  // Never throws: the caller falls back to the built-in estimate and marks the record 估算.
  async function liveRate(currency, { fetchImpl, storage, now = Date.now() } = {}) {
    if (currency === 'HKD') return { rate: 1, updated: null, cached: false };
    const cached = read(storage);
    if (cached && now - cached.fetchedAt < MAX_AGE_MS && hkdPer(cached, currency)) return { rate: hkdPer(cached, currency), updated: cached.updated, cached: true };
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (doFetch) {
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
        const res = await doFetch(URL_HKD, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...(controller ? { signal: controller.signal } : {}) });
        if (timer) clearTimeout(timer);
        const body = res && res.ok ? await res.json() : null;
        if (body && body.result === 'success' && body.base_code === 'HKD' && hkdPer(body, currency)) {
          const value = { rates: body.rates, updated: body.time_last_update_unix ? body.time_last_update_unix * 1000 : now, fetchedAt: now };
          write(storage, value);
          return { rate: hkdPer(value, currency), updated: value.updated, cached: false };
        }
      } catch (_) { /* offline, timeout or blocked */ }
    }
    // Offline: a rate from the last two days is still far closer than the built-in estimate.
    if (cached && now - cached.fetchedAt < STALE_OK_MS && hkdPer(cached, currency)) return { rate: hkdPer(cached, currency), updated: cached.updated, cached: true };
    return { rate: null, updated: null, cached: false };
  }

  return { URL_HKD, STORAGE_KEY, MAX_AGE_MS, hkdPer, liveRate };
});
