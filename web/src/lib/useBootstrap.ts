'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { UserProfile, Product } from '@/lib/types';

export interface BootstrapData {
  me: UserProfile | null;
  products: Product[];
  plan?: { id: string; name: string; limit: number; cycle?: string; expiresAt?: string | null; autoRenew?: boolean };
  counts?: { lowStock: number; pendingOrders: number; unreadNotifications: number };
}

export function useBootstrap(requiredRole?: 'owner' | 'moderator') {
  const router = useRouter();
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<BootstrapData>('/api/bootstrap');
      if (!res.me) {
        router.replace('/login');
        return;
      }
      if (requiredRole && res.me.role !== requiredRole) {
        router.replace(res.me.role === 'owner' ? '/owner' : res.me.role === 'moderator' ? '/moderator' : '/dashboard');
        return;
      }
      setData(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/login');
      }
    } finally {
      setLoading(false);
    }
  }, [router, requiredRole]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, reload };
}
