import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminCsv } from '../src/modules/admin/epic08/admin-epic08.service.js';

test('Admin CSV is RFC-style escaped and neutralizes spreadsheet formulas', () => {
  const csv = renderAdminCsv([{
    name: '=HYPERLINK("https://example.invalid")',
    note: 'quoted, "value"',
    amountMinor: 123,
  }]);
  assert.match(csv, /^\uFEFF/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
  assert.match(csv, /"quoted, ""value"""/);
  assert.match(csv, /"123"/);
  assert.match(csv, /\r\n$/);
});

test('Admin CSV returns a valid empty UTF-8 document', () => {
  assert.equal(renderAdminCsv([]), '\uFEFF\r\n');
});
