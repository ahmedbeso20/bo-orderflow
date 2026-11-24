import React from 'react';
import Link from 'next/link';

export const metadata = {
  title: 'سياسة الخصوصية وحماية البيانات — OrderFlow',
  description: 'سياسة الخصوصية والامتثال لقانون حماية البيانات الشخصية المصري رقم 151 لسنة 2020 وسياسة Amazon SP-API DPP.'
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="font-extrabold text-xl text-[var(--primary)]">OrderFlow</Link>
          <div className="flex items-center gap-3 text-sm font-bold">
            <Link href="/terms" className="text-[var(--muted)] hover:text-[var(--ink)]">الشروط</Link>
            <Link href="/refund" className="text-[var(--muted)] hover:text-[var(--ink)]">الاسترداد</Link>
            <Link href="/login" className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs text-white">تسجيل الدخول</Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-6">
        <div className="of-card p-8 space-y-6">
          <div>
            <h1 className="text-2xl lg:text-3xl font-extrabold">سياسة الخصوصية وحماية البيانات الشخصية</h1>
            <p className="text-xs text-[var(--muted)] mt-1">متوافقة مع القانون المصري رقم ١٥١ لسنة ٢٠٢٠ لحماية البيانات الشخصية وسياسة حماية بيانات أمازون (SP-API DPP)</p>
          </div>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">١. البيانات التي نجمعها</h2>
            <p className="text-[var(--muted)]">
              نجمع فقط البيانات اللازمة لتشغيل متجرك: بيانات حساب التاجر (الاسم، المتجر، البريد الإلكتروني، رقم الموبايل)، وبيانات الطلبات والشحن (اسم العميل، الهاتف، العنوان) لغرض التنفيذ وإصدار بوالص الشحن ومطابقة التحصيلات فقط.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٢. التشفير والحماية التقنية</h2>
            <ul className="list-disc list-inside space-y-1.5 text-[var(--muted)]">
              <li>تُشفَّر جميع البيانات الشخصية الحساسة ومفاتيح الربط في قاعدة البيانات باستخدام تشفير AES-256-GCM.</li>
              <li>تُدار جلسات الدخول عبر ملفات تعريف ارتباط آمنة <code>HttpOnly</code> فقط ولا تُخزَّن أي رموز مصادقة في <code>localStorage</code>.</li>
              <li>يُسجَّل كل وصول إداري لبيانات العملاء في سجل تدقيق (PII Access Log) قابل للمراجعة والتصدير.</li>
            </ul>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٣. سياسة الاحتفاظ والإخفاء التلقائي (٣٠ يومًا)</h2>
            <p className="text-[var(--muted)]">
              تُخفى بيانات المشترين الشخصية (الاسم والهاتف والعنوان) تلقائيًا للطلبات المكتملة أو الملغاة بعد مرور ٣٠ يومًا من التنفيذ (أو وفق المدة المحددة في إعدادات الامتثال)، مع الإبقاء فقط على الأرقام المالية المجمّعة لتقارير الأرباح والضرائب.
            </p>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٤. حقوقك وفق القانون ١٥١/٢٠٢٠</h2>
            <ul className="list-disc list-inside space-y-1.5 text-[var(--muted)]">
              <li><strong>حق النقل والتصدير:</strong> يمكنك تصدير نسخة كاملة من بيانات متجرك بصيغة JSON من صفحة الإعدادات في أي وقت.</li>
              <li><strong>حق المحو وحذف الحساب:</strong> يمكنك حذف حسابك وجميع بيانات متجرك من صفحة الإعدادات مع الاحتفاظ القانوني بسجلات الفوترة المجهّلة فقط للامتثال الضريبي.</li>
              <li><strong>عدم بيع البيانات:</strong> لا تبيع OrderFlow ولا تشارك بيانات متجرك أو عملائك مع أي طرف ثالث لأغراض إعلانية.</li>
            </ul>
          </section>

          <section className="space-y-2 text-sm leading-relaxed">
            <h2 className="text-lg font-extrabold">٥. التواصل مع مسؤول حماية البيانات</h2>
            <p className="text-[var(--muted)]">
              لممارسة حقوقك أو الإبلاغ عن أي استفسار متعلق بالخصوصية، يُرجى مراسلتنا عبر <Link href="/contact" className="text-[var(--primary)] underline font-bold">صفحة التواصل</Link>.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
