export interface MonthRow {
  ym: string;
  revenue: number;
  profit: number;
}

export interface MonthlyChartPoint {
  ym: string;
  monthLabel: string;
  fullLabel: string;
  revenue: number;
  profit: number;
  marginPct: number;
}

export interface TwelveMonthSummary {
  totalRevenue: number;
  totalProfit: number;
  avgMargin: number;
  bestMonth: MonthlyChartPoint | null;
  hasAnyActivity: boolean;
}

const AR_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر'
];

export function formatMonthShortAr(ym: string): string {
  const parts = String(ym || '').split('-');
  const monthIdx = Number(parts[1]) - 1;
  if (monthIdx >= 0 && monthIdx < 12) return AR_MONTHS[monthIdx];
  return ym;
}

export function formatMonthFullAr(ym: string): string {
  const parts = String(ym || '').split('-');
  const year = parts[0] || '';
  const monthIdx = Number(parts[1]) - 1;
  if (monthIdx >= 0 && monthIdx < 12 && year) {
    return `${AR_MONTHS[monthIdx]} ${year}`;
  }
  return ym;
}

export function formatCompactEgpTick(value: number): string {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    return `${sign}${m >= 10 ? Math.round(m) : Number(m.toFixed(1))} م`;
  }
  if (abs >= 1_000) {
    const k = abs / 1_000;
    return `${sign}${k >= 10 ? Math.round(k) : Number(k.toFixed(1))} ألف`;
  }
  return `${sign}${Math.round(abs)}`;
}

export function buildMonthlyChartData(months: MonthRow[]): {
  points: MonthlyChartPoint[];
  summary: TwelveMonthSummary;
} {
  const safe = Array.isArray(months) ? months : [];
  const points: MonthlyChartPoint[] = safe.map((m) => {
    const revenue = Math.round((Number(m.revenue) || 0) * 100) / 100;
    const profit = Math.round((Number(m.profit) || 0) * 100) / 100;
    const marginPct = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;
    return {
      ym: m.ym,
      monthLabel: formatMonthShortAr(m.ym),
      fullLabel: formatMonthFullAr(m.ym),
      revenue,
      profit,
      marginPct
    };
  });

  const totalRevenue = Math.round(points.reduce((s, p) => s + p.revenue, 0) * 100) / 100;
  const totalProfit = Math.round(points.reduce((s, p) => s + p.profit, 0) * 100) / 100;
  const avgMargin = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 1000) / 10 : 0;
  const hasAnyActivity = points.some((p) => p.revenue !== 0 || p.profit !== 0);

  let bestMonth: MonthlyChartPoint | null = null;
  for (const p of points) {
    if (p.revenue <= 0 && p.profit <= 0) continue;
    if (!bestMonth || p.revenue > bestMonth.revenue) {
      bestMonth = p;
    }
  }

  return {
    points,
    summary: {
      totalRevenue,
      totalProfit,
      avgMargin,
      bestMonth,
      hasAnyActivity
    }
  };
}
