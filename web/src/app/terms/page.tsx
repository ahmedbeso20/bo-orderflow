import React from 'react';
import Link from 'next/link';

export const metadata = {
  title: 'شروط الاستخدام — OrderFlow',
  description: 'شروط وأحكام استخدام منصة OrderFlow لإدارة التجارة متعددة القنوات في مصر.'
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="font-extrabold text-xl text-[var(--primary)]">OrderFlow</Link>
          <div className="flex items-center gap-3 text-sm font-bold">
            <Link href="/privacy" className="text-[var(--muted)] hover:text-[var(--ink)]">الخصوصية</Link>
            <Link href="/refund" className="text-[var(--muted)] hover:text-[var(--ink)]">الاسترداد</Link>
            <Link href="/login" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs text-white">تسجيل الدخول</Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-6">
        <div className="of-card p-8 space-y-6">
          <div>
            <h1 className="text-2xl lg:text-3xl font-extrabold">شروط وأحكام الاستخدام</h1>
            <p className="text-xs text-[var(--muted)] mt-1">آخر تحديث: ٢٠٢٦ · يخضع للقوانين المعمول بها في جمهورية مصر العربية</p>
          </div>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">١. نطاق الخدمة</h2>
            <p className="text-[var(--muted)]">
              توفر منصة OrderFlow نظام تشغيل موحّد للتجار في مصر لإدارة المخزون والطلبات عبر أمازون مصر ونون وجوميا وترينديول وكنز، وإصدار بوالص الشحن، ومطابقة تحصيلات الدفع عند الاستلام (COD)، وأدوات الذكاء الاصطناعي التسويقية.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٢. التزامات التاجر وأمان الحساب</h2>
            <ul className="list-disc list-inside space-y-1.5 text-[var(--muted)]">
              <li>يلتزم التاجر بتقديم بيانات صحيحة لمتجره وبيانات الاتصال الرسمية.</li>
              <li>يتحمل التاجر مسؤولية الحفاظ على سرية كلمة المرور وتفعيل المصادقة الثنائية (2FA) لحماية بياناته ومفاتيح الربط.</li>
              <li>يُحظر استخدام المنصة في بيع منتجات مخالفة للقانون المصري أو سياسات الأسواق المتصلة.</li>
            </ul>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٣. الربط مع المنصات وشركات الشحن</h2>
            <p className="text-[var(--muted)]">
              تُخزَّن جميع مفاتيح API ورموز OAuth مشفّرة باستخدام AES-256-GCM. تعتمد مزامنة الطلبات والمخزون على توافر واجهات البرمجة الخاصة بالمنصات (أمازون SP-API، نون، جوميا، ترينديول، كنز) وشركات الشحن (بوسطة، أرامكس، مايلرز).
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٤. الاشتراكات والمدفوعات</h2>
            <p className="text-[var(--muted)]">
              تُحتسب أسعار الباقات بالجنيه المصري وتُسدّد إلكترونيًا عبر بوابات الدفع المعتمدة مثل كاشير (Kashier). تُصدر المنصة إيصالًا تجاريًا مبسّطًا لكل عملية دفع مكتملة، وتخضع طلبات الإلغاء والاسترداد لـ <Link href="/refund" className="text-[var(--primary)] underline font-bold">سياسة الاسترداد</Link>.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٥. إخلاء المسؤولية والتعديلات</h2>
            <p className="text-[var(--muted)]">
              تعمل OrderFlow كوسيط تقني لإدارة العمليات التجارية ولا تتحمل مسؤولية توقفات الجهات الخارجية أو التزامات الإقرارات الضريبية الخاصة بالتاجر أمام مصلحة الضرائب المصرية. لأي استفسار يرجى <Link href="/contact" className="text-[var(--primary)] underline font-bold">التواصل معنا</Link>.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
