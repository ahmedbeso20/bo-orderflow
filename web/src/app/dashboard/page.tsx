'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { api } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum, MARKET_NAMES } from '@/lib/format';

interface DashboardSummary {
  kpis?: {
    sales?: number;
    profit?: number;
    orders?: number;
    codPending?: number;
    lowStock?: number;
    rtoRate?: number;
  };
  byMarket?: Array<{ market: string; sales: number; orders: number }>;
  recentOrders?: Array<{ id: number; no: number; customer: string; market: string; total: number; status: number }>;
}

export default function DashboardOverviewPage() {
  const { data: boot } = useBootstrap();
  const [dash, setDash] = useState<DashboardSummary | null>(null);

  useEffect(() => {
    if (!boot?.me) return;
    api.get<DashboardSummary>('/api/dashboard').then(setDash).catch(() => {});
  }, [boot?.me]);

  const k = dash?.kpis || {};
  const markets = dash?.byMarket || [];
  const maxSales = Math.max(1, ...markets.map((m) => Number(m.sales || 0)));

  return (
    <AppShell
      title="نظرة عامة على المتجر"
      subtitle={`مرحبًا ${boot?.me?.storeName || ''} · مؤشرات الأداء الموحدة بالجنيه المصري`}
      user={boot?.me}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">إجمالي المبيعات</div>
          <div className="text-2xl font-extrabold font-mono-num">{fmtEGP(k.sales)}</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">صافي الربح التقديري</div>
          <div className="text-2xl font-extrabold font-mono-num text-emerald-600">{fmtEGP(k.profit)}</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">إجمالي الطلبات</div>
          <div className="text-2xl font-extrabold font-mono-num">{fmtNum(k.orders)}</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">تحصيلات COD المعلقة</div>
          <div className="text-2xl font-extrabold font-mono-num text-amber-600">{fmtEGP(k.codPending)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="of-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">توزيع المبيعات حسب المنصة</h2>
            <Link href="/dashboard/integrations" className="text-xs font-bold text-[var(--primary)]">إدارة الربط ◂</Link>
          </div>
          {markets.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">لا توجد بيانات مبيعات بعد — ابدأ بإضافة منتجاتك وطلباتك.</p>
          ) : (
            <div className="space-y-3">
              {markets.map((m) => {
                const pct = Math.round((Number(m.sales || 0) / maxSales) * 100);
                return (
                  <div key={m.market} className="space-y-1">
                    <div className="flex items-center justify-between text-xs font-bold">
                      <span>{MARKET_NAMES[m.market] || m.market} ({fmtNum(m.orders)} طلب)</span>
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
              <div className="font-bold text-sm">📦 استيراد وإدارة المنتجات</div>
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
    </AppShell>
  );
}
