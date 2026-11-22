'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP } from '@/lib/format';

interface BillingData {
  plan?: { id: string; name: string; limit: number; cycle?: string; expiresAt?: string | null };
  plans?: Array<{ id: string; name: string; price: number; yearly: number; limit: number }>;
  payments?: Array<{ id: number; txRef: string; plan: string; amount: number; status: string; createdAt: string }>;
}

export default function BillingPage() {
  const { data: boot, reload } = useBootstrap();
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [coupon, setCoupon] = useState('');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadBilling() {
    const res = await api.get<BillingData>('/api/billing');
    setBilling(res);
  }

  useEffect(() => {
    if (boot?.me) void loadBilling();
  }, [boot?.me]);

  async function subscribe(planId: string) {
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ redirectUrl?: string; status?: string }>('/api/billing/checkout', {
        plan: planId,
        cycle,
        coupon: coupon.trim() || undefined
      });
      if (res.redirectUrl) {
        window.location.assign(res.redirectUrl);
        return;
      }
      setNotice('تم تحديث الباقة بنجاح');
      await Promise.all([loadBilling(), reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إتمام الاشتراك');
    }
  }

  return (
    <AppShell title="الباقات والاشتراكات" subtitle="ترقية الباقة، تطبيق الكوبونات، وسجل الإيصالات الضريبية" user={boot?.me}>
      <div className="of-card p-5 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs text-[var(--muted)]">باقتك الحالية</div>
          <div className="text-lg font-extrabold">{billing?.plan?.name || boot?.plan?.name || 'مجانية'}</div>
          {billing?.plan?.expiresAt && (
            <div className="text-xs text-[var(--muted)]">تنتهي في: {fmtDate(billing.plan.expiresAt)}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="of-input w-44"
            dir="ltr"
            placeholder="كود كوبون خصم"
            value={coupon}
            onChange={(e) => setCoupon(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setCycle((c) => (c === 'monthly' ? 'yearly' : 'monthly'))}
            className="rounded-xl border border-[var(--border)] px-3 py-2.5 text-xs font-bold"
          >
            الدورة: {cycle === 'monthly' ? 'شهري' : 'سنوي (توفير)'}
          </button>
        </div>
      </div>

      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {(billing?.plans || []).map((p) => (
          <div key={p.id} className="of-card p-6 flex flex-col justify-between gap-4">
            <div>
              <h2 className="font-extrabold text-lg">{p.name}</h2>
              <div className="text-2xl font-extrabold font-mono-num mt-2">
                {fmtEGP(cycle === 'yearly' ? p.yearly : p.price)}
              </div>
              <p className="text-xs text-[var(--muted)] mt-1">حتى {p.limit} منتج</p>
            </div>
            <button
              type="button"
              onClick={() => void subscribe(p.id)}
              className="w-full rounded-xl bg-[#0C5CA4] py-2.5 text-xs font-bold text-white"
            >
              اختيار {p.name}
            </button>
          </div>
        ))}
      </div>

      <section className="of-card overflow-x-auto">
        <div className="p-4 border-b border-[var(--border)] font-extrabold text-sm">سجل المدفوعات</div>
        <table className="w-full text-sm text-right">
          <thead className="bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">المرجع</th>
              <th className="p-3">الباقة</th>
              <th className="p-3">المبلغ</th>
              <th className="p-3">الحالة</th>
              <th className="p-3">التاريخ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {(billing?.payments || []).map((pay) => (
              <tr key={pay.id}>
                <td className="p-3 font-mono-num text-xs" dir="ltr">{pay.txRef}</td>
                <td className="p-3">{pay.plan}</td>
                <td className="p-3 font-mono-num font-bold">{fmtEGP(pay.amount)}</td>
                <td className="p-3">{pay.status}</td>
                <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(pay.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
