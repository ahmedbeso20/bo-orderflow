'use client';

import React from 'react';
import Link from 'next/link';
import { useTheme } from '@/components/ThemeProvider';

interface AuthSplitLayoutProps {
  mode: 'login' | 'register';
  children: React.ReactNode;
}

const MARKETPLACES = ['Amazon', 'Noon', 'Jumia', 'Trendyol', 'Kenzz'];

export function AuthSplitLayout({ mode, children }: AuthSplitLayoutProps) {
  const { theme, toggle } = useTheme();
  const isRegister = mode === 'register';

  return (
    <div className="min-h-screen flex flex-col justify-between px-4 py-5 sm:px-6 bg-gradient-to-b from-[#F8FAFE] to-[#EEF3FA] dark:from-[#040D1A] dark:to-[#091E37] text-[var(--ink)] relative overflow-x-hidden">
      <header className="w-full max-w-[1120px] mx-auto flex items-center justify-between gap-3 relative z-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)]/85 backdrop-blur text-xs font-bold text-[var(--muted)] hover:text-[var(--primary)] hover:border-[var(--primary)] transition-colors whitespace-nowrap"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
          <span>العودة للرئيسية</span>
        </Link>

        <button
          type="button"
          onClick={toggle}
          aria-label="تبديل المظهر"
          className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)]/85 backdrop-blur text-xs font-bold text-[var(--muted)] hover:text-[var(--primary)] hover:border-[var(--primary)] transition-colors whitespace-nowrap cursor-pointer"
        >
          <span>{theme === 'dark' ? '☀️ نهاري' : '🌙 ليلي'}</span>
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center py-5 relative z-10">
        <section
          aria-label={isRegister ? 'صفحة إنشاء حساب' : 'صفحة تسجيل الدخول'}
          className={`w-full max-w-[1000px] min-h-[580px] grid grid-cols-1 ${
            isRegister ? 'lg:grid-cols-[1fr_1.62fr]' : 'lg:grid-cols-[1.52fr_1fr]'
          } rounded-[26px] overflow-hidden bg-[var(--surface)] border border-[var(--border)] shadow-[0_30px_70px_-20px_rgba(8,33,61,0.22)]`}
        >
          <div className={`p-7 sm:p-10 flex flex-col justify-center bg-[var(--surface)] ${isRegister ? 'lg:order-2' : 'lg:order-1'}`}>
            <div className="flex justify-center mb-4">
              <Link href="/" className="inline-flex items-center gap-2.5" dir="ltr">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#0B57A4] to-[#0EA5C6] text-white font-extrabold text-sm shadow-sm">
                  OF
                </span>
                <span className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">
                  Order<span className="bg-gradient-to-r from-[#0B57A4] to-[#0EA5C6] bg-clip-text text-transparent">Flow</span>
                </span>
              </Link>
            </div>
            {children}
          </div>

          <aside
            className={`relative overflow-hidden p-8 sm:p-9 flex flex-col items-center justify-between text-center text-white bg-gradient-to-br from-[#06182E] via-[#092C54] to-[#0B57A4] ${
              isRegister ? 'lg:order-1' : 'lg:order-2'
            }`}
          >
            <span aria-hidden="true" className="pointer-events-none absolute -top-16 -end-16 h-40 w-40 rounded-full bg-white/[0.06] border border-white/[0.08]" />
            <span aria-hidden="true" className="pointer-events-none absolute -bottom-20 -start-20 h-44 w-44 rounded-full bg-[#0EA5C6]/15 border border-[#7EE4F5]/15" />

            <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-3 max-w-[280px] py-4">
              <span className="text-xs font-bold text-[#7EE4F5]">منصة التجارة متعددة القنوات</span>
              <h2 className="text-2xl font-extrabold text-white leading-snug text-balance">
                {isRegister ? 'لديك حساب بالفعل؟' : 'ليس لديك حساب؟'}
              </h2>
              <p className="text-xs sm:text-sm text-[#C7DAEC] leading-relaxed mb-3">
                {isRegister
                  ? 'سجّل دخولك لمتابعة مخزونك الموحّد وطلباتك وتحصيلات COD لحظة بلحظة.'
                  : 'ابدأ إدارة متاجرك على أمازون مصر ونون وجوميا وترينديول من شاشة واحدة.'}
              </p>

              <Link
                href={isRegister ? '/login' : '/register'}
                className="group w-[134px] h-[134px] rounded-full bg-white text-[#082B52] hover:bg-[#F0FAFE] hover:text-[#0B57A4] flex flex-col items-center justify-center gap-2 shadow-[0_20px_44px_-10px_rgba(4,15,31,0.48),0_0_0_8px_rgba(255,255,255,0.11)] hover:-translate-y-1 hover:scale-[1.03] transition-all duration-200"
              >
                <span className="w-10 h-10 rounded-full bg-[#E6F2FD] text-[#0B57A4] group-hover:bg-[#0B57A4] group-hover:text-white flex items-center justify-center transition-colors">
                  {isRegister ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" x2="3" y1="12" y2="12" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <line x1="19" x2="19" y1="8" y2="14" />
                      <line x1="22" x2="16" y1="11" y2="11" />
                    </svg>
                  )}
                </span>
                <span className="text-sm font-extrabold whitespace-nowrap">
                  {isRegister ? 'تسجيل الدخول' : 'إنشاء حساب'}
                </span>
              </Link>
            </div>

            <div className="relative z-10 w-full pt-4 border-t border-white/15 space-y-2">
              <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] font-semibold text-white/85" dir="ltr">
                {MARKETPLACES.map((mk, idx) => (
                  <React.Fragment key={mk}>
                    <span>{mk}</span>
                    {idx < MARKETPLACES.length - 1 && <span aria-hidden="true" className="text-white/35">·</span>}
                  </React.Fragment>
                ))}
              </div>
              <p className="text-[11px] text-[#9FC2E0]">تشفير AES-256 · مصادقة ثنائية 2FA · بالجنيه المصري</p>
            </div>
          </aside>
        </section>
      </main>

      <footer className="relative z-10 flex flex-wrap items-center justify-center gap-2.5 text-xs text-[var(--muted)]">
        <Link href="/terms" className="hover:text-[var(--primary)]">الشروط والأحكام</Link>
        <span aria-hidden="true">·</span>
        <Link href="/privacy" className="hover:text-[var(--primary)]">سياسة الخصوصية</Link>
        <span aria-hidden="true">·</span>
        <Link href="/contact" className="hover:text-[var(--primary)]">تواصل معنا</Link>
        <span aria-hidden="true">·</span>
        <span>© {new Date().getFullYear()} OrderFlow</span>
      </footer>
    </div>
  );
}
