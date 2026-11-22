export function fmtEGP(amount: number | string | null | undefined): string {
  const n = Number(amount || 0);
  return `${Math.round(n).toLocaleString('ar-EG')} ج.م`;
}

export function fmtNum(value: number | string | null | undefined): string {
  return Number(value || 0).toLocaleString('ar-EG');
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const MARKET_NAMES: Record<string, string> = {
  a: 'أمازون مصر',
  n: 'نون',
  j: 'جوميا',
  t: 'ترينديول',
  k: 'كنز'
};

export const ORDER_STATUS_LABELS: Record<number, { label: string; tone: string }> = {
  0: { label: 'قيد التجهيز', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  1: { label: 'تم الشحن', tone: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  2: { label: 'تم التسليم', tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
  3: { label: 'مرتجع RTO', tone: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200' },
  4: { label: 'ملغى', tone: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' }
};
