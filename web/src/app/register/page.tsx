'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TurnstileWidget } from '@/components/TurnstileWidget';

interface AuthConfig {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [store, setStore] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
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

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <div className="of-card w-full max-w-md p-8 space-y-6">
        <div className="space-y-1 text-center">
          <Link href="/" className="inline-block font-extrabold text-2xl text-[var(--primary)]">OrderFlow</Link>
          <h1 className="text-xl font-extrabold">إنشاء حساب تاجر جديد</h1>
        </div>

        {pendingMsg ? (
          <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 p-4 text-sm text-emerald-800 dark:text-emerald-200 space-y-3">
            <p className="font-bold">{pendingMsg}</p>
            <p className="text-xs">ستصلك رسالة تأكيد فور تفعيل حسابك من إدارة المنصة.</p>
            <Link href="/login" className="inline-block font-bold underline">العودة لتسجيل الدخول</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-bold block">اسم المتجر</label>
              <input className="of-input" value={store} onChange={(e) => setStore(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold block">الاسم الكامل</label>
              <input className="of-input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold block">البريد الإلكتروني</label>
              <input type="email" dir="ltr" className="of-input" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold block">رقم الموبايل المصري</label>
              <input dir="ltr" className="of-input" placeholder="010xxxxxxxx" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold block">كلمة المرور (8 أحرف فأكثر بحروف وأرقام)</label>
              <input type="password" dir="ltr" className="of-input" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>

            <label className="flex items-start gap-2.5 text-xs text-[var(--muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[var(--border)] accent-[#0C5CA4]"
                required
              />
              <span>
                أوافق على{' '}
                <Link href="/terms" className="text-[var(--primary)] underline font-bold" target="_blank">شروط الاستخدام</Link>
                {' '}و{' '}
                <Link href="/privacy" className="text-[var(--primary)] underline font-bold" target="_blank">سياسة الخصوصية وحماية البيانات</Link>
                {' '}وفق القانون المصري رقم ١٥١ لسنة ٢٠٢٠ (إخفاء بيانات المشترين تلقائيًا بعد ٣٠ يومًا).
              </span>
            </label>

            <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} />

            {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}
            <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60">
              {loading ? 'جارٍ التسجيل...' : 'إنشاء الحساب'}
            </button>
          </form>
        )}

        <p className="text-center text-xs text-[var(--muted)]">
          لديك حساب بالفعل؟ <Link href="/login" className="font-bold text-[var(--primary)]">سجّل الدخول</Link>
        </p>
      </div>
    </div>
  );
}
