'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  api,
  clearImpersonationToken,
  getImpersonationStoreName,
  getImpersonationToken,
  subscribeImpersonation
} from '@/lib/api';
import { useTheme } from '@/components/ThemeProvider';
import { fmtDate } from '@/lib/format';
import type { NotificationItem, UserProfile } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export const MERCHANT_NAV: NavItem[] = [
  { href: '/dashboard', label: 'نظرة عامة', icon: '📊' },
  { href: '/dashboard/products', label: 'المنتجات والمخزون', icon: '📦' },
  { href: '/dashboard/orders', label: 'الطلبات والفواتير', icon: '🧾' },
  { href: '/dashboard/returns', label: 'المرتجعات وRTO', icon: '↩️' },
  { href: '/dashboard/cod', label: 'التحصيلات والربح', icon: '💰' },
  { href: '/dashboard/customers', label: 'العملاء', icon: '👥' },
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

  // Notifications Center
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  // Read-only impersonation state (in-memory only)
  const [impersonating, setImpersonating] = useState(false);
  const [impersonatedStore, setImpersonatedStore] = useState('');

  useEffect(() => {
    const syncImp = () => {
      setImpersonating(Boolean(getImpersonationToken()));
      setImpersonatedStore(getImpersonationStoreName());
    };
    syncImp();
    return subscribeImpersonation(syncImp);
  }, []);

  const loadNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.get<{ notifications?: NotificationItem[]; unread?: number }>('/api/notifications');
      const items = res.notifications || [];
      setNotifs(items);
      setUnreadCount(
        typeof res.unread === 'number'
          ? res.unread
          : items.filter((n) => !n.readAt).length
      );
    } catch {
      // ignore notifications load errors
    }
  }, [user]);

  useEffect(() => {
    if (user) void loadNotifications();
  }, [user, loadNotifications]);

  async function markNotifRead(id: number) {
    try {
      await api.post(`/api/notifications/${id}/read`, {});
      await loadNotifications();
    } catch {
      // ignore
    }
  }

  async function markAllNotifsRead() {
    try {
      await api.post('/api/notifications/read-all', {});
      await loadNotifications();
    } catch {
      // ignore
    }
  }

  async function deleteNotif(id: number) {
    try {
      await api.del(`/api/notifications/${id}`);
      await loadNotifications();
    } catch {
      // ignore
    }
  }

  function exitImpersonation() {
    clearImpersonationToken();
    router.push('/owner');
  }

  async function handleLogout() {
    clearImpersonationToken();
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Ignore network errors on logout
    }
    router.push('/login');
  }

  const showImpersonationBanner = impersonating || Boolean(user?.readOnly) || Boolean(user?.impersonatedBy);

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
        {showImpersonationBanner && (
          <div className="bg-amber-500 text-slate-950 px-4 lg:px-8 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-extrabold">
            <span>
              وضع المعاينة الإدارية (للقراءة فقط) — المتجر: {impersonatedStore || user?.storeName || 'تاجر'} (لا يمكن تعديل أي بيانات)
            </span>
            <button
              type="button"
              onClick={exitImpersonation}
              className="rounded-lg bg-slate-950 text-white px-3 py-1 text-xs font-bold hover:opacity-90"
            >
              إنهاء المعاينة والعودة للوحة المالك
            </button>
          </div>
        )}

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

          <div className="flex items-center gap-2 shrink-0 relative">
            {user && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    const next = !notifOpen;
                    setNotifOpen(next);
                    if (next) void loadNotifications();
                  }}
                  className="relative rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold hover:bg-[var(--surface-alt)]"
                  aria-label="مركز الإشعارات"
                >
                  🔔
                  {unreadCount > 0 && (
                    <span className="absolute -top-1.5 -left-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-extrabold text-white font-mono-num">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>
                {notifOpen && (
                  <div className="absolute left-0 mt-2 w-80 max-w-[90vw] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl z-50 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                      <strong className="text-xs">الإشعارات ({unreadCount} غير مقروء)</strong>
                      <button
                        type="button"
                        onClick={() => void markAllNotifsRead()}
                        className="text-[11px] font-bold text-[var(--primary)] hover:underline"
                      >
                        تحديد الكل كمقروء
                      </button>
                    </div>
                    <div className="max-h-80 overflow-y-auto divide-y divide-[var(--border)]">
                      {notifs.length === 0 ? (
                        <p className="p-4 text-xs text-center text-[var(--muted)]">لا توجد إشعارات جديدة.</p>
                      ) : (
                        notifs.slice(0, 20).map((n) => (
                          <div
                            key={n.id}
                            className={`p-3 space-y-1 text-xs ${n.readAt ? 'opacity-70' : 'bg-[#0C5CA4]/5'}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <strong className="leading-snug">{n.title}</strong>
                              <div className="flex items-center gap-1 shrink-0">
                                {!n.readAt && (
                                  <button
                                    type="button"
                                    onClick={() => void markNotifRead(n.id)}
                                    className="text-[10px] font-bold text-[var(--primary)]"
                                    title="تحديد كمقروء"
                                  >
                                    ✓
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void deleteNotif(n.id)}
                                  className="text-[10px] font-bold text-rose-600"
                                  title="حذف"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            <p className="text-[var(--muted)] leading-relaxed">{n.body}</p>
                            <div className="text-[10px] text-[var(--muted)]">{fmtDate(n.createdAt)}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {user?.role === 'owner' && !showImpersonationBanner && (
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
