'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function VerifyEmailContent() {
  const params = useSearchParams();
  const initialToken = params.get('token') || '';
  const [token, setToken] = useState(initialToken);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>(initialToken ? 'loading' : 'idle');
  const [message, setMessage] = useState('');

  async function verify(tok: string) {
    if (!tok.trim()) return;
    setStatus('loading');
    setMessage('');
    try {
      await api.post('/api/auth/verify-email', { token: tok.trim() });
      setStatus('ok');
      setMessage('تم توثيق بريدك الإلكتروني بنجاح! يمكنك الآن استخدام كافة مزايا الحساب والدفع والربط.');
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof ApiError ? err.message : 'رمز التوثيق غير صالح أو منتهي الصلاحية');
    }
  }

  useEffect(() => {
    if (initialToken) {
      void verify(initialToken);
    }
  }, [initialToken]);

  return (
    <div className="of-card w-full max-w-md p-8 space-y-6 text-center">
      <Link href="/" className="inline-block font-extrabold text-2xl text-[var(--primary)]">OrderFlow</Link>
      <h1 className="text-xl font-extrabold">تأكيد البريد الإلكتروني</h1>

      {status === 'loading' && <p className="text-sm text-[var(--muted)]">جارٍ التحقق من رمز التوثيق...</p>}

      {status === 'ok' && (
        <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 p-4 text-sm font-bold text-emerald-800 dark:text-emerald-200 space-y-3">
          <p>{message}</p>
          <div className="flex justify-center gap-3">
            <Link href="/dashboard" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs font-bold text-white">لوحة التحكم</Link>
            <Link href="/login" className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold">تسجيل الدخول</Link>
          </div>
        </div>
      )}

      {(status === 'idle' || status === 'error') && (
        <form
          onSubmit={(e) => { e.preventDefault(); void verify(token); }}
          className="space-y-4 text-right"
        >
          <div className="space-y-1">
            <label className="text-xs font-bold block">رمز التوثيق من البريد الإلكتروني</label>
            <input className="of-input" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} required />
          </div>
          {status === 'error' && <p className="text-xs font-bold text-[var(--danger)]">{message}</p>}
          <button type="submit" className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white">
            تأكيد البريد الإلكتروني
          </button>
        </form>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <Suspense fallback={<div className="of-card p-8 text-sm">جارٍ التحميل...</div>}>
        <VerifyEmailContent />
      </Suspense>
    </div>
  );
}
