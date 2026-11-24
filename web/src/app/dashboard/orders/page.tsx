'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtDate, fmtEGP, MARKET_NAMES, ORDER_STATUS_LABELS } from '@/lib/format';
import type { Order } from '@/lib/types';

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'الكل' },
  { key: '0', label: 'قيد التجهيز' },
  { key: '1', label: 'تم الشحن' },
  { key: '2', label: 'تم التسليم' },
  { key: '3', label: 'مرتجع' },
  { key: '4', label: 'ملغي' }
];

const COURIER_OPTIONS = ['بوسطة', 'أرامكس', 'مايلرز'];
const PAYMENT_OPTIONS = ['الدفع عند الاستلام', 'بطاقة بنكية', 'فودافون كاش', 'إنستاباي'];
const GOV_OPTIONS = ['القاهرة', 'الجيزة', 'الإسكندرية', 'الدقهلية', 'الشرقية', 'الغربية', 'المنوفية', 'القليوبية', 'بورسعيد', 'الإسماعيلية', 'السويس', 'أسيوط', 'المنيا', 'طنطا', 'الأقصر', 'أسوان'];

function courierKeyOf(name?: string): 'bosta' | 'aramex' | 'mylerz' {
  const s = String(name || '');
  if (s.includes('أرامكس') || /aramex/i.test(s)) return 'aramex';
  if (s.includes('مايلرز') || /mylerz/i.test(s)) return 'mylerz';
  return 'bosta';
}

