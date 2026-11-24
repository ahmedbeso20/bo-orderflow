'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP } from '@/lib/format';
import type { PlanItem } from '@/lib/types';

interface GatewayInfo {
  provider?: string;
  providerName?: string;
  label?: string;
  mode?: string;
  sandbox?: boolean;
  collectsCardData?: boolean;
  methods?: Array<string | { id: string; name: string }>;
}

interface PaymentRow {
  id: number;
  txRef: string;
  receiptNo?: number | null;
  plan: string;
  cycle?: string;
  amount: number;
  status: string;
  method?: string;
  createdAt: string;
}

interface BillingData {
  plan?: { id: string; name: string; limit: number | null; cycle?: string; expiresAt?: string | null };
  plans?: PlanItem[];
  gateway?: GatewayInfo;
  payments?: PaymentRow[];
}

const METHOD_LABELS: Record<string, string> = {
  kashier: 'بوابة كاشير (بطاقة / محفظة)',
  card: 'بطاقة بنكية (Visa / Mastercard / Meeza)',
  wallet: 'محفظة إلكترونية (فودافون / اتصالات / أورنج)',
  instapay: 'InstaPay'
};

export default function BillingPage() {
  const { data: boot, reload } = useBootstrap();
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [coupon, setCoupon] = useState('');
  const [couponMsg, setCouponMsg] = useState('');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [method, setMethod] = useState('kashier');
  const [walletPhone, setWalletPhone] = useState('');
  const [walletOtp, setWalletOtp] = useState('123456');
  const [pollingRef, setPollingRef] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const loadBilling = useCallback(async () => {
    try {
      const res = await api.get<BillingData>('/api/billing');
      setBilling(res);
      if (res.gateway?.methods && res.gateway.methods.length > 0) {
        const first = res.gateway.methods[0];
        setMethod(typeof first === 'string' ? first : first.id);
      } else if (res.gateway?.provider === 'kashier') {
        setMethod('kashier');
      } else {
        setMethod('wallet');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات الفوترة');
    }
  }, []);

  useEffect(() => {
    if (boot?.me) {
      setWalletPhone(boot.me.phone || '');
      void loadBilling();
    }
  }, [boot?.me, loadBilling]);

  // Poll payment confirmation when returning from Kashier / hosted gateway (?pay_ref=...)
  useEffect(() => {
    if (!boot?.me || typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const ref = (sp.get('pay_ref') || '').trim();
    if (!ref) return;
    setPollingRef(ref);
    let cancelled = false;
    let attempts = 0;

    const check = async () => {
      attempts += 1;
      try {
        const st = await api.get<{ status?: string; payment?: { status?: string } }>(`/api/billing/status/${encodeURIComponent(ref)}`);
        if (cancelled) return;
        const status = st.payment?.status || st.status || 'pending';
        if (status === 'paid' || status === 'success') {
          setPollingRef('');
          setNotice('تم تأكيد الدفع وتفعيل باقتك الجديدة بنجاح ✓');
          await Promise.all([loadBilling(), reload()]);
          return;
        }
        if (status === 'failed' || status === 'cancelled' || status === 'refunded') {
          setPollingRef('');
          setError(`لم تكتمل عملية الدفع (الحالة: ${status})`);
          await loadBilling();
          return;
        }
      } catch {
        // retry while pending
      }
      if (!cancelled && attempts < 12) {
        setTimeout(() => void check(), 2500);
      } else if (!cancelled) {
        setPollingRef('');
        setNotice('تم استلام طلب الدفع وجارٍ التحقق النهائي مع بوابة الدفع — يمكنك تحديث الصفحة خلال لحظات.');
      }
    };

    void check();
    return () => { cancelled = true; };
  }, [boot?.me, loadBilling, reload]);

  async function checkCoupon() {
    setCouponMsg('');
    setError('');
    if (!coupon.trim()) return;
    try {
      const res = await api.post<{ coupon?: { code: string; desc?: string }; quote?: { total: number; discount: number } }>('/api/billing/coupon', {
        plan: 'pro',
        cycle,
        code: coupon.trim()
      });
      setCouponMsg(`الكوبون ${res.coupon?.code || coupon} صالح (${res.coupon?.desc || ''}) — الخصم: ${fmtEGP(res.quote?.discount)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الكوبون غير صالح');
    }
  }

  async function subscribe(planId: string) {
    setError('');
    setNotice('');
    try {
      const idemKey = `web-${planId}-${cycle}-${Date.now()}`;
      const payload: Record<string, unknown> = {
        plan: planId,
        cycle,
        method,
        idempotencyKey: idemKey,
        coupon: coupon.trim() || undefined
      };
      if (billing?.gateway?.sandbox && method === 'wallet') {
        payload.walletPhone = walletPhone.trim() || boot?.me?.phone || '01000000000';
        payload.walletOtp = walletOtp.trim() || '123456';
      }
      const res = await api.post<{ redirectUrl?: string; status?: string }>('/api/billing/checkout', payload);
      if (res.redirectUrl) {
        window.location.assign(res.redirectUrl);
        return;
      }
      setNotice('تم تحديث الباقة بنجاح ✓');
      await Promise.all([loadBilling(), reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إتمام الاشتراك');
    }
  }

  async function openReceipt(paymentId: number) {
    setError('');
    try {
      const res = await api.post<{ url: string }>(`/api/billing/payments/${paymentId}/receipt-link`, {});
      if (res.url) {
        window.location.assign(res.url);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر فتح الإيصال');
    }
  }

  const methods = (billing?.gateway?.methods || ['wallet', 'instapay', 'kashier']).map((m) =>
    typeof m === 'string' ? { id: m, name: METHOD_LABELS[m] || m } : m
  );

  const gatewayTitle = billing?.gateway?.providerName || billing?.gateway?.label || billing?.gateway?.provider || '';

  return (
    <AppShell title="الباقات والاشتراكات" subtitle="ترقية الباقة، تطبيق الكوبونات، وسجل الإيصالات الضريبية" user={boot?.me}>
      {pollingRef && (
        <div className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-xs font-bold text-amber-800 dark:text-amber-200">
          جارٍ تأكيد حالة الدفع للمرجع <span className="font-mono-num" dir="ltr">{pollingRef}</span>...
        </div>
      )}

      <div className="of-card p-5 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs text-[var(--muted)]">باقتك الحالية</div>
          <div className="text-lg font-extrabold">{billing?.plan?.name || boot?.plan?.name || 'مجانية'}</div>
          {billing?.plan?.expiresAt && (
            <div className="text-xs text-[var(--muted)]">تنتهي في: {fmtDate(billing.plan.expiresAt)}</div>
          )}
          {gatewayTitle && (
            <div className="text-[11px] text-[var(--muted)] mt-0.5">بوابة الدفع: {gatewayTitle}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="of-input w-40"
            dir="ltr"
            placeholder="كود كوبون خصم"
            value={coupon}
            onChange={(e) => setCoupon(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void checkCoupon()}
            className="rounded-xl border border-[var(--border)] px-3 py-2.5 text-xs font-bold"
          >
            تحقق من الكوبون
          </button>
          <select
            className="of-input w-52"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {methods.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCycle((c) => (c === 'monthly' ? 'yearly' : 'monthly'))}
            className="rounded-xl border border-[var(--border)] px-3 py-2.5 text-xs font-bold"
          >
            الدورة: {cycle === 'monthly' ? 'شهري' : 'سنوي (توفير)'}
          </button>
        </div>
      </div>

      {billing?.gateway?.sandbox && method === 'wallet' && (
        <div className="of-card p-4 mb-5 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-bold block mb-1">رقم المحفظة (وضع تجريبي)</label>
            <input className="of-input w-44" dir="ltr" value={walletPhone} onChange={(e) => setWalletPhone(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">رمز التحقق التجريبي</label>
            <input className="of-input w-32 font-mono-num" dir="ltr" value={walletOtp} onChange={(e) => setWalletOtp(e.target.value)} />
          </div>
        </div>
      )}

      {couponMsg && <p className="mb-4 text-sm font-bold text-emerald-700 dark:text-emerald-300">{couponMsg}</p>}
      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {(billing?.plans || []).map((p) => {
          const monthly = Number(p.priceMonthly ?? p.price ?? 0);
          const yearly = Number(p.priceYearly ?? p.yearly ?? monthly * 10);
          const displayPrice = cycle === 'yearly' ? yearly : monthly;
          return (
            <div key={p.id} className="of-card p-6 flex flex-col justify-between gap-4">
              <div>
                <h2 className="font-extrabold text-lg">{p.name}</h2>
                <div className="text-2xl font-extrabold font-mono-num mt-2">
                  {displayPrice === 0 ? 'مجاني' : fmtEGP(displayPrice)}
                </div>
                <p className="text-xs text-[var(--muted)] mt-1">
                  {p.products == null ? 'منتجات غير محدودة' : `حتى ${p.products} منتج`} · {p.markets} أسواق · {p.ai} طلب ذكاء يوميًا
                </p>
              </div>
              <button
                type="button"
                onClick={() => void subscribe(p.id)}
                className="w-full rounded-xl bg-[#0C5CA4] py-2.5 text-xs font-bold text-white"
              >
                اختيار {p.name}
              </button>
            </div>
          );
        })}
      </div>

      <section className="of-card overflow-x-auto">
        <div className="p-4 border-b border-[var(--border)] font-extrabold text-sm">سجل المدفوعات والإيصالات</div>
        <table className="w-full text-sm text-right">
          <thead className="bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">المرجع</th>
              <th className="p-3">الباقة</th>
              <th className="p-3">المبلغ</th>
              <th className="p-3">الحالة</th>
              <th className="p-3">التاريخ</th>
              <th className="p-3">الإيصال</th>
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
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => void openReceipt(pay.id)}
                    className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-bold hover:bg-[var(--surface-alt)]"
                  >
                    إيصال ضريبي
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
