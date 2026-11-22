'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';

export default function SettingsPage() {
  const { data: boot, reload } = useBootstrap();
  const [storeName, setStoreName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [instapay, setInstapay] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!boot?.me) return;
    setStoreName(boot.me.storeName || '');
    setTaxId(boot.me.taxId || '');
    setInstapay(boot.me.instapay || '');
  }, [boot?.me]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.put('/api/settings', { storeName: storeName.trim(), taxId: taxId.trim(), instapay: instapay.trim() });
      setNotice('تم حفظ بيانات المتجر والرقم الضريبي بنجاح');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الإعدادات');
    }
  }

  async function setup2fa() {
    setError('');
    try {
      const res = await api.post<{ secret?: string }>('/api/auth/2fa/setup', {});
      setTotpSecret(res.secret || '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر بدء إعداد 2FA');
    }
  }

  async function enable2fa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/auth/2fa/enable', { code: totpCode.trim() });
      setTotpSecret('');
      setTotpCode('');
      setNotice('تم تفعيل المصادقة الثنائية (2FA) بنجاح');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الرمز غير صحيح');
    }
  }

  return (
    <AppShell title="إعدادات المتجر والأمان" subtitle="البيانات الضريبية، إنستا باي، والمصادقة الثنائية 2FA" user={boot?.me}>
      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={saveProfile} className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">بيانات المتجر والفوترة</h2>
          <div className="space-y-1">
            <label className="text-xs font-bold block">اسم المتجر</label>
            <input className="of-input" value={storeName} onChange={(e) => setStoreName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold block">الرقم الضريبي (مشفّر مع فهرس بحث آمن)</label>
            <input className="of-input" dir="ltr" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="412-890-115" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold block">عنوان InstaPay</label>
            <input className="of-input" dir="ltr" value={instapay} onChange={(e) => setInstapay(e.target.value)} placeholder="store@instapay" />
          </div>
          <button type="submit" className="rounded-xl bg-[#0C5CA4] px-6 py-2.5 text-sm font-bold text-white">حفظ التغييرات</button>
        </form>

        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">المصادقة الثنائية (2FA / TOTP)</h2>
          <p className="text-xs text-[var(--muted)]">
            الحالة الحالية: <strong>{boot?.me?.totpEnabled ? 'مفعّلة ✓' : 'غير مفعّلة'}</strong>
          </p>
          {!boot?.me?.totpEnabled && !totpSecret && (
            <button type="button" onClick={() => void setup2fa()} className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">
              تفعيل المصادقة الثنائية
            </button>
          )}
          {totpSecret && (
            <form onSubmit={enable2fa} className="space-y-3">
              <div className="rounded-xl bg-[var(--surface-alt)] p-3 text-xs font-mono-num" dir="ltr">
                Secret: {totpSecret}
              </div>
              <input
                className="of-input font-mono-num text-center"
                dir="ltr"
                maxLength={6}
                placeholder="أدخل رمز 6 أرقام من تطبيق المصادقة"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                required
              />
              <button type="submit" className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-bold text-white">تأكيد التفعيل</button>
            </form>
          )}
        </section>
      </div>
    </AppShell>
  );
}
