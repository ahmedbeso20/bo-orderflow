'use client';

import React, { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { useTheme } from '@/components/ThemeProvider';
import { fmtEGP, fmtNum } from '@/lib/format';
import {
  buildMonthlyChartData,
  formatCompactEgpTick,
  type MonthRow,
  type MonthlyChartPoint
} from '@/lib/chartData';

type ChartMode = 'area' | 'bar';

interface SalesProfitChartProps {
  months: MonthRow[];
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    dataKey?: string;
    value?: number;
    payload?: MonthlyChartPoint;
  }>;
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  const isNegativeProfit = point.profit < 0;

  return (
    <div
      dir="rtl"
      className="min-w-[210px] rounded-xl border border-[var(--border)] bg-[var(--surface)]/95 p-3.5 shadow-lg backdrop-blur-sm text-right"
    >
      <div className="mb-2.5 flex items-center justify-between border-b border-[var(--border)] pb-2">
        <span className="text-xs font-extrabold text-[var(--ink)]">{point.fullLabel}</span>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold font-mono-num ${
            point.marginPct >= 15
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
              : point.marginPct < 0
                ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                : 'bg-[var(--surface-alt)] text-[var(--muted)]'
          }`}
        >
          هامش {fmtNum(point.marginPct)}%
        </span>
      </div>
      <div className="space-y-1.5 text-xs">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-[var(--muted)]">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#0C5CA4] dark:bg-[#38BDF8]" />
            إجمالي المبيعات
          </span>
          <span className="font-mono-num font-extrabold text-[var(--ink)]">{fmtEGP(point.revenue)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-[var(--muted)]">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
            صافي الربح
          </span>
          <span
            className={`font-mono-num font-extrabold ${
              isNegativeProfit ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {fmtEGP(point.profit)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SalesProfitChart({ months }: SalesProfitChartProps) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<ChartMode>('area');
  const [showRevenue, setShowRevenue] = useState(true);
  const [showProfit, setShowProfit] = useState(true);

  const { points, summary } = useMemo(() => buildMonthlyChartData(months), [months]);

  if (points.length === 0) return null;

  const isDark = theme === 'dark';
  const revColor = isDark ? '#38BDF8' : '#0C5CA4';
  const profitColor = isDark ? '#34D399' : '#10B981';
  const gridColor = isDark ? '#273549' : '#E2E8F0';
  const tickColor = isDark ? '#94A3B8' : '#64748B';
  const hasNegative = points.some((p) => p.profit < 0);

  const toggleRevenue = () => {
    if (showRevenue && !showProfit) return;
    setShowRevenue((v) => !v);
  };

  const toggleProfit = () => {
    if (showProfit && !showRevenue) return;
    setShowProfit((v) => !v);
  };

  return (
    <section className="of-card p-6 mb-6 space-y-5" aria-label="تطور المبيعات والأرباح عبر آخر 12 شهرًا">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-extrabold text-base">تطور المبيعات وصافي الربح (آخر 12 شهرًا)</h2>
          <p className="text-xs text-[var(--muted)]">
            مقارنة تفاعلية شهرية بالجنيه المصري بعد خصم عمولات المنصات والشحن والمرتجعات
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface-alt)] p-0.5"
            role="group"
            aria-label="نوع الرسم البياني"
          >
            <button
              type="button"
              onClick={() => setMode('area')}
              aria-pressed={mode === 'area'}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition-colors ${
                mode === 'area'
                  ? 'bg-[#0C5CA4] text-white shadow-xs'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              منحنى الاتجاه
            </button>
            <button
              type="button"
              onClick={() => setMode('bar')}
              aria-pressed={mode === 'bar'}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition-colors ${
                mode === 'bar'
                  ? 'bg-[#0C5CA4] text-white shadow-xs'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              أعمدة المقارنة
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-[var(--surface-alt)] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold text-[var(--muted)]">مبيعات 12 شهرًا</div>
          <div className="text-sm font-extrabold font-mono-num mt-0.5">{fmtEGP(summary.totalRevenue)}</div>
        </div>
        <div className="rounded-xl bg-[var(--surface-alt)] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold text-[var(--muted)]">صافي ربح 12 شهرًا</div>
          <div
            className={`text-sm font-extrabold font-mono-num mt-0.5 ${
              summary.totalProfit < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {fmtEGP(summary.totalProfit)}
          </div>
        </div>
        <div className="rounded-xl bg-[var(--surface-alt)] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold text-[var(--muted)]">متوسط هامش الربح</div>
          <div className="text-sm font-extrabold font-mono-num mt-0.5">{fmtNum(summary.avgMargin)}%</div>
        </div>
        <div className="rounded-xl bg-[var(--surface-alt)] px-3.5 py-2.5">
          <div className="text-[11px] font-semibold text-[var(--muted)]">أعلى شهر مبيعًا</div>
          <div className="text-sm font-extrabold mt-0.5 truncate">
            {summary.bestMonth ? `${summary.bestMonth.monthLabel} · ${fmtEGP(summary.bestMonth.revenue)}` : '—'}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleRevenue}
            aria-pressed={showRevenue}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-bold transition-opacity ${
              showRevenue
                ? 'border-[var(--border)] bg-[var(--surface)] text-[var(--ink)]'
                : 'border-dashed border-[var(--border)] bg-transparent text-[var(--muted)] opacity-55'
            }`}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: revColor }} />
            إجمالي المبيعات
          </button>
          <button
            type="button"
            onClick={toggleProfit}
            aria-pressed={showProfit}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-bold transition-opacity ${
              showProfit
                ? 'border-[var(--border)] bg-[var(--surface)] text-[var(--ink)]'
                : 'border-dashed border-[var(--border)] bg-transparent text-[var(--muted)] opacity-55'
            }`}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: profitColor }} />
            صافي الربح
          </button>
        </div>
        <span className="text-[11px] text-[var(--muted)]">مرّر المؤشر على أي شهر لعرض التفاصيل</span>
      </div>

      {!summary.hasAnyActivity ? (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-alt)]/40 text-center px-4">
          <div className="space-y-1">
            <div className="text-sm font-bold text-[var(--ink)]">لا توجد مبيعات مسجّلة خلال آخر 12 شهرًا</div>
            <p className="text-xs text-[var(--muted)]">
              ستظهر منحنيات المبيعات وصافي الربح تلقائيًا بمجرد إضافة طلبات أو مزامنة متاجرك.
            </p>
          </div>
        </div>
      ) : (
        <div dir="ltr" className="h-72 sm:h-80 w-full" data-testid="sales-profit-recharts">
          <ResponsiveContainer width="100%" height="100%">
            {mode === 'area' ? (
              <AreaChart data={points} margin={{ top: 10, right: 12, left: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="ofRevenueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={revColor} stopOpacity={isDark ? 0.34 : 0.24} />
                    <stop offset="95%" stopColor={revColor} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="ofProfitFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={profitColor} stopOpacity={isDark ? 0.34 : 0.24} />
                    <stop offset="95%" stopColor={profitColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                <XAxis
                  dataKey="monthLabel"
                  tick={{ fill: tickColor, fontSize: 11, fontFamily: 'Cairo, sans-serif' }}
                  axisLine={{ stroke: gridColor }}
                  tickLine={false}
                  dy={6}
                />
                <YAxis
                  tickFormatter={formatCompactEgpTick}
                  tick={{ fill: tickColor, fontSize: 11, fontFamily: 'Cairo, sans-serif' }}
                  axisLine={false}
                  tickLine={false}
                  width={72}
                />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: revColor, strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                {hasNegative && <ReferenceLine y={0} stroke={tickColor} strokeDasharray="3 3" />}
                {showRevenue && (
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    name="المبيعات"
                    stroke={revColor}
                    strokeWidth={2.5}
                    fill="url(#ofRevenueFill)"
                    activeDot={{ r: 5, strokeWidth: 2, stroke: isDark ? '#111827' : '#ffffff' }}
                  />
                )}
                {showProfit && (
                  <Area
                    type="monotone"
                    dataKey="profit"
                    name="صافي الربح"
                    stroke={profitColor}
                    strokeWidth={2.5}
                    fill="url(#ofProfitFill)"
                    activeDot={{ r: 5, strokeWidth: 2, stroke: isDark ? '#111827' : '#ffffff' }}
                  />
                )}
              </AreaChart>
            ) : (
              <BarChart data={points} margin={{ top: 10, right: 12, left: 4, bottom: 4 }} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                <XAxis
                  dataKey="monthLabel"
                  tick={{ fill: tickColor, fontSize: 11, fontFamily: 'Cairo, sans-serif' }}
                  axisLine={{ stroke: gridColor }}
                  tickLine={false}
                  dy={6}
                />
                <YAxis
                  tickFormatter={formatCompactEgpTick}
                  tick={{ fill: tickColor, fontSize: 11, fontFamily: 'Cairo, sans-serif' }}
                  axisLine={false}
                  tickLine={false}
                  width={72}
                />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ fill: isDark ? 'rgba(148, 163, 184, 0.08)' : 'rgba(12, 92, 164, 0.06)' }}
                />
                {hasNegative && <ReferenceLine y={0} stroke={tickColor} strokeDasharray="3 3" />}
                {showRevenue && (
                  <Bar
                    dataKey="revenue"
                    name="المبيعات"
                    fill={revColor}
                    radius={[6, 6, 0, 0]}
                    maxBarSize={22}
                  />
                )}
                {showProfit && (
                  <Bar
                    dataKey="profit"
                    name="صافي الربح"
                    fill={profitColor}
                    radius={[6, 6, 0, 0]}
                    maxBarSize={22}
                  />
                )}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
