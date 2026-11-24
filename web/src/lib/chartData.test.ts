import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthlyChartData,
  formatCompactEgpTick,
  formatMonthFullAr,
  formatMonthShortAr
} from './chartData';

test('formatMonthShortAr and formatMonthFullAr format YYYY-MM into Arabic labels', () => {
  assert.equal(formatMonthShortAr('2026-01'), 'يناير');
  assert.equal(formatMonthShortAr('2026-11'), 'نوفمبر');
  assert.equal(formatMonthFullAr('2026-11'), 'نوفمبر 2026');
  assert.equal(formatMonthShortAr('invalid'), 'invalid');
});

test('formatCompactEgpTick formats thousands, millions, and negative numbers cleanly', () => {
  assert.equal(formatCompactEgpTick(0), '0');
  assert.equal(formatCompactEgpTick(850), '850');
  assert.equal(formatCompactEgpTick(1500), '1.5 ألف');
  assert.equal(formatCompactEgpTick(42000), '42 ألف');
  assert.equal(formatCompactEgpTick(1250000), '1.3 م');
  assert.equal(formatCompactEgpTick(-2500), '-2.5 ألف');
});

test('buildMonthlyChartData calculates margins, totals, and best month accurately', () => {
  const { points, summary } = buildMonthlyChartData([
    { ym: '2026-09', revenue: 10000, profit: 2500 },
    { ym: '2026-10', revenue: 25000, profit: 5000 },
    { ym: '2026-11', revenue: 0, profit: 0 }
  ]);

  assert.equal(points.length, 3);
  assert.equal(points[0].monthLabel, 'سبتمبر');
  assert.equal(points[0].marginPct, 25);
  assert.equal(points[1].marginPct, 20);
  assert.equal(points[2].marginPct, 0);

  assert.equal(summary.totalRevenue, 35000);
  assert.equal(summary.totalProfit, 7500);
  assert.equal(summary.avgMargin, 21.4);
  assert.equal(summary.bestMonth?.ym, '2026-10');
  assert.equal(summary.hasAnyActivity, true);
});

test('buildMonthlyChartData handles empty or zero activity cleanly', () => {
  const { points, summary } = buildMonthlyChartData([
    { ym: '2026-10', revenue: 0, profit: 0 },
    { ym: '2026-11', revenue: 0, profit: 0 }
  ]);

  assert.equal(points.length, 2);
  assert.equal(summary.hasAnyActivity, false);
  assert.equal(summary.bestMonth, null);
  assert.equal(summary.avgMargin, 0);
});
