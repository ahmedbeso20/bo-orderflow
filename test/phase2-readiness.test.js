'use strict';
// اختبارات شاملة للمرحلة 1 + المرحلة 2: سد ثغرة 2FA، حذف الحساب مع الأرشفة الضريبية، SMS OTP، تدوير المفتاح، Cloudflare Turnstile، وفحص جاهزية الإنتاج
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/app');
const { generateTotpCode } = require('../src/auth');
const { rotateEncryptionKey } = require('../scripts/rotate-encryption-key');

class Client {
  constructor(base, ip = '10.20.0.1') {
    this.base = base;
    this.ip = ip;
    this.jar = '';
  }
  async call(method, urlPath, body, extra = {}) {
    const headers = { 'x-forwarded-for': this.ip, ...extra };
    if (method !== 'GET' && !('x-requested-with' in headers)) headers['x-requested-with'] = 'omniarab';
    if (this.jar) headers.cookie = this.jar;
    if (body !== undefined && typeof body !== 'string') headers['content-type'] = 'application/json';
    const res = await fetch(this.base + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const pair = sc.split(';')[0];
      this.jar = pair.endsWith('=') ? '' : pair;
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b = {}, h) { return this.call('POST', p, b, h); }
  put(p, b = {}, h) { return this.call('PUT', p, b, h); }
  del(p, b, h) { return this.call('DELETE', p, b, h); }
}

async function start(opts = {}) {
  const app = createApp({
    dbFile: ':memory:',
    secret: 's'.repeat(48),
    dataEncryptionKey: 'd'.repeat(48),
    trustProxy: true,
    geminiKey: '',
    ownerEmail: 'owner@orderflow.eg',
    ownerPhone: '01099990000',
    ownerPassword: 'OwnerStrong@2026!',
    ...opts
  });
  app.db.prepare("UPDATE platform_settings SET value = '0' WHERE key = 'require_client_approval'").run();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let seq = 0;
  return { app, base, client: (ip) => new Client(base, ip || `10.88.0.${++seq}`) };
}

async function loginOwner(client) {
  const login = await client.post('/api/auth/login', { id: 'owner@orderflow.eg', password: 'OwnerStrong@2026!' });
  assert.equal(login.status, 200);
  if (login.data.setup2faRequired) {
    const setup = await client.post('/api/account/2fa/setup');
    const code = generateTotpCode(setup.data.secret);
    const en = await client.post('/api/account/2fa/enable', { code });
    assert.equal(en.status, 200);
    return setup.data.secret;
  }
  return null;
}

// 1. منع تجاوز المصادقة الثنائية (2FA Bypass) عند استعادة كلمة المرور عبر البريد وSMS OTP
test('Phase 1.1: استعادة كلمة المرور لحساب مفعّل عليه 2FA لا تصدر جلسة كاملة وتُجبر التحقق الثنائي', async (t) => {
  const s = await start({ smsProvider: 'console' });
  t.after(() => s.app.close());

  const c = s.client('10.21.0.1');
  const reg = await c.post('/api/auth/register', {
    store: 'متجر الحماية', phone: '01012345678', email: 'sec2fa@store.eg', password: 'InitPassword@2026!', termsAccepted: true
  });
  assert.equal(reg.status, 200);

  // تفعيل 2FA للتاجر
  const setup = await c.post('/api/account/2fa/setup');
  assert.equal(setup.status, 200);
  const enableCode = generateTotpCode(setup.data.secret);
  const en = await c.post('/api/account/2fa/enable', { code: enableCode });
  assert.equal(en.status, 200);
  const recovery1 = en.data.recoveryCodes[0];
  const recovery2 = en.data.recoveryCodes[1];

  // أ) استعادة عبر البريد الإلكتروني
  const anon = s.client('10.21.0.2');
  const fgEmail = await anon.post('/api/auth/forgot-password', { id: 'sec2fa@store.eg' });
  assert.equal(fgEmail.status, 200);
  const resetToken = fgEmail.data.devToken || s.app.mailer.outbox.find((m) => m.type === 'reset_password')?.token;
  assert.ok(resetToken, 'يجب إصدار رمز استعادة كلمة المرور');

  const reset1 = await anon.post('/api/auth/reset-password', { token: resetToken, password: 'UpdatedPass@2026!' });
  assert.equal(reset1.status, 200, JSON.stringify(reset1.data));
  assert.equal(reset1.data.passwordReset, true);
  assert.equal(reset1.data.requires2fa, true);
  assert.ok(reset1.data.challengeToken, 'يُعاد challengeToken لاستكمال التحقق الثنائي');
  // التأكد من عدم إصدار جلسة دخول كاملة
  const unauthBoot = await anon.get('/api/bootstrap');
  assert.equal(unauthBoot.status, 401, 'لا يمكن دخول لوحة التحكم بدون إتمام 2FA');

  // إتمام التحقق بكود استرداد
  const finish1 = await anon.post('/api/auth/login/2fa', { challengeToken: reset1.data.challengeToken, code: recovery1 });
  assert.equal(finish1.status, 200);
  assert.equal((await anon.get('/api/bootstrap')).status, 200);

  // ب) استعادة عبر SMS OTP
  const anon2 = s.client('10.21.0.3');
  const fgSms = await anon2.post('/api/auth/forgot-password', { id: '01012345678', viaSms: true });
  assert.equal(fgSms.status, 200);
  assert.ok(fgSms.data.devOtp);

  const reset2 = await anon2.post('/api/auth/reset-password/otp', {
    phone: '01012345678', code: fgSms.data.devOtp, password: 'UpdatedPass2@2026!'
  });
  assert.equal(reset2.status, 200, JSON.stringify(reset2.data));
  assert.equal(reset2.data.requires2fa, true);
  assert.ok(reset2.data.challengeToken);
  assert.equal((await anon2.get('/api/bootstrap')).status, 401, 'ممنوع إصدار جلسة بعد OTP reset إذا كان 2FA مفعّلًا');

  const finish2 = await anon2.post('/api/auth/login/2fa', { challengeToken: reset2.data.challengeToken, code: recovery2 });
  assert.equal(finish2.status, 200);

  // التحقق من تسجيل security.password_reset في audit_log
  const audits = s.app.db.prepare("SELECT * FROM audit_log WHERE action = 'security.password_reset'").all();
  assert.equal(audits.length, 2);
});

// 2. حماية DELETE /api/account بـ 2FA + أرشفة plan_payments ضريبيًا
test('Phase 1.2: DELETE /api/account يفرض 2FA عند التفعيل ويؤرشف plan_payments في anonymized_payments', async (t) => {
  const s = await start();
  t.after(() => s.app.close());

  const c = s.client('10.22.0.1');
  const reg = await c.post('/api/auth/register', {
    store: 'متجر الأرشفة', phone: '01023456789', email: 'arch@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  assert.equal(reg.status, 200);
  const uid = reg.data.me.id;

  // دفع اشتراك حتى يتم التحقق من أرشفته
  const pay = await c.post('/api/billing/checkout', {
    plan: 'pro', cycle: 'monthly', method: 'wallet', walletPhone: '01023456789', walletOtp: '123456'
  });
  assert.equal(pay.status, 200);

  // تفعيل 2FA
  const setup = await c.post('/api/account/2fa/setup');
  const en = await c.post('/api/account/2fa/enable', { code: generateTotpCode(setup.data.secret) });
  assert.equal(en.status, 200);

  // رفض الحذف بدون كود 2FA
  const denied = await c.del('/api/account', { password: 'StrongPass@2026!' });
  assert.equal(denied.status, 401);
  assert.equal(denied.data.code, '2FA_REQUIRED');

  // نجاح الحذف مع كود استرداد وأرشفة الفاتورة
  const okDel = await c.del('/api/account', { password: 'StrongPass@2026!', code: en.data.recoveryCodes[0] });
  assert.equal(okDel.status, 200);
  assert.equal(s.app.db.prepare('SELECT id FROM users WHERE id = ?').get(uid), undefined);
  const archived = s.app.db.prepare('SELECT * FROM anonymized_payments').all();
  assert.equal(archived.length, 1, 'تم حفظ فاتورة الاشتراك في anonymized_payments قبل حذف الحساب');
});

// 3. إصلاح SMS OTP: تمرير النص بنجاح + إبطال الرمز عند فشل المزوّد (502)
test('Phase 1.3: SMS OTP يمرّر النص الفعلي للمزوّد ويُبطل الرمز ويرجع 502 عند فشل الإرسال', async (t) => {
  const captured = [];
  let shouldFail = false;
  const origFetch = global.fetch;
  const mockSmsFetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://sms.example.test/')) {
      captured.push(JSON.parse(init.body));
      if (shouldFail) {
        return { ok: false, status: 503, text: async () => 'Gateway Down', json: async () => ({ error: 'down' }) };
      }
      return { ok: true, status: 200, text: async () => 'OK', json: async () => ({ ok: true }) };
    }
    return origFetch(url, init);
  };
  global.fetch = mockSmsFetch;
  t.after(() => { global.fetch = origFetch; });

  const s = await start({
    smsProvider: 'http',
    smsApiUrl: 'https://sms.example.test/send',
    smsApiKey: 'test-key'
  });
  t.after(() => s.app.close());

  const c = s.client('10.23.0.1');
  await c.post('/api/auth/register', {
    store: 'متجر الرسائل', phone: '01034567890', email: 'sms@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });

  // إرسال ناجح
  const okSend = await c.post('/api/account/verify-phone/send');
  assert.equal(okSend.status, 200, JSON.stringify(okSend.data));
  assert.equal(captured.length, 1);
  assert.ok(captured[0].message && captured[0].message.includes('OrderFlow'), 'يجب إرسال نص رسالة غير فارغ لمزوّد SMS');

  // إرسال فاشل -> 502 وإبطال الرمز
  s.app.app.limiter.reset('otp-cool:01034567890');
  shouldFail = true;
  const failSend = await c.post('/api/account/verify-phone/send');
  assert.equal(failSend.status, 502, JSON.stringify(failSend.data));
  const activeTokens = s.app.db.prepare("SELECT COUNT(*) n FROM auth_tokens WHERE type = 'phone_otp' AND used_at IS NULL").get().n;
  assert.equal(activeTokens, 0, 'لا يجب بقاء رمز OTP نشط بعد فشل الإرسال');
});

// 4. توحيد تطبيع الهاتف والأرقام العربية وتشفير customers.email أثناء تدوير المفتاح
test('Phase 1.4 & 1.5: تدوير المفتاح يوحّد phone_hash للهواتف (+20 والأرقام العربية) ويشفّر customers.email', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-rot-norm-'));
  const dbPath = path.join(tmpDir, 'rot.db');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const oldKey = 'old-key-32-chars-minimum-secret-1111';
  const newKey = 'new-key-32-chars-minimum-secret-2222';

  const s1 = await start({ dbFile: dbPath, dataDir: tmpDir, dataEncryptionKey: oldKey });
  const c1 = s1.client('10.24.0.1');
  await c1.post('/api/auth/register', {
    store: 'متجر التطبيع', phone: '01045678901', email: 'norm@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  const cust = await c1.post('/api/customers', {
    name: 'عميل بريد مشفر',
    phone: '+201055551234',
    email: 'buyer@secret.eg',
    gov: 'القاهرة',
    address: 'الزمالك'
  });
  assert.equal(cust.status, 200, JSON.stringify(cust.data));

  // التأكد من تشفير البريد الإلكتروني في قاعدة البيانات
  const rawCust = s1.app.db.prepare('SELECT email, phone_hash FROM customers WHERE id = ?').get(cust.data.customer.id);
  assert.ok(rawCust.email.startsWith('enc:v1:'), 'customers.email يجب أن يكون مشفرًا');
  await s1.app.close();

  // تدوير المفتاح
  rotateEncryptionKey({ dbPath, oldKey, newKey });

  // إعادة الفتح بالمفتاح الجديد + إضافة طلب برقم عربي لنفس العميل -> يجب أن يندمج عبر نفس phone_hash
  const s2 = await start({ dbFile: dbPath, dataDir: tmpDir, dataEncryptionKey: newKey });
  t.after(() => s2.app.close());
  const c2 = s2.client('10.24.0.2');
  await c2.post('/api/auth/login', { id: '01045678901', password: 'StrongPass@2026!' });

  const prod = await c2.post('/api/products', { name: 'منتج أ', sku: 'NRM-1', price: 100, cost: 50, stock: 5, markets: 'a' });
  const ord = await c2.post('/api/orders', {
    market: 'a', customer: 'عميل بريد مشفر', phone: '٠١٠٥٥٥٥١٢٣٤', gov: 'القاهرة', address: 'الزمالك',
    pay: 'عند الاستلام', courier: 'بوسطة', items: [{ productId: prod.data.product.id, qty: 1 }]
  });
  assert.equal(ord.status, 200, JSON.stringify(ord.data));

  const list = await c2.get('/api/customers');
  assert.equal(list.data.customers.length, 1, 'يجب دمج +201055551234 مع ٠١٠٥٥٥٥١٢٣٤ بعد تدوير المفتاح');
  assert.equal(list.data.customers[0].email, 'buyer@secret.eg');
});

// 5. Cloudflare Turnstile على المسارات العامة (رفض/قبول + عدم تسريب السر)
test('Phase 2.1: Cloudflare Turnstile يرفض غياب/بطلان التوكن ويقبل التوكن الصالح ولا يسرّب السر', async (t) => {
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      const bodyStr = String(init.body || '');
      const valid = bodyStr.includes('response=valid-cf-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: valid, 'error-codes': valid ? [] : ['invalid-input-response'] })
      };
    }
    return origFetch(url, init);
  };
  t.after(() => { global.fetch = origFetch; });

  const s = await start({
    turnstileSiteKey: '0x4AAAAAA-public-site-key',
    turnstileSecretKey: '0x4AAAAAA-super-secret-key'
  });
  t.after(() => s.app.close());

  const c = s.client('10.25.0.1');
  const authCfg = await c.get('/api/auth/config');
  assert.equal(authCfg.status, 200);
  assert.equal(authCfg.data.turnstileEnabled, true);
  assert.equal(authCfg.data.turnstileSiteKey, '0x4AAAAAA-public-site-key');
  assert.equal(JSON.stringify(authCfg.data).includes('super-secret-key'), false, 'عدم تسريب TURNSTILE_SECRET_KEY');

  // رفض بدون توكن
  const noTokReg = await c.post('/api/auth/register', {
    store: 'متجر بدون كابتشا', phone: '01056789012', email: 'nocap@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  assert.equal(noTokReg.status, 400);
  assert.equal(noTokReg.data.code, 'CAPTCHA_REQUIRED');

  // رفض توكن خاطئ على /api/contact و /api/consultations و /api/auth/forgot-password
  const badContact = await c.post('/api/contact', {
    name: 'زائر', contact: '01056789012', subject: 'استفسار', message: 'رسالة اختبارية للتواصل', turnstileToken: 'bad-token'
  });
  assert.equal(badContact.status, 400);
  assert.equal(badContact.data.code, 'CAPTCHA_FAILED');

  const badConsult = await c.post('/api/consultations', {
    serviceKey: 'setup', name: 'زائر', phone: '01056789012', turnstileToken: 'bad-token'
  });
  assert.equal(badConsult.status, 400);

  const badForgot = await c.post('/api/auth/forgot-password', { id: '01056789012', turnstileToken: 'bad-token' });
  assert.equal(badForgot.status, 400);

  // قبول توكن صالح
  const okReg = await c.post('/api/auth/register', {
    store: 'متجر بكابتشا', phone: '01056789012', email: 'okcap@store.eg', password: 'StrongPass@2026!', termsAccepted: true,
    turnstileToken: 'valid-cf-token'
  });
  assert.equal(okReg.status, 200, JSON.stringify(okReg.data));

  const okContact = await c.post('/api/contact', {
    name: 'زائر', contact: '01056789012', subject: 'استفسار', message: 'رسالة اختبارية للتواصل بنجاح', turnstileToken: 'valid-cf-token'
  });
  assert.equal(okContact.status, 200);
});

// 6. فحص جاهزية الإنتاج للمالك، S3 upload status، و PII log في مسارات المالك والمشرف
test('Phase 2.2: جاهزية الإنتاج للمالك، حالة رفع S3، وتسجيل pii_access_log عند استعراض طلبات العملاء', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-s3-readiness-'));
  const dbPath = path.join(tmpDir, 'ready.db');
  const backupDir = path.join(tmpDir, 'backups');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://s3.example.test/')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
    }
    return origFetch(url, init);
  };
  t.after(() => { global.fetch = origFetch; });

