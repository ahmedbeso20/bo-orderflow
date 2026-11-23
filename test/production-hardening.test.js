'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load: loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { generateTotpCode } = require('../src/auth');
const { assertSafeExternalUrlWithDns } = require('../src/connectors');
const { createMailer } = require('../src/mailer');

// صورة PNG حقيقية 1x1 صالحة (Magic Bytes: 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function startApp(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-prod-test-'));
  const inst = createApp({
    dbFile: overrides.dbFile ?? ':memory:',
    dataDir: tmpDir,
    backupDir: path.join(tmpDir, 'backups'),
    uploadsDir: path.join(tmpDir, 'uploads', 'products'),
    secret: 'prod-hardening-session-secret-at-least-32-chars!!',
    dataEncryptionKey: 'prod-hardening-data-enc-key-at-least-32-chars!!',
    ownerEmail: 'owner@hardened.eg',
    ownerPhone: '01099990009',
    ownerPassword: 'OwnerHard@2026!',
    ...overrides
  });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const { port } = inst.server.address();
  const base = `http://127.0.0.1:${port}`;
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'omniarab' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  const cleanup = async () => {
    await inst.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  };
  return { ...inst, base, req, tmpDir, cleanup };
}

async function loginAs(req, id, password, extra = {}) {
  const r = await req('POST', '/api/auth/login', { id, password, ...extra });
  return r;
}

