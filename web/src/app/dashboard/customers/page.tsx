'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum } from '@/lib/format';
import type { CustomerItem } from '@/lib/types';

interface CustomersResponse {
  customers?: CustomerItem[];
  total?: number;
  summary?: {
    totalCustomers?: number;
    repeatCustomers?: number;
    vipCustomers?: number;
    avgLtv?: number;
  };
}

const SEGMENTS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'كل العملاء' },
  { key: 'vip', label: 'VIP' },
  { key: 'repeat', label: 'متكررو الشراء' },
  { key: 'rto', label: 'مرتجعات RTO' }
];

export default function CustomersPage() {
  const { data: boot } = useBootstrap();
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [summary, setSummary] = useState<CustomersResponse['summary']>({});
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [segment, setSegment] = useState('all');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', gov: 'القاهرة', address: '', tags: '', notes: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  const loadCustomers = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (debouncedQ.trim()) qs.set('q', debouncedQ.trim());
      if (segment !== 'all') qs.set('segment', segment);
      const res = await api.get<CustomersResponse>(`/api/customers?${qs.toString()}`);
      setCustomers(res.customers || []);
      setSummary(res.summary || {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل العملاء');
    }
  }, [debouncedQ, segment]);

  useEffect(() => {
    if (boot?.me) void loadCustomers();
  }, [boot?.me, loadCustomers]);

  function openNew() {
    setEditingId(null);
    setForm({ name: '', phone: '', email: '', gov: 'القاهرة', address: '', tags: '', notes: '' });
    setShowForm(true);
    setError('');
    setNotice('');
  }

  function openEdit(c: CustomerItem) {
    setEditingId(c.id);
    setForm({
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      gov: c.gov || 'القاهرة',
      address: c.address || '',
      tags: c.tags || '',
      notes: c.notes || ''
    });
    setShowForm(true);
    setError('');
    setNotice('');
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      if (editingId) {
        await api.put(`/api/customers/${editingId}`, form);
        setNotice('تم تحديث بيانات العميل بنجاح ✓');
      } else {
        await api.post('/api/customers', form);
        setNotice('تمت إضافة العميل بنجاح ✓');
      }
      setShowForm(false);
      setEditingId(null);
      await loadCustomers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ بيانات العميل');
    }
  }

  async function deleteCustomer(id: number) {
    setError('');
    setNotice('');
    try {
      await api.del(`/api/customers/${id}`);
      setNotice('تم حذف العميل من دليل العملاء');
      await loadCustomers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حذف العميل');
    }
  }

  return (
    <AppShell title="إدارة العملاء (CRM)" subtitle="قاعدة بيانات العملاء، الشرائح، ومؤشر مرتجعات الدفع عند الاستلام" user={boot?.me}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="of-card p-4">
          <div className="text-xs text-[var(--muted)]">إجمالي العملاء</div>
          <div className="text-xl font-extrabold font-mono-num mt-1">{fmtNum(summary?.totalCustomers)}</div>
        </div>
        <div className="of-card p-4">
          <div className="text-xs text-[var(--muted)]">عملاء VIP</div>
          <div className="text-xl font-extrabold font-mono-num mt-1 text-emerald-600">{fmtNum(summary?.vipCustomers)}</div>
        </div>
        <div className="of-card p-4">
          <div className="text-xs text-[var(--muted)]">عملاء متكررون</div>
          <div className="text-xl font-extrabold font-mono-num mt-1 text-[var(--primary)]">{fmtNum(summary?.repeatCustomers)}</div>
        </div>
        <div className="of-card p-4">
          <div className="text-xs text-[var(--muted)]">متوسط إنفاق العميل (LTV)</div>
          <div className="text-xl font-extrabold font-mono-num mt-1">{fmtEGP(summary?.avgLtv)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <input
          className="of-input max-w-sm"
          placeholder="ابحث باسم العميل أو الموبايل أو المحافظة أو الوسوم..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={openNew} className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs font-bold text-white">
            + إضافة عميل
          </button>
          <a
            href="/api/customers/export.csv"
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-bold hover:bg-[var(--surface-alt)]"
          >
            📥 تصدير CSV
          </a>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-5">
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSegment(s.key)}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
              segment === s.key ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      {showForm && (
        <form onSubmit={submitForm} className="of-card p-5 mb-5 space-y-3 border-[#0C5CA4]/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">{editingId ? 'تعديل بيانات العميل' : 'إضافة عميل جديد'}</strong>
            <button type="button" onClick={() => setShowForm(false)} className="text-xs font-bold">إغلاق ✕</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-bold block mb-1">اسم العميل</label>
              <input className="of-input" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} required />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الموبايل</label>
              <input className="of-input" dir="ltr" placeholder="010xxxxxxxx" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">البريد الإلكتروني</label>
              <input type="email" className="of-input" dir="ltr" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">المحافظة</label>
              <input className="of-input" value={form.gov} onChange={(e) => setForm((p) => ({ ...p, gov: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">العنوان</label>
              <input className="of-input" value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الوسوم (Tags)</label>
              <input className="of-input" placeholder="VIP, جملة" value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">ملاحظات</label>
            <input className="of-input" value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} />
          </div>
          <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2 text-xs font-bold text-white">
            {editingId ? 'حفظ التعديلات' : 'إضافة العميل'}
          </button>
        </form>
      )}

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">العميل</th>
              <th className="p-3">الموبايل</th>
              <th className="p-3">المحافظة</th>
              <th className="p-3">الطلبات</th>
              <th className="p-3">إجمالي الشراء</th>
              <th className="p-3">مرتجعات / ملغي</th>
              <th className="p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {customers.map((c) => {
              const returned = c.returnedCount ?? c.rtoCount ?? 0;
              const cancelled = c.cancelledCount ?? 0;
              return (
                <tr key={c.id}>
                  <td className="p-3">
                    <div className="font-bold">{c.name}</div>
                    {c.tags && <div className="text-[11px] text-[var(--primary)]">{c.tags}</div>}
                  </td>
                  <td className="p-3 font-mono-num text-xs" dir="ltr">{c.phone || '—'}</td>
                  <td className="p-3">{c.gov || '—'}</td>
                  <td className="p-3 font-mono-num">{fmtNum(c.ordersCount)}</td>
                  <td className="p-3 font-mono-num font-bold">{fmtEGP(c.totalSpent)}</td>
                  <td className="p-3 font-mono-num text-xs">
                    <span className="text-rose-600 font-bold">{fmtNum(returned)} مرتجع</span>
                    {cancelled > 0 ? <span className="text-[var(--muted)]"> · {fmtNum(cancelled)} ملغي</span> : null}
                  </td>
                  <td className="p-3 flex gap-1.5">
                    <button type="button" onClick={() => openEdit(c)} className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold">
                      تعديل
                    </button>
                    <button type="button" onClick={() => void deleteCustomer(c.id)} className="rounded-lg border border-rose-500/40 px-2.5 py-1 text-xs font-bold text-rose-600">
                      حذف
                    </button>
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