  const s = await start({
    dbFile: dbPath,
    dataDir: tmpDir,
    backupDir,
    backupEncryptionKey: 'backup-secret-key-32-chars-minimum!!',
    backupS3Endpoint: 'https://s3.example.test',
    backupS3Bucket: 'orderflow-backups',
    backupS3AccessKey: 'AKIA-TEST-KEY',
    backupS3Secret: 'S3-SUPER-SECRET-NEVER-LEAK',
    smsProvider: 'console'
  });
  t.after(() => s.app.close());

  const owner = s.client('10.26.0.1');
  await loginOwner(owner);

  // readiness بدون تسريب أي أسرار
  const ready = await owner.get('/api/owner/readiness');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.backup.encryptionConfigured, true);
  assert.equal(ready.data.backup.s3Configured, true);
  assert.match(ready.data.kashier.webhookUrl, /\/api\/billing\/webhook\/kashier$/);
  const rawJson = JSON.stringify(ready.data);
  assert.equal(rawJson.includes('S3-SUPER-SECRET-NEVER-LEAK'), false, 'عدم تسريب أسرار S3');

  // اختبار اتصال S3
  const s3Test = await owner.post('/api/owner/backups/test-s3');
  assert.equal(s3Test.status, 200);
  assert.equal(s3Test.data.ok, true);

  // إنشاء نسخة احتياطية وانتظار رفعها إلى S3 والتحقق من تحديث systemStatus و /api/owner/backups
  const bk = s.app.createBackup();
  assert.ok(bk.uploadPromise);
  await bk.uploadPromise;
  const backupsRes = await owner.get('/api/owner/backups');
  assert.equal(backupsRes.status, 200);
  assert.match(backupsRes.data.lastBackupUpload.status, /^uploaded:/);
  assert.ok(backupsRes.data.lastBackupUpload.uploadedAt);

  // اختبار SMS وتنبيه أمني ومطابقة المدفوعات من لوحة المالك
  const smsTest = await owner.post('/api/owner/sms/test', { to: '01099990000' });
  assert.equal(smsTest.status, 200);
  assert.equal(smsTest.data.ok, true);

  const alertTest = await owner.post('/api/owner/alerts/test');
  assert.equal(alertTest.status, 200);
  assert.ok(alertTest.data.eventId);

  const recRes = await owner.post('/api/owner/payments/reconcile');
  assert.equal(recRes.status, 200);

  // تسجيل pii_access_log عند استعراض طلبات عميل من المالك
  const merchant = s.client('10.26.0.2');
  const reg = await merchant.post('/api/auth/register', {
    store: 'متجر الرصد', phone: '01067890123', email: 'pii@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  const pr = await merchant.post('/api/products', { name: 'منتج رصد', sku: 'PII-1', price: 120, cost: 60, stock: 5, markets: 'a' });
  await merchant.post('/api/orders', {
    market: 'a', customer: 'عميل رصد', phone: '01077770000', gov: 'القاهرة', address: 'المعادي',
    pay: 'عند الاستلام', courier: 'بوسطة', items: [{ productId: pr.data.product.id, qty: 1 }]
  });

  const viewClient = await owner.get(`/api/owner/clients/${reg.data.me.id}`);
  assert.equal(viewClient.status, 200);
  const viewApprovals = await owner.get('/api/owner/approvals?status=all');
  assert.equal(viewApprovals.status, 200);

  const piiLogs = (await owner.get('/api/owner/pii-log')).data.logs;
  assert.ok(piiLogs.some((x) => x.action === 'owner_view_client_orders'));
  assert.ok(piiLogs.some((x) => x.action === 'owner_view_approvals_orders'));
});
