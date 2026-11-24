'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP, fmtNum } from '@/lib/format';
import type { ServiceRequest, SupportTicket } from '@/lib/types';

type OwnerTab =
  | 'overview'
  | 'readiness'
  | 'clients'
  | 'moderators'
  | 'approvals'
  | 'payments'
  | 'security'
  | 'pii'
  | 'tickets'
  | 'services'
  | 'settings'
  | 'audit';

interface ClientRow {
  id: number;
  storeName: string;
  fullName?: string;
  email?: string;
  phone: string;
  planName: string;
  plan?: string;
  status: string;
  createdAt: string;
}

interface ModeratorRow {
  id: number;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  totpEnabled: boolean;
  permissions: Record<string, boolean>;
  totalActions: number;
  createdAt: string;
}

interface ApprovalRow {
  id: number;
  type: 'product' | 'order';
  name?: string;
  customer?: string;
  storeName?: string;
  approvalStatus?: string;
}

interface PaymentRow {
  id: number;
  txRef: string;
  storeName?: string;
  plan: string;
  amount: number;
  status: string;
  method?: string;
  createdAt: string;
}

interface CouponRow {
  id: number;
  code: string;
  type: 'pct' | 'fixed';
  value: number;
  desc: string;
  active: boolean;
  usedCount?: number;
}

