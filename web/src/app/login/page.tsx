'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (challengeToken) {
        const res = await api.post<{ user?: { role?: string } }>('/api/auth/2fa/verify-login', {
          challengeToken,
          code: totpCode.trim()
        });
        const role = res.user?.role;
        router.push(role === 'owner' ? '/owner' : role === 'moderator' ? '/moderator' : '/dashboard');
        return;
      }

      const res = await api.post<{ requires2fa?: boolean; challengeToken?: string; user?: { role?: string } }>(
        '/api/auth/login',
        { identifier: identifier.trim(), password }
      );

      if (res.requires2fa && res.challengeToken) {
        setChallengeToken(res.challengeToken);
        return;
      }
      const role = res.user?.role;
      router.push(role === 'owner' ? '/owner' : role === 'moderator' ? '/moderator' : '/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل الدخول');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <div className="of-card w-full max-w-md p-8 space-y-6">
        <div className="space-y-1 text-center">
          <Link href="/" className="inline-block font-extrabold text-2xl text-[var(--primary)]">OrderFlow</Link>
          <h1 className="text-xl font-extrabold">تسجيل الدخول</h1>
          <p className="text-xs text-[var(--muted)]">جلسة محمية بكوكيز HttpOnly بدون حفظ رموز في المتصفح</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!challengeToken ? (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-bold block">البريد الإلكتروني أو رقم الموبايل</label>
                <input
                  className="of-input"
                  dir="ltr"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="merchant@store.eg أو 010xxxxxxxx"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold block">كلمة المرور</label>
                <input
                  type="password"
                  className="of-input"
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <label className="text-xs font-bold block">رمز المصادقة الثنائية (2FA — 6 أرقام)</label>
              <input
                className="of-input text-center tracking-widest font-mono-num"
                dir="ltr"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456"
                required
              />
            </div>
          )}

          {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-[#0C5CA4] hover:bg-[#094a85] py-3 text-sm font-bold text-white disabled:opacity-60"
          >
            {loading ? 'جارٍ التحقق...' : challengeToken ? 'تأكيد رمز 2FA والدخول' : 'دخول إلى لوحة التحكم'}
          </button>
        </form>

        <div className="flex items-center justify-between text-xs text-[var(--muted)] pt-2 border-t border-[var(--border)]">
          <Link href="/forgot-password" className="hover:text-[var(--primary)] font-semibold">نسيت كلمة المرور؟</Link>
          <Link href="/register" className="hover:text-[var(--primary)] font-semibold">إنشاء حساب جديد</Link>
        </div>
      </div>
    </div>
  );
}
