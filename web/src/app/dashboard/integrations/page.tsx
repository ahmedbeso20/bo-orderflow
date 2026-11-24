'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate } from '@/lib/format';

interface FieldSchema {
  key: string;
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
  environment?: string;
  status?: string;
  lastSyncAt?: string | null;
  lastError?: string;
}

interface SyncRun {
  id: number;
  platform: string;
  status: string;
  importedOrders: number;
  updatedProducts: number;
  error?: string;
  startedAt: string;
}

interface CourierConn {
  courier: string;
  enabled: boolean;
  environment?: string;
  status?: string;
  lastError?: string;
}

const DEFAULT_MARKETS: PlatformSchema[] = [
  {
    key: 'a',
    name: 'أمازون مصر (SP-API)',
    fields: [
      { key: 'sellerId', label: 'Seller ID', required: true },
      { key: 'clientId', label: 'LWA Client ID', required: true },
      { key: 'clientSecret', label: 'LWA Client Secret', required: true, secret: true },
      { key: 'refreshToken', label: 'Refresh Token', required: true, secret: true },
      { key: 'marketplaceId', label: 'Marketplace ID', placeholder: 'ARBP9OOSHTCHU' }
    ]
  },
  {
    key: 'n',
    name: 'نون (Noon Partners)',
    fields: [
      { key: 'partnerKey', label: 'Partner Key', required: true },
      { key: 'projectCode', label: 'Project Code', required: true },
      { key: 'apiKey', label: 'API Key / Secret', required: true, secret: true }
    ]
  },
  {
    key: 'j',
    name: 'جوميا (Seller Center)',
    fields: [
      { key: 'shopId', label: 'Shop / User ID', required: true },
      { key: 'apiKey', label: 'API Key', required: true, secret: true }
    ]
  },
  {
    key: 't',
    name: 'ترينديول (Trendyol)',
    fields: [
      { key: 'supplierId', label: 'Supplier ID', required: true },
      { key: 'apiKey', label: 'API Key', required: true },
      { key: 'apiSecret', label: 'API Secret', required: true, secret: true }
    ]
  },
  {
    key: 'k',
    name: 'كنز (Kenzz)',
    fields: [
      { key: 'merchantId', label: 'Merchant ID', required: true },
      { key: 'apiKey', label: 'API Key', required: true, secret: true }
    ]
  }
];

const COURIER_SCHEMAS: PlatformSchema[] = [
  {
    key: 'bosta',
    name: 'بوسطة (Bosta API)',
    fields: [{ key: 'apiKey', label: 'Bosta API Key', required: true, secret: true }]
  },
  {
    key: 'aramex',
    name: 'أرامكس (Aramex Shipping API)',
    fields: [
      { key: 'username', label: 'Username', required: true },
      { key: 'password', label: 'Password', required: true, secret: true },
      { key: 'accountNumber', label: 'Account Number', required: true },
      { key: 'accountPin', label: 'Account PIN', required: true, secret: true },
      { key: 'accountEntity', label: 'Account Entity', placeholder: 'CAI' },
      { key: 'accountCountryCode', label: 'Country Code', placeholder: 'EG' }
    ]
  }
];