interface SecurityEventRow {
  id: number;
  severity: string;
  title: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

interface PiiLogRow {
  id: number;
  actorName: string;
  actorRole: string;
  merchantName: string;
  action: string;
  count: number;
  ip: string;
  createdAt: string;
}

interface AuditRow {
  id: number;
  actorName: string;
  actorRole: string;
  action: string;
  createdAt: string;
}

interface BackupRow {
  filename?: string;
  file?: string;
  size?: number;
  encrypted?: boolean;
  createdAt?: string;
}

interface ReadinessData {
  production: boolean;
  email: { configured: boolean; provider: string; fromConfigured: boolean };
  sms: { configured: boolean; provider: string };
  kashier: { active: boolean; configured: boolean; mode: string; webhookUrl: string; provider: string };
  gemini: { configured: boolean; model: string };
  backup: {
    encryptionConfigured: boolean;
    s3Configured: boolean;
    lastBackupAt: string | null;
    lastBackupFile: string | null;
    lastBackupEncrypted: boolean;
    lastUploadStatus: string;
    lastUploadedAt: string | null;
  };
  turnstile: { enabled: boolean; siteKeyConfigured: boolean; secretKeyConfigured: boolean };
  alerts: { webhookConfigured: boolean; errorWebhookConfigured: boolean; unackSecurityEvents: number };
}

export default function OwnerPanelPage() {
  const { data: boot } = useBootstrap('owner');
  const [tab, setTab] = useState<OwnerTab>('overview');
  const [kpis, setKpis] = useState<Record<string, number>>({});
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientQuery, setClientQuery] = useState('');
  const [moderators, setModerators] = useState<ModeratorRow[]>([]);
  const [permMeta, setPermMeta] = useState<Array<{ key: string; label: string }>>([]);
  const [modForm, setModForm] = useState({ fullName: '', email: '', phone: '', password: '' });
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [couponForm, setCouponForm] = useState({ code: '', type: 'pct' as 'pct' | 'fixed', value: '15', desc: '' });
  const [secEvents, setSecEvents] = useState<SecurityEventRow[]>([]);
  const [piiLogs, setPiiLogs] = useState<PiiLogRow[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [services, setServices] = useState<ServiceRequest[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [platSettings, setPlatSettings] = useState<Record<string, string>>({});
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [readiness, setReadiness] = useState<ReadinessData | null>(null);
  const [replyText, setReplyText] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadTab(activeTab: OwnerTab, q = clientQuery) {
    setError('');
    try {
      if (activeTab === 'overview') {
        const res = await api.get<{ kpis?: Record<string, number> }>('/api/owner/dashboard');
        setKpis(res.kpis || {});
      } else if (activeTab === 'readiness') {
        const res = await api.get<ReadinessData>('/api/owner/readiness');
        setReadiness(res);
      } else if (activeTab === 'clients') {
        const res = await api.get<{ clients?: ClientRow[] }>(`/api/owner/clients?q=${encodeURIComponent(q)}`);
        setClients(res.clients || []);
      } else if (activeTab === 'moderators') {
        const res = await api.get<{ moderators?: ModeratorRow[]; permissionMeta?: Record<string, { label: string }> | Array<{ key: string; label: string }> }>('/api/owner/moderators');
        setModerators(res.moderators || []);
        if (Array.isArray(res.permissionMeta)) {
          setPermMeta(res.permissionMeta);
        } else if (res.permissionMeta) {
          setPermMeta(Object.entries(res.permissionMeta).map(([key, v]) => ({ key, label: v.label || key })));
        }
      } else if (activeTab === 'approvals') {
        const res = await api.get<{ products?: ApprovalRow[]; orders?: ApprovalRow[] }>('/api/owner/approvals?status=pending');
        setApprovals([
          ...(res.products || []).map((p) => ({ ...p, type: 'product' as const })),
          ...(res.orders || []).map((o) => ({ ...o, type: 'order' as const }))
        ]);
      } else if (activeTab === 'payments') {
        const [pRes, cRes] = await Promise.all([
          api.get<{ payments?: PaymentRow[] }>('/api/owner/payments'),
          api.get<{ coupons?: CouponRow[] }>('/api/owner/coupons')
        ]);
        setPayments(pRes.payments || []);
        setCoupons(cRes.coupons || []);
      } else if (activeTab === 'security') {
        const res = await api.get<{ events?: SecurityEventRow[] }>('/api/owner/security');
        setSecEvents(res.events || []);
      } else if (activeTab === 'pii') {
        const res = await api.get<{ logs?: PiiLogRow[] }>('/api/owner/pii-log');
        setPiiLogs(res.logs || []);
      } else if (activeTab === 'tickets') {
        const res = await api.get<{ tickets?: SupportTicket[] }>('/api/owner/tickets');
        setTickets(res.tickets || []);
      } else if (activeTab === 'services') {
        const res = await api.get<{ requests?: ServiceRequest[] }>('/api/owner/services');
        setServices(res.requests || []);
      } else if (activeTab === 'settings') {
        const res = await api.get<{ settings?: Record<string, string>; backups?: BackupRow[] }>('/api/owner/settings');
        setPlatSettings(res.settings || {});
        setBackups(res.backups || []);
      } else if (activeTab === 'audit') {
        const res = await api.get<{ logs?: AuditRow[] }>('/api/owner/audit');
        setAudit(res.logs || []);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل البيانات');
    }
  }

  useEffect(() => {
    if (boot?.me?.role === 'owner') void loadTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot?.me?.role, tab]);

  async function runAction(fn: () => Promise<void>, successMsg: string, reloadCurrent = true) {
    setNotice('');
    setError('');
    try {
      await fn();
      setNotice(successMsg);
      if (reloadCurrent) await loadTab(tab);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تنفيذ الإجراء');
    }
  }

  const tabs: Array<[OwnerTab, string]> = [
    ['overview', '📊 النظرة العامة'],
    ['readiness', '🩺 جاهزية الإنتاج'],
    ['clients', '🏪 العملاء'],
    ['moderators', '🧑‍💼 المشرفون'],
    ['approvals', '✅ الاعتمادات'],
    ['payments', '💳 المدفوعات والكوبونات'],
    ['security', '🚨 التنبيهات الأمنية'],
    ['pii', '🔐 سجل PII'],
    ['tickets', '💬 الدعم'],
    ['services', '💼 الخبراء'],
    ['settings', '⚙️ الإعدادات والنسخ'],
    ['audit', '📜 سجل المراقبة']
  ];

  return (
    <AppShell
      title="لوحة تحكم المالك"
      subtitle="الإدارة الشاملة، المشرفون، الاعتمادات، جاهزية الإنتاج، وسجل PII والأمان"
      user={boot?.me}
      nav={[
        { href: '/owner', label: 'لوحة المالك', icon: '🛡️' },
        { href: '/dashboard', label: 'معاينة التاجر', icon: '📊' }
      ]}
    >
      <div className="flex flex-wrap gap-2 mb-6">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setTab(k); setNotice(''); setError(''); }}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold ${
              tab === k ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      {tab === 'overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">إجمالي العملاء</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1">{fmtNum(kpis.totalClients)}</div>
            <div className="text-[11px] text-[var(--muted)]">معلّق: {fmtNum(kpis.pendingClients)}</div>
          </div>
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">تذاكر دعم مفتوحة</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1 text-amber-600">{fmtNum(kpis.openTickets)}</div>
            <div className="text-[11px] text-[var(--muted)]">إجمالي التذاكر: {fmtNum(kpis.totalTickets)}</div>
          </div>
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">منتجات وطلبات للمراجعة</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1">{fmtNum((kpis.pendingProducts || 0) + (kpis.pendingOrders || 0))}</div>
            <div className="text-[11px] text-[var(--muted)]">طلبات خبراء: {fmtNum(kpis.pendingServices)}</div>
          </div>
          <div className="of-card p-5">
            <div className="text-xs text-[var(--muted)]">إيرادات الاشتراكات</div>
            <div className="text-2xl font-extrabold font-mono-num mt-1 text-emerald-600">{fmtEGP(kpis.totalRevenue)}</div>
            <div className="text-[11px] text-[var(--muted)]">المشرفون النشطون: {fmtNum(kpis.activeModerators)} / {fmtNum(kpis.maxModerators || 3)}</div>
          </div>
        </div>
      )}

      {tab === 'readiness' && readiness && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="of-card p-5 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">البريد الإلكتروني (Email)</strong>
                <span className={`text-xs font-bold ${readiness.email.configured ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {readiness.email.configured ? `مفعّل (${readiness.email.provider})` : 'غير مضبوط'}
                </span>
              </div>
              <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/mail/test', {}); }, 'تم إرسال بريد اختباري بنجاح', false)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                اختبار البريد الآن
              </button>
            </div>

            <div className="of-card p-5 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">رسائل SMS OTP</strong>
                <span className={`text-xs font-bold ${readiness.sms.configured ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {readiness.sms.configured ? `مفعّل (${readiness.sms.provider})` : 'غير مضبوط'}
                </span>
              </div>
              <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/sms/test', {}); }, 'تم إرسال رسالة SMS اختبارية', false)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                اختبار SMS
              </button>
            </div>

            <div className="of-card p-5 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">بوابة الدفع كاشير (Kashier)</strong>
                <span className={`text-xs font-bold ${readiness.kashier.configured ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {readiness.kashier.configured ? `${readiness.kashier.mode}` : readiness.kashier.provider}
                </span>
              </div>
              <div className="text-[11px] font-mono-num text-[var(--muted)] break-all" dir="ltr">
                Webhook: {readiness.kashier.webhookUrl}
              </div>
              <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/payments/reconcile', {}); }, 'تم تنفيذ مطابقة المدفوعات المعلقة', false)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                مطابقة المدفوعات المعلقة
              </button>
            </div>

            <div className="of-card p-5 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">الذكاء الاصطناعي (Gemini)</strong>
                <span className={`text-xs font-bold ${readiness.gemini.configured ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {readiness.gemini.configured ? readiness.gemini.model : 'غير مضبوط'}
                </span>
              </div>
              <button type="button" onClick={() => void runAction(async () => {
                const r = await api.post<{ ok?: boolean; error?: string; reply?: string }>('/api/owner/ai/test', {});
                if (!r.ok) throw new ApiError(500, r.error || 'فشل اختبار AI');
              }, 'نجح الاتصال بنموذج Gemini ✓', false)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                اختبار الذكاء الاصطناعي
              </button>
            </div>

            <div className="of-card p-5 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">النسخ الاحتياطي و S3</strong>
                <span className={`text-xs font-bold ${readiness.backup.s3Configured ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {readiness.backup.s3Configured ? 'S3 مضبوط' : 'محلي فقط'}
                </span>
              </div>
              <div className="text-xs text-[var(--muted)]">
                التشفير: {readiness.backup.encryptionConfigured ? 'AES-256 ✓' : 'غير مفعّل'} · الحالة: {readiness.backup.lastUploadStatus}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void runAction(async () => {
                  const r = await api.post<{ ok?: boolean; error?: string }>('/api/owner/backups/test-s3', {});
                  if (!r.ok) throw new ApiError(500, r.error || 'فشل الاتصال بـ S3');
                }, 'نجح اختبار اتصال S3 ✓')} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                  اختبار S3
                </button>
                <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/backup', {}); }, 'تم إنشاء نسخة احتياطية جديدة ✓')} className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white">
                  نسخة الآن
                </button>
              </div>
            </div>

            <div className="of-card p-5 space-y-2">
              <div className="flex justify-between items-center">
                <strong className="text-sm">Turnstile والتنبيهات الأمنية</strong>
                <span className={`text-xs font-bold ${readiness.turnstile.enabled ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {readiness.turnstile.enabled ? 'Turnstile مفعّل' : 'Turnstile غير مضبوط'}
                </span>
              </div>
              <div className="text-xs text-[var(--muted)]">
                Webhook التنبيهات: {readiness.alerts.webhookConfigured ? 'مضبوط ✓' : 'بريد/سجل داخلي فقط'}
              </div>
              <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/alerts/test', {}); }, 'تم إرسال تنبيه أمني اختباري بنجاح ✓')} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                اختبار التنبيهات الأمنية
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'clients' && (
        <div className="space-y-4">
          <form onSubmit={(e) => { e.preventDefault(); void loadTab('clients', clientQuery); }} className="flex gap-2 max-w-lg">
            <input
              className="of-input"
              placeholder="ابحث بالاسم أو المتجر أو البريد أو الهاتف أو الرقم الضريبي..."
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
            />
            <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 text-xs font-bold text-white shrink-0">بحث</button>
          </form>
          <div className="of-card overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-[var(--surface-alt)] text-xs">
                <tr>
                  <th className="p-3">المتجر</th>
                  <th className="p-3">التواصل</th>
                  <th className="p-3">الباقة</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 font-bold">{c.storeName}</td>
                    <td className="p-3 text-xs" dir="ltr">{c.email || c.phone}</td>
                    <td className="p-3">{c.planName}</td>
                    <td className="p-3">{c.status}</td>
                    <td className="p-3 flex flex-wrap gap-1.5">
                      {c.status !== 'active' && (
                        <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/owner/clients/${c.id}/approve`, {}); }, 'تم تفعيل حساب العميل ✓')} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
                          تفعيل
                        </button>
                      )}
                      {c.status === 'active' && (
                        <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/owner/clients/${c.id}/status`, { status: 'suspended', reason: 'إيقاف إداري' }); }, 'تم تعليق الحساب')} className="rounded-lg border border-rose-500/40 px-3 py-1 text-xs font-bold text-rose-600">
                          تعليق
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'moderators' && (
        <div className="space-y-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runAction(async () => {
                await api.post('/api/owner/moderators', modForm);
                setModForm({ fullName: '', email: '', phone: '', password: '' });
              }, 'تم إنشاء حساب المشرف بنجاح ✓');
            }}
            className="of-card p-5 grid grid-cols-1 md:grid-cols-5 gap-3 items-end"
          >
            <div>
              <label className="text-xs font-bold block mb-1">اسم المشرف</label>
              <input className="of-input" value={modForm.fullName} onChange={(e) => setModForm((p) => ({ ...p, fullName: e.target.value }))} required />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">البريد الإلكتروني</label>
              <input type="email" dir="ltr" className="of-input" value={modForm.email} onChange={(e) => setModForm((p) => ({ ...p, email: e.target.value }))} required />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الموبايل</label>
              <input dir="ltr" className="of-input" value={modForm.phone} onChange={(e) => setModForm((p) => ({ ...p, phone: e.target.value }))} required />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">كلمة المرور</label>
              <input type="password" dir="ltr" className="of-input" value={modForm.password} onChange={(e) => setModForm((p) => ({ ...p, password: e.target.value }))} required />
            </div>
            <button type="submit" disabled={moderators.length >= 3} className="rounded-xl bg-[#0C5CA4] py-2.5 text-xs font-bold text-white disabled:opacity-50">
              + إضافة مشرف ({moderators.length}/3)
            </button>
          </form>

          <div className="space-y-3">
            {moderators.map((m) => (
              <div key={m.id} className="of-card p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-extrabold">{m.fullName} <span className="text-xs text-[var(--muted)]">({m.status})</span></div>
                    <div className="text-xs text-[var(--muted)]" dir="ltr">{m.email} · {m.phone} · 2FA: {m.totpEnabled ? '✓' : 'مطلوب'}</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void runAction(async () => {
                        await api.post(`/api/owner/moderators/${m.id}/status`, { status: m.status === 'active' ? 'suspended' : 'active' });
                      }, 'تم تحديث حالة المشرف')}
                      className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-bold"
                    >
                      {m.status === 'active' ? 'إيقاف مؤقت' : 'إعادة تفعيل'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction(async () => { await api.del(`/api/owner/moderators/${m.id}`); }, 'تم حذف المشرف نهائيًا')}
                      className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-bold text-white"
                    >
                      حذف
                    </button>
                  </div>
                </div>
                {permMeta.length > 0 && (
                  <div className="flex flex-wrap gap-3 pt-2 border-t border-[var(--border)]">
                    {permMeta.map((pm) => (
                      <label key={pm.key} className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(m.permissions?.[pm.key])}
                          onChange={(e) => {
                            const nextPerms = { ...m.permissions, [pm.key]: e.target.checked };
                            void runAction(async () => {
                              await api.post(`/api/owner/moderators/${m.id}/permissions`, { permissions: nextPerms });
                            }, 'تم تحديث صلاحيات المشرف ✓');
                          }}
                        />
                        <span>{pm.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'approvals' && (
        <div className="space-y-3">
          {approvals.length === 0 ? (
            <div className="of-card p-6 text-sm text-[var(--muted)]">لا توجد منتجات أو طلبات بانتظار الاعتماد حاليًا.</div>
          ) : (
            approvals.map((item) => (
              <div key={`${item.type}-${item.id}`} className="of-card p-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-extrabold">
                    {item.type === 'product' ? `منتج: ${item.name}` : `طلب #${item.id}: ${item.customer}`}
                  </div>
                  <div className="text-xs text-[var(--muted)]">المتجر: {item.storeName || '—'}</div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/admin/approvals/${item.type}/${item.id}/approve`, {}); }, 'تم الاعتماد بنجاح ✓')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
                    اعتماد
                  </button>
                  <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/admin/approvals/${item.type}/${item.id}/reject`, { reason: 'غير مطابق لمعايير المنصة' }); }, 'تم الرفض وإشعار التاجر')} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white">
                    رفض
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'payments' && (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="font-extrabold text-base">المدفوعات والاشتراكات</h2>
            <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/payments/reconcile', {}); }, 'تمت مطابقة المدفوعات المعلقة ✓')} className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs font-bold text-white">
              مطابقة المدفوعات المعلقة
            </button>
          </div>
          <div className="of-card overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-[var(--surface-alt)] text-xs">
                <tr>
                  <th className="p-3">المرجع</th>
                  <th className="p-3">المتجر</th>
                  <th className="p-3">الباقة</th>
                  <th className="p-3">المبلغ</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="p-3 font-mono-num text-xs" dir="ltr">{p.txRef}</td>
                    <td className="p-3 font-bold">{p.storeName || '—'}</td>
                    <td className="p-3">{p.plan}</td>
                    <td className="p-3 font-mono-num font-bold">{fmtEGP(p.amount)}</td>
                    <td className="p-3">{p.status}</td>
                    <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="of-card p-5 space-y-4">
            <h3 className="font-extrabold text-sm">إدارة كوبونات الخصم</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runAction(async () => {
                  await api.post('/api/owner/coupons', {
                    code: couponForm.code,
                    type: couponForm.type,
                    value: Number(couponForm.value),
                    desc: couponForm.desc
                  });
                  setCouponForm({ code: '', type: 'pct', value: '15', desc: '' });
                }, 'تم إنشاء الكوبون بنجاح ✓');
              }}
              className="grid grid-cols-1 md:grid-cols-5 gap-2"
            >
              <input className="of-input" dir="ltr" placeholder="كود مثل SAVE20" value={couponForm.code} onChange={(e) => setCouponForm((p) => ({ ...p, code: e.target.value }))} required />
              <select className="of-input" value={couponForm.type} onChange={(e) => setCouponForm((p) => ({ ...p, type: e.target.value as 'pct' | 'fixed' }))}>
                <option value="pct">نسبة مئوية (%)</option>
                <option value="fixed">مبلغ ثابت (ج.م)</option>
              </select>
              <input type="number" className="of-input" placeholder="القيمة" value={couponForm.value} onChange={(e) => setCouponForm((p) => ({ ...p, value: e.target.value }))} required />
              <input className="of-input" placeholder="وصف اختياري" value={couponForm.desc} onChange={(e) => setCouponForm((p) => ({ ...p, desc: e.target.value }))} />
              <button type="submit" className="rounded-xl bg-[#0C5CA4] text-xs font-bold text-white">+ إضافة كوبون</button>
            </form>
            <div className="space-y-2">
              {coupons.map((cp) => (
                <div key={cp.id} className="rounded-xl border border-[var(--border)] p-3 flex items-center justify-between text-xs">
                  <div>
                    <strong dir="ltr" className="font-mono-num">{cp.code}</strong> · {cp.desc} ({cp.active ? 'نشط' : 'متوقف'})
                  </div>
                  <button type="button" onClick={() => void runAction(async () => { await api.del(`/api/owner/coupons/${cp.id}`); }, 'تم حذف الكوبون')} className="text-rose-600 font-bold">
                    حذف
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'security' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/alerts/test', {}); }, 'تم إرسال تنبيه أمني اختباري ✓')} className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs font-bold text-white">
              إرسال تنبيه اختباري
            </button>
          </div>
          {secEvents.map((ev) => (
            <div key={ev.id} className="of-card p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-extrabold text-sm">[{ev.severity.toUpperCase()}] {ev.title}</div>
                <div className="text-xs text-[var(--muted)]">{fmtDate(ev.createdAt)} {ev.acknowledgedAt ? `· تم الإقرار في ${fmtDate(ev.acknowledgedAt)}` : '· غير مقروء'}</div>
              </div>
              {!ev.acknowledgedAt && (
                <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/owner/security/${ev.id}/ack`, {}); }, 'تم الإقرار بالتنبيه الأمني ✓')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
                  إقرار بالعلم
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'pii' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="font-extrabold text-base">سجل الوصول إلى البيانات الشخصية (Amazon DPP / القانون 151/2020)</h2>
            <a href="/api/owner/pii-log/export.csv" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-bold">
              📥 تصدير CSV
            </a>
          </div>
          <div className="of-card overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead className="bg-[var(--surface-alt)] text-xs">
                <tr>
                  <th className="p-3">المنفّذ</th>
                  <th className="p-3">الإجراء</th>
                  <th className="p-3">العدد</th>
                  <th className="p-3">IP</th>
                  <th className="p-3">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {piiLogs.map((l) => (
                  <tr key={l.id}>
                    <td className="p-3 font-bold">{l.actorName || '—'} ({l.actorRole || '—'})</td>
                    <td className="p-3 font-mono-num text-xs" dir="ltr">{l.action}</td>
                    <td className="p-3 font-mono-num">{l.count}</td>
                    <td className="p-3 font-mono-num text-xs" dir="ltr">{l.ip || '—'}</td>
                    <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'tickets' && (
        <div className="space-y-3">
          {tickets.map((t) => (
            <div key={t.id} className="of-card p-5 space-y-3">
              <div className="flex justify-between gap-2">
                <div>
                  <div className="font-extrabold">#{t.id} — {t.subject}</div>
                  <div className="text-xs text-[var(--muted)]">{t.storeName} · {fmtDate(t.createdAt)}</div>
                </div>
                <span className="text-xs font-bold">{t.status}</span>
              </div>
              <p className="text-sm">{t.message}</p>
              {t.reply && <p className="text-xs text-emerald-700 font-bold">الرد السابق: {t.reply}</p>}
              <div className="flex gap-2">
                <input
                  className="of-input"
                  placeholder="اكتب ردك للتاجر..."
                  value={replyText[t.id] || ''}
                  onChange={(e) => setReplyText((prev) => ({ ...prev, [t.id]: e.target.value }))}
                />
                <button
                  type="button"
                  onClick={() => void runAction(async () => {
                    const reply = (replyText[t.id] || '').trim();
                    if (!reply) return;
                    await api.post(`/api/owner/tickets/${t.id}/reply`, { reply, status: 'resolved' });
                  }, 'تم إرسال الرد وإشعار التاجر ✓')}
                  className="rounded-xl bg-[#0C5CA4] px-4 text-xs font-bold text-white shrink-0"
                >
                  إرسال الرد
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'services' && (
        <div className="space-y-3">
          {services.map((s) => (
            <div key={s.id} className="of-card p-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="font-extrabold">#{s.id} — {s.serviceTitle || s.service_title}</div>
                <div className="text-xs text-[var(--muted)]">{s.storeName} · {s.refCode || s.ref_code} · الحالة: {s.status}</div>
                {s.notes && <p className="text-xs mt-1">{s.notes}</p>}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/owner/services/${s.id}/status`, { status: 'in_progress', adminNotes: 'تم البدء من لوحة المالك' }); }, 'تم تحديث الحالة')} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                  بدء التنفيذ
                </button>
                <button type="button" onClick={() => void runAction(async () => { await api.post(`/api/owner/services/${s.id}/status`, { status: 'completed', adminNotes: 'تم الإنجاز بنجاح' }); }, 'تم تحديد الطلب كمكتمل ✓')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
                  مكتمل
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'settings' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runAction(async () => { await api.put('/api/owner/settings', platSettings); }, 'تم حفظ إعدادات المنصة بنجاح ✓');
            }}
            className="of-card p-6 space-y-3"
          >
            <h2 className="font-extrabold text-base">إعدادات المنصة العامة</h2>
            <div>
              <label className="text-xs font-bold block mb-1">اسم المنصة</label>
              <input className="of-input" value={platSettings.platform_name || ''} onChange={(e) => setPlatSettings((p) => ({ ...p, platform_name: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الاسم القانوني</label>
              <input className="of-input" value={platSettings.platform_legal_name || ''} onChange={(e) => setPlatSettings((p) => ({ ...p, platform_legal_name: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الرقم الضريبي للمنصة</label>
              <input className="of-input" dir="ltr" value={platSettings.platform_tax_id || ''} onChange={(e) => setPlatSettings((p) => ({ ...p, platform_tax_id: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">مدة الاحتفاظ ببيانات المشترين PII (بالأيام)</label>
              <input type="number" className="of-input" value={platSettings.pii_retention_days || '30'} onChange={(e) => setPlatSettings((p) => ({ ...p, pii_retention_days: e.target.value }))} />
            </div>
            <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
              <input
                type="checkbox"
                checked={platSettings.require_client_approval === '1'}
                onChange={(e) => setPlatSettings((p) => ({ ...p, require_client_approval: e.target.checked ? '1' : '0' }))}
              />
              <span>إلزام موافقة الإدارة قبل تفعيل التجار الجدد</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
              <input
                type="checkbox"
                checked={platSettings.require_email_verification === '1'}
                onChange={(e) => setPlatSettings((p) => ({ ...p, require_email_verification: e.target.checked ? '1' : '0' }))}
              />
              <span>إلزام توثيق البريد الإلكتروني قبل الدفع والربط</span>
            </label>
            <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">حفظ الإعدادات</button>
          </form>

          <section className="of-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-extrabold text-base">النسخ الاحتياطي المشفّر</h2>
              <div className="flex gap-2">
                <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/backups/test-s3', {}); }, 'تم اختبار اتصال S3')} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                  اختبار S3
                </button>
                <button type="button" onClick={() => void runAction(async () => { await api.post('/api/owner/backup', {}); }, 'تم إنشاء نسخة احتياطية جديدة ✓')} className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white">
                  إنشاء نسخة الآن
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {backups.length === 0 ? (
                <p className="text-xs text-[var(--muted)]">لا توجد نسخ احتياطية محفوظة محليًا بعد.</p>
              ) : (
                backups.map((b, i) => (
                  <div key={b.filename || b.file || i} className="rounded-xl border border-[var(--border)] p-3 flex justify-between text-xs">
                    <span className="font-mono-num" dir="ltr">{b.filename || b.file}</span>
                    <span className="text-[var(--muted)]">{b.encrypted ? 'مشفّر ✓' : 'خام'} · {fmtDate(b.createdAt)}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {tab === 'audit' && (
        <div className="of-card overflow-x-auto">
          <table className="w-full text-sm text-right">
            <thead className="bg-[var(--surface-alt)] text-xs">
              <tr>
                <th className="p-3">المنفّذ</th>
                <th className="p-3">الدور</th>
                <th className="p-3">الإجراء</th>
                <th className="p-3">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="p-3 font-bold">{a.actorName}</td>
                  <td className="p-3 text-xs">{a.actorRole}</td>
                  <td className="p-3 font-mono-num text-xs" dir="ltr">{a.action}</td>
                  <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
