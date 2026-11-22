'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP, fmtNum } from '@/lib/format';
import type { ServiceRequest, SupportTicket } from '@/lib/types';

type OwnerTab = 'overview' | 'clients' | 'tickets' | 'services' | 'audit';

interface ClientRow {
  id: number;
  storeName: string;
  fullName?: string;
  email?: string;
  phone: string;
  planName: string;
  status: string;
  createdAt: string;
}

interface AuditRow {
  id: number;
  actorName: string;
  actorRole: string;
  action: string;
  createdAt: string;
}

export default function OwnerPanelPage() {
  const { data: boot } = useBootstrap('owner');
  const [tab, setTab] = useState<OwnerTab>('overview');
  const [kpis, setKpis] = useState<Record<string, number>>({});
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientQuery, setClientQuery] = useState('');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [services, setServices] = useState<ServiceRequest[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [replyText, setReplyText] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadTab(activeTab: OwnerTab, q = clientQuery) {
    setError('');
    try {
      if (activeTab === 'overview') {
        const res = await api.get<{ kpis?: Record<string, number> }>('/api/owner/dashboard');
        setKpis(res.kpis || {});
      } else if (activeTab === 'clients') {
        const res = await api.get<{ clients?: ClientRow[] }>(`/api/owner/clients?q=${encodeURIComponent(q)}`);
        setClients(res.clients || []);
      } else if (activeTab === 'tickets') {
        const res = await api.get<{ tickets?: SupportTicket[] }>('/api/owner/tickets');
        setTickets(res.tickets || []);
      } else if (activeTab === 'services') {
        const res = await api.get<{ requests?: ServiceRequest[] }>('/api/owner/services');
        setServices(res.requests || []);
      } else if (activeTab === 'audit') {
        const res = await api.get<{ logs?: AuditRow[] }>('/api/owner/audit');
        setAudit(res.logs || []);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل البيانات');
    }
  }

  useEffect(() => {
    if (boot?.me?.role === 'owner') void loadTab(tab);
  }, [boot?.me?.role, tab]);

  async function approveClient(id: number) {
    await api.post(`/api/owner/clients/${id}/approve`, {});
    setNotice('تم تفعيل حساب العميل بنجاح');
    await loadTab('clients');
  }

  async function sendTicketReply(id: number) {
    const reply = (replyText[id] || '').trim();
    if (!reply) return;
    await api.post(`/api/owner/tickets/${id}/reply`, { reply, status: 'resolved' });
    setNotice('تم إرسال الرد وإشعار التاجر');
    await loadTab('tickets');
  }

  async function updateServiceStatus(id: number, status: string) {
    await api.post(`/api/owner/services/${id}/status`, { status, adminNotes: 'تم التحديث من لوحة المالك' });
    setNotice('تم تحديث حالة طلب الخدمة وإشعار التاجر');
    await loadTab('services');
  }

  return (
    <AppShell
      title="لوحة تحكم المالك"
      subtitle="إدارة العملاء بالبحث الضريبي، تذاكر الدعم، خدمات الخبراء، وسجل المراقبة"
      user={boot?.me}
      nav={[
        { href: '/owner', label: 'لوحة المالك', icon: '🛡️' },
        { href: '/dashboard', label: 'معاينة التاجر', icon: '📊' }
      ]}
    >
      <div className="flex flex-wrap gap-2 mb-6">
        {[
          ['overview', '📊 النظرة العامة'],
          ['clients', '🏪 العملاء والرقم الضريبي'],
          ['tickets', '💬 تذاكر الدعم'],
          ['services', '💼 طلبات الخبراء'],
          ['audit', '📜 سجل المراقبة']
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k as OwnerTab)}
            className={`rounded-xl px-4 py-2 text-xs font-bold ${
              tab === k ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      {tab === 'overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">إجمالي العملاء</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1">{fmtNum(kpis.totalClients)}</div>
          </div>
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">تذاكر دعم مفتوحة</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1 text-amber-600">{fmtNum(kpis.openTickets)}</div>
          </div>
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">طلبات خبراء معلّقة</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1">{fmtNum(kpis.pendingServices)}</div>
          </div>
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">إيرادات الاشتراكات</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1 text-emerald-600">{fmtEGP(kpis.totalRevenue)}</div>
          </div>
        </div>
      )}

      {tab === 'clients' && (
        <div className="space-y-4">
          <form
            onSubmit={(e) => { e.preventDefault(); void loadTab('clients', clientQuery); }}
            className="flex gap-2 max-w-lg"
          >
            <input
              className="of-input"
              placeholder="ابحث بالاسم أو المتجر أو البريد أو الهاتف أو الرقم الضريبي..."
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
            />
            <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 text-xs font-bold text-white shrink-0">بحث</button>
          </form>
          <div className="of-card overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-[var(--surface-alt)] text-xs">
                <tr>
                  <th className="p-3">المتجر</th>
                  <th className="p-3">التواصل</th>
                  <th className="p-3">الباقة</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 font-bold">{c.storeName}</td>
                    <td className="p-3 text-xs" dir="ltr">{c.email || c.phone}</td>
                    <td className="p-3">{c.planName}</td>
                    <td className="p-3">{c.status}</td>
                    <td className="p-3">
                      {c.status !== 'active' && (
                        <button type="button" onClick={() => void approveClient(c.id)} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
                          تفعيل
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'tickets' && (
        <div className="space-y-3">
          {tickets.map((t) => (
            <div key={t.id} className="of-card p-5 space-y-3">
              <div className="flex justify-between gap-2">
                <div>
                  <div className="font-extrabold">#{t.id} — {t.subject}</div>
                  <div className="text-xs text-[var(--muted)]">{t.storeName} · {fmtDate(t.createdAt)}</div>
                </div>
                <span className="text-xs font-bold">{t.status}</span>
              </div>
              <p className="text-sm">{t.message}</p>
              {t.reply && <p className="text-xs text-emerald-700 font-bold">الرد السابق: {t.reply}</p>}
              <div className="flex gap-2">
                <input
                  className="of-input"
                  placeholder="اكتب ردك للتاجر..."
                  value={replyText[t.id] || ''}
                  onChange={(e) => setReplyText((prev) => ({ ...prev, [t.id]: e.target.value }))}
                />
                <button type="button" onClick={() => void sendTicketReply(t.id)} className="rounded-xl bg-[#0C5CA4] px-4 text-xs font-bold text-white shrink-0">
                  إرسال الرد
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'services' && (
        <div className="space-y-3">
          {services.map((s) => (
            <div key={s.id} className="of-card p-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="font-extrabold">#{s.id} — {s.serviceTitle}</div>
                <div className="text-xs text-[var(--muted)]">{s.storeName} · {fmtEGP(s.price)} · الحالة: {s.status}</div>
                {s.notes && <p className="text-xs mt-1">{s.notes}</p>}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void updateServiceStatus(s.id, 'in_progress')} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                  بدء التنفيذ
                </button>
                <button type="button" onClick={() => void updateServiceStatus(s.id, 'completed')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
                  مكتمل
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'audit' && (
        <div className="of-card overflow-x-auto">
          <table className="w-full text-sm text-right">
            <thead className="bg-[var(--surface-alt)] text-xs">
              <tr>
                <th className="p-3">المنفّذ</th>
                <th className="p-3">الدور</th>
                <th className="p-3">الإجراء</th>
                <th className="p-3">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="p-3 font-bold">{a.actorName}</td>
                  <td className="p-3 text-xs">{a.actorRole}</td>
                  <td className="p-3 font-mono-num text-xs" dir="ltr">{a.action}</td>
                  <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
