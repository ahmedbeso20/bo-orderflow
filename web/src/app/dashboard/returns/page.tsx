'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP, fmtNum, MARKET_NAMES } from '@/lib/format';
import type { Order } from '@/lib/types';

interface ReturnsResponse {
  returns?: Order[];
  summary?: {
    count?: number;
    totalReturns?: number;
    returnRate?: number;
    totalAmount?: number;
    returnsValue?: number;
    shipLoss?: number;
  };
  byCourier?: Array<{ courier: string; n: number; loss: number }>;
}

export default function ReturnsPage() {
  const { data: boot } = useBootstrap();
  const [data, setData] = useState<ReturnsResponse | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(t);
  }, [query]);

  const loadReturns = useCallback(async () => {
    try {
      const qs = debouncedQuery.trim() ? `?q=${encodeURIComponent(debouncedQuery.trim())}` : '';
      const res = await api.get<ReturnsResponse>(`/api/returns${qs}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات المرتجعات');
    }
  }, [debouncedQuery]);

  useEffect(() => {
    if (boot?.me) void loadReturns();
  }, [boot?.me, loadReturns]);

  async function saveReason(id: number) {
    setError('');
    setNotice('');
    try {
      await api.post(`/api/returns/${id}/reason`, { reason: reasonDraft.trim() });
      setEditingId(null);
      setReasonDraft('');
      setNotice('تم تحديث سبب المرتجع بنجاح ✓');
      await loadReturns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ السبب');
    }
  }

  const s = data?.summary || {};
  const list = data?.returns || [];
  const byCourier = data?.byCourier || [];

  return (
    <AppShell
      title="تحليلات المرتجعات وRTO"
      subtitle="متابعة مرتجعات الدفع عند الاستلام، خسائر الشحن ذهابًا وإيابًا، وأسباب الرفض"
      user={boot?.me}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">معدل المرتجعات (RTO)</div>
          <div className="text-2xl font-extrabold font-mono-num text-rose-600">{fmtNum(s.returnRate)}%</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">إجمالي الطلبات المرتجعة</div>
          <div className="text-2xl font-extrabold font-mono-num">{fmtNum(s.totalReturns ?? s.count)}</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">قيمة البضاعة المرتجعة</div>
          <div className="text-2xl font-extrabold font-mono-num">{fmtEGP(s.returnsValue ?? s.totalAmount)}</div>
        </div>
        <div className="of-card p-5 space-y-1">
          <div className="text-xs font-bold text-[var(--muted)]">خسارة الشحن التقديرية (×1.8)</div>
          <div className="text-2xl font-extrabold font-mono-num text-amber-600">{fmtEGP(s.shipLoss)}</div>
        </div>
      </div>

      {byCourier.length > 0 && (
        <section className="of-card p-5 mb-6">
          <h2 className="font-extrabold text-sm mb-3">توزيع المرتجعات حسب شركة الشحن</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {byCourier.map((c) => (
              <div key={c.courier} className="rounded-xl border border-[var(--border)] p-3 flex items-center justify-between text-xs">
                <div>
                  <div className="font-bold text-sm">{c.courier}</div>
                  <div className="text-[var(--muted)]">{fmtNum(c.n)} شحنة مرتجعة</div>
                </div>
                <div className="font-mono-num font-bold text-rose-600">{fmtEGP(c.loss)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="mb-4 max-w-md">
        <input
          className="of-input"
          placeholder="ابحث في المرتجعات بالعميل أو المحافظة أو شركة الشحن..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {notice && <p className="mb-4 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">الطلب</th>
              <th className="p-3">العميل</th>
              <th className="p-3">السوق والشحن</th>
              <th className="p-3">القيمة</th>
              <th className="p-3">سبب المرتجع</th>
              <th className="p-3">إجراء</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {list.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-xs text-[var(--muted)]">
                  لا توجد مرتجعات مسجلة حاليًا — أداء ممتاز!
                </td>
              </tr>
            ) : (
              list.map((o) => (
                <tr key={o.id}>
                  <td className="p-3 font-mono-num font-bold">
                    #{o.no}
                    <div className="text-[11px] font-normal text-[var(--muted)]">{fmtDate(o.createdAt)}</div>
                  </td>
                  <td className="p-3">
                    <div className="font-bold">{o.customer}</div>
                    <div className="text-xs text-[var(--muted)]">{o.gov}</div>
                  </td>
                  <td className="p-3 text-xs">
                    <div>{MARKET_NAMES[o.market] || o.market}</div>
                    <div className="text-[var(--muted)]">{o.courier}</div>
                  </td>
                  <td className="p-3 font-mono-num font-bold">{fmtEGP(o.total)}</td>
                  <td className="p-3">
                    {editingId === o.id ? (
                      <div className="flex gap-1.5">
                        <input
                          className="of-input text-xs py-1.5"
                          value={reasonDraft}
                          onChange={(e) => setReasonDraft(e.target.value)}
                          placeholder="اكتب سبب المرتجع..."
                        />
                        <button
                          type="button"
                          onClick={() => void saveReason(o.id)}
                          className="rounded-lg bg-[#0C5CA4] px-3 py-1 text-xs font-bold text-white shrink-0"
                        >
                          حفظ
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs">{o.returnReason || 'غير محدد'}</span>
                    )}
                  </td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(o.id);
                        setReasonDraft(o.returnReason || '');
                      }}
                      className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-bold"
                    >
                      تعديل السبب
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
