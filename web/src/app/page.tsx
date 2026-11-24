'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useTheme } from '@/components/ThemeProvider';
import { TurnstileWidget } from '@/components/TurnstileWidget';

const FEATURES = [
  { icon: '📦', title: 'مخزون موحّد لحظي', desc: 'مزامنة تلقائية للكميات والأسعار عبر أمازون مصر ونون وجوميا وترينديول وكنز بدون بيع على المكشوف.' },
  { icon: '💰', title: 'تحصيلات COD والأرباح', desc: 'حاسبة أرباح مصرية دقيقة بعمولات المنصات والشحن والمرتجعات مع تسوية بوسطة وأرامكس ومايلرز.' },
  { icon: '✨', title: 'استوديو ذكاء اصطناعي', desc: 'توليد وصف A+ وSEO، رادار تسعير، مستشار نمو، ورسائل واتساب ذكية للعملاء.' },
  { icon: '🛡️', title: 'حماية وأمان متكامل', desc: 'جلسات مشفّرة عبر HttpOnly Cookies ومصادقة ثنائية 2FA وصلاحيات دقيقة للمالك والمشرفين.' }
];

interface AuthConfig {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
}

export default function LandingPage() {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [error, setError] = useState('');
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [demoCaptchaToken, setDemoCaptchaToken] = useState('');

  const [consultOpen, setConsultOpen] = useState(false);
  const [consultForm, setConsultForm] = useState({
    name: '',
    phone: '',
    storeName: '',
    monthlyOrders: '١٠٠ - ٥٠٠ طلب',
    platforms: 'أمازون مصر · نون · جوميا',
    notes: ''
  });
  const [consultToken, setConsultToken] = useState('');
  const [consultSubmitting, setConsultSubmitting] = useState(false);
  const [consultError, setConsultError] = useState('');
  const [consultRef, setConsultRef] = useState('');

  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config')
      .then((cfg) => {
        if (cfg.turnstileEnabled && cfg.turnstileSiteKey) {
          setTurnstileSiteKey(cfg.turnstileSiteKey);
        }
      })
      .catch(() => {});
  }, []);

  async function startDemo() {
    if (turnstileSiteKey && !demoCaptchaToken) {
      setError('يرجى إكمال التحقق الأمني قبل تشغيل الحساب التجريبي');
      return;
    }
    setLoadingDemo(true);
    setError('');
    try {
      await api.post('/api/auth/demo', demoCaptchaToken ? { turnstileToken: demoCaptchaToken } : {});
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'تعذر تشغيل الحساب التجريبي');
    } finally {
      setLoadingDemo(false);
    }
  }

  async function submitConsultation(e: React.FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !consultToken) {
      setConsultError('يرجى إكمال التحقق الأمني أولًا');
      return;
    }
    setConsultSubmitting(true);
    setConsultError('');
    try {
      const res = await api.post<{ ok?: boolean; request?: { ref_code?: string } }>('/api/consultations', {
        ...consultForm,
        ...(consultToken ? { turnstileToken: consultToken } : {})
      });
      setConsultRef(res.request?.ref_code || 'OF-CON');
      setConsultForm({
        name: '',
        phone: '',
        storeName: '',
        monthlyOrders: '١٠٠ - ٥٠٠ طلب',
        platforms: 'أمازون مصر · نون · جوميا',
        notes: ''
      });
    } catch (err) {
      setConsultError(err instanceof ApiError ? err.message : 'تعذر حجز الاستشارة حاليًا');
    } finally {
      setConsultSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)] flex flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 lg:px-8 h-16 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5 font-extrabold text-xl text-[var(--primary)]">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#0C5CA4] text-white text-sm">OF</span>
            <span>OrderFlow</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/about" className="hidden sm:inline-block px-3 py-2 text-xs font-bold text-[var(--muted)] hover:text-[var(--ink)]">
              عن المنصة
            </Link>
            <Link href="/contact" className="hidden sm:inline-block px-3 py-2 text-xs font-bold text-[var(--muted)] hover:text-[var(--ink)]">
              تواصل معنا
            </Link>
            <button
              type="button"
              onClick={toggle}
              className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold"
            >
              {theme === 'dark' ? '☀️ نهاري' : '🌙 ليلي'}
            </button>
            <Link href="/login" className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-bold">
              تسجيل الدخول
            </Link>
            <Link href="/register" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-sm font-bold text-white">
              ابدأ مجانًا
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto px-4 lg:px-8 py-16 lg:py-24 w-full">
        <section className="max-w-3xl space-y-6">
          <p className="text-sm font-bold text-[var(--primary)]">منصة التجارة متعددة القنوات في مصر · بالجنيه المصري</p>
          <h1 className="text-4xl lg:text-6xl font-extrabold leading-tight">
            أدِر متاجرك على أمازون مصر ونون وجوميا من لوحة واحدة
          </h1>
          <p className="text-lg text-[var(--muted)] leading-relaxed">
            مخزون موحّد، إصدار بوالص شحن، مطابقة تحصيلات الدفع عند الاستلام (COD)، فواتير بـ QR، واستوديو ذكاء اصطناعي — بتجربة ويب سريعة وتثبيت PWA.
          </p>
          {turnstileSiteKey && (
            <div className="max-w-sm">
              <TurnstileWidget siteKey={turnstileSiteKey} onToken={setDemoCaptchaToken} />
            </div>
          )}
          {error && <p className="text-sm font-bold text-[var(--danger)]">{error}</p>}
          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              onClick={startDemo}
              disabled={loadingDemo}
              className="rounded-xl bg-[#0C5CA4] hover:bg-[#094a85] px-6 py-3.5 text-sm font-bold text-white transition-colors disabled:opacity-60"
            >
              {loadingDemo ? 'جارٍ تجهيز المتجر التجريبي...' : 'جرّب لوحة التحكم فورًا (حساب تجريبي)'}
            </button>
            <Link
              href="/register"
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-6 py-3.5 text-sm font-bold"
            >
              إنشاء حساب تاجر جديد
            </Link>
            <button
              type="button"
              onClick={() => { setConsultOpen(true); setConsultRef(''); setConsultError(''); }}
              className="rounded-xl border border-[#0C5CA4]/40 bg-[#0C5CA4]/5 px-6 py-3.5 text-sm font-bold text-[var(--primary)]"
            >
              حجز استشارة نمو مجانية
            </button>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mt-16">
          {FEATURES.map((f) => (
            <article key={f.title} className="of-card p-6 space-y-3">
              <div className="text-2xl" aria-hidden="true">{f.icon}</div>
              <h2 className="text-lg font-extrabold">{f.title}</h2>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{f.desc}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="border-t border-[var(--border)] bg-[var(--surface)] py-8">
        <div className="max-w-7xl mx-auto px-4 lg:px-8 flex flex-wrap items-center justify-between gap-4 text-xs text-[var(--muted)]">
          <div>© {new Date().getFullYear()} OrderFlow — منصة التجارة متعددة القنوات في مصر</div>
          <nav className="flex flex-wrap gap-4 font-bold">
            <Link href="/about" className="hover:text-[var(--ink)]">عن المنصة</Link>
            <Link href="/contact" className="hover:text-[var(--ink)]">تواصل معنا</Link>
            <Link href="/terms" className="hover:text-[var(--ink)]">شروط الاستخدام</Link>
            <Link href="/privacy" className="hover:text-[var(--ink)]">سياسة الخصوصية</Link>
            <Link href="/refund" className="hover:text-[var(--ink)]">سياسة الاسترداد</Link>
          </nav>
        </div>
      </footer>

      {consultOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="حجز استشارة نمو مجانية">
          <div className="of-card w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-extrabold">حجز استشارة نمو مجانية</h2>
              <button type="button" onClick={() => setConsultOpen(false)} className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold">
                إغلاق
              </button>
            </div>

            {consultRef ? (
              <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 p-5 space-y-2 text-emerald-800 dark:text-emerald-200">
                <div className="font-extrabold">تم تسجيل طلب الاستشارة بنجاح ✓</div>
                <p className="text-sm">الرقم المرجعي: <strong className="font-mono-num">{consultRef}</strong>. سيتواصل معك خبير التجارة الإلكترونية خلال ٢٤ ساعة.</p>
                <button type="button" onClick={() => setConsultOpen(false)} className="rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-bold text-white">
                  حسنًا
                </button>
              </div>
            ) : (
              <form onSubmit={submitConsultation} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold block mb-1">الاسم الكامل</label>
                    <input className="of-input" value={consultForm.name} onChange={(e) => setConsultForm((p) => ({ ...p, name: e.target.value }))} required />
                  </div>
                  <div>
                    <label className="text-xs font-bold block mb-1">رقم الموبايل المصري</label>
                    <input className="of-input" dir="ltr" placeholder="010xxxxxxxx" value={consultForm.phone} onChange={(e) => setConsultForm((p) => ({ ...p, phone: e.target.value }))} required />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold block mb-1">اسم المتجر</label>
                    <input className="of-input" value={consultForm.storeName} onChange={(e) => setConsultForm((p) => ({ ...p, storeName: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-xs font-bold block mb-1">حجم الطلبات الشهري</label>
                    <select className="of-input" value={consultForm.monthlyOrders} onChange={(e) => setConsultForm((p) => ({ ...p, monthlyOrders: e.target.value }))}>
                      <option value="أقل من ١٠٠ طلب">أقل من ١٠٠ طلب</option>
                      <option value="١٠٠ - ٥٠٠ طلب">١٠٠ - ٥٠٠ طلب</option>
                      <option value="٥٠٠ - ٢٬٠٠٠ طلب">٥٠٠ - ٢٬٠٠٠ طلب</option>
                      <option value="أكثر من ٢٬٠٠٠ طلب">أكثر من ٢٬٠٠٠ طلب</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-bold block mb-1">المنصات المستهدفة</label>
                  <input className="of-input" value={consultForm.platforms} onChange={(e) => setConsultForm((p) => ({ ...p, platforms: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-bold block mb-1">ملاحظات إضافية</label>
                  <textarea className="of-input min-h-[80px]" value={consultForm.notes} onChange={(e) => setConsultForm((p) => ({ ...p, notes: e.target.value }))} placeholder="اذكر التحدي الأساسي لديك في المخزون أو الشحن..." />
                </div>

                <TurnstileWidget siteKey={turnstileSiteKey} onToken={setConsultToken} />
                {consultError && <p className="text-xs font-bold text-[var(--danger)]">{consultError}</p>}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setConsultOpen(false)} className="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-bold">
                    إلغاء
                  </button>
                  <button type="submit" disabled={consultSubmitting} className="rounded-xl bg-[#0C5CA4] px-5 py-2 text-xs font-bold text-white disabled:opacity-60">
                    {consultSubmitting ? 'جارٍ الإرسال...' : 'تأكيد الحجز'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
