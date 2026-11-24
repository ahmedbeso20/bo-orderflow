import { NextRequest, NextResponse } from 'next/server';

const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/, '');

function notFoundResponse() {
  return new NextResponse(
    `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>404 — الصفحة غير موجودة | OrderFlow</title></head><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a;text-align:center"><div><h1 style="font-size:56px;margin:0;color:#0C5CA4">404</h1><p style="font-size:18px;font-weight:700">الصفحة المطلوبة غير موجودة</p><a href="/" style="color:#0C5CA4;font-weight:700">العودة إلى الرئيسية</a></div></body></html>`,
    {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    }
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isOwnerPath = pathname === '/owner' || pathname.startsWith('/owner/') || pathname === '/admin' || pathname.startsWith('/admin/');
  const isModPath = pathname === '/moderator' || pathname.startsWith('/moderator/');

  if (!isOwnerPath && !isModPath) {
    return NextResponse.next();
  }

  const cookie = request.headers.get('cookie') || '';
  if (!cookie.includes('omni_sid=')) {
    return notFoundResponse();
  }

  try {
    const res = await fetch(`${API_ORIGIN}/api/auth/me`, {
      method: 'GET',
      headers: {
        cookie,
        'x-requested-with': 'omniarab'
      },
      cache: 'no-store'
    });
    if (!res.ok) return notFoundResponse();

    const data = (await res.json()) as {
      authenticated?: boolean;
      me?: { role?: string; setup2faRequired?: boolean } | null;
      setup2faRequired?: boolean;
    };

    const role = data?.me?.role;
    if (data?.authenticated === false || !role) return notFoundResponse();

    if (isOwnerPath && role !== 'owner') {
      return notFoundResponse();
    }
    if (isModPath && role !== 'moderator' && role !== 'owner') {
      return notFoundResponse();
    }

    if (data.setup2faRequired || data.me?.setup2faRequired) {
      const url = request.nextUrl.clone();
      url.pathname = '/setup-2fa';
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  } catch {
    return notFoundResponse();
  }
}

export const config = {
  matcher: ['/owner', '/owner/:path*', '/admin', '/admin/:path*', '/moderator', '/moderator/:path*']
};
