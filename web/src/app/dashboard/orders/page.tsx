'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP, MARKET_NAMES, ORDER_STATUS_LABELS } from '@/lib/format';
import type { Order } from '@/lib/types';

export default function OrdersPage() {
  const { data: boot } = useBootstrap();
  const [orders, setOrders] = useState<Order[]>([]);
  const [waPreview, setWaPreview] = useState('');

  async function loadOrders() {
    const res = await api.get<{ items?: Order[] }>('/api/orders');
    setOrders(res.items || []);
  }

  useEffect(() => {
    if (boot?.me) void loadOrders();
  }, [boot?.me]);

  async function advanceStatus(id: number, status: number) {
    await api.post(`/api/orders/${id}/status`, { status });
    await loadOrders();
  }

  async function generateWhatsApp(id: number) {
    const res = await api.post<{ message?: string }>(`/api/orders/${id}/ai-whatsapp`, {});
    setWaPreview(res.message || '');
  }

  return (
    <AppShell title="الطلبات والفواتير" subtitle="تتبع الطلبات، فواتير QR، ورسائل واتساب الذكية" user={boot?.me}>
      {waPreview && (
        <div className="of-card p-4 mb-5 space-y-2 border-emerald-500/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">رسالة واتساب المولّدة للعميل</strong>
            <button type="button" onClick={() => setWaPreview('')} className="text-xs font-bold">إغلاق</button>
          </div>
          <p className="text-sm whitespace-pre-wrap">{waPreview}</p>
        </div>
      )}

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">الطلب</th>
              <th className="p-3">السوق</th>
              <th className="p-3">العميل</th>
              <th className="p-3">الإجمالي</th>
              <th className="p-3">الحالة</th>
              <th className="p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {orders.map((o) => {
              const st = ORDER_STATUS_LABELS[o.status] || ORDER_STATUS_LABELS[0];
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
                    <button
                      type="button"
                      onClick={() => void generateWhatsApp(o.id)}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      واتساب ذكي
                    </button>
                    <a
                      href={`/invoice/${o.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      فاتورة QR
                    </a>
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
