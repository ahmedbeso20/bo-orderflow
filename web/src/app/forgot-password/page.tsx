'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TurnstileWidget } from '@/components/TurnstileWidget';

interface AuthConfig {
  smsEnabled?: boolean;
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
}

export default function ForgotPasswordPage() {
  const [id, setId] = useState('');
  const [viaSms, setViaSms] = useState(false);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config')
      .then((cfg) => {
        setSmsEnabled(Boolean(cfg.smsEnabled));
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
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const res = await api.post<{ message?: string; channel?: string }>('/api/auth/forgot-password', {
        id: id.trim(),
        viaSms,
        ...(turnstileToken ? { turnstileToken } : {})
      });
      setMessage(
        res.message ||
          (viaSms
            ? 'إذا كان رقم الموبايل مسجلًا لدينا فقد أرسلنا رمز تحقق SMS من 6 أرقام.'
            : 'إذا كان الحساب مسجلًا لدينا فقد أرسلنا رابط إعادة التعيين إلى بريدك الإلكتروني.')
      );
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
          <Link href="/" className="inline-block font-extrabold text-2xl text-[var(--primary)]">OrderFlow</Link>
          <h1 className="text-xl font-extrabold">استعادة كلمة المرور</h1>
          <p className="text-xs text-[var(--muted)]">
            {viaSms ? 'أدخل رقم موبايلك لاستلام رمز OTP في رسالة SMS' : 'أدخل بريدك الإلكتروني أو رقم موبايلك لإرسال رابط الاستعادة'}
          </p>
        </div>

        {smsEnabled && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setViaSms(false)}
              className={`rounded-xl py-2 text-xs font-bold ${!viaSms ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)]'}`}
            >
              عبر البريد الإلكتروني
            </button>
            <button
              type="button"
              onClick={() => setViaSms(true)}
              className={`rounded-xl py-2 text-xs font-bold ${viaSms ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)]'}`}
            >
              عبر رسالة SMS OTP
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            className="of-input"
            dir="ltr"
            placeholder={viaSms ? '010xxxxxxxx' : 'merchant@store.eg أو 010xxxxxxxx'}
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
          />

          <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} />

          {message && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs font-bold text-emerald-700 dark:text-emerald-300 space-y-2">
              <p>{message}</p>
              {viaSms && (
                <Link
                  href={`/reset-password?mode=otp&phone=${encodeURIComponent(id.trim())}`}
                  className="inline-block underline"
                >
                  إدخال رمز SMS OTP وتعيين كلمة المرور الجديدة ◂
                </Link>
              )}
            </div>
          )}
          {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}

          <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60">
            {loading ? 'جارٍ الإرسال...' : viaSms ? 'إرسال رمز SMS OTP' : 'إرسال رابط الاستعادة'}
          </button>
        </form>

        <div className="flex items-center justify-between text-xs">
          <Link href="/reset-password" className="font-semibold text-[var(--muted)] hover:text-[var(--primary)]">لدي رمز استعادة بالفعل</Link>
          <Link href="/login" className="font-bold text-[var(--primary)]">العودة لتسجيل الدخول</Link>
        </div>
      </div>
    </div>
  );
}