export default function IntegrationsPage() {
  const { data: boot } = useBootstrap();
  const [schemas, setSchemas] = useState<PlatformSchema[]>(DEFAULT_MARKETS);
  const [connections, setConnections] = useState<MarketConn[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
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
      const [mRes, cRes] = await Promise.all([
        api.get<{ schemas?: Record<string, { name?: string; fields?: FieldSchema[] }> | PlatformSchema[]; connections?: MarketConn[]; syncRuns?: SyncRun[] }>('/api/integrations/connections'),
        api.get<{ connections?: CourierConn[] }>('/api/couriers/connections').catch(() => ({ connections: [] }))
      ]);
      if (mRes.schemas) {
        if (Array.isArray(mRes.schemas)) {
          setSchemas(mRes.schemas);
        } else {
          const list: PlatformSchema[] = Object.entries(mRes.schemas).map(([k, v]) => ({
            key: k,
            name: v.name || DEFAULT_MARKETS.find((x) => x.key === k)?.name || k,
            fields: v.fields || DEFAULT_MARKETS.find((x) => x.key === k)?.fields || []
          }));
          if (list.length > 0) setSchemas(list);
        }
      }
      setConnections(mRes.connections || []);
      setSyncRuns(mRes.syncRuns || []);
      setCourierConns(cRes.connections || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات الربط');
    }
  }

  useEffect(() => {
    if (boot?.me) void loadAll();
  }, [boot?.me]);

  const activeSchema = schemas.find((s) => s.key === selected) || DEFAULT_MARKETS[0];
  const activeCourierSchema = COURIER_SCHEMAS.find((s) => s.key === selectedCourier) || COURIER_SCHEMAS[0];

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
      setNotice('تم حفظ وتشفير بيانات ربط السوق بنجاح');
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر اختبار الاتصال');
    }
  }

  async function syncMarket(key: string) {
    setNotice('');
    setError('');
    try {
      const r = await api.post<{ importedOrders?: number; updatedProducts?: number; message?: string }>(`/api/integrations/connections/${key}/sync`, {});
      setNotice(r.message || `تمت المزامنة: ${r.importedOrders ?? 0} طلب مستورد و ${r.updatedProducts ?? 0} منتج محدّث`);
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
      setNotice('تم حفظ وتشفير بيانات شركة الشحن بنجاح');
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
    <AppShell title="ربط المنصات وشركات الشحن" subtitle="أمازون، نون، جوميا، ترينديول، كنز + بوسطة وأرامكس بتشفير AES-256-GCM" user={boot?.me}>
      {notice && <p className="mb-4 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">الأسواق الإلكترونية (Marketplaces)</h2>
          {schemas.map((m) => {
            const c = connections.find((x) => x.platform === m.key);
            return (
              <div key={m.key} className="rounded-xl border border-[var(--border)] p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-bold text-sm">{m.name}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {c?.enabled ? `متصل (${c.environment || 'production'})` : 'غير متصل بعد'}
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
            );
          })}
        </section>

        <form onSubmit={saveMarketplace} className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">إعداد مفاتيح: {activeSchema.name}</h2>
          <p className="text-xs text-[var(--muted)]">تُحفظ المفاتيح مشفّرة بالكامل ولا تُعرض مجددًا بعد الحفظ.</p>
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
          {activeSchema.fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-xs font-bold block">{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                className="of-input"
                dir="ltr"
                placeholder={f.placeholder || ''}
                value={creds[f.key] || ''}
                onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                required={Boolean(f.required)}
              />
            </div>
          ))}
          <button type="submit" className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white">
            حفظ وتشفير بيانات السوق
          </button>
        </form>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">ربط شركات الشحن (Bosta & Aramex)</h2>
          {COURIER_SCHEMAS.map((cs) => {
            const c = courierConns.find((x) => x.courier === cs.key);
            return (
              <div key={cs.key} className="rounded-xl border border-[var(--border)] p-4 flex flex-wrap items-center justify-between gap-3">
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
          {activeCourierSchema.fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-xs font-bold block">{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                className="of-input"
                dir="ltr"
                placeholder={f.placeholder || ''}
                value={courierCreds[f.key] || ''}
                onChange={(e) => setCourierCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                required={Boolean(f.required)}
              />
            </div>
          ))}
          <button type="submit" className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white">
            حفظ وتشفير مفاتيح الشحن
          </button>
        </form>
      </div>

      {syncRuns.length > 0 && (
        <section className="of-card overflow-x-auto">
          <div className="p-4 border-b border-[var(--border)] font-extrabold text-sm">سجل عمليات المزامنة الأخيرة</div>
          <table className="w-full text-sm text-right">
            <thead className="bg-[var(--surface-alt)] text-xs">
              <tr>
                <th className="p-3">السوق</th>
                <th className="p-3">الحالة</th>
                <th className="p-3">طلبات مستوردة</th>
                <th className="p-3">منتجات محدّثة</th>
                <th className="p-3">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {syncRuns.slice(0, 15).map((r) => (
                <tr key={r.id}>
                  <td className="p-3 font-bold">{schemas.find((s) => s.key === r.platform)?.name || r.platform}</td>
                  <td className="p-3 text-xs font-bold">{r.status}</td>
                  <td className="p-3 font-mono-num">{r.importedOrders}</td>
                  <td className="p-3 font-mono-num">{r.updatedProducts}</td>
                  <td className="p-3 text-xs text-[var(--muted)]">{fmtDate(r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </AppShell>
  );
}
