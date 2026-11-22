'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useTheme } from '@/components/ThemeProvider';
import type { UserProfile } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export const MERCHANT_NAV: NavItem[] = [
  { href: '/dashboard', label: 'نظرة عامة', icon: '📊' },
  { href: '/dashboard/products', label: 'المنتجات والمخزون', icon: '📦' },
  { href: '/dashboard/orders', label: 'الطلبات والفواتير', icon: '🧾' },
  { href: '/dashboard/cod', label: 'التحصيلات والربح', icon: '💰' },
  { href: '/dashboard/customers', label: 'العملاء والمرتجعات', icon: '👥' },
  { href: '/dashboard/integrations', label: 'الربط والمنصات', icon: '🔌' },
  { href: '/dashboard/ai', label: 'استوديو الذكاء', icon: '✨' },
  { href: '/dashboard/billing', label: 'الباقات والفواتير', icon: '💳' },
  { href: '/dashboard/services', label: 'الخبراء والدعم', icon: '🛟' },
  { href: '/dashboard/settings', label: 'الإعدادات والأمان', icon: '⚙️' }
];

interface AppShellProps {
  title: string;
  subtitle?: string;
  user?: UserProfile | null;
  nav?: NavItem[];
  children: React.ReactNode;
}

export function AppShell({ title, subtitle, user, nav = MERCHANT_NAV, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function handleLogout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Ignore network errors on logout
    }
    router.push('/login');
  }

  return (
    <div className="min-h-screen flex bg-[var(--bg)] text-[var(--ink)]">
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed lg:sticky top-0 right-0 z-40 h-screen w-64 shrink-0 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col transition-transform lg:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-5 border-b border-[var(--border)] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 font-extrabold text-lg text-[var(--primary)]">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#0C5CA4] text-white text-sm">OF</span>
            <span>OrderFlow</span>
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="lg:hidden rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--surface-alt)]"
            aria-label="إغلاق القائمة"
          >
            ✕
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
                  active
                    ? 'bg-[#0C5CA4] text-white'
                    : 'text-[var(--ink)] hover:bg-[var(--surface-alt)]'
                }`}
              >
                <span aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-[var(--border)] space-y-2">
          {user && (
            <div className="rounded-xl bg-[var(--surface-alt)] p-3 text-xs">
              <div className="font-bold text-sm truncate">{user.storeName || user.fullName}</div>
              <div className="text-[var(--muted)] truncate" dir="ltr">{user.email || user.phone}</div>
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold hover:bg-[var(--surface-alt)]"
          >
            تسجيل الخروج
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur px-4 lg:px-8 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="lg:hidden rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-bold"
              aria-label="فتح القائمة"
            >
              ☰
            </button>
            <div className="min-w-0">
              <h1 className="text-lg lg:text-xl font-extrabold truncate">{title}</h1>
              {subtitle && <p className="text-xs text-[var(--muted)] truncate">{subtitle}</p>}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {user?.role === 'owner' && (
              <Link href="/owner" className="rounded-xl bg-[#0C5CA4] px-3 py-2 text-xs font-bold text-white">
                لوحة المالك
              </Link>
            )}
            {user?.role === 'moderator' && (
              <Link href="/moderator" className="rounded-xl bg-[#0C5CA4] px-3 py-2 text-xs font-bold text-white">
                لوحة المشرف
              </Link>
            )}
            <button
              type="button"
              onClick={toggle}
              className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold hover:bg-[var(--surface-alt)]"
              aria-label="تبديل المظهر"
            >
              {theme === 'dark' ? '☀️ نهاري' : '🌙 ليلي'}
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
