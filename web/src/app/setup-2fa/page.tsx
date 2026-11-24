'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

interface MeResponse {
  authenticated?: boolean;
  me?: { role?: string; storeName?: string; email?: string; totpEnabled?: boolean };
}

interface SetupResponse {
  secret: string;
  qrSvg: string;
  otpauthUrl?: string;
}

export default function Setup2faPage() {
  const router = useRouter();
  const [role, setRole] = useState('client');
  const [secret, setSecret] = useState('');
  const [qrSvg, setQrSvg] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const meRes = await api.get<MeResponse>('/api/auth/me');
        if (!active) return;
        if (meRes.authenticated === false || !meRes.me) {
          router.replace('/login');
          return;
        }
        setRole(meRes.me.role || 'client');
        const setup = await api.post<SetupResponse>('/api/account/2fa/setup', {});
        if (!active) return;
        setSecret(setup.secret);
        setQrSvg(setup.qrSvg);
      } catch (err) {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : 'تعذر بدء إعداد المصادقة الثنائية');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [router]);

  async function handleEnable(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await api.post<{ recoveryCodes?: string[] }>('/api/account/2fa/enable', {
        code: code.trim()
      });
      setRecoveryCodes(res.recoveryCodes || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الرمز غير صحيح، حاول مجددًا');
    } finally {
      setSubmitting(false);
    }
  }

  function finish() {
    router.replace(role === 'owner' ? '/owner' : role === 'moderator' ? '/moderator' : '/dashboard');
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopied(true);
    } catch {
      // ignore clipboard errors
    }
  }

  const qrDataUri = qrSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}` : '';

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <div className="of-card w-full max-w-lg p-8 space-y-6">
        <div className="text-center space-y-1">
          <div className="font-extrabold text-2xl text-[var(--primary)]">OrderFlow</div>
          <h1 className="text-xl font-extrabold">تفعيل المصادقة الثنائية الإلزامية (2FA)</h1>
          <p className="text-xs text-[var(--muted)]">
            لحماية لوحة التحكم، يلزم ربط حسابك بتطبيق مصادقة (Google Authenticator أو Authy) قبل المتابعة.
          </p>
        </div>

        {loading ? (
          <p className="text-center text-sm text-[var(--muted)]">جارٍ توليد مفتاح المصادقة...</p>
        ) : recoveryCodes.length > 0 ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/40 p-4 text-xs font-bold text-amber-900 dark:text-amber-200">
              احفظ أكواد الاسترداد التالية في مكان آمن الآن — كل كود يُستخدم مرة واحدة فقط ولن تُعرض مرة أخرى.
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-[var(--surface-alt)] p-4 font-mono-num text-sm text-center" dir="ltr">
              {recoveryCodes.map((c) => (
                <div key={c} className="rounded-lg bg-[var(--surface)] py-1.5 border border-[var(--border)] font-bold">{c}</div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copyCodes()}
                className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-xs font-bold"
              >
                {copied ? 'تم النسخ ✓' : 'نسخ جميع الأكواد'}
              </button>
              <button
                type="button"
                onClick={finish}
                className="flex-1 rounded-xl bg-[#0C5CA4] py-2.5 text-xs font-bold text-white"
              >
                حفظتها — دخول للوحة التحكم
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleEnable} className="space-y-4">
            {qrDataUri && (
              <div className="flex justify-center">
                <img
                  src={qrDataUri}
                  alt="رمز QR للمصادقة الثنائية"
                  className="h-48 w-48 rounded-xl border border-[var(--border)] bg-white p-2"
                />
              </div>
            )}
            {secret && (
              <div className="rounded-xl bg-[var(--surface-alt)] p-3 text-center">
                <div className="text-[11px] text-[var(--muted)] mb-1">المفتاح اليدوي (إذا لم تتمكن من مسح QR)</div>
                <code className="font-mono-num text-xs font-bold select-all" dir="ltr">{secret}</code>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-bold block">أدخل الرمز المكون من 6 أرقام من التطبيق</label>
              <input
                className="of-input text-center font-mono-num tracking-widest"
                dir="ltr"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 py-3 text-sm font-bold text-white disabled:opacity-60"
            >
              {submitting ? 'جارٍ التفعيل...' : 'تفعيل المصادقة الثنائية الآن'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
