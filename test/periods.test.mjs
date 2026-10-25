// Period math for grouping sessions by start date. Uses local-time dates, so it passes in
// any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { periodOf, weekStart, groupByPeriod } = require('../dist/test-lib/periods.js');

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('year, month and day periods', () => {
  assert.deepEqual(periodOf(at(2026, 10, 25), 'year'), { key: '2026', label: '2026', start: at(2026, 1, 1, 0) });
  assert.deepEqual(periodOf(at(2026, 10, 25), 'month'), { key: '2026-10', label: 'Oct 2026', start: at(2026, 10, 1, 0) });
  assert.deepEqual(periodOf(at(2026, 10, 25, 23, 59), 'day'), { key: '2026-10-25', label: 'Sun, Oct 25, 2026', start: at(2026, 10, 25, 0) });
});

test('weeks run Saturday 2 PM to Saturday 2 PM', () => {
  // Saturday Oct 24 2026, just before and at 2 PM.
  assert.equal(weekStart(at(2026, 10, 24, 13, 59)).getTime(), at(2026, 10, 17, 14));
  assert.equal(weekStart(at(2026, 10, 24, 14, 0)).getTime(), at(2026, 10, 24, 14));
  // Friday the 30th is still in the week that started on the 24th.
  assert.equal(weekStart(at(2026, 10, 30, 23)).getTime(), at(2026, 10, 24, 14));
  const w = periodOf(at(2026, 10, 25), 'week');
  assert.equal(w.key, 'w2026-10-24');
  assert.equal(w.label, 'Week of Sat, Oct 24, 2026, 2 PM');
});

test('groups by start date, newest period and session first, each session once', () => {
  const sessions = [
    { id: 'a', start: at(2026, 9, 30, 23) },
    { id: 'b', start: at(2026, 10, 2) },
    { id: 'c', start: at(2026, 10, 20) },
  ];
  const groups = groupByPeriod(sessions, (s) => s.start, 'month');
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((s) => s.id)]), [
    ['Oct 2026', ['c', 'b']],
    ['Sep 2026', ['a']],
  ]);
});
