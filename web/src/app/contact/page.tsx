'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TurnstileWidget } from '@/components/TurnstileWidget';

interface AuthConfig {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
}

export default function ContactPage() {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [subject, setSubject] = useState('استفسار عن الباقات والربط');
  const [message, setMessage] = useState('');
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [ticketId, setTicketId] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config')
      .then((cfg) => {
        if (cfg.turnstileEnabled && cfg.turnstileSiteKey) {
          setTurnstileSiteKey(cfg.turnstileSiteKey);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !turnstileToken) {
      setError('يرجى إكمال التحقق الأمني أولًا');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await api.post<{ ok?: boolean; ticketId?: number }>('/api/contact', {
        name: name.trim(),
        contact: contact.trim(),
        subject: subject.trim(),
        message: message.trim(),
        ...(turnstileToken ? { turnstileToken } : {})
      });
      setTicketId(res.ticketId || 1);
      setName('');
      setContact('');
      setMessage('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إرسال الرسالة حاليًا');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="font-extrabold text-xl text-[var(--primary)]">OrderFlow</Link>
          <div className="flex items-center gap-3 text-sm font-bold">
            <Link href="/about" className="text-[var(--muted)] hover:text-[var(--ink)]">عن المنصة</Link>
            <Link href="/login" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs text-white">تسجيل الدخول</Link>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="of-card p-8 space-y-6">
          <div>
            <h1 className="text-2xl font-extrabold">تواصل مع فريق OrderFlow</h1>
            <p className="text-xs text-[var(--muted)] mt-1">أرسل استفسارك حول الربط مع المنصات أو الباقات أو الدعم الفني وسنرد عليك في أقرب وقت.</p>
          </div>

          {ticketId ? (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 p-5 space-y-2 text-emerald-800 dark:text-emerald-200">
              <div className="font-extrabold text-base">تم استلام رسالتك بنجاح ✓</div>
              <p className="text-sm">رقم التذكرة المرجعي: <strong className="font-mono-num">#{ticketId}</strong>. سيتواصل معك فريق الدعم قريبًا.</p>
              <button type="button" onClick={() => setTicketId(null)} className="rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-bold text-white">
                إرسال رسالة أخرى
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-bold block mb-1">الاسم الكامل</label>
                <input className="of-input" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <label className="text-xs font-bold block mb-1">البريد الإلكتروني أو رقم الموبايل</label>
                <input className="of-input" dir="ltr" placeholder="name@store.eg أو 010xxxxxxxx" value={contact} onChange={(e) => setContact(e.target.value)} required />
              </div>
              <div>
                <label className="text-xs font-bold block mb-1">الموضوع</label>
                <input className="of-input" value={subject} onChange={(e) => setSubject(e.target.value)} required />
              </div>
              <div>
                <label className="text-xs font-bold block mb-1">الرسالة</label>
                <textarea className="of-input min-h-[120px]" value={message} onChange={(e) => setMessage(e.target.value)} required />
              </div>

              <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} />

              {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}

              <button type="submit" disabled={submitting} className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60">
                {submitting ? 'جارٍ الإرسال...' : 'إرسال الرسالة'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
