'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const res = await api.post<{ message?: string }>('/api/auth/forgot-password', {
        identifier: identifier.trim()
      });
      setMessage(res.message || 'إذا كان الحساب مسجلًا لدينا فقد أرسلنا رابط إعادة التعيين إلى بريدك الإلكتروني.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إرسال الطلب');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <div className="of-card w-full max-w-md p-8 space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-extrabold">استعادة كلمة المرور</h1>
          <p className="text-xs text-[var(--muted)]">أدخل بريدك الإلكتروني أو رقم موبايلك لإرسال رابط إعادة التعيين</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            className="of-input"
            dir="ltr"
            placeholder="merchant@store.eg"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
          {message && <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">{message}</p>}
          {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}
          <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60">
            {loading ? 'جارٍ الإرسال...' : 'إرسال رابط الاستعادة'}
          </button>
        </form>

        <div className="text-center text-xs">
          <Link href="/login" className="font-bold text-[var(--primary)]">العودة لتسجيل الدخول</Link>
        </div>
      </div>
    </div>
  );
}
