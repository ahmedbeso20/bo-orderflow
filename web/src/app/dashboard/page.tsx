'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { api } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum, MARKET_NAMES, ORDER_STATUS_LABELS } from '@/lib/format';

interface DashboardSummary {
  kpis?: {
    gross?: number;
    net?: number;
    orders?: number;
    codReady?: number;
    margin?: number;
    deliveryRate?: number;
    avgOrder?: number;
    returned?: number;
  };
  marketShare?: Array<{ key: string; name?: string; sales: number; orders: number; pct?: number }>;
  recent?: Array<{ id: number; no: number; customer: string; market: string; total: number; status: number }>;
  hasConnectedData?: boolean;
}

export default function DashboardOverviewPage() {
  const { data: boot } = useBootstrap();
  const [range, setRange] = useState<'7' | '30' | '90'>('30');
  const [source, setSource] = useState<'all' | 'connected'>('all');
  const [dash, setDash] = useState<DashboardSummary | null>(null);

  useEffect(() => {
    if (!boot?.me) return;
    api.get<DashboardSummary>(`/api/dashboard?range=${range}&source=${source}`)
      .then(setDash)
      .catch(() => {});
  }, [boot?.me, range, source]);

  const k = dash?.kpis || {};
  const markets = dash?.marketShare || [];
  const recent = dash?.recent || [];
  const maxSales = Math.max(1, ...markets.map((m) => Number(m.sales || 0)));

  return (
    <AppShell
      title="نظرة عامة على المتجر"
      subtitle={`مرحبًا ${boot?.me?.storeName || ''} · مؤشرات الأداء الموحدة بالجنيه المصري`}
      user={boot?.me}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-1.5">
          {(['7', '30', '90'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setRange(d)}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
                range === d ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
              }`}
            >
              آخر {d} يوم
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSource('all')}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
              source === 'all' ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            كل الطلبات
          </button>
          <button
            type="button"
            onClick={() => setSource('connected')}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
              source === 'connected' ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            الأسواق المربوطة فقط
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">إجمالي المبيعات</div>
          <div className="text-2xl font-extrabold font-mono-num">{fmtEGP(k.gross)}</div>
          <div className="text-[11px] text-[var(--muted)]">نسبة التسليم: {fmtNum(k.deliveryRate)}%</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">صافي الربح التقديري</div>
          <div className="text-2xl font-extrabold font-mono-num text-emerald-600">{fmtEGP(k.net)}</div>
          <div className="text-[11px] text-[var(--muted)]">هامش الربح: {fmtNum(k.margin)}%</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">إجمالي الطلبات</div>
          <div className="text-2xl font-extrabold font-mono-num">{fmtNum(k.orders)}</div>
          <div className="text-[11px] text-[var(--muted)]">مرتجعات RTO: {fmtNum(k.returned)}</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">رصيد COD الجاهز للتحويل</div>
          <div className="text-2xl font-extrabold font-mono-num text-amber-600">{fmtEGP(k.codReady)}</div>
          <div className="text-[11px] text-[var(--muted)]">متوسط الطلب: {fmtEGP(k.avgOrder)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">توزيع المبيعات حسب المنصة</h2>
            <Link href="/dashboard/integrations" className="text-xs font-bold text-[var(--primary)]">إدارة الربط ◂</Link>
          </div>
          {markets.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">لا توجد بيانات مبيعات في هذا النطاق — جرّب توسيع الفترة أو إضافة طلبات.</p>
          ) : (
            <div className="space-y-3">
              {markets.map((m) => {
                const pct = m.pct ?? Math.round((Number(m.sales || 0) / maxSales) * 100);
                return (
                  <div key={m.key} className="space-y-1">
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span>{m.name || MARKET_NAMES[m.key] || m.key} ({fmtNum(m.orders)} طلب)</span>
                      <span className="font-mono-num">{fmtEGP(m.sales)}</span>
                    </div>
                    <div className="h-2.5 rounded-full bg-[var(--surface-alt)] overflow-hidden">
                      <div className="h-full rounded-full bg-[#0C5CA4]" style={{ width: `${Math.max(4, pct)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="of-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">إجراءات سريعة</h2>
            <span className="text-xs text-[var(--muted)]">باقة {boot?.plan?.name || 'مجانية'}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Link href="/dashboard/products" className="rounded-xl border border-[var(--border)] p-4 hover:bg-[var(--surface-alt)]">
              <div className="font-bold text-sm">📦 المنتجات والمخزون</div>
              <div className="text-xs text-[var(--muted)] mt-1">{fmtNum(boot?.products?.length || 0)} منتج مسجّل</div>
            </Link>
            <Link href="/dashboard/orders" className="rounded-xl border border-[var(--border)] p-4 hover:bg-[var(--surface-alt)]">
              <div className="font-bold text-sm">🧾 الطلبات والفواتير</div>
              <div className="text-xs text-[var(--muted)] mt-1">{fmtNum(boot?.counts?.pendingOrders || 0)} قيد التجهيز</div>
            </Link>
            <Link href="/dashboard/ai" className="rounded-xl border border-[var(--border)] p-4 hover:bg-[var(--surface-alt)]">
              <div className="font-bold text-sm">✨ استوديو الذكاء</div>
              <div className="text-xs text-[var(--muted)] mt-1">A+ ورادار تسعير ومستشار</div>
            </Link>
            <Link href="/dashboard/cod" className="rounded-xl border border-[var(--border)] p-4 hover:bg-[var(--surface-alt)]">
              <div className="font-bold text-sm">💰 حاسبة الأرباح وCOD</div>
              <div className="text-xs text-[var(--muted)] mt-1">عمولات أمازون ونون وجوميا</div>
            </Link>
          </div>
        </section>
      </div>

      {recent.length > 0 && (
        <section className="of-card overflow-x-auto">
          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="font-extrabold text-sm">أحدث الطلبات</h2>
            <Link href="/dashboard/orders" className="text-xs font-bold text-[var(--primary)]">عرض الكل ◂</Link>
          </div>
          <table className="w-full text-sm text-right">
            <thead className="bg-[var(--surface-alt)] text-xs">
              <tr>
                <th className="p-3">الطلب</th>
                <th className="p-3">العميل</th>
                <th className="p-3">المنصة</th>
                <th className="p-3">الإجمالي</th>
                <th className="p-3">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {recent.slice(0, 6).map((o) => {
                const st = ORDER_STATUS_LABELS[o.status] || ORDER_STATUS_LABELS[0];
                return (
                  <tr key={o.id}>
                    <td className="p-3 font-mono-num font-bold">#{o.no}</td>
                    <td className="p-3 font-bold">{o.customer}</td>
                    <td className="p-3">{MARKET_NAMES[o.market] || o.market}</td>
                    <td className="p-3 font-mono-num font-bold">{fmtEGP(o.total)}</td>
                    <td className="p-3">
                      <span className={`inline-block rounded-lg px-2 py-0.5 text-xs font-bold ${st.tone}`}>{st.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </AppShell>
  );
}
