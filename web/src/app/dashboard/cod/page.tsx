'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum } from '@/lib/format';

interface CodCourier {
  key: string;
  name: string;
  orders: number;
  pending: number;
  settled: number;
}

export default function CodAndProfitPage() {
  const { data: boot } = useBootstrap();
  const [couriers, setCouriers] = useState<CodCourier[]>([]);
  const [price, setPrice] = useState(1000);
  const [cost, setCost] = useState(550);
  const [shipping, setShipping] = useState(65);
  const [commissionPct, setCommissionPct] = useState(12);

  async function loadCod() {
    const res = await api.get<{ couriers?: CodCourier[] }>('/api/cod');
    setCouriers(res.couriers || []);
  }

  useEffect(() => {
    if (boot?.me) void loadCod();
  }, [boot?.me]);

  async function settleCourier(key: string) {
    await api.post(`/api/cod/${encodeURIComponent(key)}/settle`, {});
    await loadCod();
  }

  const commission = (price * commissionPct) / 100;
  const netProfit = price - cost - shipping - commission;
  const margin = price > 0 ? Math.round((netProfit / price) * 100) : 0;

  return (
    <AppShell title="تحصيلات COD وحاسبة الأرباح" subtitle="متابعة شركات الشحن وحساب صافي الربح بالجنيه المصري" user={boot?.me}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">تسويات الدفع عند الاستلام (COD)</h2>
          <div className="space-y-3">
            {couriers.map((c) => (
              <div key={c.key} className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold">{c.name}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {fmtNum(c.orders)} شحنة · محصّل: {fmtEGP(c.settled)}
                  </div>
                </div>
                <div className="text-left space-y-1">
                  <div className="font-mono-num font-bold text-amber-600">{fmtEGP(c.pending)}</div>
                  {c.pending > 0 && (
                    <button
                      type="button"
                      onClick={() => void settleCourier(c.key)}
                      className="rounded-lg bg-[#0C5CA4] px-3 py-1 text-xs font-bold text-white"
                    >
                      تأكيد التحصيل
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
