'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate } from '@/lib/format';

interface FieldSchema {
  name?: string;
  key?: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

interface PlatformSchema {
  key: string;
  name: string;
  fields: FieldSchema[];
}

interface MarketConn {
  platform: string;
  enabled: boolean;
  configured?: boolean;
  environment?: string;
  status?: string;
  lastSyncAt?: string | null;
  lastError?: string;
  masked?: Record<string, string>;
}

interface SyncRun {
  id: number;
  platform: string;
  status?: string;
  ordersNew?: number;
  ordersUpdated?: number;
  importedOrders?: number;
  updatedProducts?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string | null;
}

interface OutboxItem {
  id: number;
  platform: string;
  sku: string;
  stock: number;
  status: string;
  attempts: number;
  lastError?: string;
  updatedAt?: string;
}

interface CourierConn {
  courier: string;
  enabled: boolean;
  configured?: boolean;
  environment?: string;
  status?: string;
  lastError?: string;
  masked?: Record<string, string>;
}

const DEFAULT_MARKETS: PlatformSchema[] = [
  {
    key: 'a',
    name: 'أمازون مصر (SP-API)',
    fields: [
      { name: 'clientId', label: 'LWA Client ID', required: true },
      { name: 'clientSecret', label: 'LWA Client Secret', required: true, secret: true },
      { name: 'refreshToken', label: 'Refresh Token', required: true, secret: true },
      { name: 'sellerId', label: 'Seller ID', required: false },
      { name: 'marketplaceId', label: 'Marketplace ID', placeholder: 'ARBP9OOSHTCHU' }
    ]
  },
  {
    key: 'n',
    name: 'نون (Noon Partners)',
    fields: [
      { name: 'projectCode', label: 'Project Code', required: true },
      { name: 'keyId', label: 'Key ID', required: true },
      { name: 'privateKeyPem', label: 'Private Key (PEM)', required: true, secret: true }
    ]
  },
  {
    key: 'j',
    name: 'جوميا (Seller Center)',
    fields: [
      { name: 'clientId', label: 'OAuth Client ID', required: true },
      { name: 'clientSecret', label: 'OAuth Client Secret', required: true, secret: true },
      { name: 'refreshToken', label: 'Refresh Token', required: true, secret: true }
    ]
  },
  {
    key: 't',
    name: 'ترينديول (Trendyol)',
    fields: [
      { name: 'supplierId', label: 'Supplier ID', required: true },
      { name: 'apiKey', label: 'API Key', required: true },
      { name: 'apiSecret', label: 'API Secret', required: true, secret: true }
    ]
  },
  {
    key: 'k',
    name: 'كنز (Kenzz)',
    fields: [
      { name: 'merchantId', label: 'Merchant ID', required: true },
      { name: 'apiKey', label: 'API Key', required: true, secret: true }
    ]
  }
];

const DEFAULT_COURIERS: PlatformSchema[] = [
  {
    key: 'bosta',
    name: 'بوسطة (Bosta API)',
    fields: [{ name: 'apiKey', label: 'Bosta API Key', required: true, secret: true }]
  },
  {
    key: 'aramex',
    name: 'أرامكس (Aramex Shipping API)',
    fields: [
      { name: 'userName', label: 'Aramex UserName (Email)', required: true },
      { name: 'password', label: 'Password', required: true, secret: true },
      { name: 'accountNumber', label: 'Account Number', required: true },
      { name: 'accountPin', label: 'Account PIN', required: true, secret: true },
      { name: 'accountEntity', label: 'Account Entity', placeholder: 'CAI' },
      { name: 'accountCountryCode', label: 'Country Code', placeholder: 'EG' }
    ]
  },
  {
    key: 'mylerz',
    name: 'مايلرز (Mylerz Shipping API)',
    fields: [
      { name: 'username', label: 'Mylerz Username', required: true },
      { name: 'password', label: 'Mylerz Password', required: true, secret: true },
      { name: 'warehouseName', label: 'Warehouse Name', placeholder: 'Main' }
    ]
  }
];

function fieldIdOf(f: FieldSchema): string {
  return String(f.name || f.key || '');
}

function normalizeSchemaList(
  raw: Record<string, { name?: string; label?: string; fields?: FieldSchema[] }> | PlatformSchema[] | undefined,
  fallback: PlatformSchema[]
): PlatformSchema[] {
  if (!raw) return fallback;
  if (Array.isArray(raw)) {
    return raw.map((item) => ({
      key: item.key,
      name: item.name || fallback.find((x) => x.key === item.key)?.name || item.key,
      fields: (item.fields || []).filter((f) => Boolean(fieldIdOf(f)))
    }));
  }
  const entries = Object.entries(raw).map(([k, v]) => ({
    key: k,
    name: v.label || v.name || fallback.find((x) => x.key === k)?.name || k,
    fields: (v.fields && v.fields.length ? v.fields : fallback.find((x) => x.key === k)?.fields || []).filter((f) => Boolean(fieldIdOf(f)))
  }));
  return entries.length ? entries : fallback;
}

export default function IntegrationsPage() {
  const { data: boot } = useBootstrap();
  const [schemas, setSchemas] = useState<PlatformSchema[]>(DEFAULT_MARKETS);
  const [courierSchemas, setCourierSchemas] = useState<PlatformSchema[]>(DEFAULT_COURIERS);
  const [connections, setConnections] = useState<MarketConn[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [selected, setSelected] = useState('a');
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('production');
  const [creds, setCreds] = useState<Record<string, string>>({});

  const [courierConns, setCourierConns] = useState<CourierConn[]>([]);
  const [selectedCourier, setSelectedCourier] = useState('bosta');
  const [courierEnv, setCourierEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [courierCreds, setCourierCreds] = useState<Record<string, string>>({});

  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadAll() {
    try {
      const [mRes, cRes, oRes] = await Promise.all([
        api.get<{
          schemas?: Record<string, { name?: string; label?: string; fields?: FieldSchema[] }> | PlatformSchema[];
          connections?: MarketConn[];
          syncRuns?: SyncRun[];
        }>('/api/integrations/connections'),
        api.get<{
          schemas?: Record<string, { name?: string; label?: string; fields?: FieldSchema[] }> | PlatformSchema[];
          connections?: CourierConn[];
        }>('/api/couriers/connections').catch(() => ({ schemas: undefined, connections: [] })),
        api.get<{ items?: OutboxItem[] }>('/api/integrations/outbox').catch(() => ({ items: [] }))
      ]);
      setSchemas(normalizeSchemaList(mRes.schemas, DEFAULT_MARKETS));
      setCourierSchemas(normalizeSchemaList(cRes.schemas, DEFAULT_COURIERS));
      setConnections(mRes.connections || []);
      setSyncRuns(mRes.syncRuns || []);
      setCourierConns(cRes.connections || []);
      setOutbox(oRes.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات الربط');
    }
  }

  useEffect(() => {
    if (boot?.me) {
      void loadAll();
      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search);
        if (sp.get('amazon_oauth') === 'ok') {
          setNotice('تم ربط حساب أمازون مصر عبر OAuth بنجاح ✓');
        } else if (sp.get('amazon_oauth') === 'error') {
          setError('تعذر إكمال ربط أمازون عبر OAuth، تحقق من الإعدادات وحاول مجددًا.');
        }
      }
    }
  }, [boot?.me]);

  const activeSchema = schemas.find((s) => s.key === selected) || schemas[0] || DEFAULT_MARKETS[0];
  const activeMarketConn = connections.find((c) => c.platform === selected);
  const activeCourierSchema = courierSchemas.find((s) => s.key === selectedCourier) || courierSchemas[0] || DEFAULT_COURIERS[0];
  const activeCourierConn = courierConns.find((c) => c.courier === selectedCourier);

  async function saveMarketplace(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.put(`/api/integrations/connections/${selected}`, {
        enabled: true,
        environment,
        credentials: creds
      });
      setNotice('تم حفظ وتشفير بيانات ربط السوق بنجاح ✓');
      setCreds({});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الربط');
    }
  }

  async function testMarket(key: string) {
    setNotice('');
    setError('');
    try {
      const r = await api.post<{ ok?: boolean; message?: string; error?: string }>(`/api/integrations/connections/${key}/test`, {});
      if (r.ok) setNotice(r.message || 'نجح اختبار الاتصال بالسوق ✓');
      else setError(r.error || r.message || 'فشل اختبار الاتصال');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر اختبار الاتصال');
    }
  }

  async function syncMarket(key: string) {
    setNotice('');
    setError('');
    try {
      const r = await api.post<{ ordersNew?: number; ordersUpdated?: number; importedOrders?: number; updatedProducts?: number; message?: string }>(`/api/integrations/connections/${key}/sync`, {});
      const added = r.ordersNew ?? r.importedOrders ?? 0;
      const updated = r.ordersUpdated ?? r.updatedProducts ?? 0;
      setNotice(r.message || `تمت المزامنة: ${added} طلب جديد و ${updated} تحديث`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذرت المزامنة');
    }
  }

  async function removeMarket(key: string) {
    setNotice('');
    setError('');
    try {
      await api.del(`/api/integrations/connections/${key}`);
      setNotice('تم فصل الربط وحذف المفاتيح المشفّرة بنجاح');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر فصل الربط');
    }
  }

  async function processOutboxNow() {
    setNotice('');
    setError('');
    try {
      const r = await api.post<{ processed?: number; synced?: number }>('/api/integrations/outbox/process', {});
      setNotice(`تمت معالجة طابور دفع المخزون (${r.synced ?? r.processed ?? 0} عملية)`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر معالجة طابور المزامنة');
    }
  }

  async function saveCourier(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.put(`/api/couriers/connections/${selectedCourier}`, {
        enabled: true,
        environment: courierEnv,
        credentials: courierCreds
      });
      setNotice('تم حفظ وتشفير بيانات شركة الشحن بنجاح ✓');
      setCourierCreds({});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ بيانات شركة الشحن');
    }
  }

  async function testCourier(key: string) {
    setNotice('');
    setError('');
    try {
      const r = await api.post<{ ok?: boolean; message?: string; error?: string }>(`/api/couriers/connections/${key}/test`, {});
      if (r.ok) setNotice(r.message || 'نجح اختبار الاتصال بشركة الشحن ✓');
      else setError(r.error || r.message || 'فشل اختبار الاتصال بشركة الشحن');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر اختبار الاتصال');
    }
  }

  async function removeCourier(key: string) {
    setNotice('');
    setError('');
    try {
      await api.del(`/api/couriers/connections/${key}`);
      setNotice('تم فصل شركة الشحن بنجاح');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر فصل شركة الشحن');
    }
  }

  return (
    <AppShell title="ربط المنصات وشركات الشحن" subtitle="أمازون، نون، جوميا، ترينديول، كنز + بوسطة وأرامكس ومايلرز بتشفير AES-256-GCM" user={boot?.me}>
      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-extrabold text-base">الأسواق الإلكترونية (Marketplaces)</h2>
            <a
              href="/api/integrations/amazon/oauth/start"
              className="rounded-lg border border-[#0C5CA4]/40 px-2.5 py-1 text-[11px] font-bold text-[var(--primary)] hover:bg-[#0C5CA4]/10"
            >
              ربط أمازون بنقرة (OAuth)
            </a>
          </div>
          {schemas.map((m) => {
            const c = connections.find((x) => x.platform === m.key);
            return (
              <div key={m.key} className="rounded-xl border border-[var(--border)] p-4 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-sm flex items-center gap-2">
                      <span>{m.name}</span>
                      {c?.status && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${c.status === 'connected' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : c.status === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-[var(--surface-alt)] text-[var(--muted)]'}`}>
                          {c.status === 'connected' ? 'متصل' : c.status === 'error' ? 'خطأ' : 'غير متصل'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--muted)]">
                      {c?.enabled ? `مفعّل (${c.environment || 'production'})` : 'غير متصل بعد'}
                      {c?.lastSyncAt ? ` · آخر مزامنة: ${fmtDate(c.lastSyncAt)}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setSelected(m.key); setCreds({}); }}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold"
                    >
                      إعداد
                    </button>
                    {c?.enabled && (
                      <>
                        <button type="button" onClick={() => void testMarket(m.key)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold">
                          اختبار
                        </button>
                        <button type="button" onClick={() => void syncMarket(m.key)} className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white">
                          مزامنة
                        </button>
                        <button type="button" onClick={() => void removeMarket(m.key)} className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-bold text-rose-600">
                          فصل
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {c?.lastError && (
                  <p className="text-[11px] text-[var(--danger)] break-words">آخر خطأ: {c.lastError}</p>
                )}
              </div>
            );
          })}
        </section>

        <form onSubmit={saveMarketplace} className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">إعداد مفاتيح: {activeSchema.name}</h2>
          <p className="text-xs text-[var(--muted)]">تُحفظ المفاتيح مشفّرة بالكامل (AES-256-GCM) ولا تُعرض صريحة بعد الحفظ.</p>
          <div className="space-y-1">
            <label className="text-xs font-bold block">بيئة التشغيل</label>
            <select
              className="of-input"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as 'sandbox' | 'production')}
            >
              <option value="production">إنتاج فعلي (Production)</option>
              <option value="sandbox">بيئة اختبار (Sandbox)</option>
            </select>
          </div>
          {activeSchema.fields.map((f) => {
            const key = fieldIdOf(f);
            const maskedHint = activeMarketConn?.masked?.[key];
            return (
              <div key={key} className="space-y-1">
                <label className="text-xs font-bold block">
                  {f.label} {maskedHint ? <span className="font-mono-num text-[10px] text-[var(--muted)]" dir="ltr">(محفوظ: {maskedHint})</span> : null}
                </label>
                <input
                  type={f.secret ? 'password' : 'text'}
                  className="of-input"
                  dir="ltr"
                  placeholder={f.placeholder || (maskedHint ? 'اتركه فارغًا للإبقاء على القيمة المحفوظة' : '')}
                  value={creds[key] || ''}
                  onChange={(e) => setCreds((prev) => ({ ...prev, [key]: e.target.value }))}
                  required={Boolean(f.required) && !maskedHint}
                />
              </div>
            );
          })}
          <button type="submit" className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white">
            حفظ وتشفير بيانات السوق
          </button>
        </form>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">ربط شركات الشحن (Bosta · Aramex · Mylerz)</h2>
          {courierSchemas.map((cs) => {
            const c = courierConns.find((x) => x.courier === cs.key);
            return (
              <div key={cs.key} className="rounded-xl border border-[var(--border)] p-4 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-sm">{cs.name}</div>
                    <div className="text-xs text-[var(--muted)]">
                      {c?.enabled ? `متصل (${c.environment || 'sandbox'})` : 'غير متصل بعد'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setSelectedCourier(cs.key); setCourierCreds({}); }}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold"
                    >
                      إعداد
                    </button>
                    {c?.enabled && (
                      <>
                        <button type="button" onClick={() => void testCourier(cs.key)} className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white">
                          اختبار الاتصال
                        </button>
                        <button type="button" onClick={() => void removeCourier(cs.key)} className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-bold text-rose-600">
                          فصل
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {c?.lastError && <p className="text-[11px] text-[var(--danger)]">{c.lastError}</p>}
              </div>
            );
          })}
        </section>

        <form onSubmit={saveCourier} className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">إعداد شركة الشحن: {activeCourierSchema.name}</h2>
          <div className="space-y-1">
            <label className="text-xs font-bold block">بيئة الشحن</label>
            <select
              className="of-input"
              value={courierEnv}
              onChange={(e) => setCourierEnv(e.target.value as 'sandbox' | 'production')}
            >
              <option value="sandbox">بيئة اختبار (Sandbox)</option>
              <option value="production">إنتاج فعلي (Production)</option>
            </select>
          </div>
          {activeCourierSchema.fields.map((f) => {
            const key = fieldIdOf(f);
            const maskedHint = activeCourierConn?.masked?.[key];
            return (
              <div key={key} className="space-y-1">
                <label className="text-xs font-bold block">
                  {f.label} {maskedHint ? <span className="font-mono-num text-[10px] text-[var(--muted)]" dir="ltr">(محفوظ: {maskedHint})</span> : null}
                </label>
                <input
                  type={f.secret ? 'password' : 'text'}
                  className="of-input"
                  dir="ltr"
                  placeholder={f.placeholder || ''}
                  value={courierCreds[key] || ''}
                  onChange={(e) => setCourierCreds((prev) => ({ ...prev, [key]: e.target.value }))}
                  required={Boolean(f.required) && !maskedHint}
                />
              </div>
            );
          })}
          <button type="submit" className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white">
            حفظ وتشفير مفاتيح الشحن
          </button>
        </form>
      </div>

      {outbox.length > 0 && (
        <section className="of-card overflow-x-auto mb-6">
          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-2">
            <strong className="text-sm">طابور دفع المخزون للأسواق (Stock Sync Outbox)</strong>
            <button type="button" onClick={() => void processOutboxNow()} className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white">
              تشغيل المزامنة الآن
            </button>
          </div>
          <table className="w-full text-sm text-right">
            <thead className="bg-[var(--surface-alt)] text-xs">
              <tr>
                <th className="p-3">السوق</th>
                <th className="p-3">SKU</th>
                <th className="p-3">الكمية</th>
                <th className="p-3">الحالة</th>
                <th className="p-3">المحاولات</th>
                <th className="p-3">ملاحظة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {outbox.slice(0, 15).map((item) => (
                <tr key={item.id}>
                  <td className="p-3 font-bold">{schemas.find((s) => s.key === item.platform)?.name || item.platform}</td>
                  <td className="p-3 font-mono-num text-xs" dir="ltr">{item.sku}</td>
                  <td className="p-3 font-mono-num font-bold">{item.stock}</td>
                  <td className="p-3 text-xs font-bold">{item.status}</td>
                  <td className="p-3 font-mono-num">{item.attempts}</td>
                  <td className="p-3 text-xs text-[var(--muted)]">{item.lastError || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {syncRuns.length > 0 && (
        <section className="of-card overflow-x-auto">
          <div className="p-4 border-b border-[var(--border)] font-extrabold text-sm">سجل عمليات المزامنة الأخيرة</div>
          <table className="w-full text-sm text-right">
            <thead className="bg-[var(--surface-alt)] text-xs">
              <tr>
                <th className="p-3">السوق</th>
                <th className="p-3">الحالة</th>
                <th className="p-3">طلبات جديدة</th>
                <th className="p-3">تحديثات</th>
                <th className="p-3">التفاصيل / الخطأ</th>
                <th className="p-3">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {syncRuns.slice(0, 15).map((r) => {
                const derivedStatus = r.status || (r.error ? 'فشل' : r.finishedAt ? 'مكتمل ✓' : 'جارٍ التنفيذ');
                const newCount = r.ordersNew ?? r.importedOrders ?? 0;
                const updCount = r.ordersUpdated ?? r.updatedProducts ?? 0;
                return (
                  <tr key={r.id}>
                    <td className="p-3 font-bold">{schemas.find((s) => s.key === r.platform)?.name || r.platform}</td>
                    <td className={`p-3 text-xs font-bold ${r.error ? 'text-rose-600' : 'text-emerald-700'}`}>{derivedStatus}</td>
                    <td className="p-3 font-mono-num">{newCount}</td>
                    <td className="p-3 font-mono-num">{updCount}</td>
                    <td className="p-3 text-xs text-[var(--muted)] max-w-xs truncate" title={r.error || ''}>{r.error || '—'}</td>
                    <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(r.startedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </AppShell>
  );
}
