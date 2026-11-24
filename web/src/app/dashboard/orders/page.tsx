'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP, MARKET_NAMES, ORDER_STATUS_LABELS } from '@/lib/format';
import type { Order } from '@/lib/types';

export default function OrdersPage() {
  const { data: boot } = useBootstrap();
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState('');
  const [waPreview, setWaPreview] = useState('');
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadOrders(q = query) {
    try {
      const res = await api.get<{ items?: Order[] }>(`/api/orders?q=${encodeURIComponent(q)}`);
      setOrders(res.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل الطلبات');
    }
  }

  useEffect(() => {
    if (boot?.me) void loadOrders('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot?.me]);

  async function advanceStatus(id: number, status: number) {
    setError('');
    setNotice('');
    try {
      await api.post(`/api/orders/${id}/status`, { status });
      setNotice('تم تحديث حالة الطلب بنجاح');
      await loadOrders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحديث حالة الطلب');
    }
  }

  async function submitCancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelOrder) return;
    setError('');
    setNotice('');
    try {
      await api.post(`/api/orders/${cancelOrder.id}/cancel`, {
        reason: cancelReason.trim() || 'إلغاء بطلب العميل'
      });
      setCancelOrder(null);
      setCancelReason('');
      setNotice('تم إلغاء الطلب واستعادة كميات المخزون تلقائيًا');
      await loadOrders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إلغاء الطلب');
    }
  }

  async function generateWhatsApp(id: number) {
    setError('');
    try {
      const res = await api.post<{ text?: string }>('/api/ai/order-message', { orderId: id });
      setWaPreview(res.text || '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر توليد رسالة واتساب');
    }
  }

  async function createCourierAwb(id: number, courier: 'bosta' | 'aramex') {
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ awb?: string; message?: string }>(`/api/couriers/orders/${id}/awb`, { courier });
      setNotice(res.message || `تم إصدار بوليصة الشحن بنجاح${res.awb ? ` (${res.awb})` : ''}`);
      await loadOrders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إصدار بوليصة الشحن — تأكد من ربط شركة الشحن في صفحة التكاملات');
    }
  }

  async function trackCourierAwb(id: number) {
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ status?: string; courierStatus?: string }>(`/api/couriers/orders/${id}/track`, {});
      setNotice(`حالة الشحنة المحدّثة: ${res.courierStatus || res.status || 'تم التحديث'}`);
      await loadOrders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تتبع الشحنة حاليًا');
    }
  }

  return (
    <AppShell title="الطلبات والفواتير" subtitle="تتبع الطلبات، فواتير QR، بوالص الشحن AWB، ورسائل واتساب الذكية" user={boot?.me}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <form
          onSubmit={(e) => { e.preventDefault(); void loadOrders(query); }}
          className="flex gap-2 flex-1 max-w-md"
        >
          <input
            className="of-input"
            placeholder="ابحث برقم الطلب أو اسم العميل أو الهاتف أو العنوان..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="rounded-xl bg-[#0C5CA4] px-4 text-xs font-bold text-white shrink-0">بحث</button>
        </form>
        <div className="flex flex-wrap gap-2">
          <a
            href="/api/orders/export.csv"
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-bold hover:bg-[var(--surface-alt)]"
          >
            📥 تصدير CSV
          </a>
        </div>
      </div>

      {notice && <p className="mb-4 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      {waPreview && (
        <div className="of-card p-4 mb-5 space-y-2 border-emerald-500/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">رسالة واتساب المولّدة للعميل</strong>
            <button type="button" onClick={() => setWaPreview('')} className="text-xs font-bold">إغلاق</button>
          </div>
          <p className="text-sm whitespace-pre-wrap">{waPreview}</p>
        </div>
      )}

      {cancelOrder && (
        <form onSubmit={submitCancel} className="of-card p-5 mb-5 space-y-3 border-rose-500/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">إلغاء الطلب #{cancelOrder.no} ({cancelOrder.customer})</strong>
            <button type="button" onClick={() => setCancelOrder(null)} className="text-xs font-bold">إغلاق</button>
          </div>
          <input
            className="of-input"
            placeholder="سبب الإلغاء (مثال: طلب العميل الإلغاء / عدم الرد)"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            required
          />
          <button type="submit" className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white">
            تأكيد الإلغاء واستعادة المخزون
          </button>
        </form>
      )}

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">الطلب</th>
              <th className="p-3">السوق</th>
              <th className="p-3">العميل والشحن</th>
              <th className="p-3">الإجمالي</th>
              <th className="p-3">الحالة</th>
              <th className="p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {orders.map((o) => {
              const st = ORDER_STATUS_LABELS[o.status] || ORDER_STATUS_LABELS[0];
              const awbCode = o.awbNumber || o.awb;
              return (
                <tr key={o.id}>
                  <td className="p-3 font-mono-num font-bold">
                    #{o.no}
                    <div className="text-[11px] font-normal text-[var(--muted)]">{fmtDate(o.createdAt)}</div>
                  </td>
                  <td className="p-3">{MARKET_NAMES[o.market] || o.market}</td>
                  <td className="p-3">
                    <div className="font-bold">{o.customer}</div>
                    <div className="text-xs text-[var(--muted)]">{o.gov} · {o.courier}</div>
                    {awbCode && <div className="text-[11px] font-mono-num text-[var(--primary)]" dir="ltr">AWB: {awbCode}</div>}
                  </td>
                  <td className="p-3 font-mono-num font-bold">{fmtEGP(o.total)}</td>
                  <td className="p-3">
                    <span className={`inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${st.tone}`}>{st.label}</span>
                  </td>
                  <td className="p-3 flex flex-wrap gap-1.5">
                    {o.status === 0 && (
                      <button
                        type="button"
                        onClick={() => void advanceStatus(o.id, 1)}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                      >
                        شحن
                      </button>
                    )}
                    {o.status === 1 && (
                      <button
                        type="button"
                        onClick={() => void advanceStatus(o.id, 2)}
                        className="rounded-lg border border-emerald-500/40 px-2.5 py-1 text-xs font-bold text-emerald-700"
                      >
                        تسليم
                      </button>
                    )}
                    {(o.status === 0 || o.status === 1) && (
                      <button
                        type="button"
                        onClick={() => { setCancelOrder(o); setCancelReason(''); }}
                        className="rounded-lg border border-rose-500/40 px-2.5 py-1 text-xs font-bold text-rose-600"
                      >
                        إلغاء
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void generateWhatsApp(o.id)}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      واتساب ذكي
                    </button>
                    <a
                      href={`/api/orders/${o.id}/invoice`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      فاتورة QR
                    </a>
                    <a
                      href={`/api/orders/awb?ids=${o.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      بوليصة AWB
                    </a>
                    {!awbCode && o.status === 0 && (
                      <button
                        type="button"
                        onClick={() => void createCourierAwb(o.id, o.courier?.includes('أرامكس') ? 'aramex' : 'bosta')}
                        className="rounded-lg bg-[#0C5CA4] px-2.5 py-1 text-xs font-bold text-white"
                      >
                        إصدار AWB
                      </button>
                    )}
                    {awbCode && (
                      <button
                        type="button"
                        onClick={() => void trackCourierAwb(o.id)}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                      >
                        تتبع الشحنة
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
