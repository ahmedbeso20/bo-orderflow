'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP } from '@/lib/format';
import type { ServiceRequest, SupportTicket } from '@/lib/types';

export default function ServicesAndSupportPage() {
  const { data: boot } = useBootstrap();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [serviceKey, setServiceKey] = useState('account_setup');
  const [serviceNotes, setServiceNotes] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadAll() {
    const [tRes, sRes] = await Promise.all([
      api.get<{ tickets?: SupportTicket[] }>('/api/support/tickets'),
      api.get<{ requests?: ServiceRequest[] }>('/api/services/requests')
    ]);
    setTickets(tRes.tickets || []);
    setRequests(sRes.requests || []);
  }

  useEffect(() => {
    if (boot?.me) void loadAll();
  }, [boot?.me]);

  async function submitTicket(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.post('/api/support/tickets', { subject: subject.trim(), message: message.trim() });
      setSubject('');
      setMessage('');
      setNotice('تم فتح تذكرة الدعم بنجاح');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر فتح التذكرة');
    }
  }

  async function submitService(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.post('/api/services/requests', {
        serviceKey,
        notes: serviceNotes.trim()
      });
      setServiceNotes('');
      setNotice('تم إرسال طلب خدمة الخبراء بنجاح');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إرسال الطلب');
    }
  }

  return (
    <AppShell title="خدمات الخبراء والدعم الفني" subtitle="افتح تذكرة دعم أو اطلب خدمة خبراء وتابع الردود" user={boot?.me}>
      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">تذاكر الدعم الفني</h2>
          <form onSubmit={submitTicket} className="space-y-3">
            <input className="of-input" placeholder="موضوع التذكرة" value={subject} onChange={(e) => setSubject(e.target.value)} required />
            <textarea rows={3} className="of-input" placeholder="اشرح المشكلة بالتفصيل..." value={message} onChange={(e) => setMessage(e.target.value)} required />
            <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">إرسال التذكرة</button>
          </form>
          <div className="space-y-2 pt-2">
            {tickets.map((t) => (
              <div key={t.id} className="rounded-xl border border-[var(--border)] p-3 space-y-1 text-sm">
                <div className="flex justify-between font-bold">
                  <span>{t.subject}</span>
                  <span className="text-xs text-[var(--muted)]">{t.status} · {fmtDate(t.createdAt)}</span>
                </div>
                <p className="text-xs text-[var(--muted)]">{t.message}</p>
                {t.reply && (
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 p-2 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                    رد الإدارة: {t.reply}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">طلبات خدمات الخبراء</h2>
          <form onSubmit={submitService} className="space-y-3">
            <select className="of-input" value={serviceKey} onChange={(e) => setServiceKey(e.target.value)}>
              <option value="account_setup">فتح وتوثيق حسابات البائعين (أمازون · نون · جوميا · ترينديول)</option>
              <option value="ppc_ads">إدارة وتحسين الحملات الإعلانية الممولة (PPC)</option>
              <option value="aplus_content">تصميم صفحات المنتجات ومحتوى A+ وصور الاستوديو</option>
              <option value="full_management">الإدارة التشغيلية الكاملة لحسابات المتجر</option>
              <option value="team_training">تدريب واعتماد فريق المتجر</option>
            </select>
            <textarea rows={3} className="of-input" placeholder="ملاحظات إضافية لفريق الخبراء..." value={serviceNotes} onChange={(e) => setServiceNotes(e.target.value)} />
            <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">طلب الخدمة</button>
          </form>
          <div className="space-y-2 pt-2">
            {requests.map((r) => (
              <div key={r.id} className="rounded-xl border border-[var(--border)] p-3 text-sm space-y-1">
                <div className="flex justify-between font-bold">
                  <span>{r.serviceTitle}</span>
                  <span className="text-xs font-mono-num">{fmtEGP(r.price)}</span>
                </div>
                <div className="text-xs text-[var(--muted)]">الحالة: {r.status}</div>
                {r.adminNotes && <div className="text-xs text-emerald-700 dark:text-emerald-300">ملاحظة الإدارة: {r.adminNotes}</div>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
