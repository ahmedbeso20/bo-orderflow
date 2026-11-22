'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [token, setToken] = useState(params.get('token') || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/api/auth/reset-password', { token: token.trim(), password });
      setDone(true);
      setTimeout(() => router.push('/login'), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الرابط غير صالح أو منتهي الصلاحية');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="of-card w-full max-w-md p-8 space-y-6">
      <h1 className="text-xl font-extrabold text-center">تعيين كلمة مرور جديدة</h1>
      {done ? (
        <p className="text-sm font-bold text-emerald-700 text-center">تم تحديث كلمة المرور بنجاح — جارٍ تحويلك لتسجيل الدخول...</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-bold block">رمز الاستعادة (Token)</label>
            <input className="of-input" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold block">كلمة المرور الجديدة</label>
            <input type="password" dir="ltr" className="of-input" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}
          <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60">
            {loading ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور'}
          </button>
        </form>
      )}
      <div className="text-center text-xs">
        <Link href="/login" className="font-bold text-[var(--primary)]">تسجيل الدخول</Link>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <Suspense fallback={<div className="of-card p-8 text-sm">جارٍ التحميل...</div>}>
        <ResetPasswordForm />
      </Suspense>
    </div>
  );
}
