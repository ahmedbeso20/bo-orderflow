'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum, MARKET_NAMES } from '@/lib/format';
import type { Product } from '@/lib/types';

const MARKET_KEYS = Object.keys(MARKET_NAMES);

function approvalBadge(status?: string) {
  if (status === 'approved') return { label: 'معتمد ✓', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' };
  if (status === 'rejected') return { label: 'مرفوض', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' };
  return { label: 'قيد المراجعة', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' };
}

export default function ProductsPage() {
  const { data: boot, reload } = useBootstrap();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [cat, setCat] = useState('عام');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [stock, setStock] = useState('10');
  const [markets, setMarkets] = useState<string[]>(['a', 'n']);
  const [image, setImage] = useState('');
  const [uploadingImg, setUploadingImg] = useState(false);

  const [csvText, setCsvText] = useState('');
  const [showCsv, setShowCsv] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const products: Product[] = (boot?.products || []).filter(
    (p) => !query || p.name.includes(query) || p.sku.toLowerCase().includes(query.toLowerCase()) || (p.cat || '').includes(query)
  );

  function resetForm() {
    setEditingId(null);
    setName('');
    setSku('');
    setCat('عام');
    setPrice('');
    setCost('');
    setStock('10');
    setMarkets(['a', 'n']);
    setImage('');
  }

  function startEdit(p: Product) {
    setEditingId(p.id);
    setName(p.name);
    setSku(p.sku);
    setCat(p.cat || 'عام');
    setPrice(String(p.price));
    setCost(String(p.cost));
    setStock(String(p.stock));
    setMarkets(MARKET_KEYS.filter((k) => (p.markets || '').includes(k)));
    setImage(p.image || '');
    setNotice('');
    setError('');
  }

  function toggleMarket(k: string) {
    setMarkets((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImg(true);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('تعذر قراءة الصورة'));
        reader.readAsDataURL(file);
      });
      const res = await api.post<{ url?: string; image?: string }>('/api/products/upload-image', { dataUrl });
      setImage(res.url || res.image || '');
      setNotice('تم رفع صورة المنتج بنجاح ✓');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر رفع الصورة');
    } finally {
      setUploadingImg(false);
      e.target.value = '';
    }
  }

  async function saveProduct(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    const marketStr = markets.length ? markets.join('') : 'a';
    const payload = {
      name: name.trim(),
      sku: sku.trim() || `SKU-${Date.now().toString(36).toUpperCase()}`,
      cat: cat.trim() || 'عام',
      price: Number(price),
      cost: Number(cost || Math.round(Number(price) * 0.6)),
      stock: Number(stock || 0),
      markets: marketStr,
      image: image.trim()
    };
    try {
      if (editingId) {
        await api.put(`/api/products/${editingId}`, payload);
        setNotice('تم تحديث بيانات المنتج بنجاح ✓');
      } else {
        await api.post('/api/products', payload);
        setNotice('تم إضافة المنتج بنجاح ✓');
      }
      resetForm();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ المنتج');
    }
  }

  async function deleteProduct(id: number) {
    setError('');
    setNotice('');
    try {
      await api.del(`/api/products/${id}`);
      if (editingId === id) resetForm();
      setNotice('تم حذف المنتج بنجاح');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حذف المنتج');
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
    setError('');
    try {
      await api.post(`/api/products/${id}/restock`, { qty: 10 });
      setNotice('تمت إضافة +10 للمخزون وجدولة دفعه للأسواق المربوطة ✓');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تزويد المخزون');
    }
  }

  return (
    <AppShell title="المنتجات والمخزون الموحّد" subtitle="إدارة الكتالوج، الصور، الأسواق، استيراد CSV، وتزويد المخزون" user={boot?.me}>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          className="of-input max-w-xs"
          placeholder="ابحث بالاسم أو كود SKU أو الفئة..."
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

      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

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

      <form onSubmit={saveProduct} className="of-card p-5 mb-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-extrabold text-sm">{editingId ? 'تعديل المنتج' : 'إضافة منتج جديد'}</h2>
          {editingId && (
            <button type="button" onClick={resetForm} className="text-xs font-bold text-[var(--muted)]">
              إلغاء التعديل ✕
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-2">
            <label className="text-xs font-bold block mb-1">اسم المنتج</label>
            <input className="of-input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">SKU</label>
            <input className="of-input" dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="تلقائي" />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">الفئة</label>
            <input className="of-input" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="إلكترونيات" />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">السعر (ج.م)</label>
            <input type="number" className="of-input" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">التكلفة (ج.م)</label>
            <input type="number" className="of-input" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="اختياري" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-center">
          <div>
            <label className="text-xs font-bold block mb-1">المخزون</label>
            <input type="number" className="of-input" value={stock} onChange={(e) => setStock(e.target.value)} required />
          </div>
          <div className="md:col-span-3">
            <label className="text-xs font-bold block mb-1">الأسواق المنشور عليها</label>
            <div className="flex flex-wrap gap-3 pt-1">
              {MARKET_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-xs font-bold cursor-pointer">
                  <input type="checkbox" checked={markets.includes(k)} onChange={() => toggleMarket(k)} />
                  <span>{MARKET_NAMES[k]}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="md:col-span-2 flex items-center gap-2">
            <label className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold cursor-pointer hover:bg-[var(--surface-alt)] shrink-0">
              {uploadingImg ? 'جارٍ الرفع...' : '📷 رفع صورة'}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void handleImagePick(e)} />
            </label>
            {image && (
              <img src={image} alt="معاينة المنتج" className="h-10 w-10 rounded-lg object-cover border border-[var(--border)]" />
            )}
            <button type="submit" className="mr-auto rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white shrink-0">
              {editingId ? 'حفظ التعديلات' : '+ إضافة منتج'}
            </button>
          </div>
        </div>
      </form>

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">المنتج</th>
              <th className="p-3">SKU</th>
              <th className="p-3">السعر / التكلفة</th>
              <th className="p-3">المخزون</th>
              <th className="p-3">الاعتماد</th>
              <th className="p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {products.map((p) => {
              const badge = approvalBadge(p.approvalStatus);
              return (
                <tr key={p.id}>
                  <td className="p-3">
                    <div className="flex items-center gap-2.5">
                      {p.image && (
                        <img src={p.image} alt={p.name} className="h-9 w-9 rounded-lg object-cover border border-[var(--border)] shrink-0" />
                      )}
                      <div>
                        <div className="font-bold">{p.name}</div>
                        <div className="text-[11px] text-[var(--muted)]">{p.cat || 'عام'} · {(p.markets || '').split('').map((m) => MARKET_NAMES[m] || m).join('، ')}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 font-mono-num text-xs" dir="ltr">{p.sku}</td>
                  <td className="p-3 font-mono-num">
                    <div className="font-bold">{fmtEGP(p.price)}</div>
                    <div className="text-[11px] text-[var(--muted)]">تكلفة: {fmtEGP(p.cost)}</div>
                  </td>
                  <td className="p-3 font-mono-num font-bold">{fmtNum(p.stock)}</td>
                  <td className="p-3">
                    <span className={`inline-block rounded-lg px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}>{badge.label}</span>
                    {p.rejectReason && <div className="text-[10px] text-rose-600 mt-0.5">{p.rejectReason}</div>}
                  </td>
                  <td className="p-3 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void quickRestock(p.id)}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold hover:bg-[var(--surface-alt)]"
                    >
                      +10
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold hover:bg-[var(--surface-alt)]"
                    >
                      تعديل
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteProduct(p.id)}
                      className="rounded-lg border border-rose-500/40 px-2.5 py-1 text-xs font-bold text-rose-600"
                    >
                      حذف
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
