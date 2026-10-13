'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path');
const E = require('../engine.js');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
test('web app knows the HaseCard source label and engine accepts it', () => {
  assert.match(app, /HaseCard: '恒生信用卡'/);
  const r = E.prepare({ id: 'hase-card-0123456789', source: 'HaseCard', currency: 'HKD', amount: '10.15', merchant: 'Alipay', timestamp: '2026-10-13T21:05:30+08:00', account: 'hase-0702-abc' }, [], 'n');
  assert.equal(r.category, 'Uncategorized');
  assert.deepEqual(E.prepare(E.inputOf(r), [], 'n').fingerprint, r.fingerprint);
});