async function loginStaffCookie(req, id, password) {
  const r = await req('POST', '/api/auth/login', { id, password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  let me = r.json.me;
  if (r.json && r.json.setup2faRequired) {
    const setup = await req('POST', '/api/account/2fa/setup', {}, { Cookie: cookie });
    assert.equal(setup.status, 200, JSON.stringify(setup.json));
    const en = await req('POST', '/api/account/2fa/enable', { code: generateTotpCode(setup.json.secret) }, { Cookie: cookie });
    assert.equal(en.status, 200, JSON.stringify(en.json));
    cookie = (en.headers.get('set-cookie') || '').split(';')[0] || cookie;
    me = en.json.me;
  }
  return { cookie, me };
}

describe('١. إلزام مفاتيح التشفير والجلسات في الإنتاج ومسار البيانات الافتراضي', () => {
  it('يرفض تشغيل الخادم (Throws Error) في production إذا كان SESSION_SECRET أو DATA_ENCRYPTION_KEY مفقودًا أو أقل من ٣٢ حرفًا', () => {
    const origEnv = {
      NODE_ENV: process.env.NODE_ENV,
      SESSION_SECRET: process.env.SESSION_SECRET,
      DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY
    };
    try {
      delete process.env.SESSION_SECRET;
      delete process.env.DATA_ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';

      assert.throws(() => loadConfig({ production: true, secret: '', dataEncryptionKey: 'a'.repeat(32) }), /SESSION_SECRET/);
      assert.throws(() => loadConfig({ production: true, secret: 'short-secret', dataEncryptionKey: 'a'.repeat(32) }), /SESSION_SECRET/);
      assert.throws(() => loadConfig({ production: true, secret: 'a'.repeat(32), dataEncryptionKey: '' }), /DATA_ENCRYPTION_KEY/);
      assert.throws(() => loadConfig({ production: true, secret: 'a'.repeat(32), dataEncryptionKey: 'too-short' }), /DATA_ENCRYPTION_KEY/);

      const okCfg = loadConfig({
        production: true,
        secret: 'a'.repeat(32),
        dataEncryptionKey: 'b'.repeat(32),
        dataDir: path.join(os.tmpdir(), 'of-cfg-ok')
      });
      assert.equal(okCfg.production, true);
      assert.equal(okCfg.secret.length, 32);
    } finally {
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('يستخدم مجلد data الدائم داخل المشروع كمسار افتراضي لـ dataDir بدلًا من os.tmpdir()', () => {
    const origDataDir = process.env.DATA_DIR;
    const origDbFile = process.env.DB_FILE;
    try {
      delete process.env.DATA_DIR;
      delete process.env.DB_FILE;
      const cfg = loadConfig({ production: false });
      assert.ok(cfg.dataDir.endsWith(path.sep + 'data'));
      assert.equal(cfg.dataDir.startsWith(os.tmpdir()), false);
      assert.ok(cfg.dbFile.startsWith(cfg.dataDir + path.sep));
      assert.ok(/\.(db|sqlite)$/i.test(cfg.dbFile));
    } finally {
      if (origDataDir !== undefined) process.env.DATA_DIR = origDataDir;
      if (origDbFile !== undefined) process.env.DB_FILE = origDbFile;
    }
  });
});

describe('٢. تشديد ترويسات CSP و X-Frame-Options وإعدادات الكوكي في الإنتاج', () => {
  it('يرسل frame-ancestors none و X-Frame-Options DENY و script-src بدون unsafe-inline وكوكي SameSite=Lax', async () => {
    const s = await startApp({ production: true });
    try {
      const health = await s.req('GET', '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('x-frame-options'), 'DENY');
      const csp = health.headers.get('content-security-policy') || '';
      assert.ok(csp.includes("frame-ancestors 'none'"), `CSP missing frame-ancestors 'none': ${csp}`);
      assert.ok(csp.includes("script-src 'self'"), `CSP missing script-src 'self': ${csp}`);
      assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, `script-src must not allow unsafe-inline: ${csp}`);

      const login = await loginAs(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie') || '';
      assert.ok(setCookie.includes('SameSite=Lax'), `Expected SameSite=Lax in cookie: ${setCookie}`);
      assert.ok(setCookie.includes('Secure'), `Expected Secure in production cookie: ${setCookie}`);
      assert.equal(setCookie.includes('SameSite=None'), false);
      assert.equal(setCookie.includes('Partitioned'), false);
    } finally {
      await s.cleanup();
    }
  });
});

describe('٣. حماية SSRF ضد DNS Rebinding ومنع إعادة التوجيه (Redirects)', () => {
  it('يرفض نطاقًا عامًا يُحل عبر DNS إلى عنوان IP محلي أو داخلي (127.0.0.1 / 169.254.169.254 / ::1)', async () => {
    await assert.rejects(
      () => assertSafeExternalUrlWithDns('https://evil-rebind.example.com/api', 'رابط خارجي', { lookupFn: async () => [{ address: '127.0.0.1', family: 4 }] }),
      /خاص|محلي/
    );
    await assert.rejects(
      () => assertSafeExternalUrlWithDns('https://meta-rebind.example.com/latest', 'رابط خارجي', { lookupFn: async () => [{ address: '169.254.169.254', family: 4 }] }),
      /خاص|محلي/
    );
    await assert.rejects(
      () => assertSafeExternalUrlWithDns('https://v6-rebind.example.com/', 'رابط خارجي', { lookupFn: async () => [{ address: '::1', family: 6 }] }),
      /خاص|محلي/
    );
    const okUrl = await assertSafeExternalUrlWithDns('https://partners-api.kenzz.com/health', 'رابط خارجي', { lookupFn: async () => [{ address: '93.184.216.34', family: 4 }] });
    assert.equal(okUrl, 'https://partners-api.kenzz.com/health');
  });

  it('يرفض استجابات إعادة التوجيه 3xx ويمرّر redirect: error في اتصالات الموصّلات', async () => {
    let seenRedirectOption = null;
    const s = await startApp({
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (url, opts) => {
        seenRedirectOption = opts.redirect;
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'http://127.0.0.1:8080/internal' }),
          text: async () => ''
        };
      }
    });
    try {
      const { cookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const auth = { Cookie: cookie };
      const saveConn = await s.req('PUT', '/api/integrations/connections/k', {
        credentials: { apiKey: 'test-kenzz-key-123456', storeId: 'KNZ-EG-8821' },
        environment: 'production'
      }, auth);
      assert.equal(saveConn.status, 200);
      const testRes = await s.req('POST', '/api/integrations/connections/k/test', {}, auth);
      assert.equal(testRes.status, 200);
      assert.equal(testRes.json.ok, false);
      assert.equal(seenRedirectOption, 'error');
      assert.match(testRes.json.message, /إعادة التوجيه/);
    } finally {
      await s.cleanup();
    }
  });
});

describe('٤. المصادقة الثنائية (2FA - TOTP) للمالك والمشرفين', () => {
  it('تفعّل TOTP الإلزامي للمالك وتفرض إدخال رمز 6 أرقام صالح أو كود استرداد وتمنع التعطيل للمالك', async () => {
    const s = await startApp();
    try {
      const login1 = await loginAs(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      assert.equal(login1.status, 200);
      assert.equal(login1.json.setup2faRequired, true);
      assert.equal(login1.json.token, undefined);
      const setupCookie = (login1.headers.get('set-cookie') || '').split(';')[0];
      const auth = { Cookie: setupCookie };

      const setup = await s.req('POST', '/api/account/2fa/setup', {}, auth);
      assert.equal(setup.status, 200);
      assert.ok(setup.json.secret && setup.json.secret.length >= 16);
      assert.ok(setup.json.otpauthUri.startsWith('otpauth://totp/'));
      assert.ok(setup.json.qrSvg.includes('<svg'));

      // رمز خاطئ يُرفض
      const badEnable = await s.req('POST', '/api/account/2fa/enable', { code: '000000' }, auth);
      assert.equal(badEnable.status, 400);

      // رمز TOTP صحيح يُفعّل 2FA ويُصدر أكواد استرداد
      const validCode = generateTotpCode(setup.json.secret);
      const enable = await s.req('POST', '/api/account/2fa/enable', { code: validCode }, auth);
      assert.equal(enable.status, 200);
      assert.equal(enable.json.totpEnabled, true);
      assert.equal(enable.json.recoveryCodes.length, 10);

      // محاولة الدخول بدون رمز تُرجع requires2fa + challengeToken دون إصدار جلسة
      const chal = await loginAs(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      assert.equal(chal.status, 200);
      assert.equal(chal.json.requires2fa, true);
      assert.ok(chal.json.challengeToken);
      assert.equal(chal.json.token, undefined);

      // رمز خاطئ في /api/auth/login/2fa يُرفض بـ 401
      const bad2fa = await s.req('POST', '/api/auth/login/2fa', {
        challengeToken: chal.json.challengeToken,
        code: '999999'
      });
      assert.equal(bad2fa.status, 401);

      // كود استرداد صالح يُكمل الدخول ويصدر كوكي جلسة المالك (بدون token في JSON)
      const good2fa = await s.req('POST', '/api/auth/login/2fa', {
        challengeToken: chal.json.challengeToken,
        code: enable.json.recoveryCodes[0]
      });
      assert.equal(good2fa.status, 200);
      assert.equal(good2fa.json.ok, true);
      assert.equal(good2fa.json.token, undefined);
      assert.equal(good2fa.json.me.totpEnabled, true);
      const fullCookie = (good2fa.headers.get('set-cookie') || '').split(';')[0];

      // تعطيل 2FA ممنوع لحسابات المالك والمشرفين (403 2FA_MANDATORY_FOR_STAFF)
      const dis = await s.req('POST', '/api/account/2fa/disable', {
        password: 'OwnerHard@2026!',
        code: enable.json.recoveryCodes[1]
      }, { Cookie: fullCookie });
      assert.equal(dis.status, 403);
      assert.equal(dis.json.code, '2FA_MANDATORY_FOR_STAFF');
    } finally {
      await s.cleanup();
    }
  });
});

describe('٥. جدول العملاء الحقيقي (Migration 8) وربط الطلبات دون دمج أصحاب الاسم المتشابه', () => {
  it('يربط الطلبات بـ customer_id ولا يدمج عميلين لهما نفس الاسم وأرقام هواتف مختلفة، ويدعم CRUD والملاحظات', async () => {
    const s = await startApp();
    try {
      const { cookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const auth = { Cookie: cookie };

      const pRes = await s.req('POST', '/api/products', {
        name: 'سماعة اختبار CRM',
        sku: 'CRM-100',
        price: 500,
        cost: 250,
        stock: 50,
        markets: 'an'
      }, auth);
      assert.equal(pRes.status, 200);
      const pid = pRes.json.product.id;

      // طلب أول لـ "أحمد محمد" برقم هاتف 01011112222
      const o1 = await s.req('POST', '/api/orders', {
        market: 'a',
        customer: 'أحمد محمد',
        phone: '01011112222',
        gov: 'القاهرة',
        pay: 'عند الاستلام',
        courier: 'بوسطة',
        items: [{ productId: pid, qty: 1 }]
      }, auth);
      assert.equal(o1.status, 200);
      assert.ok(o1.json.order.customerId > 0);

      // طلب ثانٍ لنفس الاسم "أحمد محمد" ولكن برقم هاتف مختلف 01033334444 -> يجب عدم الدمج!
      const o2 = await s.req('POST', '/api/orders', {
        market: 'n',
        customer: 'أحمد محمد',
        phone: '01033334444',
        gov: 'الإسكندرية',
        pay: 'إنستاباي',
        courier: 'أرامكس',
        items: [{ productId: pid, qty: 2 }]
      }, auth);
      assert.equal(o2.status, 200);
      assert.ok(o2.json.order.customerId > 0);
      assert.notEqual(o1.json.order.customerId, o2.json.order.customerId, 'يجب عدم دمج عميلين بنفس الاسم ورقمي هاتف مختلفين');

      // طلب ثالث لنفس رقم هاتف العميل الأول -> يجب ربطه بنفس العميل الأول
      const o3 = await s.req('POST', '/api/orders', {
        market: 'a',
        customer: 'أحمد محمد علي',
        phone: '01011112222',
        gov: 'القاهرة',
        pay: 'فودافون كاش',
        courier: 'بوسطة',
        items: [{ productId: pid, qty: 1 }]
      }, auth);
      assert.equal(o3.status, 200);
      assert.equal(o3.json.order.customerId, o1.json.order.customerId);

      // GET /api/customers يعيد العميلين منفصلين مع إحصائيات orders الصحيحة
      const list = await s.req('GET', '/api/customers', undefined, auth);
      assert.equal(list.status, 200);
      assert.equal(list.json.customers.length, 2);
      const c1 = list.json.customers.find((c) => c.phone === '01011112222');
      const c2 = list.json.customers.find((c) => c.phone === '01033334444');
      assert.equal(c1.ordersCount, 2);
      assert.equal(c1.totalSpent, 1000);
      assert.equal(c2.ordersCount, 1);
      assert.equal(c2.totalSpent, 1000);

      // PUT /api/customers/:id لتعديل البيانات وإضافة ملاحظات ووسوم
      const upd = await s.req('PUT', `/api/customers/${c1.id}`, {
        notes: 'عميل ممتاز يفضّل التوصيل مساءً',
        tags: 'VIP'
      }, auth);
      assert.equal(upd.status, 200);
      assert.equal(upd.json.customer.notes, 'عميل ممتاز يفضّل التوصيل مساءً');
      assert.equal(upd.json.customer.tags, 'VIP');

      // POST /api/customers + DELETE /api/customers/:id
      const created = await s.req('POST', '/api/customers', {
        name: 'سارة محمود',
        phone: '01122334455',
        gov: 'الجيزة',
        notes: 'استفسار جملة'
      }, auth);
      assert.equal(created.status, 200);
      const del = await s.req('DELETE', `/api/customers/${created.json.customer.id}`, undefined, auth);
      assert.equal(del.status, 200);
    } finally {
      await s.cleanup();
    }
  });
});

describe('٦. النسخ الاحتياطي التلقائي واليدوي لـ SQLite وتخزين صور المنتجات بـ Magic Bytes', () => {
  it('ينشئ نسخة احتياطية عبر POST /api/owner/backup (VACUUM INTO) ويحتفظ بآخر ٧ نسخ فقط', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-bkp-test-'));
    const s = await startApp({
      dbFile: path.join(tmpDir, 'live.sqlite'),
      backupDir: path.join(tmpDir, 'backups')
    });
    try {
      const { cookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const auth = { Cookie: cookie };

      for (let i = 0; i < 9; i++) {
        const b = await s.req('POST', '/api/owner/backup', {}, auth);
        assert.equal(b.status, 200);
        assert.equal(b.json.ok, true);
        assert.ok(b.json.backup.size > 0);
      }

      const list = await s.req('GET', '/api/owner/backups', undefined, auth);
      assert.equal(list.status, 200);
      assert.equal(list.json.backups.length, 7, 'يجب الاحتفاظ بآخر 7 نسخ احتياطية فقط');
    } finally {
      await s.cleanup();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('يرفض ملفًا مزوّرًا لا يطابق Magic Bytes ويحفظ PNG صالحًا على القرص ويقدّمه بأمان', async () => {
    const s = await startApp();
    try {
      const { cookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const auth = { Cookie: cookie };

      // ملف نصي مموّه بامتداد PNG
      const fakePng = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>not-a-png-file').toString('base64');
      const badUp = await s.req('POST', '/api/products/upload-image', { dataUrl: fakePng }, auth);
      assert.equal(badUp.status, 400);
      assert.match(badUp.json.error, /Magic Bytes|صالحة/);

      // صورة PNG حقيقية تُحفظ كملف على القرص وليس Base64 داخل SQLite
      const prod = await s.req('POST', '/api/products', {
        name: 'منتج بصورة حقيقية',
        sku: 'IMG-1',
        price: 200,
        cost: 100,
        stock: 10,
        markets: 'a',
        image: VALID_PNG_DATA_URL
      }, auth);
      assert.equal(prod.status, 200);
      assert.ok(prod.json.product.image.startsWith('/api/uploads/products/'));
      assert.ok(prod.json.product.image.endsWith('.png'));

      const imgRes = await s.req('GET', prod.json.product.image);
      assert.equal(imgRes.status, 200);
      assert.equal(imgRes.headers.get('content-type'), 'image/png');
      assert.equal(imgRes.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await s.cleanup();
    }
  });
});

describe('٧. البريد الإلكتروني الحقيقي (HTTP API) وانتهاء الباقات والمزامنة المجدولة والإيصالات والشحن', () => {
  it('يرسل البريد عبر HTTP API (Resend) عند ضبط MAIL_API_KEY و MAIL_FROM باستخدام fetch وهمي', async () => {
    const calls = [];
    const mailer = createMailer({
      mailApiKey: 're_test_123456',
      mailFrom: 'OrderFlow <noreply@orderflow.eg>',
      mailApiUrl: 'https://api.resend.com/emails',
      fetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'email_999' })
        };
      }
    });
    const r = await mailer.send({
      to: 'merchant@store.eg',
      subject: 'تأكيد البريد',
      text: 'رمز التفعيل 123456'
    });
    assert.equal(r.delivered, true);
    assert.equal(r.provider, 'resend');
    assert.equal(r.providerId, 'email_999');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.authorization, 'Bearer re_test_123456');
    assert.equal(calls[0].body.to[0], 'merchant@store.eg');
  });

  it('يخفّض الباقة المنتهية تلقائيًا إلى free عند انتهاء plan_expires_at ويشعر التاجر ويرسل تذكير الـ 3 أيام', async () => {
    const sentEmails = [];
    const s = await startApp({
      mailApiKey: 're_live_stub',
      mailFrom: 'noreply@orderflow.eg',
      fetch: async (url, init) => {
        sentEmails.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'em_1' }) };
      }
    });
    try {
      // نسجّل تاجرين ونفعّلهما
      const { cookie: oCookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const oAuth = { Cookie: oCookie };

      const reg1 = await s.req('POST', '/api/auth/register', {
        store: 'متجر منتهي الباقة',
        phone: '01055551111',
        email: 'expired@store.eg',
        password: 'Merchant@2026!',
        termsAccepted: true
      });
      const uid1 = reg1.json.account.id;
      await s.req('POST', `/api/owner/clients/${uid1}/approve`, {}, oAuth);

      const reg2 = await s.req('POST', '/api/auth/register', {
        store: 'متجر قريب الانتهاء',
        phone: '01055552222',
        email: 'soon@store.eg',
        password: 'Merchant@2026!',
        termsAccepted: true
      });
      const uid2 = reg2.json.account.id;
      await s.req('POST', `/api/owner/clients/${uid2}/approve`, {}, oAuth);

      // نضبط الباقة المنتهية بالأمس والباقة القريبة بعد يومين
      const past = new Date(Date.now() - 86400_000).toISOString();
      const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
      s.app.q("UPDATE users SET plan = 'pro', plan_expires_at = ? WHERE id = ?").run(past, uid1);
      s.app.q("UPDATE users SET plan = 'pro', plan_expires_at = ? WHERE id = ?").run(soon, uid2);

      // تشغيل purge() التلقائي
      s.app.runPurge();
      await new Promise((r) => setTimeout(r, 20));

      const u1 = s.app.q('SELECT * FROM users WHERE id = ?').get(uid1);
      assert.equal(u1.plan, 'free', 'يجب تخفيض الباقة المنتهية تلقائيًا إلى free');
      assert.equal(u1.plan_expires_at, null);

      const u2 = s.app.q('SELECT * FROM users WHERE id = ?').get(uid2);
      assert.equal(u2.plan, 'pro', 'الباقة السارية لا تُخفّض');
      assert.ok(u2.plan_reminded_at, 'يجب تسجيل إرسال تذكير قبل 3 أيام');

      // التحقق من وصول البريد الإلكتروني وإشعارات النظام
      assert.ok(sentEmails.some((e) => e.to[0] === 'expired@store.eg'));
      assert.ok(sentEmails.some((e) => e.to[0] === 'soon@store.eg'));

      // التحقق أيضًا من أن model.planOf يفرض التخفيض الفوري حتى قبل تشغيل purge
      s.app.q("UPDATE users SET plan = 'business', plan_expires_at = ? WHERE id = ?").run(past, uid1);
      const freshU1 = s.app.q('SELECT * FROM users WHERE id = ?').get(uid1);
      const planInfo = s.app.model.planOf(freshU1);
      assert.equal(planInfo.id, 'free');
    } finally {
      await s.cleanup();
    }
  });

  it('يستخدم الاسم القانوني والرقم الضريبي الديناميكيين في إيصال الاشتراك بدل القيمة الثابتة', async () => {
    const s = await startApp({ allowPlanSelfService: true });
    try {
      const { cookie: oCookie, me: ownerMe } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const oAuth = { Cookie: oCookie };

      const upd = await s.req('PUT', '/api/owner/settings', {
        platform_legal_name: 'شركة أوردر فلو الحديثة ش.م.م',
        platform_tax_id: '777-888-999'
      }, oAuth);
      assert.equal(upd.status, 200);

      // إنشاء إيصال مدفوع للتجربة
      const now = new Date().toISOString();
      const payId = Number(s.app.q(`INSERT INTO plan_payments (user_id, tx_ref, plan, cycle, method, amount, vat, discount, coupon, payer_info, status, period_start, period_end, created_at)
        VALUES (?, 'OF-REC-777', 'pro', 'monthly', 'card', 1000, 122.81, 0, '', 'card', 'paid', ?, ?, ?)`).run(ownerMe.id, now, now, now).lastInsertRowid);

      const rec = await s.req('GET', `/api/billing/payments/${payId}/receipt`, undefined, oAuth);
      assert.equal(rec.status, 200);
      assert.ok(rec.text.includes('شركة أوردر فلو الحديثة ش.م.م'));
      assert.ok(rec.text.includes('777-888-999'));
      assert.equal(rec.text.includes('310-554-890'), false, 'يجب إزالة الرقم الضريبي الثابت القديم 310-554-890');
    } finally {
      await s.cleanup();
    }
  });

  it('يدعم ربط Bosta API لإنشاء بوليصة AWB وتتبع الشحنة مع توضيح أن تسوية COD محاسبية يدوية', async () => {
    const s = await startApp({
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (url, init) => {
        if (url.includes('/pickup-locations')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ _id: 'loc_1' }] }) };
        }
        if (url.includes('/deliveries') && init.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ trackingNumber: 'BOSTA-987654', state: { value: 'Pickup requested' } }) };
        }
        if (url.includes('/deliveries/business/BOSTA-987654')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ trackingNumber: 'BOSTA-987654', state: { value: 'In Transit' } }) };
        }
        return { ok: false, status: 404, text: async () => '{}' };
      }
    });
    try {
      const { cookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const auth = { Cookie: cookie };

      // فحص إشعار COD المحاسبي اليدوي
      const cod = await s.req('GET', '/api/cod', undefined, auth);
      assert.equal(cod.status, 200);
      assert.equal(cod.json.accountingMode, 'manual');
      assert.ok(cod.json.accountingNotice.includes('محاسبي'));

      // حفظ واختبار مفتاح Bosta API
      const save = await s.req('PUT', '/api/couriers/connections/bosta', {
        credentials: { apiKey: 'bosta_live_secret_key_123456' },
        environment: 'production',
        testNow: true
      }, auth);
      assert.equal(save.status, 200);
      assert.equal(save.json.testResult.ok, true);

      // إنشاء منتج وطلب ثم إصدار بوليصة Bosta AWB وتتبّعها
      const p = await s.req('POST', '/api/products', {
        name: 'منتج شحن بوسطة', sku: 'BST-1', price: 300, cost: 150, stock: 10, markets: 'a'
      }, auth);
      const o = await s.req('POST', '/api/orders', {
        market: 'a', customer: 'كريم شحن', phone: '01077778888', gov: 'القاهرة', address: 'المعادي',
        pay: 'عند الاستلام', courier: 'بوسطة',
        items: [{ productId: p.json.product.id, qty: 1 }]
      }, auth);
      assert.equal(o.status, 200);

      const awb = await s.req('POST', `/api/orders/${o.json.order.id}/awb/create`, { courier: 'bosta' }, auth);
      assert.equal(awb.status, 200);
      assert.equal(awb.json.awbNumber, 'BOSTA-987654');

      const track = await s.req('POST', `/api/orders/${o.json.order.id}/awb/track`, {}, auth);
      assert.equal(track.status, 200);
      assert.equal(track.json.courierStatus, 'In Transit');
    } finally {
      await s.cleanup();
    }
  });

  it('تشغّل المزامنة المجدولة syncAllActiveConnections للربط النشط وتُشعر التاجر بالطلبات الجديدة وتمنع التداخل المتزامن', async () => {
    const s = await startApp({
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (url) => {
        if (url.includes('/store')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'KNZ-EG-8821', name: 'متجر كنز' }) };
        }
        if (url.includes('/products')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ sku: 'KNZ-AUTO-1', name: 'منتج مزامنة تلقائية', price: 250, cost: 120, stock: 15 }] }) };
        }
        if (url.includes('/orders')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'ORD-KNZ-900', customerName: 'عميل مزامنة', phone: '01066667777', city: 'القاهرة', total: 250, paymentMethod: 'cod', status: 'pending', items: [{ name: 'منتج مزامنة تلقائية', qty: 1, price: 250 }] }] }) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      }
    });
    try {
      const { cookie } = await loginStaffCookie(s.req, 'owner@hardened.eg', 'OwnerHard@2026!');
      const auth = { Cookie: cookie };
      await s.req('PUT', '/api/integrations/connections/k', {
        credentials: { apiKey: 'knz_auto_secret_123456', storeId: 'KNZ-EG-8821' },
        environment: 'production',
        testNow: true
      }, auth);

      // تشغيل المزامنة المجدولة مع استدعاء متزامن للتأكد من منع التداخل
      const [r1, r2] = await Promise.all([
        s.app.connectors.syncAllActiveConnections(),
        s.app.connectors.syncAllActiveConnections()
      ]);
      assert.equal(r1.skipped, false);
      assert.equal(r1.count, 1);
      assert.equal(r2.skipped, true, 'الاستدعاء المتزامن الثاني يجب أن يُتجاوز لمنع التداخل');

      const notifs = await s.req('GET', '/api/notifications', undefined, auth);
      assert.ok(notifs.json.notifications.some((n) => n.body.includes('المزامنة التلقائية')));
    } finally {
      await s.cleanup();
    }
  });
});
