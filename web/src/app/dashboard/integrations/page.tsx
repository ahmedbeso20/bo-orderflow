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
  multiline?: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface PlatformSchema {
  key: string;
  name: string;
  docsHint?: string;
  authMethod?: string;
  fields: FieldSchema[];
}

type MaskedFieldVal = string | { configured?: boolean; masked?: string };

interface MarketConn {
  platform: string;
  enabled: boolean;
  configured?: boolean;
  environment?: string;
  status?: string;
  lastSyncAt?: string | null;
  lastError?: string;
  masked?: Record<string, MaskedFieldVal>;
  maskedCredentials?: Record<string, MaskedFieldVal>;
}

interface SyncRun {
  id: number;
  platform: string;
  platformName?: string;
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
  platformName?: string;
  sku: string;
  qty?: number;
  stock?: number;
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
  masked?: Record<string, MaskedFieldVal>;
  maskedCredentials?: Record<string, MaskedFieldVal>;
}

const DEFAULT_MARKETS: PlatformSchema[] = [
  {
    key: 'a',
    name: 'أمازون مصر (Amazon SP-API)',
    fields: [
      { name: 'sellerId', label: 'معرّف البائع (Seller ID)', required: true },
      { name: 'marketplaceId', label: 'معرّف سوق مصر (Marketplace ID)', placeholder: 'ARBP9OOSHTCHU', defaultValue: 'ARBP9OOSHTCHU' },
      { name: 'clientId', label: 'LWA Client ID', required: true },
      { name: 'clientSecret', label: 'LWA Client Secret', required: true, secret: true },
      { name: 'refreshToken', label: 'LWA Refresh Token', required: true, secret: true }
    ]
  },
  {
    key: 'n',
    name: 'نون مصر والخليج (Noon Partners API)',
    fields: [
      { name: 'projectCode', label: 'كود المشروع (Project Code)', required: true },
      { name: 'keyId', label: 'معرّف المفتاح (Key ID)', required: true },
      { name: 'privateKey', label: 'المفتاح الخاص (Private Key PEM أو JSON Key)', required: true, secret: true, multiline: true },
      { name: 'baseUrl', label: 'رابط البوابة (اختياري)', placeholder: 'https://noon-api-gateway.noon.partners', defaultValue: 'https://noon-api-gateway.noon.partners' }
    ]
  },
  {
    key: 'j',
    name: 'جوميا مصر (Jumia Vendor Center API)',
    fields: [
      { name: 'shopId', label: 'معرّف المتجر (Shop ID — اختياري، يُكتشف تلقائيًا)', required: false },
      { name: 'clientId', label: 'معرّف التطبيق (Client ID)', required: true },
      { name: 'apiKey', label: 'رمز التحديث (OAuth2 Refresh Token)', required: true, secret: true },
      { name: 'baseUrl', label: 'رابط Jumia API (اختياري)', placeholder: 'https://vendor-api.jumia.com', defaultValue: 'https://vendor-api.jumia.com' }
    ]
  },
  {
    key: 't',
    name: 'ترينديول (Trendyol Supplier API v2)',
    fields: [
      { name: 'supplierId', label: 'معرّف المورّد (Supplier ID)', required: true },
      { name: 'apiKey', label: 'مفتاح الربط (API Key)', required: true, secret: true },
      { name: 'apiSecret', label: 'الرمز السري (API Secret)', required: true, secret: true },
      { name: 'storeFrontCode', label: 'كود الدولة / السوق (storeFrontCode)', placeholder: 'EG', defaultValue: 'EG' }
    ]
  },
  {
    key: 'k',
    name: 'كنز مصر (Kenzz Partner API)',
    fields: [
      { name: 'storeId', label: 'معرّف المتجر (Store ID)', required: true },
      { name: 'apiKey', label: 'مفتاح الربط (Partner API Key)', required: true, secret: true },
      { name: 'apiSecret', label: 'الرمز السري (API Secret — اختياري)', required: false, secret: true },
      { name: 'baseUrl', label: 'رابط Kenzz API (اختياري)', placeholder: 'https://partners-api.kenzz.com/v1', defaultValue: 'https://partners-api.kenzz.com/v1' }
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
      { name: 'accountEntity', label: 'Account Entity', placeholder: 'CAI', defaultValue: 'CAI' },
      { name: 'accountCountryCode', label: 'Country Code', placeholder: 'EG', defaultValue: 'EG' }
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
  raw: Record<string, { name?: string; label?: string; docsHint?: string; authMethod?: string; fields?: FieldSchema[] }> | PlatformSchema[] | undefined,
  fallback: PlatformSchema[]
): PlatformSchema[] {
  if (!raw) return fallback;
  if (Array.isArray(raw)) {
    return raw.map((item) => ({
      key: item.key,
      name: item.name || fallback.find((x) => x.key === item.key)?.name || item.key,
      docsHint: item.docsHint || fallback.find((x) => x.key === item.key)?.docsHint,
      authMethod: item.authMethod || fallback.find((x) => x.key === item.key)?.authMethod,
      fields: (item.fields || []).filter((f) => Boolean(fieldIdOf(f)))
    }));
  }
  const entries = Object.entries(raw).map(([k, v]) => {
    const fb = fallback.find((x) => x.key === k);
    return {
      key: k,
      name: v.label || v.name || fb?.name || k,
      docsHint: v.docsHint || fb?.docsHint,
      authMethod: v.authMethod || fb?.authMethod,
      fields: (v.fields && v.fields.length ? v.fields : fb?.fields || []).filter((f) => Boolean(fieldIdOf(f)))
    };
  });
  return entries.length ? entries : fallback;
}

function getMaskedMap(conn?: { masked?: Record<string, MaskedFieldVal>; maskedCredentials?: Record<string, MaskedFieldVal> }) {
  return conn?.maskedCredentials || conn?.masked;
}

function getSecretStatus(conn: { masked?: Record<string, MaskedFieldVal>; maskedCredentials?: Record<string, MaskedFieldVal> } | undefined, key: string) {
  const raw = getMaskedMap(conn)?.[key];
  if (!raw) return { configured: false, masked: '' };
  if (typeof raw === 'string') return { configured: Boolean(raw), masked: raw };
  return { configured: Boolean(raw.configured), masked: raw.masked || '' };
}

function buildInitialCreds(
  schema: PlatformSchema,
  conn?: { masked?: Record<string, MaskedFieldVal>; maskedCredentials?: Record<string, MaskedFieldVal> }
): Record<string, string> {
  const map = getMaskedMap(conn);
  const out: Record<string, string> = {};
  for (const f of schema.fields) {
    const k = fieldIdOf(f);
    if (!k) continue;
    if (f.secret) {
      out[k] = '';
    } else {
      const saved = map?.[k];
      out[k] = typeof saved === 'string' && saved ? saved : (f.defaultValue || '');
    }
  }
  return out;
}

export default function IntegrationsPage() {
  const { data: boot, reload } = useBootstrap();
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
  const [courierEnv, setCourierEnv] = useState<'sandbox' | 'production'>('production');
  const [courierCreds, setCourierCreds] = useState<Record<string, string>>({});

  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function loadAll() {
    try {
      const [mRes, cRes, oRes] = await Promise.all([
        api.get<{
          schemas?: Record<string, { name?: string; label?: string; docsHint?: string; authMethod?: string; fields?: FieldSchema[] }> | PlatformSchema[];
          connections?: MarketConn[];
          syncRuns?: SyncRun[];
        }>('/api/integrations/connections'),
        api.get<{
          schemas?: Record<string, { name?: string; label?: string; fields?: FieldSchema[] }> | PlatformSchema[];
          connections?: CourierConn[];
        }>('/api/couriers/connections').catch(() => ({ schemas: undefined, connections: [] })),
        api.get<{ items?: OutboxItem[] }>('/api/integrations/outbox').catch(() => ({ items: [] }))
      ]);
      const nextMarkets = normalizeSchemaList(mRes.schemas, DEFAULT_MARKETS);
      const nextCouriers = normalizeSchemaList(cRes.schemas, DEFAULT_COURIERS);
      setSchemas(nextMarkets);
      setCourierSchemas(nextCouriers);
      const nextConns = mRes.connections || [];
      const nextCConns = cRes.connections || [];
      setConnections(nextConns);
      setSyncRuns(mRes.syncRuns || []);
      setCourierConns(nextCConns);
      setOutbox(oRes.items || []);

      const curSchema = nextMarkets.find((s) => s.key === selected) || nextMarkets[0];
      const curConn = nextConns.find((c) => c.platform === curSchema.key);
      setCreds((prev) => (Object.keys(prev).length ? prev : buildInitialCreds(curSchema, curConn)));

      const curCSchema = nextCouriers.find((s) => s.key === selectedCourier) || nextCouriers[0];
      const curCConn = nextCConns.find((c) => c.courier === curCSchema.key);
      setCourierCreds((prev) => (Object.keys(prev).length ? prev : buildInitialCreds(curCSchema, curCConn)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل بيانات الربط');
    }
  }

  useEffect(() => {
    if (boot?.me) {
      void loadAll();
      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search);
        if (sp.get('amazon') === 'connected' || sp.get('amazon_oauth') === 'ok') {
          setNotice('تم ربط حساب أمازون مصر عبر OAuth بنجاح ✓');
        } else if (sp.get('amazon_oauth') === 'error') {
          setError('تعذر إكمال ربط أمازون عبر OAuth، تحقق من الإعدادات وحاول مجددًا.');
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot?.me]);

  const activeSchema = schemas.find((s) => s.key === selected) || schemas[0] || DEFAULT_MARKETS[0];
  const activeMarketConn = connections.find((c) => c.platform === selected);
  const activeCourierSchema = courierSchemas.find((s) => s.key === selectedCourier) || courierSchemas[0] || DEFAULT_COURIERS[0];
  const activeCourierConn = courierConns.find((c) => c.courier === selectedCourier);

  function selectPlatform(key: string) {
    setSelected(key);
    const schema = schemas.find((s) => s.key === key) || schemas[0];
    const conn = connections.find((c) => c.platform === key);
    setEnvironment(conn?.environment === 'sandbox' ? 'sandbox' : 'production');
    setCreds(buildInitialCreds(schema, conn));
    setNotice('');
    setError('');
  }

  function selectCourier(key: string) {
    setSelectedCourier(key);
    const schema = courierSchemas.find((s) => s.key === key) || courierSchemas[0];
    const conn = courierConns.find((c) => c.courier === key);
    setCourierEnv(conn?.environment === 'sandbox' ? 'sandbox' : 'production');
    setCourierCreds(buildInitialCreds(schema, conn));
    setNotice('');
    setError('');
  }

  async function startAmazonOauth() {
    setNotice('');
    setError('');
    setBusyKey('amz-oauth');
    try {
      const r = await api.get<{ authUrl?: string }>('/api/integrations/amazon/oauth/start');
      if (r.authUrl) {
        window.location.assign(r.authUrl);
        return;
      }
      setError('تعذر توليد رابط تفويض أمازون');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر بدء ربط أمازون عبر OAuth');
    } finally {
      setBusyKey('');
    }
  }

  async function submitMarketplace(testAndSync: boolean) {
    setNotice('');
    setError('');
    setBusyKey(`save-market-${selected}`);
    try {
      const r = await api.put<{
        ok?: boolean;
        testResult?: { ok?: boolean; message?: string; error?: string } | null;
        syncResult?: {
          ok?: boolean;
          name?: string;
          importedProducts?: number;
          updatedProducts?: number;
          importedOrders?: number;
          error?: string;
        } | null;
        connections?: MarketConn[];
        syncRuns?: SyncRun[];
      }>(`/api/integrations/connections/${selected}`, {
        enabled: true,
        environment,
        credentials: creds,
        testNow: testAndSync,
        syncNow: testAndSync
      });
      if (r.connections) setConnections(r.connections);
      if (r.syncRuns) setSyncRuns(r.syncRuns);

      if (testAndSync) {
        if (r.testResult && !r.testResult.ok) {
          setError(`تم حفظ المفاتيح لكن فشل اختبار الاتصال: ${r.testResult.message || r.testResult.error || 'تأكد من صحة المفاتيح'}`);
        } else if (r.syncResult && r.syncResult.ok) {
          setNotice(
            `✓ تم الاتصال وسحب بيانات ${r.syncResult.name || activeSchema.name}: +${r.syncResult.importedProducts ?? 0} منتج جديد، ${r.syncResult.updatedProducts ?? 0} محدّث، +${r.syncResult.importedOrders ?? 0} طلب جديد.`
          );
          await reload();
        } else if (r.syncResult && !r.syncResult.ok) {
          setError(`نجح اختبار الاتصال لكن تعذّر السحب: ${r.syncResult.error || 'خطأ من سيرفر المنصة'}`);
        } else {
          setNotice(r.testResult?.message || 'تم حفظ واختبار بيانات السوق بنجاح ✓');
          await reload();
        }
      } else {
        setNotice('تم حفظ وتشفير بيانات ربط السوق بنجاح ✓');
      }
      const freshConn = (r.connections || []).find((c) => c.platform === selected);
      setCreds(buildInitialCreds(activeSchema, freshConn));
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الربط');
    } finally {
      setBusyKey('');
    }
  }

  async function saveMarketplace(e: React.FormEvent) {
    e.preventDefault();
    await submitMarketplace(true);
  }

  async function testMarket(key: string) {
    setNotice('');
    setError('');
    setBusyKey(`test-${key}`);
    try {
      const r = await api.post<{ ok?: boolean; message?: string; error?: string }>(`/api/integrations/connections/${key}/test`, {});
      if (r.ok) setNotice(r.message || 'نجح اختبار الاتصال بالسوق ✓');
      else setError(r.error || r.message || 'فشل اختبار الاتصال');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر اختبار الاتصال');
    } finally {
      setBusyKey('');
    }
  }

  async function syncMarket(key: string) {
    setNotice('');
    setError('');
    setBusyKey(`sync-${key}`);
    try {
      const r = await api.post<{
        ordersNew?: number;
        ordersUpdated?: number;
        importedProducts?: number;
        importedOrders?: number;
        updatedProducts?: number;
        message?: string;
      }>(`/api/integrations/connections/${key}/sync`, {});
      const added = r.ordersNew ?? r.importedOrders ?? 0;
      const updated = r.ordersUpdated ?? r.updatedProducts ?? 0;
      setNotice(r.message || `تمت المزامنة: +${r.importedProducts ?? 0} منتج و +${added} طلب و ${updated} تحديث`);
      await Promise.all([loadAll(), reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذرت المزامنة');
    } finally {
      setBusyKey('');
    }
  }

  async function syncAllMarkets() {
    setNotice('');
    setError('');
    setBusyKey('sync-all');
    try {
      const r = await api.post<{ message?: string }>('/api/sync', {});
      setNotice(r.message || 'تمت مزامنة جميع المنصات المربوطة بنجاح ✓');
      await Promise.all([loadAll(), reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذرت مزامنة المنصات');
    } finally {
      setBusyKey('');
    }
  }

  async function removeMarket(key: string) {
    setNotice('');
    setError('');
    setBusyKey(`del-${key}`);
    try {
      await api.del(`/api/integrations/connections/${key}`);
      setNotice('تم فصل الربط وحذف المفاتيح المشفّرة بنجاح');
      await Promise.all([loadAll(), reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر فصل الربط');
    } finally {
      setBusyKey('');
    }
  }

  async function processOutboxNow() {
    setNotice('');
    setError('');
    setBusyKey('outbox');
    try {
      const r = await api.post<{ processed?: number; succeeded?: number; synced?: number }>('/api/integrations/outbox/process', {});
      setNotice(`تمت معالجة طابور دفع المخزون (${r.succeeded ?? r.synced ?? r.processed ?? 0} عملية ناجحة)`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر معالجة طابور المزامنة');
    } finally {
      setBusyKey('');
    }
  }

  async function saveCourier(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    setBusyKey(`save-courier-${selectedCourier}`);
    try {
      const r = await api.put<{
        testResult?: { ok?: boolean; message?: string } | null;
        connections?: CourierConn[];
      }>(`/api/couriers/connections/${selectedCourier}`, {
        enabled: true,
        environment: courierEnv,
        credentials: courierCreds,
        testNow: true
      });
      if (r.testResult && !r.testResult.ok) {
        setError(`تم حفظ مفاتيح الشحن لكن فشل الاختبار: ${r.testResult.message || 'راجع المفاتيح'}`);
      } else {
        setNotice(r.testResult?.message || 'تم حفظ واختبار بيانات شركة الشحن بنجاح ✓');
      }
      const freshConn = (r.connections || []).find((c) => c.courier === selectedCourier);
      setCourierCreds(buildInitialCreds(activeCourierSchema, freshConn));
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ بيانات شركة الشحن');
    } finally {
      setBusyKey('');
    }
  }

  async function testCourier(key: string) {
    setNotice('');
    setError('');
    setBusyKey(`test-courier-${key}`);
    try {
      const r = await api.post<{ ok?: boolean; message?: string; error?: string }>(`/api/couriers/connections/${key}/test`, {});
      if (r.ok) setNotice(r.message || 'نجح اختبار الاتصال بشركة الشحن ✓');
      else setError(r.error || r.message || 'فشل اختبار الاتصال بشركة الشحن');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر اختبار الاتصال');
    } finally {
      setBusyKey('');
    }
  }

  async function removeCourier(key: string) {
    setNotice('');
    setError('');
    setBusyKey(`del-courier-${key}`);
    try {
      await api.del(`/api/couriers/connections/${key}`);
      setNotice('تم فصل شركة الشحن بنجاح');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر فصل شركة الشحن');
    } finally {
      setBusyKey('');
    }
  }

  return (
    <AppShell title="ربط المنصات وشركات الشحن" subtitle="أمازون، نون، جوميا، ترينديول، كنز + بوسطة وأرامكس ومايلرز بتشفير AES-256-GCM" user={boot?.me}>
      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-extrabold text-base">الأسواق الإلكترونية (Marketplaces)</h2>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={busyKey === 'sync-all'}
                onClick={() => void syncAllMarkets()}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-60"
              >
                {busyKey === 'sync-all' ? 'جارٍ السحب...' : '⟳ مزامنة الكل الآن'}
              </button>
              <button
                type="button"
                disabled={busyKey === 'amz-oauth'}
                onClick={() => void startAmazonOauth()}
                className="rounded-lg border border-[#0C5CA4]/40 px-2.5 py-1 text-[11px] font-bold text-[var(--primary)] hover:bg-[#0C5CA4]/10 disabled:opacity-60"
              >
                ربط أمازون بنقرة (OAuth)
              </button>
            </div>
          </div>
          {schemas.map((m) => {
            const c = connections.find((x) => x.platform === m.key);
            return (
              <div
                key={m.key}
                className={`rounded-xl border p-4 space-y-1.5 ${
                  selected === m.key ? 'border-[#0C5CA4] bg-[var(--surface-alt)]/40' : 'border-[var(--border)]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-sm flex items-center gap-2">
                      <span>{m.name}</span>
                      {c?.status && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${c.status === 'connected' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : c.status === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-[var(--surface-alt)] text-[var(--muted)]'}`}>
                          {c.status === 'connected' ? 'متصل ✓' : c.status === 'error' ? 'خطأ' : c.configured ? 'محفوظ' : 'غير متصل'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--muted)]">
                      {c?.configured ? `مفعّل (${c.environment || 'production'})` : 'غير متصل بعد'}
                      {c?.lastSyncAt ? ` · آخر مزامنة: ${fmtDate(c.lastSyncAt)}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectPlatform(m.key)}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold"
                    >
                      إعداد
                    </button>
                    {c?.configured && (
                      <>
                        <button
                          type="button"
                          disabled={busyKey === `test-${m.key}`}
                          onClick={() => void testMarket(m.key)}
                          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                        >
                          اختبار
                        </button>
                        <button
                          type="button"
                          disabled={busyKey === `sync-${m.key}`}
                          onClick={() => void syncMarket(m.key)}
                          className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                        >
                          {busyKey === `sync-${m.key}` ? '...' : 'مزامنة'}
                        </button>
                        <button
                          type="button"
                          disabled={busyKey === `del-${m.key}`}
                          onClick={() => void removeMarket(m.key)}
                          className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-bold text-rose-600 disabled:opacity-60"
                        >
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
          <div className="space-y-1">
            <h2 className="font-extrabold text-base">إعداد مفاتيح: {activeSchema.name}</h2>
            <p className="text-xs text-[var(--muted)]">
              {activeSchema.docsHint || 'تُحفظ المفاتيح مشفّرة بالكامل (AES-256-GCM) ولا تُعرض صريحة بعد الحفظ.'}
            </p>
          </div>
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
            const secretInfo = f.secret ? getSecretStatus(activeMarketConn, key) : null;
            const isRequired = Boolean(f.required) && !(secretInfo?.configured);
            return (
              <div key={key} className="space-y-1">
                <label className="text-xs font-bold block">
                  {f.label}{' '}
                  {secretInfo?.configured ? (
                    <span className="font-mono-num text-[10px] text-emerald-700 dark:text-emerald-300" dir="ltr">
                      (محفوظ: {secretInfo.masked || '••••'})
                    </span>
                  ) : null}
                </label>
                {f.multiline ? (
                  <textarea
                    rows={3}
                    className="of-input font-mono-num text-xs"
                    dir="ltr"
                    placeholder={secretInfo?.configured ? 'اتركه فارغًا للإبقاء على القيمة المحفوظة' : (f.placeholder || '')}
                    value={creds[key] || ''}
                    onChange={(e) => setCreds((prev) => ({ ...prev, [key]: e.target.value }))}
                    required={isRequired}
                  />
                ) : (
                  <input
                    type={f.secret ? 'password' : 'text'}
                    className="of-input"
                    dir="ltr"
                    placeholder={secretInfo?.configured ? 'اتركه فارغًا للإبقاء على القيمة المحفوظة' : (f.placeholder || '')}
                    value={creds[key] || ''}
                    onChange={(e) => setCreds((prev) => ({ ...prev, [key]: e.target.value }))}
                    required={isRequired}
                  />
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busyKey === `save-market-${selected}`}
              className="flex-1 rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60"
            >
              {busyKey === `save-market-${selected}` ? 'جارٍ الحفظ والاختبار وسحب البيانات...' : '⚡ حفظ واختبار وسحب البيانات فورًا'}
            </button>
            <button
              type="button"
              disabled={busyKey === `save-market-${selected}`}
              onClick={() => void submitMarketplace(false)}
              className="rounded-xl border border-[var(--border)] px-4 py-3 text-xs font-bold disabled:opacity-60"
            >
              حفظ فقط
            </button>
          </div>
        </form>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">ربط شركات الشحن (Bosta · Aramex · Mylerz)</h2>
          {courierSchemas.map((cs) => {
            const c = courierConns.find((x) => x.courier === cs.key);
            return (
              <div
                key={cs.key}
                className={`rounded-xl border p-4 space-y-1.5 ${
                  selectedCourier === cs.key ? 'border-[#0C5CA4] bg-[var(--surface-alt)]/40' : 'border-[var(--border)]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-sm">{cs.name}</div>
                    <div className="text-xs text-[var(--muted)]">
                      {c?.configured ? `متصل (${c.environment || 'production'})` : 'غير متصل بعد'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectCourier(cs.key)}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold"
                    >
                      إعداد
                    </button>
                    {c?.configured && (
                      <>
                        <button
                          type="button"
                          disabled={busyKey === `test-courier-${cs.key}`}
                          onClick={() => void testCourier(cs.key)}
                          className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                        >
                          اختبار الاتصال
                        </button>
                        <button
                          type="button"
                          disabled={busyKey === `del-courier-${cs.key}`}
                          onClick={() => void removeCourier(cs.key)}
                          className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs font-bold text-rose-600 disabled:opacity-60"
                        >
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
              <option value="production">إنتاج فعلي (Production)</option>
              <option value="sandbox">بيئة اختبار (Sandbox)</option>
            </select>
          </div>
          {activeCourierSchema.fields.map((f) => {
            const key = fieldIdOf(f);
            const secretInfo = f.secret ? getSecretStatus(activeCourierConn, key) : null;
            const isRequired = Boolean(f.required) && !(secretInfo?.configured);
            return (
              <div key={key} className="space-y-1">
                <label className="text-xs font-bold block">
                  {f.label}{' '}
                  {secretInfo?.configured ? (
                    <span className="font-mono-num text-[10px] text-emerald-700 dark:text-emerald-300" dir="ltr">
                      (محفوظ: {secretInfo.masked || '••••'})
                    </span>
                  ) : null}
                </label>
                <input
                  type={f.secret ? 'password' : 'text'}
                  className="of-input"
                  dir="ltr"
                  placeholder={secretInfo?.configured ? 'اتركه فارغًا للإبقاء على القيمة المحفوظة' : (f.placeholder || '')}
                  value={courierCreds[key] || ''}
                  onChange={(e) => setCourierCreds((prev) => ({ ...prev, [key]: e.target.value }))}
                  required={isRequired}
                />
              </div>
            );
          })}
          <button
            type="submit"
            disabled={busyKey === `save-courier-${selectedCourier}`}
            className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white disabled:opacity-60"
          >
            {busyKey === `save-courier-${selectedCourier}` ? 'جارٍ الحفظ والاختبار...' : 'حفظ واختبار مفاتيح الشحن'}
          </button>
        </form>
      </div>

      {outbox.length > 0 && (
        <section className="of-card overflow-x-auto mb-6">
          <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-2">
            <strong className="text-sm">طابور دفع المخزون للأسواق (Stock Sync Outbox)</strong>
            <button
              type="button"
              disabled={busyKey === 'outbox'}
              onClick={() => void processOutboxNow()}
              className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
            >
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
                  <td className="p-3 font-bold">{item.platformName || schemas.find((s) => s.key === item.platform)?.name || item.platform}</td>
                  <td className="p-3 font-mono-num text-xs" dir="ltr">{item.sku}</td>
                  <td className="p-3 font-mono-num font-bold">{item.qty ?? item.stock ?? 0}</td>
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
                    <td className="p-3 font-bold">{r.platformName || schemas.find((s) => s.key === r.platform)?.name || r.platform}</td>
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
