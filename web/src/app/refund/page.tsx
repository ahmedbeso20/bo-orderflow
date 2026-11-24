import React from 'react';
import Link from 'next/link';

export const metadata = {
  title: 'سياسة الاسترداد والإلغاء — OrderFlow',
  description: 'سياسة استرداد وإلغاء الاشتراكات المدفوعة في منصة OrderFlow بالجنيه المصري.'
};

export default function RefundPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="font-extrabold text-xl text-[var(--primary)]">OrderFlow</Link>
          <div className="flex items-center gap-3 text-sm font-bold">
            <Link href="/terms" className="text-[var(--muted)] hover:text-[var(--ink)]">الشروط</Link>
            <Link href="/privacy" className="text-[var(--muted)] hover:text-[var(--ink)]">الخصوصية</Link>
            <Link href="/login" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs text-white">تسجيل الدخول</Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-6">
        <div className="of-card p-8 space-y-6">
          <div>
            <h1 className="text-2xl lg:text-3xl font-extrabold">سياسة الاسترداد وإلغاء الاشتراكات</h1>
            <p className="text-xs text-[var(--muted)] mt-1">شفافية كاملة في الاشتراكات الشهرية والسنوية بالجنيه المصري</p>
          </div>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">١. ضمان الاسترداد خلال ١٤ يومًا</h2>
            <p className="text-[var(--muted)]">
              يحق للتاجر طلب استرداد كامل قيمة الاشتراك الأول (الشهري أو السنوي) خلال ١٤ يومًا من تاريخ السداد إذا لم تكن المنصة ملائمة لاحتياجات متجره، بشرط عدم إساءة استخدام الحصص البرمجية أو خدمات الخبراء المنفّذة بالفعل.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٢. إلغاء التجديد وتخفيض الباقة</h2>
            <p className="text-[var(--muted)]">
              يمكنك إلغاء التجديد أو العودة للباقة المجانية في أي وقت دون رسوم إلغاء إضافية. تظل مميزات الباقة المدفوعة فعّالة حتى نهاية دورة الفوترة الحالية ما لم يُنفّذ استرداد فوري للمبلغ.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٣. مدة وطريقة رد المبالغ</h2>
            <p className="text-[var(--muted)]">
              تُراجع طلبات الاسترداد خلال يومي عمل، ويُرد المبلغ إلى نفس وسيلة الدفع المستخدمة عبر بوابة كاشير (بطاقة بنكية، محفظة إلكترونية، أو إنستاباي) خلال ٥ إلى ١٤ يوم عمل وفق سياسات البنك المُصدِر للبطاقة.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٤. تقديم طلب استرداد</h2>
            <p className="text-[var(--muted)]">
              لتقديم طلب استرداد، أرسل رقم مرجع العملية (<code>txRef</code>) واسم المتجر عبر <Link href="/contact" className="text-[var(--primary)] underline font-bold">صفحة التواصل</Link> أو من خلال تذاكر الدعم داخل لوحة التحكم.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
