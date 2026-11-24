/**
 * OrderFlow Same-Origin API Client
 *
 * Uses HttpOnly session cookies exclusively via Next.js /api/* same-origin rewrites.
 * Zero authentication tokens are ever stored in localStorage or sessionStorage.
 * Temporary read-only owner impersonation tokens are held in JS memory only.
 */

let impersonationToken = '';
let impersonationStoreName = '';
const impersonationListeners = new Set<() => void>();

export function setImpersonationToken(token: string, storeName = '') {
  impersonationToken = token ? String(token).trim() : '';
  impersonationStoreName = impersonationToken ? storeName : '';
  impersonationListeners.forEach((fn) => fn());
}

export function getImpersonationToken() {
  return impersonationToken;
}

export function getImpersonationStoreName() {
  return impersonationStoreName;
}

export function clearImpersonationToken() {
  impersonationToken = '';
  impersonationStoreName = '';
  impersonationListeners.forEach((fn) => fn());
}

export function subscribeImpersonation(listener: () => void) {
  impersonationListeners.add(listener);
  return () => {
    impersonationListeners.delete(listener);
  };
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data: Record<string, unknown>;

  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof data.code === 'string' ? data.code : undefined;
    this.data = data;
  }
}

export async function apiRequest<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'omniarab'
  };
  if (impersonationToken) {
    headers['X-Impersonate-Token'] = impersonationToken;
  }
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers,
    cache: 'no-store'
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'تعذّر الاتصال بالخادم، تأكد من الاتصال وحاول مجددًا');
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : 'حدث خطأ غير متوقع';
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T = Record<string, unknown>>(path: string) => apiRequest<T>('GET', path),
  post: <T = Record<string, unknown>>(path: string, body?: unknown) => apiRequest<T>('POST', path, body),
  put: <T = Record<string, unknown>>(path: string, body?: unknown) => apiRequest<T>('PUT', path, body),
  del: <T = Record<string, unknown>>(path: string, body?: unknown) => apiRequest<T>('DELETE', path, body)
};
