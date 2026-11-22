'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate } from '@/lib/format';

interface PendingClient {
  id: number;
  storeName: string;
  fullName?: string;
  email?: string;
  phone: string;
  status: string;
  createdAt: string;
}

interface ApprovalItem {
  id: number;
  type: 'product' | 'order';
  name?: string;
  customer?: string;
  approvalStatus: string;
}

export default function ModeratorPanelPage() {
  const { data: boot } = useBootstrap('moderator');
  const [clients, setClients] = useState<PendingClient[]>([]);
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadAll() {
    setError('');
    try {
      const [cRes, aRes] = await Promise.all([
        api.get<{ clients?: PendingClient[] }>('/api/moderator/clients?status=pending').catch(() => ({ clients: [] })),
        api.get<{ products?: ApprovalItem[]; orders?: ApprovalItem[] }>('/api/moderator/approvals?status=pending').catch(() => ({ products: [], orders: [] }))
      ]);
      setClients(cRes.clients || []);
      setItems([
        ...(aRes.products || []).map((p) => ({ ...p, type: 'product' as const })),
        ...(aRes.orders || []).map((o) => ({ ...o, type: 'order' as const }))
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل قائمة المراجعة');
    }
  }

  useEffect(() => {
    if (boot?.me?.role === 'moderator') void loadAll();
  }, [boot?.me?.role]);

  async function decideClient(id: number, approve: boolean) {
    await api.post(`/api/moderator/clients/${id}/${approve ? 'approve' : 'reject'}`, approve ? {} : { reason: 'بيانات غير مكتملة' });
    setNotice(approve ? 'تم اعتماد العميل' : 'تم رفض العميل');
    await loadAll();
  }

  async function decideItem(type: 'product' | 'order', id: number, approve: boolean) {
    await api.post(
      `/api/moderator/approvals/${type}/${id}/${approve ? 'approve' : 'reject'}`,
      approve ? {} : { reason: 'مخالفة سياسة المراجعة' }
    );
    setNotice(approve ? 'تم الاعتماد وإشعار التاجر' : 'تم الرفض واستعادة المخزون وإشعار التاجر');
    await loadAll();
  }

  return (
    <AppShell
      title="لوحة مراجعة المشرف"
      subtitle="اعتماد حسابات التجار ومراجعة المنتجات والطلبات"
      user={boot?.me}
      nav={[{ href: '/moderator', label: 'قائمة المراجعة', icon: '✅' }]}
    >
      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">حسابات العملاء بانتظار التفعيل ({clients.length})</h2>
          {clients.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">لا توجد حسابات معلقة حاليًا.</p>
          ) : (
            clients.map((c) => (
              <div key={c.id} className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold">{c.storeName}</div>
                  <div className="text-xs text-[var(--muted)]">{c.email || c.phone} · {fmtDate(c.createdAt)}</div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void decideClient(c.id, true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">قبول</button>
                  <button type="button" onClick={() => void decideClient(c.id, false)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white">رفض</button>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">المنتجات والطلبات بانتظار المراجعة ({items.length})</h2>
          {items.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">لا توجد منتجات أو طلبات معلقة حاليًا.</p>
          ) : (
            items.map((item) => (
              <div key={`${item.type}-${item.id}`} className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold">{item.type === 'product' ? `منتج: ${item.name}` : `طلب #${item.id}: ${item.customer}`}</div>
                  <div className="text-xs text-[var(--muted)]">{item.approvalStatus}</div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void decideItem(item.type, item.id, true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">اعتماد</button>
                  <button type="button" onClick={() => void decideItem(item.type, item.id, false)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white">رفض</button>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </AppShell>
  );
}