export default function OrdersPage() {
  const { data: boot, reload: reloadBoot } = useBootstrap();
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [waPreview, setWaPreview] = useState('');
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [returnOrder, setReturnOrder] = useState<Order | null>(null);
  const [returnReason, setReturnReason] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newOrder, setNewOrder] = useState({
    market: 'a',
    customer: '',
    phone: '',
    gov: 'القاهرة',
    address: '',
    pay: 'الدفع عند الاستلام',
    courier: 'بوسطة'
  });
  const [orderItems, setOrderItems] = useState<Array<{ productId: number; qty: number }>>([]);

  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const loadOrders = useCallback(async (targetPage = page) => {
    try {
      const qs = new URLSearchParams();
      if (debouncedQuery.trim()) qs.set('q', debouncedQuery.trim());
      if (statusFilter !== 'all') qs.set('status', statusFilter);
      qs.set('page', String(targetPage));
      qs.set('limit', '20');
      const res = await api.get<{ items?: Order[]; page?: number; pages?: number; total?: number }>(`/api/orders?${qs.toString()}`);
      setOrders(res.items || []);
      setPage(res.page || 1);
      setPages(res.pages || 1);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل الطلبات');
    }
  }, [debouncedQuery, statusFilter, page]);

  useEffect(() => {
    if (boot?.me) void loadOrders(page);
  }, [boot?.me, loadOrders, page]);

  const availableProducts = (boot?.products || []).filter((p) => p.markets.includes(newOrder.market) && p.stock > 0);

  function openCreateModal() {
    const prods = boot?.products || [];
    const first = prods.find((p) => p.markets.includes(newOrder.market) && p.stock > 0) || prods[0];
    setOrderItems(first ? [{ productId: first.id, qty: 1 }] : []);
    setShowCreate(true);
    setError('');
    setNotice('');
  }

  async function submitCreateOrder(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!orderItems.length) {
      setError('أضف منتجًا واحدًا على الأقل للطلب');
      return;
    }
    try {
      await api.post('/api/orders', {
        ...newOrder,
        items: orderItems
      });
      setShowCreate(false);
      setNewOrder({ market: 'a', customer: '', phone: '', gov: 'القاهرة', address: '', pay: 'الدفع عند الاستلام', courier: 'بوسطة' });
      setNotice('تم إنشاء الطلب وخصم المخزون بنجاح ✓');
      await Promise.all([loadOrders(1), reloadBoot()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إنشاء الطلب');
    }
  }

  async function advanceStatus(id: number, status: number, reason?: string) {
    setError('');
    setNotice('');
    try {
      await api.post(`/api/orders/${id}/status`, { status, ...(reason ? { reason } : {}) });
      setNotice('تم تحديث حالة الطلب بنجاح ✓');
      await loadOrders(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحديث حالة الطلب');
    }
  }

  async function submitReturn(e: React.FormEvent) {
    e.preventDefault();
    if (!returnOrder) return;
    await advanceStatus(returnOrder.id, 3, returnReason.trim() || 'مرتجع شحن RTO');
    setReturnOrder(null);
    setReturnReason('');
  }

  async function submitCancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelOrder) return;
    setError('');
    setNotice('');
    try {
      await api.post(`/api/orders/${cancelOrder.id}/cancel`, {
        reason: cancelReason.trim() || 'إلغاء بطلب العميل'
      });
      setCancelOrder(null);
      setCancelReason('');
      setNotice('تم إلغاء الطلب واستعادة كميات المخزون تلقائيًا ✓');
      await Promise.all([loadOrders(page), reloadBoot()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إلغاء الطلب');
    }
  }

  async function generateWhatsApp(id: number) {
    setError('');
    try {
      const res = await api.post<{ text?: string }>('/api/ai/order-message', { orderId: id });
      setWaPreview(res.text || '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر توليد رسالة واتساب');
    }
  }

  async function createCourierAwb(id: number, courier: 'bosta' | 'aramex' | 'mylerz') {
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ awbNumber?: string; awb?: string; message?: string }>(`/api/orders/${id}/awb/create`, { courier });
      const code = res.awbNumber || res.awb;
      setNotice(res.message || `تم إصدار بوليصة الشحن بنجاح${code ? ` (${code})` : ''}`);
      await loadOrders(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر إصدار بوليصة الشحن — تأكد من ربط شركة الشحن في صفحة التكاملات');
    }
  }

  async function trackCourierAwb(id: number) {
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ status?: string; courierStatus?: string }>(`/api/orders/${id}/awb/track`, {});
      setNotice(`حالة الشحنة المحدّثة: ${res.courierStatus || res.status || 'تم التحديث'}`);
      await loadOrders(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تتبع الشحنة حاليًا');
    }
  }

  return (
    <AppShell title="الطلبات والفواتير" subtitle="إنشاء الطلبات، فواتير QR، بوالص AWB، المرتجعات، ورسائل واتساب الذكية" user={boot?.me}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-2 flex-1 max-w-md">
          <input
            className="of-input"
            placeholder="ابحث برقم الطلب أو اسم العميل أو الهاتف..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openCreateModal}
            className="rounded-xl bg-[#0C5CA4] px-4 py-2 text-xs font-bold text-white"
          >
            + إنشاء طلب جديد
          </button>
          <a
            href="/api/orders/export.csv"
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-bold hover:bg-[var(--surface-alt)]"
          >
            📥 تصدير CSV
          </a>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-5">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setStatusFilter(t.key); setPage(1); }}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold ${
              statusFilter === t.key ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            {t.label}
          </button>
        ))}
        <span className="mr-auto self-center text-xs text-[var(--muted)]">الإجمالي: {total} طلب</span>
      </div>

      {notice && <p className="mb-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-sm font-bold text-[var(--danger)]">{error}</p>}

      {showCreate && (
        <form onSubmit={submitCreateOrder} className="of-card p-5 mb-5 space-y-4 border-[#0C5CA4]/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">إنشاء طلب يدوي جديد</strong>
            <button type="button" onClick={() => setShowCreate(false)} className="text-xs font-bold">إغلاق ✕</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-bold block mb-1">المنصة</label>
              <select className="of-input" value={newOrder.market} onChange={(e) => setNewOrder((p) => ({ ...p, market: e.target.value }))}>
                {Object.entries(MARKET_NAMES).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">اسم العميل</label>
              <input className="of-input" value={newOrder.customer} onChange={(e) => setNewOrder((p) => ({ ...p, customer: e.target.value }))} required />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">الموبايل</label>
              <input className="of-input" dir="ltr" placeholder="010xxxxxxxx" value={newOrder.phone} onChange={(e) => setNewOrder((p) => ({ ...p, phone: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">المحافظة</label>
              <select className="of-input" value={newOrder.gov} onChange={(e) => setNewOrder((p) => ({ ...p, gov: e.target.value }))}>
                {GOV_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">طريقة الدفع</label>
              <select className="of-input" value={newOrder.pay} onChange={(e) => setNewOrder((p) => ({ ...p, pay: e.target.value }))}>
                {PAYMENT_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold block mb-1">شركة الشحن</label>
              <select className="of-input" value={newOrder.courier} onChange={(e) => setNewOrder((p) => ({ ...p, courier: e.target.value }))}>
                {COURIER_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-bold block mb-1">العنوان التفصيلي</label>
            <input className="of-input" value={newOrder.address} onChange={(e) => setNewOrder((p) => ({ ...p, address: e.target.value }))} placeholder="الحي، الشارع، رقم العمارة" />
          </div>

          <div className="space-y-2 pt-2 border-t border-[var(--border)]">
            <div className="flex items-center justify-between">
              <strong className="text-xs">المنتجات (متاحة على {MARKET_NAMES[newOrder.market]})</strong>
              <button
                type="button"
                onClick={() => {
                  const first = availableProducts[0] || (boot?.products || [])[0];
                  if (first) setOrderItems((prev) => [...prev, { productId: first.id, qty: 1 }]);
                }}
                className="text-xs font-bold text-[var(--primary)]"
              >
                + إضافة سطر منتج
              </button>
            </div>
            {orderItems.map((it, idx) => (
              <div key={idx} className="flex flex-wrap gap-2 items-center">
                <select
                  className="of-input flex-1"
                  value={it.productId}
                  onChange={(e) => {
                    const pid = Number(e.target.value);
                    setOrderItems((prev) => prev.map((x, i) => (i === idx ? { ...x, productId: pid } : x)));
                  }}
                >
                  {(availableProducts.length ? availableProducts : boot?.products || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {fmtEGP(p.price)} (متاح {p.stock})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  max={999}
                  className="of-input w-24 font-mono-num"
                  value={it.qty}
                  onChange={(e) => {
                    const qty = Math.max(1, Number(e.target.value) || 1);
                    setOrderItems((prev) => prev.map((x, i) => (i === idx ? { ...x, qty } : x)));
                  }}
                />
                {orderItems.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setOrderItems((prev) => prev.filter((_, i) => i !== idx))}
                    className="rounded-lg border border-rose-500/40 px-2.5 py-2 text-xs font-bold text-rose-600"
                  >
                    حذف
                  </button>
                )}
              </div>
            ))}
          </div>

          <button type="submit" className="rounded-xl bg-[#0C5CA4] px-5 py-2.5 text-xs font-bold text-white">
            حفظ الطلب وخصم المخزون
          </button>
        </form>
      )}

      {waPreview && (
        <div className="of-card p-4 mb-5 space-y-2 border-emerald-500/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">رسالة واتساب المولّدة للعميل</strong>
            <button type="button" onClick={() => setWaPreview('')} className="text-xs font-bold">إغلاق</button>
          </div>
          <p className="text-sm whitespace-pre-wrap">{waPreview}</p>
        </div>
      )}

      {cancelOrder && (
        <form onSubmit={submitCancel} className="of-card p-5 mb-5 space-y-3 border-rose-500/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">إلغاء الطلب #{cancelOrder.no} ({cancelOrder.customer})</strong>
            <button type="button" onClick={() => setCancelOrder(null)} className="text-xs font-bold">إغلاق</button>
          </div>
          <input
            className="of-input"
            placeholder="سبب الإلغاء (مثال: طلب العميل الإلغاء / عدم الرد)"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            required
          />
          <button type="submit" className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white">
            تأكيد الإلغاء واستعادة المخزون
          </button>
        </form>
      )}

      {returnOrder && (
        <form onSubmit={submitReturn} className="of-card p-5 mb-5 space-y-3 border-amber-500/40">
          <div className="flex items-center justify-between">
            <strong className="text-sm">تسجيل مرتجع للطلب #{returnOrder.no} ({returnOrder.customer})</strong>
            <button type="button" onClick={() => setReturnOrder(null)} className="text-xs font-bold">إغلاق</button>
          </div>
          <input
            className="of-input"
            placeholder="سبب المرتجع (مثال: رفض الاستلام / هاتف مغلق / عنوان غير صحيح)"
            value={returnReason}
            onChange={(e) => setReturnReason(e.target.value)}
            required
          />
          <button type="submit" className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white">
            تسجيل المرتجع واستعادة المخزون
          </button>
        </form>
      )}

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">الطلب</th>
              <th className="p-3">السوق</th>
              <th className="p-3">العميل والشحن</th>
              <th className="p-3">الإجمالي</th>
              <th className="p-3">الحالة</th>
              <th className="p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {orders.map((o) => {
              const st = ORDER_STATUS_LABELS[o.status] || ORDER_STATUS_LABELS[0];
              const awbCode = o.awbNumber || o.awb;
              return (
                <tr key={o.id}>
                  <td className="p-3 font-mono-num font-bold">
                    #{o.no}
                    <div className="text-[11px] font-normal text-[var(--muted)]">{fmtDate(o.createdAt)}</div>
                  </td>
                  <td className="p-3">
                    <div>{MARKET_NAMES[o.market] || o.market}</div>
                    {o.fulfillmentChannel && <div className="text-[10px] text-[var(--muted)]">{o.fulfillmentChannel}</div>}
                  </td>
                  <td className="p-3">
                    <div className="font-bold">{o.customer}</div>
                    <div className="text-xs text-[var(--muted)]">{o.gov} · {o.courier}</div>
                    {awbCode && (
                      <div className="text-[11px] font-mono-num text-[var(--primary)]" dir="ltr">
                        AWB: {awbCode}{o.courierStatus ? ` (${o.courierStatus})` : ''}
                      </div>
                    )}
                  </td>
                  <td className="p-3 font-mono-num font-bold">
                    {fmtEGP(o.total)}
                    {o.costEstimated && <div className="text-[10px] font-normal text-amber-600">تكلفة تقديرية</div>}
                  </td>
                  <td className="p-3">
                    <span className={`inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${st.tone}`}>{st.label}</span>
                  </td>
                  <td className="p-3 flex flex-wrap gap-1.5">
                    {o.status === 0 && (
                      <button
                        type="button"
                        onClick={() => void advanceStatus(o.id, 1)}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                      >
                        شحن
                      </button>
                    )}
                    {o.status === 1 && (
                      <>
                        <button
                          type="button"
                          onClick={() => void advanceStatus(o.id, 2)}
                          className="rounded-lg border border-emerald-500/40 px-2.5 py-1 text-xs font-bold text-emerald-700"
                        >
                          تسليم
                        </button>
                        <button
                          type="button"
                          onClick={() => { setReturnOrder(o); setReturnReason(''); }}
                          className="rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs font-bold text-amber-700"
                        >
                          مرتجع
                        </button>
                      </>
                    )}
                    {o.status === 2 && (
                      <button
                        type="button"
                        onClick={() => { setReturnOrder(o); setReturnReason(''); }}
                        className="rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs font-bold text-amber-700"
                      >
                        تسجيل مرتجع
                      </button>
                    )}
                    {o.status === 0 && (
                      <button
                        type="button"
                        onClick={() => { setCancelOrder(o); setCancelReason(''); }}
                        className="rounded-lg border border-rose-500/40 px-2.5 py-1 text-xs font-bold text-rose-600"
                      >
                        إلغاء
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void generateWhatsApp(o.id)}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      واتساب ذكي
                    </button>
                    <a
                      href={`/api/orders/${o.id}/invoice`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      فاتورة QR
                    </a>
                    <a
                      href={`/api/orders/awb?ids=${o.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                    >
                      بوليصة AWB
                    </a>
                    {!awbCode && o.status === 0 && (
                      <button
                        type="button"
                        onClick={() => void createCourierAwb(o.id, courierKeyOf(o.courier))}
                        className="rounded-lg bg-[#0C5CA4] px-2.5 py-1 text-xs font-bold text-white"
                      >
                        إصدار AWB
                      </button>
                    )}
                    {awbCode && (
                      <button
                        type="button"
                        onClick={() => void trackCourierAwb(o.id)}
                        className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
                      >
                        تتبع الشحنة
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-5">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-xl border border-[var(--border)] px-3 py-1.5 text-xs font-bold disabled:opacity-40"
          >
            السابق
          </button>
          <span className="text-xs font-bold font-mono-num">صفحة {page} من {pages}</span>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            className="rounded-xl border border-[var(--border)] px-3 py-1.5 text-xs font-bold disabled:opacity-40"
          >
            التالي
          </button>
        </div>
      )}
    </AppShell>
  );
}
