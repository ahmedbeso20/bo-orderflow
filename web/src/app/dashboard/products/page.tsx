'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum } from '@/lib/format';
import type { Product } from '@/lib/types';

export default function ProductsPage() {
  const { data: boot, reload } = useBootstrap();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [stock, setStock] = useState('10');
  const [csvText, setCsvText] = useState('');
  const [showCsv, setShowCsv] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const products: Product[] = (boot?.products || []).filter(
    (p) => !query || p.name.includes(query) || p.sku.toLowerCase().includes(query.toLowerCase())
  );

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/api/products', {
        name: name.trim(),
        sku: sku.trim() || `SKU-${Date.now().toString(36).toUpperCase()}`,
        price: Number(price),
        cost: Number(cost || Math.round(Number(price) * 0.6)),
        stock: Number(stock || 0),
        markets: 'an'
      });
      setName('');
      setSku('');
      setPrice('');
      setCost('');
      setNotice('تم إضافة المنتج بنجاح');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إضافة المنتج');
    }
  }

  async function handleCsvImport(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ imported: number; updated: number; skipped: number }>('/api/products/import', {
        csv: csvText
      });
      setNotice(`تم استيراد ${res.imported} منتج وتحديث ${res.updated} منتج (تخطي ${res.skipped})`);
      setCsvText('');
      setShowCsv(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر استيراد CSV');
    }
  }

  async function quickRestock(id: number) {
    await api.post(`/api/products/${id}/restock`, { qty: 10 });
    await reload();
  }

  return (
    <AppShell title="المنتجات والمخزون الموحّد" subtitle="إدارة الكتالوج، استيراد CSV، وتزويد المخزون" user={boot?.me}>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          className="of-input max-w-xs"
          placeholder="ابحث بالاسم أو كود SKU..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setShowCsv((v) => !v)}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-xs font-bold"
        >
          📤 استيراد CSV مجمّع
        </button>
        <a
          href="/api/products/export.csv"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-xs font-bold"
        >
          📥 تصدير CSV
        </a>
      </div>

      {notice && <p className="mb-4 text-sm font-bold text-emerald-700">{notice}</p>}
      {error && <p className="mb-4 text-sm font-bold text-[var(--danger)]">{error}</p>}

      {showCsv && (
        <form onSubmit={handleCsvImport} className="of-card p-5 mb-6 space-y-3">
          <h2 className="font-bold text-sm">استيراد منتجات مجمّع (CSV)</h2>
          <p className="text-xs text-[var(--muted)]">الأعمدة المدعومة: SKU, name, cat, price, cost, stock, markets</p>
          <textarea
            rows={5}
            dir="ltr"
            className="of-input font-mono-num text-xs"
            placeholder={'SKU,الاسم,الفئة,السعر,التكلفة,المخزون,الأسواق\nCSV-101,سماعة بلوتوث برو,إلكترونيات,950,580,25,"أمازون,نون"'}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            required
          />
          <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">
            تنفيذ الاستيراد
          </button>
        </form>
      )}

      <form onSubmit={addProduct} className="of-card p-5 mb-6 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <div className="md:col-span-2">
          <label className="text-xs font-bold block mb-1">اسم المنتج</label>
          <input className="of-input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1">SKU</label>
          <input className="of-input" dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="تلقائي" />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1">السعر (ج.م)</label>
          <input type="number" className="of-input" value={price} onChange={(e) => setPrice(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs font-bold block mb-1">المخزون</label>
          <input type="number" className="of-input" value={stock} onChange={(e) => setStock(e.target.value)} required />
        </div>
        <button type="submit" className="rounded-xl bg-[#0C5CA4] py-2.5 text-xs font-bold text-white">
          + إضافة منتج
        </button>
      </form>

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">المنتج</th>
              <th className="p-3">SKU</th>
              <th className="p-3">السعر</th>
              <th className="p-3">التكلفة</th>
              <th className="p-3">المخزون</th>
              <th className="p-3">إجراء</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {products.map((p) => (
              <tr key={p.id}>
                <td className="p-3 font-bold">{p.name}</td>
                <td className="p-3 font-mono-num text-xs" dir="ltr">{p.sku}</td>
                <td className="p-3 font-mono-num">{fmtEGP(p.price)}</td>
                <td className="p-3 font-mono-num text-[var(--muted)]">{fmtEGP(p.cost)}</td>
                <td className="p-3 font-mono-num font-bold">{fmtNum(p.stock)}</td>
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => void quickRestock(p.id)}
                    className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-bold hover:bg-[var(--surface-alt)]"
                  >
                    +10 مخزون
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
