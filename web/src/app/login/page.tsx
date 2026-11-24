'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TurnstileWidget } from '@/components/TurnstileWidget';

interface LoginResponse {
  ok?: boolean;
  requires2fa?: boolean;
  challengeToken?: string;
  setup2faRequired?: boolean;
  me?: { role?: string; setup2faRequired?: boolean };
}

interface AuthConfig {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [requiresCaptcha, setRequiresCaptcha] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
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

  function routeAfterAuth(res: LoginResponse) {
    if (res.setup2faRequired || res.me?.setup2faRequired) {
      router.push('/setup-2fa');
      return;
    }
    const role = res.me?.role;
    router.push(role === 'owner' ? '/owner' : role === 'moderator' ? '/moderator' : '/dashboard');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (requiresCaptcha && turnstileSiteKey && !turnstileToken) {
      setError('يرجى إكمال التحقق الأمني للمتابعة');
      return;
    }
    setLoading(true);
    setError('');
    try {
      if (challengeToken) {
        const res = await api.post<LoginResponse>('/api/auth/login/2fa', {
          challengeToken,
          code: totpCode.trim()
        });
        routeAfterAuth(res);
        return;
      }

      const res = await api.post<LoginResponse>('/api/auth/login', {
        id: id.trim(),
        password,
        ...(turnstileToken ? { turnstileToken } : {})
      });

      if (res.requires2fa && res.challengeToken) {
        setChallengeToken(res.challengeToken);
        return;
      }
      routeAfterAuth(res);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.data?.requiresCaptcha) {
          setRequiresCaptcha(true);
          setTurnstileToken('');
        }
        setError(err.message);
      } else {
        setError('تعذر تسجيل الدخول');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleDemo() {
    if (turnstileSiteKey && !turnstileToken) {
      setRequiresCaptcha(true);
      setError('يرجى إكمال التحقق الأمني قبل تشغيل الحساب التجريبي');
      return;
    }
    setDemoLoading(true);
    setError('');
    try {
      const res = await api.post<LoginResponse>('/api/auth/demo', {
        ...(turnstileToken ? { turnstileToken } : {})
      });
      routeAfterAuth(res);
    } catch (err) {
      if (err instanceof ApiError && err.data?.requiresCaptcha) {
        setRequiresCaptcha(true);
      }
      setError(err instanceof ApiError ? err.message : 'تعذر تشغيل الحساب التجريبي');
    } finally {
      setDemoLoading(false);
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
                  value={id}
                  onChange={(e) => setId(e.target.value)}
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
              {requiresCaptcha && turnstileSiteKey && (
                <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
              )}
            </>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-bold block">رمز المصادقة الثنائية (6 أرقام أو كود استرداد)</label>
              <input
                className="of-input text-center tracking-widest font-mono-num"
                dir="ltr"
                maxLength={12}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456 أو XXXX-XXXX"
                required
              />
              <button
                type="button"
                onClick={() => { setChallengeToken(''); setTotpCode(''); setError(''); }}
                className="text-xs text-[var(--muted)] hover:text-[var(--primary)]"
              >
                العودة لتغيير الحساب
              </button>
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

        {!challengeToken && (
          <button
            type="button"
            onClick={() => void handleDemo()}
            disabled={demoLoading}
            className="w-full rounded-xl border border-[var(--border)] py-2.5 text-xs font-bold hover:bg-[var(--surface-alt)] disabled:opacity-60"
          >
            {demoLoading ? 'جارٍ تجهيز المتجر التجريبي...' : 'تجربة المنصة فورًا بحساب تجريبي'}
          </button>
        )}

        <div className="flex items-center justify-between text-xs text-[var(--muted)] pt-2 border-t border-[var(--border)]">
          <Link href="/forgot-password" className="hover:text-[var(--primary)] font-semibold">نسيت كلمة المرور؟</Link>
          <Link href="/register" className="hover:text-[var(--primary)] font-semibold">إنشاء حساب جديد</Link>
        </div>
      </div>
    </div>
  );
}
