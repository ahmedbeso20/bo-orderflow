'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP } from '@/lib/format';

interface CodCourier {
  key: string;
  label: string;
  cycle?: string;
  collected: number;
  pending: number;
  fees: number;
  net: number;
}

interface CodResponse {
  couriers?: CodCourier[];
  totals?: { collected: number; pending: number; fees: number; net: number };
  accountingNotice?: string;
}

export default function CodAndProfitPage() {
  const { data: boot } = useBootstrap();
  const [cod, setCod] = useState<CodResponse | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [price, setPrice] = useState(1000);
  const [cost, setCost] = useState(550);
  const [shipping, setShipping] = useState(65);
  const [commissionPct, setCommissionPct] = useState(12);

  async function loadCod() {
    try {
      const res = await api.get<CodResponse>('/api/cod');
      setCod(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات COD');
    }
  }

  useEffect(() => {
    if (boot?.me) void loadCod();
  }, [boot?.me]);

  async function requestPayout(key: string) {
    setNotice('');
    setError('');
    try {
      await api.post(`/api/cod/${encodeURIComponent(key)}/payout`, {});
      setNotice('تم تسجيل طلب تسوية الدفع عند الاستلام بنجاح');
      await loadCod();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل التسوية');
    }
  }

  const commission = (price * commissionPct) / 100;
  const netProfit = price - cost - shipping - commission;
  const margin = price > 0 ? Math.round((netProfit / price) * 100) : 0;

  return (
    <AppShell title="تحصيلات COD وحاسبة الأرباح" subtitle="متابعة شركات الشحن وحساب صافي الربح بالجنيه المصري" user={boot?.me}>
      {cod?.accountingNotice && (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 p-3.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
          {cod.accountingNotice}
        </div>
      )}
      {notice && <p className="mb-4 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="of-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">تسويات الدفع عند الاستلام (COD)</h2>
            {cod?.totals && (
              <span className="text-xs font-mono-num font-bold text-emerald-600">
                صافي جاهز: {fmtEGP(cod.totals.net)}
              </span>
            )}
          </div>
          <div className="space-y-3">
            {(cod?.couriers || []).map((c) => (
              <div key={c.key} className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold">{c.label}</div>
                  <div className="text-xs text-[var(--muted)]">
                    محصّل: {fmtEGP(c.collected)} · رسوم: {fmtEGP(c.fees)} · معلّق: {fmtEGP(c.pending)}
                  </div>
                  {c.cycle && <div className="text-[11px] text-[var(--muted)]">دورة التحويل: {c.cycle}</div>}
                </div>
                <div className="text-left space-y-1">
                  <div className="font-mono-num font-bold text-emerald-600">{fmtEGP(c.net)}</div>
                  {c.net > 0 && (
                    <button
                      type="button"
                      onClick={() => void requestPayout(c.key)}
                      className="rounded-lg bg-[#0C5CA4] px-3 py-1 text-xs font-bold text-white"
                    >
                      تسجيل تسوية
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">حاسبة أرباح المنصات المصرية</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold block mb-1">سعر البيع (ج.م)</label>
              <input type="number" className="of-input" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">تكلفة المنتج (ج.م)</label>
              <input type="number" className="of-input" value={cost} onChange={(e) => setCost(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الشحن والتغليف (ج.م)</label>
              <input type="number" className="of-input" value={shipping} onChange={(e) => setShipping(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">عمولة المنصة (%)</label>
              <input type="number" className="of-input" value={commissionPct} onChange={(e) => setCommissionPct(Number(e.target.value))} />
            </div>
          </div>

          <div className="rounded-xl bg-[var(--surface-alt)] p-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-xs text-[var(--muted)]">العمولة</div>
              <div className="font-mono-num font-bold">{fmtEGP(commission)}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--muted)]">صافي الربح</div>
              <div className={`font-mono-num font-extrabold ${netProfit >= 0 ? 'text-emerald-600' : 'text-[var(--danger)]'}`}>
                {fmtEGP(netProfit)}
              </div>
            </div>
            <div>
              <div className="text-xs text-[var(--muted)]">الهامش</div>
              <div className="font-mono-num font-bold">{margin}%</div>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
