'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
test('engine maps fx to distinct badges', () => {
  assert.deepEqual(E.fxBadges({ pending: true, ambiguous: true, estimated: false }), [{ kind: 'pending', label: '待確認' }]);
  assert.deepEqual(E.fxBadges({ pending: true, ambiguous: false, estimated: true }), [{ kind: 'estimated', label: '估算匯率' }]);
  assert.deepEqual(E.fxBadges({ pending: false, ambiguous: false, estimated: false }), []);
  assert.deepEqual(E.fxBadges(undefined), []);
});
test('badges are buttons that reuse the existing data-edit flow', () => {
  assert.match(app, /class="fx-badge fx-badge-\$\{b\.kind\}" data-edit="\$\{escape\(r\.id\)\}"/);
  assert.match(app, /closest\('\[data-edit\]'\)/);
});
test('two visually distinct badge styles exist', () => {
  const pend = /\.fx-badge-pending\s*\{([^}]*)\}/.exec(css)[1], est = /\.fx-badge-estimated\s*\{([^}]*)\}/.exec(css)[1];
  assert.notEqual(pend, est);
});
