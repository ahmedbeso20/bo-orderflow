'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useTheme } from '@/components/ThemeProvider';

const FEATURES = [
  { icon: '📦', title: 'مخزون موحّد لحظي', desc: 'مزامنة تلقائية للكميات والأسعار عبر أمازون مصر ونون وجوميا وترينديول وكنز بدون بيع على المكشوف.' },
  { icon: '💰', title: 'تحصيلات COD والأرباح', desc: 'حاسبة أرباح مصرية دقيقة بعمولات المنصات والشحن والمرتجعات مع تسوية بوسطة وأرامكس ومايلرز.' },
  { icon: '✨', title: 'استوديو ذكاء اصطناعي', desc: 'توليد وصف A+ وSEO، رادار تسعير، مستشار نمو، ورسائل واتساب ذكية للعملاء.' },
  { icon: '🛡️', title: 'حماية وأمان متكامل', desc: 'جلسات مشفّرة عبر HttpOnly Cookies ومصادقة ثنائية 2FA وصلاحيات دقيقة للمالك والمشرفين.' }
];

export default function LandingPage() {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [error, setError] = useState('');

  async function startDemo() {
    setLoadingDemo(true);
    setError('');
    try {
      await api.post('/api/auth/demo');
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تشغيل الحساب التجريبي');
    } finally {
      setLoadingDemo(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 lg:px-8 h-16 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5 font-extrabold text-xl text-[var(--primary)]">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#0C5CA4] text-white text-sm">OF</span>
            <span>OrderFlow</span>
          </Link>
          <div className="flex items-center gap-2">
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

      <main className="max-w-7xl mx-auto px-4 lg:px-8 py-16 lg:py-24">
        <section className="max-w-3xl space-y-6">
          <p className="text-sm font-bold text-[var(--primary)]">منصة التجارة متعددة القنوات في مصر · بالجنيه المصري</p>
          <h1 className="text-4xl lg:text-6xl font-extrabold leading-tight">
            أدِر متاجرك على أمازون مصر ونون وجوميا من لوحة واحدة
          </h1>
          <p className="text-lg text-[var(--muted)] leading-relaxed">
            مخزون موحّد، إصدار بوالص شحن، مطابقة تحصيلات الدفع عند الاستلام (COD)، فواتير بـ QR، واستوديو ذكاء اصطناعي — بتجربة ويب سريعة وتثبيت PWA.
          </p>
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
    </div>
  );
}
