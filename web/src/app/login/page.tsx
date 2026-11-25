'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { AuthSplitLayout } from '@/components/AuthSplitLayout';

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
  const [showPass, setShowPass] = useState(false);
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
    <AuthSplitLayout mode="login">
      <div className="w-full max-w-[440px] mx-auto space-y-5">
        <div className="text-center space-y-1">
          <h1 className="text-2xl sm:text-3xl font-extrabold">
            {challengeToken ? 'المصادقة الثنائية (2FA)' : 'تسجيل الدخول'}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--muted)]">
            {challengeToken
              ? 'أدخل الرمز المكون من ٦ أرقام من تطبيق المصادقة أو كود استرداد'
              : 'أدخل بياناتك للوصول إلى لوحة تحكم متاجرك'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!challengeToken ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="login-id" className="text-xs font-bold block text-[var(--ink)]">
                  البريد الإلكتروني أو رقم الموبايل
                </label>
                <div className="relative">
                  <input
                    id="login-id"
                    className="of-input pr-10 pl-3.5 text-right font-mono-num text-sm"
                    dir="ltr"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder="merchant@store.eg  /  010xxxxxxxx"
                    required
                  />
                  <span className="pointer-events-none absolute top-1/2 -translate-y-1/2 right-3.5 text-[var(--muted)]" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="20" height="16" x="2" y="4" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="login-pass" className="text-xs font-bold block text-[var(--ink)]">
                    كلمة المرور
                  </label>
                  <Link href="/forgot-password" className="text-xs font-bold text-[var(--primary)] hover:underline">
                    نسيت كلمة المرور؟
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="login-pass"
                    type={showPass ? 'text' : 'password'}
                    className="of-input pl-11 pr-10 text-right font-mono-num text-sm"
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                  />
                  <span className="pointer-events-none absolute top-1/2 -translate-y-1/2 right-3.5 text-[var(--muted)]" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    aria-label={showPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                    className="absolute top-1/2 -translate-y-1/2 left-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-[var(--muted)] hover:text-[var(--primary)] cursor-pointer"
                  >
                    {showPass ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" x2="22" y1="2" y2="22" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {requiresCaptcha && turnstileSiteKey && (
                <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
              )}
            </>
          ) : (
            <div className="space-y-2">
              <label htmlFor="login-2fa" className="text-xs font-bold block">
                رمز التحقق (6 أرقام أو كود استرداد)
              </label>
              <input
                id="login-2fa"
                className="of-input text-center tracking-widest font-mono-num text-lg"
                dir="ltr"
                maxLength={12}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456  /  XXXX-XXXX"
                required
              />
              <button
                type="button"
                onClick={() => { setChallengeToken(''); setTotpCode(''); setError(''); }}
                className="text-xs font-bold text-[var(--muted)] hover:text-[var(--primary)] cursor-pointer"
              >
                العودة لتغيير الحساب
              </button>
            </div>
          )}

          {error && <p className="text-xs font-bold text-[var(--danger)]" role="alert">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[48px] rounded-xl bg-gradient-to-r from-[#0B57A4] via-[#0D7BB8] to-[#0EA5C6] py-3 text-sm font-bold text-white shadow-[0_10px_24px_-8px_rgba(11,87,164,0.48)] hover:brightness-105 transition-all disabled:opacity-60 cursor-pointer"
          >
            {loading ? 'جارٍ التحقق...' : challengeToken ? 'تأكيد رمز 2FA والدخول' : 'تسجيل الدخول'}
          </button>
        </form>

        {!challengeToken && (
          <>
            <div className="flex items-center gap-3 text-xs text-[var(--muted)]" aria-hidden="true">
              <span className="h-px flex-1 bg-[var(--border)]" />
              <span>أو</span>
              <span className="h-px flex-1 bg-[var(--border)]" />
            </div>

            <button
              type="button"
              onClick={() => void handleDemo()}
              disabled={demoLoading}
              className="w-full min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--primary)] hover:text-[var(--primary)] py-2.5 text-xs font-bold transition-colors disabled:opacity-60 cursor-pointer"
            >
              {demoLoading ? 'جارٍ تجهيز المتجر التجريبي...' : 'جرّب لوحة تحكم تجريبية بدون تسجيل'}
            </button>
          </>
        )}

        <p className="lg:hidden text-center text-xs text-[var(--muted)]">
          ليس لديك حساب؟{' '}
          <Link href="/register" className="font-bold text-[var(--primary)] hover:underline">
            أنشئ حسابًا جديدًا
          </Link>
        </p>
      </div>
    </AuthSplitLayout>
  );
}
