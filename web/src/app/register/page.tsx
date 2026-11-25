'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { AuthSplitLayout } from '@/components/AuthSplitLayout';

interface AuthConfig {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
}

function getPasswordStrength(pw: string) {
  if (!pw) return { score: 0, label: 'اختر كلمة مرور من ٨ أحرف بحروف وأرقام' };
  const hasLen = pw.length >= 8;
  const hasLetter = /[a-zA-Z\u0600-\u06FF]/.test(pw);
  const hasNum = /\d/.test(pw);
  const hasExtra = /[^a-zA-Z0-9\u0600-\u06FF\s]/.test(pw) || /[A-Z]/.test(pw);
  let score = 1;
  if (hasLen && (hasLetter || hasNum)) score = 2;
  if (hasLen && hasLetter && hasNum) score = 3;
  if (pw.length >= 10 && hasLetter && hasNum && hasExtra) score = 4;
  const labels = ['', 'ضعيفة', 'متوسطة', 'جيدة ✓', 'قوية جدًا ✓'];
  return { score, label: labels[score] };
}

export default function RegisterPage() {
  const router = useRouter();
  const [store, setStore] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingMsg, setPendingMsg] = useState('');

  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config')
      .then((cfg) => {
        if (cfg.turnstileEnabled && cfg.turnstileSiteKey) {
          setTurnstileSiteKey(cfg.turnstileSiteKey);
        }
      })
      .catch(() => {});
  }, []);

  const strength = getPasswordStrength(password);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!termsAccepted) {
      setError('يجب الموافقة على شروط الاستخدام وسياسة الخصوصية (قانون حماية البيانات 151/2020) للمتابعة');
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError('يرجى إكمال التحقق الأمني قبل إنشاء الحساب');
      return;
    }
    setLoading(true);
    setError('');
    setPendingMsg('');
    try {
      const res = await api.post<{ pending?: boolean; pendingApproval?: boolean; message?: string }>('/api/auth/register', {
        store: store.trim(),
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
        termsAccepted: true,
        ...(turnstileToken ? { turnstileToken } : {})
      });
      if (res.pending || res.pendingApproval) {
        setPendingMsg(res.message || 'تم استلام طلب تسجيل متجرك بنجاح وهو قيد المراجعة حاليًا.');
      } else {
        router.push('/dashboard');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إنشاء الحساب');
    } finally {
      setLoading(false);
    }
  }

  const barColor =
    strength.score <= 1 ? 'bg-rose-500' : strength.score === 2 ? 'bg-amber-500' : strength.score === 3 ? 'bg-[#0EA5C6]' : 'bg-emerald-600';

  return (
    <AuthSplitLayout mode="register">
      <div className="w-full max-w-[500px] mx-auto space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-2xl sm:text-3xl font-extrabold">إنشاء حساب تاجر</h1>
          <p className="text-xs sm:text-sm text-[var(--muted)]">
            أدخل بيانات متجرك للبدء مجانًا — بدون بطاقة بنكية
          </p>
        </div>

        {pendingMsg ? (
          <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-6 text-center space-y-3">
            <p className="font-extrabold text-base text-emerald-900 dark:text-emerald-200">{pendingMsg}</p>
            <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
              ستصلك رسالة تأكيد فور تفعيل حسابك من إدارة المنصة.
            </p>
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-xl bg-[#0B57A4] px-5 py-2.5 text-xs font-bold text-white"
            >
              العودة لتسجيل الدخول
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="reg-store" className="text-xs font-bold block">اسم المتجر</label>
                <input
                  id="reg-store"
                  className="of-input text-sm"
                  placeholder="مثال: متجر النور للإلكترونيات"
                  value={store}
                  onChange={(e) => setStore(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="reg-name" className="text-xs font-bold block">الاسم الكامل</label>
                <input
                  id="reg-name"
                  className="of-input text-sm"
                  placeholder="مثال: أحمد محمود"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="reg-email" className="text-xs font-bold block">البريد الإلكتروني</label>
                <input
                  id="reg-email"
                  type="email"
                  dir="ltr"
                  className="of-input text-right font-mono-num text-sm"
                  placeholder="owner@yourstore.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="reg-phone" className="text-xs font-bold block">رقم الموبايل (واتساب)</label>
                <input
                  id="reg-phone"
                  dir="ltr"
                  className="of-input text-right font-mono-num text-sm"
                  placeholder="010xxxxxxxx"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="reg-pass" className="text-xs font-bold block">كلمة المرور</label>
              <div className="relative">
                <input
                  id="reg-pass"
                  type={showPass ? 'text' : 'password'}
                  dir="ltr"
                  className="of-input pl-12 text-right font-mono-num text-sm"
                  placeholder="٨ أحرف على الأقل (حروف وأرقام)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                  className="absolute top-1/2 -translate-y-1/2 left-1.5 px-2 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-[var(--muted)] hover:text-[var(--primary)] cursor-pointer"
                >
                  {showPass ? 'إخفاء' : 'عرض'}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1.5 pt-0.5" aria-hidden="true">
                {[1, 2, 3, 4].map((step) => (
                  <span key={step} className={`h-1 rounded-full ${strength.score >= step ? barColor : 'bg-[var(--border)]'}`} />
                ))}
              </div>
              <p className="text-[11px] text-[var(--muted)]">{strength.label}</p>
            </div>

            <label className="flex items-start gap-2.5 text-xs text-[var(--muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[var(--border)] accent-[#0B57A4]"
                required
              />
              <span>
                أوافق على{' '}
                <Link href="/terms" className="text-[var(--primary)] underline font-bold" target="_blank">شروط الاستخدام</Link>
                {' '}و{' '}
                <Link href="/privacy" className="text-[var(--primary)] underline font-bold" target="_blank">سياسة الخصوصية</Link>
                {' '}وفق القانون المصري رقم ١٥١ لسنة ٢٠٢٠.
              </span>
            </label>

            <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} />

            {error && <p className="text-xs font-bold text-[var(--danger)]" role="alert">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[48px] rounded-xl bg-gradient-to-r from-[#0B57A4] via-[#0D7BB8] to-[#0EA5C6] py-3 text-sm font-bold text-white shadow-[0_10px_24px_-8px_rgba(11,87,164,0.48)] hover:brightness-105 transition-all disabled:opacity-60 cursor-pointer"
            >
              {loading ? 'جارٍ إنشاء الحساب...' : 'إنشاء حساب المتجر'}
            </button>
          </form>
        )}

        <p className="lg:hidden text-center text-xs text-[var(--muted)]">
          لديك حساب بالفعل؟{' '}
          <Link href="/login" className="font-bold text-[var(--primary)] hover:underline">
            سجّل الدخول
          </Link>
        </p>
      </div>
    </AuthSplitLayout>
  );
}
