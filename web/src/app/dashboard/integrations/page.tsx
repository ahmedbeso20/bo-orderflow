'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';

interface MarketConn {
  market: string;
  name: string;
  connected: boolean;
  lastSyncAt?: string;
}

const MARKETS = [
  { key: 'amazon', label: 'أمازون مصر (SP-API)' },
  { key: 'noon', label: 'نون (Noon Partners)' },
  { key: 'jumia', label: 'جوميا (Seller Center)' },
  { key: 'trendyol', label: 'ترينديول (Trendyol)' },
  { key: 'kenzz', label: 'كنز (Kenzz)' }
];

export default function IntegrationsPage() {
  const { data: boot } = useBootstrap();
  const [connections, setConnections] = useState<MarketConn[]>([]);
  const [selected, setSelected] = useState('amazon');
  const [sellerId, setSellerId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const res = await api.get<{ connections?: MarketConn[] }>('/api/integrations/marketplaces');
    setConnections(res.connections || []);
  }

  useEffect(() => {
    if (boot?.me) void load();
  }, [boot?.me]);

  async function saveConnection(e: React.FormEvent) {
    e.preventDefault();
    setNotice('');
    setError('');
    try {
      await api.post(`/api/integrations/marketplaces/${selected}/connect`, {
        credentials: { sellerId: sellerId.trim(), apiKey: apiKey.trim() }
      });
      setNotice('تم حفظ بيانات الربط بتشفير AES-256-GCM بنجاح');
      setApiKey('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الربط');
    }
  }

  async function syncMarket(key: string) {
    setNotice('');
    setError('');
    try {
      const r = await api.post<{ message?: string }>(`/api/integrations/marketplaces/${key}/sync`, {});
      setNotice(r.message || 'تمت المزامنة بنجاح');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذرت المزامنة');
    }
  }

  return (
    <AppShell title="ربط المنصات وشركات الشحن" subtitle="أمازون، نون، جوميا، ترينديول، كنز + بوسطة وأرامكس" user={boot?.me}>
      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="of-card p-6 space-y-3">
          <h2 className="font-extrabold text-base">حالة المنصات الخمس</h2>
          {MARKETS.map((m) => {
            const c = connections.find((x) => x.market === m.key);
            return (
              <div key={m.key} className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold text-sm">{m.label}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {c?.connected ? 'متصل وجاهز للمزامنة' : 'غير متصل بعد'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelected(m.key)}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-bold"
                  >
                    إعداد
                  </button>
                  {c?.connected && (
                    <button
                      type="button"
                      onClick={() => void syncMarket(m.key)}
                      className="rounded-lg bg-[#0C5CA4] px-3 py-1.5 text-xs font-bold text-white"
                    >
                      مزامنة
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        <form onSubmit={saveConnection} className="of-card p-6 space-y-4">
          <h2 className="font-extrabold text-base">
            إعداد مفاتيح الربط: {MARKETS.find((x) => x.key === selected)?.label}
          </h2>
          <p className="text-xs text-[var(--muted)]">
            تُحفظ مفاتيح الربط مشفّرة بالكامل على الخادم ولا تُعرض مجددًا بعد الحفظ.
          </p>
          <div className="space-y-1">
            <label className="text-xs font-bold block">معرّف التاجر (Seller ID)</label>
            <input className="of-input" dir="ltr" value={sellerId} onChange={(e) => setSellerId(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold block">رمز الوصول / المفتاح السري</label>
            <input type="password" className="of-input" dir="ltr" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
          </div>
          <button type="submit" className="w-full rounded-xl bg-[#0C5CA4] py-3 text-sm font-bold text-white">
            حفظ وتشفير بيانات الربط
          </button>
        </form>
      </div>
    </AppShell>
  );
}
