'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate } from '@/lib/format';

export default function SettingsPage() {
  const router = useRouter();
  const { data: boot, reload } = useBootstrap();

  // بيانات المتجر
  const [storeName, setStoreName] = useState('');
  const [storeEmail, setStoreEmail] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [taxId, setTaxId] = useState('');
  const [instaPayHandle, setInstaPayHandle] = useState('');
  const [profileCurrentPw, setProfileCurrentPw] = useState('');
  const [profileTotp, setProfileTotp] = useState('');

  // المصادقة الثنائية 2FA
  const [totpSecret, setTotpSecret] = useState('');
  const [totpQrSvg, setTotpQrSvg] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [reconfigPw, setReconfigPw] = useState('');
  const [reconfigCode, setReconfigCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');

  // كلمة المرور والجلسات
  const [curPw, setCurPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const [pwTotp, setPwTotp] = useState('');

  // توثيق البريد والهاتف
  const [emailToken, setEmailToken] = useState('');
  const [phoneOtp, setPhoneOtp] = useState('');

  // حذف الحساب (قانون 151/2020)
  const [deletePw, setDeletePw] = useState('');
  const [delete2fa, setDelete2fa] = useState('');

  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const origEmail = boot?.settings?.storeEmail || boot?.settings?.email || boot?.me?.email || '';
  const origPhone = boot?.settings?.storePhone || boot?.settings?.phone || boot?.me?.phone || '';

  useEffect(() => {
    const s = boot?.settings;
    if (!s && !boot?.me) return;
    setStoreName(s?.storeName || boot?.me?.storeName || '');
    setStoreEmail(s?.storeEmail || s?.email || boot?.me?.email || '');
    setStorePhone(s?.storePhone || s?.phone || boot?.me?.phone || '');
    setTaxId(s?.taxId || boot?.me?.taxId || '');
    setInstaPayHandle(s?.instaPayHandle || boot?.me?.instaPayHandle || '');
  }, [boot?.settings, boot?.me]);

  const contactChanged =
    !boot?.me?.isDemo &&
    (storeEmail.trim().toLowerCase() !== origEmail.trim().toLowerCase() ||
      storePhone.trim() !== origPhone.trim());

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.put('/api/settings', {
        storeName: storeName.trim(),
        storeEmail: storeEmail.trim(),
        storePhone: storePhone.trim(),
        taxId: taxId.trim(),
        instaPayHandle: instaPayHandle.trim(),
        ...(contactChanged && profileCurrentPw ? { currentPassword: profileCurrentPw } : {}),
        ...(contactChanged && profileTotp.trim() ? { totpCode: profileTotp.trim() } : {})
      });
      setProfileCurrentPw('');
      setProfileTotp('');
      setNotice('تم حفظ بيانات المتجر والرقم الضريبي بنجاح ✓');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الإعدادات');
    }
  }

  async function setup2fa(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setError('');
    setNotice('');
    try {
      const payload = boot?.me?.totpEnabled
        ? { password: reconfigPw, totpCode: reconfigCode.trim() }
        : {};
      const res = await api.post<{ secret?: string; qrSvg?: string }>('/api/account/2fa/setup', payload);
      setTotpSecret(res.secret || '');
      setTotpQrSvg(res.qrSvg || '');
      setReconfigPw('');
      setReconfigCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر بدء إعداد 2FA');
    }
  }

  async function enable2fa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ recoveryCodes?: string[] }>('/api/account/2fa/enable', { code: totpCode.trim() });
      setTotpSecret('');
      setTotpQrSvg('');
      setTotpCode('');
      setRecoveryCodes(res.recoveryCodes || []);
      setNotice('تم تفعيل المصادقة الثنائية (2FA) بنجاح — احفظ أكواد الاسترداد الآن');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الرمز غير صحيح');
    }
  }

  async function disable2fa(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/2fa/disable', { password: disablePw, code: disableCode.trim() });
      setDisablePw('');
      setDisableCode('');
      setNotice('تم تعطيل المصادقة الثنائية');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تعطيل 2FA');
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/password', {
        current: curPw,
        next: nextPw,
        ...(boot?.me?.totpEnabled ? { totpCode: pwTotp.trim() } : {})
      });
      setCurPw('');
      setNextPw('');
      setPwTotp('');
      setNotice('تم تغيير كلمة المرور وإنهاء جميع الجلسات الأخرى بنجاح ✓');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تغيير كلمة المرور');
    }
  }

  async function logoutAll() {
    setError('');
    try {
      await api.post('/api/auth/logout-all', {});
      router.replace('/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إنهاء الجلسات');
    }
  }

  async function sendEmailVerify() {
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/verify-email/send', {});
      setNotice('تم إرسال رمز تأكيد البريد الإلكتروني بنجاح');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إرسال رمز البريد');
    }
  }

  async function confirmEmailVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/verify-email/confirm', { token: emailToken.trim() });
      setEmailToken('');
      setNotice('تم توثيق البريد الإلكتروني بنجاح ✓');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'الرمز غير صالح');
    }
  }

  async function sendPhoneOtp() {
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/verify-phone/send', {});
      setNotice('تم إرسال رمز SMS OTP إلى رقم موبايلك');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إرسال رسالة SMS');
    }
  }

  async function confirmPhoneOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/verify-phone/confirm', { code: phoneOtp.trim() });
      setPhoneOtp('');
      setNotice('تم توثيق رقم الموبايل بنجاح ✓');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'رمز OTP غير صحيح');
    }
  }

  async function deleteSeedData() {
    setError('');
    setNotice('');
    try {
      const res = await api.del<{ deletedOrders?: number; deletedProducts?: number }>('/api/account/seed-data');
      setNotice(`تم حذف البيانات التجريبية (${res.deletedProducts ?? 0} منتج و ${res.deletedOrders ?? 0} طلب) مع الإبقاء على بياناتك الحقيقية.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حذف البيانات التجريبية');
    }
  }

  async function requestDeletion(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/delete', {
        password: deletePw,
        ...(delete2fa.trim() ? { code: delete2fa.trim() } : {})
      });
      setDeletePw('');
      setDelete2fa('');
      setNotice('تم جدولة حذف الحساب بعد 14 يومًا وفق قانون حماية البيانات 151/2020. يمكنك الإلغاء قبل انتهاء المهلة.');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر جدولة حذف الحساب');
    }
  }

  async function cancelDeletion() {
    setError('');
    setNotice('');
    try {
      await api.post('/api/account/delete/cancel', {});
      setNotice('تم إلغاء طلب حذف الحساب بنجاح ✓');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إلغاء طلب الحذف');
    }
  }

  const qrUri = totpQrSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(totpQrSvg)}` : '';
  const isStaff = boot?.me?.role === 'owner' || boot?.me?.role === 'moderator';
  const deletionRequestedAt = boot?.me?.deletionRequestedAt || boot?.settings?.deletionRequestedAt;

  return (
    <AppShell title="إعدادات المتجر والأمان والخصوصية" subtitle="البيانات الضريبية، 2FA، التوثيق، وقانون حماية البيانات ١٥١/٢٠٢٠" user={boot?.me}>
      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={saveProfile} className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">بيانات المتجر والفوترة</h2>
          <div className="space-y-1">
            <label className="text-xs font-bold block">اسم المتجر</label>
            <input className="of-input" value={storeName} onChange={(e) => setStoreName(e.target.value)} required />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-bold block">البريد الإلكتروني</label>
              <input type="email" className="of-input" dir="ltr" value={storeEmail} onChange={(e) => setStoreEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold block">رقم الموبايل</label>
              <input className="of-input" dir="ltr" value={storePhone} onChange={(e) => setStorePhone(e.target.value)} />
            </div>
          </div>
          {contactChanged && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-2">
              <div className="text-xs font-bold text-amber-800 dark:text-amber-200">
                تأكيد الهوية مطلوب عند تعديل البريد الإلكتروني أو رقم الموبايل:
              </div>
              <input
                type="password"
                dir="ltr"
                className="of-input"
                placeholder="كلمة المرور الحالية"
                value={profileCurrentPw}
                onChange={(e) => setProfileCurrentPw(e.target.value)}
                required
              />
              {boot?.me?.totpEnabled && (
                <input
                  dir="ltr"
                  className="of-input font-mono-num"
                  maxLength={6}
                  placeholder="رمز المصادقة الثنائية 2FA (6 أرقام)"
                  value={profileTotp}
                  onChange={(e) => setProfileTotp(e.target.value)}
                  required
                />
              )}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-bold block">الرقم الضريبي (مشفّر AES-256-GCM مع فهرس بحث آمن)</label>
            <input className="of-input" dir="ltr" value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="412-890-115" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold block">عنوان InstaPay</label>
            <input className="of-input" dir="ltr" value={instaPayHandle} onChange={(e) => setInstaPayHandle(e.target.value)} placeholder="store@instapay" />
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
              إعداد المصادقة الثنائية الآن
            </button>
          )}
          {totpSecret && (
            <form onSubmit={enable2fa} className="space-y-3">
              {qrUri && (
                <div className="flex justify-center">
                  <img src={qrUri} alt="رمز QR للمصادقة الثنائية" className="h-44 w-44 rounded-xl border border-[var(--border)] bg-white p-2" />
                </div>
              )}
              <div className="rounded-xl bg-[var(--surface-alt)] p-3 text-xs font-mono-num text-center select-all" dir="ltr">
                {totpSecret}
              </div>
              <input
                className="of-input font-mono-num text-center tracking-widest"
                dir="ltr"
                maxLength={6}
                placeholder="أدخل رمز 6 أرقام من التطبيق"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                required
              />
              <button type="submit" className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-bold text-white">تأكيد التفعيل</button>
            </form>
          )}
          {recoveryCodes.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
              <div className="text-xs font-bold text-amber-900 dark:text-amber-200">أكواد الاسترداد (احفظها الآن — تُعرض مرة واحدة فقط):</div>
              <div className="grid grid-cols-2 gap-1.5 font-mono-num text-xs text-center" dir="ltr">
                {recoveryCodes.map((rc) => (
                  <div key={rc} className="rounded bg-[var(--surface)] py-1 font-bold">{rc}</div>
                ))}
              </div>
            </div>
          )}
          {boot?.me?.totpEnabled && !totpSecret && (
            <form onSubmit={(e) => void setup2fa(e)} className="space-y-2 pt-2 border-t border-[var(--border)]">
              <div className="text-xs font-bold text-[var(--muted)]">تدوير مفتاح 2FA (يتطلب كلمة المرور والرمز الحالي)</div>
              <input type="password" dir="ltr" className="of-input" placeholder="كلمة المرور الحالية" value={reconfigPw} onChange={(e) => setReconfigPw(e.target.value)} required />
              <input dir="ltr" className="of-input font-mono-num" maxLength={6} placeholder="رمز 2FA الحالي" value={reconfigCode} onChange={(e) => setReconfigCode(e.target.value)} required />
              <button type="submit" className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold">إنشاء مفتاح 2FA جديد</button>
            </form>
          )}
          {boot?.me?.totpEnabled && !isStaff && (
            <form onSubmit={disable2fa} className="space-y-2 pt-2 border-t border-[var(--border)]">
              <div className="text-xs font-bold text-[var(--muted)]">تعطيل المصادقة الثنائية</div>
              <input type="password" dir="ltr" className="of-input" placeholder="كلمة المرور الحالية" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} required />
              <input dir="ltr" className="of-input font-mono-num" placeholder="رمز 2FA أو كود استرداد" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} required />
              <button type="submit" className="rounded-xl border border-rose-500/40 px-4 py-2 text-xs font-bold text-rose-600">تعطيل 2FA</button>
            </form>
          )}
        </section>

        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">كلمة المرور وإدارة الجلسات</h2>
          <form onSubmit={changePassword} className="space-y-3">
            <input type="password" dir="ltr" className="of-input" placeholder="كلمة المرور الحالية" value={curPw} onChange={(e) => setCurPw(e.target.value)} required />
            <input type="password" dir="ltr" className="of-input" placeholder="كلمة المرور الجديدة (8 أحرف فأكثر)" value={nextPw} onChange={(e) => setNextPw(e.target.value)} required />
            {boot?.me?.totpEnabled && (
              <input dir="ltr" className="of-input font-mono-num" maxLength={6} placeholder="رمز المصادقة الثنائية 2FA (مطلوب)" value={pwTotp} onChange={(e) => setPwTotp(e.target.value)} required />
            )}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">تحديث كلمة المرور</button>
              <button type="button" onClick={() => void logoutAll()} className="rounded-xl border border-rose-500/40 px-4 py-2.5 text-xs font-bold text-rose-600">
                إنهاء جميع الجلسات على كل الأجهزة
              </button>
            </div>
          </form>
        </section>

        <section className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">توثيق البريد الإلكتروني ورقم الموبايل</h2>
          <div className="space-y-2 pb-3 border-b border-[var(--border)]">
            <div className="flex items-center justify-between text-xs">
              <span>البريد الإلكتروني: <strong dir="ltr">{boot?.me?.email || storeEmail || 'غير مضاف'}</strong></span>
              <span className={boot?.me?.emailVerified ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold'}>
                {boot?.me?.emailVerified ? 'موثّق ✓' : 'غير موثّق'}
              </span>
            </div>
            {!boot?.me?.emailVerified && (
              <div className="space-y-2">
                <button type="button" onClick={() => void sendEmailVerify()} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                  إرسال رمز التأكيد للبريد
                </button>
                <form onSubmit={confirmEmailVerify} className="flex gap-2">
                  <input className="of-input" placeholder="أدخل رمز التأكيد المرسل لبريدك" value={emailToken} onChange={(e) => setEmailToken(e.target.value)} required />
                  <button type="submit" className="rounded-xl bg-[#0C5CA4] px-4 text-xs font-bold text-white shrink-0">تأكيد</button>
                </form>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span>الموبايل: <strong dir="ltr">{(boot?.me?.phone && !boot.me.phone.startsWith('demo-') ? boot.me.phone : storePhone) || 'غير مضاف'}</strong></span>
              <span className={boot?.me?.phoneVerified ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold'}>
                {boot?.me?.phoneVerified ? 'موثّق ✓' : 'غير موثّق'}
              </span>
            </div>
            {!boot?.me?.phoneVerified && (
              <div className="space-y-2">
                <button type="button" onClick={() => void sendPhoneOtp()} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                  إرسال رمز SMS OTP
                </button>
                <form onSubmit={confirmPhoneOtp} className="flex gap-2">
                  <input className="of-input font-mono-num" maxLength={6} placeholder="أدخل رمز SMS المكوّن من 6 أرقام" value={phoneOtp} onChange={(e) => setPhoneOtp(e.target.value)} required />
                  <button type="submit" className="rounded-xl bg-[#0C5CA4] px-4 text-xs font-bold text-white shrink-0">تأكيد</button>
                </form>
              </div>
            )}
          </div>
        </section>

        <section className="of-card p-6 space-y-4 lg:col-span-2">
          <h2 className="font-extrabold text-base">الخصوصية وحقوق البيانات (القانون المصري ١٥١/٢٠٢٠)</h2>
          <div className="flex flex-wrap gap-3">
            <a
              href="/api/account/export"
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2.5 text-xs font-bold hover:opacity-90"
            >
              📦 تنزيل أرشيف بياناتي الكامل (ZIP)
            </a>
            <button
              type="button"
              onClick={() => void deleteSeedData()}
              className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs font-bold hover:bg-[var(--surface-alt)]"
            >
              🧹 حذف البيانات التجريبية الافتراضية فقط
            </button>
          </div>

          {!isStaff && !boot?.me?.isDemo && (
            <div className="pt-4 border-t border-[var(--border)] space-y-3">
              {deletionRequestedAt ? (
                <div className="rounded-xl bg-rose-50 dark:bg-rose-950/30 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs font-bold text-rose-800 dark:text-rose-200">
                    تم تقديم طلب حذف الحساب في {fmtDate(deletionRequestedAt)} (يُنفّذ بعد 14 يومًا مع أرشفة الإيصالات الضريبية مجهولة الهوية).
                  </div>
                  <button type="button" onClick={() => void cancelDeletion()} className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white">
                    إلغاء طلب الحذف
                  </button>
                </div>
              ) : (
                <form onSubmit={requestDeletion} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="text-xs font-bold block mb-1">كلمة المرور لجدولة حذف الحساب (14 يومًا)</label>
                    <input type="password" dir="ltr" className="of-input" value={deletePw} onChange={(e) => setDeletePw(e.target.value)} required />
                  </div>
                  {boot?.me?.totpEnabled && (
                    <div>
                      <label className="text-xs font-bold block mb-1">رمز المصادقة الثنائية 2FA</label>
                      <input dir="ltr" className="of-input font-mono-num" value={delete2fa} onChange={(e) => setDelete2fa(e.target.value)} required />
                    </div>
                  )}
                  <button type="submit" className="rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">
                    جدولة حذف الحساب نهائيًا
                  </button>
                </form>
              )}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
