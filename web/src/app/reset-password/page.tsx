'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

interface ResetResponse {
  ok?: boolean;
  requires2fa?: boolean;
  challengeToken?: string;
  message?: string;
  me?: { role?: string };
}

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const initialMode = params.get('mode') === 'otp' ? 'otp' : 'token';
  const [mode, setMode] = useState<'token' | 'otp'>(initialMode);
  const [token, setToken] = useState(params.get('token') || '');
  const [phoneNum, setPhoneNum] = useState(params.get('phone') || '');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (challengeToken) {
        const res = await api.post<{ me?: { role?: string } }>('/api/auth/login/2fa', {
          challengeToken,
          code: totpCode.trim()
        });
        const role = res.me?.role;
        router.push(role === 'owner' ? '/owner' : role === 'moderator' ? '/moderator' : '/dashboard');
        return;
      }

      const res =
        mode === 'otp'
          ? await api.post<ResetResponse>('/api/auth/reset-password/otp', {
              phone: phoneNum.trim(),
              code: otp.trim(),
              password
            })
          : await api.post<ResetResponse>('/api/auth/reset-password', {
              token: token.trim(),
              password
            });

      if (res.requires2fa) {
        if (res.challengeToken) {
          setChallengeToken(res.challengeToken);
          setDoneMsg(res.message || 'تم تحديث كلمة المرور بنجاح. أكمل الدخول بإدخال رمز المصادقة الثنائية.');
        } else {
          setDoneMsg(res.message || 'تم تحديث كلمة المرور بنجاح. سجّل الدخول الآن مع رمز المصادقة الثنائية.');
          setTimeout(() => router.push('/login'), 1800);
        }
        return;
      }

      setDoneMsg('تم تحديث كلمة المرور بنجاح — جارٍ تحويلك...');
      setTimeout(() => {
        const role = res.me?.role;
        router.push(role === 'owner' ? '/owner' : role === 'moderator' ? '/moderator' : '/dashboard');
      }, 1200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الرمز غير صالح أو منتهي الصلاحية');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="of-card w-full max-w-md p-8 space-y-6">
      <div className="text-center space-y-1">
        <Link href="/" className="inline-block font-extrabold text-2xl text-[var(--primary)]">OrderFlow</Link>
        <h1 className="text-xl font-extrabold">تعيين كلمة مرور جديدة</h1>
      </div>

      {!challengeToken && (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => { setMode('token'); setError(''); }}
            className={`rounded-xl py-2 text-xs font-bold ${mode === 'token' ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)]'}`}
          >
            رابط البريد (Token)
          </button>
          <button
            type="button"
            onClick={() => { setMode('otp'); setError(''); }}
            className={`rounded-xl py-2 text-xs font-bold ${mode === 'otp' ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)]'}`}
          >
            رسالة SMS (OTP)
          </button>
        </div>
      )}

      {doneMsg && !challengeToken ? (
        <p className="text-sm font-bold text-emerald-700 dark:text-emerald-300 text-center">{doneMsg}</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {challengeToken ? (
            <div className="space-y-3">
              <p className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs font-bold text-emerald-800 dark:text-emerald-200">
                {doneMsg}
              </p>
              <div className="space-y-1">
                <label className="text-xs font-bold block">رمز المصادقة الثنائية (6 أرقام أو كود استرداد)</label>
                <input
                  className="of-input text-center tracking-widest font-mono-num"
                  dir="ltr"
                  maxLength={12}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="123456"
                  required
                />
              </div>
            </div>
          ) : mode === 'token' ? (
            <>
              <div className="space-y-1">
                <label className="text-xs font-bold block">رمز الاستعادة (Token)</label>
                <input className="of-input" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold block">كلمة المرور الجديدة</label>
                <input type="password" dir="ltr" className="of-input" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-bold block">رقم الموبايل</label>
                <input className="of-input" dir="ltr" placeholder="010xxxxxxxx" value={phoneNum} onChange={(e) => setPhoneNum(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold block">رمز SMS OTP (6 أرقام)</label>
                <input className="of-input text-center font-mono-num tracking-widest" dir="ltr" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold block">كلمة المرور الجديدة</label>
                <input type="password" dir="ltr" className="of-input" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            </>
          )}

          {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}
          <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60">
            {loading ? 'جارٍ الحفظ...' : challengeToken ? 'تأكيد رمز 2FA والدخول' : 'حفظ كلمة المرور'}
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
