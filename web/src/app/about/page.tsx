import React from 'react';
import Link from 'next/link';

export const metadata = {
  title: 'عن OrderFlow — منصة التجارة متعددة القنوات في مصر',
  description: 'تعرف على رؤية OrderFlow في تمكين تجار التجارة الإلكترونية في مصر عبر أمازون ونون وجوميا وترينديول وكنز.'
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="font-extrabold text-xl text-[var(--primary)]">OrderFlow</Link>
          <div className="flex items-center gap-3 text-sm font-bold">
            <Link href="/contact" className="text-[var(--muted)] hover:text-[var(--ink)]">تواصل معنا</Link>
            <Link href="/register" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs text-white">ابدأ مجانًا</Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-6">
        <div className="of-card p-8 space-y-6">
          <h1 className="text-2xl lg:text-3xl font-extrabold">عن منصة OrderFlow</h1>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            صُمّمت OrderFlow خصيصًا لتجار التجارة الإلكترونية في مصر لحل أكبر تحديات البيع متعدد القنوات: منع نفاذ المخزون والبيع على المكشوف، متابعة تحصيلات الدفع عند الاستلام (COD)، تقليل نسب المرتجعات (RTO)، وحساب صافي الربح الحقيقي بالجنيه المصري بعد خصم عمولات المنصات ومصاريف الشحن.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl bg-[var(--surface-alt)] p-4 space-y-1">
              <div className="text-xl font-extrabold text-[var(--primary)]">٥ منصات بيع</div>
              <p className="text-xs text-[var(--muted)]">أمازون مصر، نون، جوميا، ترينديول، وكنز في لوحة مخزون واحدة.</p>
            </div>
            <div className="rounded-xl bg-[var(--surface-alt)] p-4 space-y-1">
              <div className="text-xl font-extrabold text-[var(--primary)]">٣ شركات شحن</div>
              <p className="text-xs text-[var(--muted)]">إصدار بوالص وتتبع لحظي عبر بوسطة وأرامكس ومايلرز.</p>
            </div>
            <div className="rounded-xl bg-[var(--surface-alt)] p-4 space-y-1">
              <div className="text-xl font-extrabold text-[var(--primary)]">أمان وامتثال</div>
              <p className="text-xs text-[var(--muted)]">تشفير AES-256، مصادقة ثنائية 2FA، وامتثال كامل للقانون المصري ١٥١/٢٠٢٠.</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="/register" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">
              أنشئ حساب متجرك مجانًا
            </Link>
            <Link href="/contact" className="rounded-xl border border-[var(--border)] px-5 py-2.5 text-xs font-bold">
              تحدث مع فريقنا
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
