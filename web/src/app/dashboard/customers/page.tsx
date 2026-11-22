'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP, fmtNum } from '@/lib/format';

interface CustomerRow {
  id: number;
  name: string;
  phone: string;
  gov: string;
  ordersCount: number;
  totalSpent: number;
  rtoCount: number;
}

export default function CustomersPage() {
  const { data: boot } = useBootstrap();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!boot?.me) return;
    api.get<{ customers?: CustomerRow[] }>(`/api/customers?q=${encodeURIComponent(q)}`)
      .then((res) => setCustomers(res.customers || []))
      .catch(() => {});
  }, [boot?.me, q]);

  return (
    <AppShell title="إدارة العملاء والمرتجعات (CRM & RTO)" subtitle="قاعدة بيانات العملاء ومؤشر مرتجعات الدفع عند الاستلام" user={boot?.me}>
      <div className="mb-5">
        <input
          className="of-input max-w-sm"
          placeholder="ابحث باسم العميل أو رقم الموبايل..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="of-card overflow-x-auto">
        <table className="w-full text-sm text-right">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-xs">
            <tr>
              <th className="p-3">العميل</th>
              <th className="p-3">الموبايل</th>
              <th className="p-3">المحافظة</th>
              <th className="p-3">عدد الطلبات</th>
              <th className="p-3">إجمالي الشراء</th>
              <th className="p-3">المرتجعات RTO</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {customers.map((c) => (
              <tr key={c.id}>
                <td className="p-3 font-bold">{c.name}</td>
                <td className="p-3 font-mono-num text-xs" dir="ltr">{c.phone}</td>
                <td className="p-3">{c.gov}</td>
                <td className="p-3 font-mono-num">{fmtNum(c.ordersCount)}</td>
                <td className="p-3 font-mono-num font-bold">{fmtEGP(c.totalSpent)}</td>
                <td className="p-3 font-mono-num text-rose-600 font-bold">{fmtNum(c.rtoCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
