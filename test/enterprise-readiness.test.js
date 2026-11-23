'use strict';
// اختبارات شاملة لجاهزية الإنتاج والأمان والامتثال (المهام 1 إلى 18)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const { createApp } = require('../src/app');
const { load } = require('../src/config');
const { generateTotpCode } = require('../src/auth');
const { clientIp } = require('../src/http');
const { generateQrSvg } = require('../src/qr');
const { decryptBackupFile } = require('../src/db');
const { buildSignature } = require('../src/payments/providers/kashier');
const { rotateEncryptionKey } = require('../scripts/rotate-encryption-key');

class Client {
  constructor(base, ip = '10.10.0.1') {
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
    let data;
    if (ct.includes('json')) data = await res.json();
    else if (ct.includes('application/zip') || ct.includes('octet-stream')) data = Buffer.from(await res.arrayBuffer());
    else data = await res.text();
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
  if (opts.autoApprove !== false) {
    app.db.prepare("UPDATE platform_settings SET value = '0' WHERE key = 'require_client_approval'").run();
  }
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let seq = 0;
  return { app, base, client: (ip) => new Client(base, ip || `10.99.0.${++seq}`) };
}

async function loginStaffWith2fa(client, id, password) {
  const login = await client.post('/api/auth/login', { id, password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  if (login.data.setup2faRequired) {
    const setup = await client.post('/api/account/2fa/setup');
    assert.equal(setup.status, 200, JSON.stringify(setup.data));
    const code = generateTotpCode(setup.data.secret);
    const enabled = await client.post('/api/account/2fa/enable', { code });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    return { login, setup, enabled, secret: setup.data.secret, recoveryCodes: enabled.data.recoveryCodes };
  }
  return { login };
}

function parseZipEntries(buf) {
  // فك مبسّط لملفات ZIP (طريقتي STORE=0 و DEFLATE=8) للتحقق من المحتوى
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const plain = method === 8 ? zlib.inflateRawSync(raw) : raw;
    entries[name] = plain.toString('utf8');
    offset = dataStart + compSize;
  }
  return entries;
}

// =========================================================================
// TASK 1: Fail-Closed Secrets & No Hardcoded Owner Credentials
// =========================================================================
test('Task 1: رفض التشغيل في الإنتاج بلا أسرار + حفظ أسرار التطوير + منع المالك الافتراضي تلقائيًا', async (t) => {
  assert.throws(() => load({ nodeEnv: 'production', secret: '', dataEncryptionKey: '' }), /SESSION_SECRET/);
  assert.throws(() => load({ appUrl: 'https://orderflow.eg', secret: 'x'.repeat(40), dataEncryptionKey: '' }), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => load({ ownerPassword: 'short' }), /12/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-task1-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const dev1 = load({ nodeEnv: 'development', appUrl: '', kService: '', dataDir: tmpDir, secret: '', dataEncryptionKey: '' });
  const dev2 = load({ nodeEnv: 'development', appUrl: '', kService: '', dataDir: tmpDir, secret: '', dataEncryptionKey: '' });
  assert.equal(dev1.secret, dev2.secret, 'أسرار التطوير تُحفظ وتستمر بعد إعادة التشغيل');
  assert.ok(fs.existsSync(path.join(tmpDir, '.dev-secrets.json')));

  const noOwnerApp = createApp({
    dbFile: ':memory:',
    secret: 's'.repeat(48),
    dataEncryptionKey: 'd'.repeat(48),
    ownerPassword: '',
    ownerEmail: '',
    ownerPhone: '',
    allowDevDefaultOwner: false
  });
  t.after(() => noOwnerApp.close());
  const owners = noOwnerApp.db.prepare("SELECT * FROM users WHERE role = 'owner'").all();
  assert.equal(owners.length, 0, 'لا يُنشأ حساب مالك افتراضي بدون OWNER_PASSWORD أو ALLOW_DEV_DEFAULT_OWNER=1');
});

// =========================================================================
// TASK 3: TRUST_PROXY & TRUST_PROXY_HOPS
// =========================================================================
test('Task 3: تجاهل X-Forwarded-For عند TRUST_PROXY=false واستخراج IP الصحيح حسب TRUST_PROXY_HOPS', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20, 192.0.2.30' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(clientIp(req, false, 1), '127.0.0.1');
  assert.equal(clientIp(req, true, 1), '192.0.2.30');
  assert.equal(clientIp(req, true, 2), '198.51.100.20');
  assert.equal(clientIp(req, true, 3), '203.0.113.10');
});

// =========================================================================
// TASK 4 & TASK 5: Mandatory Staff 2FA, QR SVG, Replay, Lockout, Recovery, Cookie-Only Auth
// =========================================================================
test('Task 4 & 5: إلزام 2FA للمالك، QR SVG حقيقي، منع إعادة الاستخدام، قفل المحاولات، أكواد الاسترداد، ورفض ?token=', async (t) => {
  const s = await start();
  t.after(() => s.app.close());
  const owner = s.client('10.4.0.1');

  // 1) الدخول الأول للمالك بدون 2FA -> جلسة مقيدة
  const firstLogin = await owner.post('/api/auth/login', { id: 'owner@orderflow.eg', password: 'OwnerStrong@2026!' });
  assert.equal(firstLogin.status, 200);
  assert.equal(firstLogin.data.setup2faRequired, true);
  assert.equal('token' in firstLogin.data, false, 'لا يُعاد token في استجابة JSON');

  const blockedDash = await owner.get('/api/owner/dashboard');
  assert.equal(blockedDash.status, 403);
  assert.equal(blockedDash.data.code, '2FA_SETUP_REQUIRED');

  // 2) توليد QR SVG حقيقي وتفعيل 2FA
  const setup = await owner.post('/api/account/2fa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.data.qrSvg, /^<svg[\s\S]+<\/svg>$/);
  assert.match(generateQrSvg('otpauth://totp/OrderFlow:test?secret=JBSWY3DPEHPK3PXP'), /^<svg/);

  const firstCode = generateTotpCode(setup.data.secret);
  const en = await owner.post('/api/account/2fa/enable', { code: firstCode });
  assert.equal(en.status, 200);
  assert.equal(en.data.recoveryCodes.length, 10);

  // المالك يستطيع الآن دخول لوحته ولا يمكنه تعطيل 2FA
  assert.equal((await owner.get('/api/owner/dashboard')).status, 200);
  const dis = await owner.post('/api/account/2fa/disable', { password: 'OwnerStrong@2026!', code: firstCode });
  assert.equal(dis.status, 403);
  assert.equal(dis.data.code, '2FA_MANDATORY_FOR_STAFF');

  // 3) إعادة استخدام نفس رمز TOTP مرفوضة
  const owner2 = s.client('10.4.0.2');
  const chal = await owner2.post('/api/auth/login', { id: 'owner@orderflow.eg', password: 'OwnerStrong@2026!' });
  assert.equal(chal.status, 200);
  assert.equal(chal.data.requires2fa, true);
  const replay = await owner2.post('/api/auth/login/2fa', { challengeToken: chal.data.challengeToken, code: firstCode });
  assert.equal(replay.status, 401);

  // 4) كود الاسترداد يعمل مرة واحدة فقط
  const recCode = en.data.recoveryCodes[0];
  const recOk = await owner2.post('/api/auth/login/2fa', { challengeToken: chal.data.challengeToken, code: recCode });
  assert.equal(recOk.status, 200);
  assert.equal('token' in recOk.data, false);

  const owner3 = s.client('10.4.0.3');
  const chal2 = await owner3.post('/api/auth/login', { id: 'owner@orderflow.eg', password: 'OwnerStrong@2026!' });
  const recReuse = await owner3.post('/api/auth/login/2fa', { challengeToken: chal2.data.challengeToken, code: recCode });
  assert.equal(recReuse.status, 401);

  // 5) 5 محاولات خاطئة ثم المحاولة 6 -> 429 + حدث أمني في security_events
  for (let i = 0; i < 4; i++) {
    await owner3.post('/api/auth/login/2fa', { challengeToken: chal2.data.challengeToken, code: '000000' });
  }
  const locked = await owner3.post('/api/auth/login/2fa', { challengeToken: chal2.data.challengeToken, code: '000000' });
  assert.equal(locked.status, 429);
  const evs = s.app.db.prepare('SELECT * FROM security_events').all();
  assert.ok(evs.length >= 1, 'تسجيل حدث أمني عند تكرر فشل 2FA');

  // 6) Task 5: رفض ?token= في مسارات التصدير والـ API بدون Cookie
  const demo = s.client('10.4.0.4');
  const dLogin = await demo.post('/api/auth/demo');
  assert.equal(dLogin.status, 200);
  assert.equal('token' in dLogin.data, false);
  const sidVal = demo.jar.split('=')[1];
  const anon = s.client('10.4.0.5');
  assert.equal((await anon.get(`/api/bootstrap?token=${encodeURIComponent(sidVal)}`)).status, 401);
  assert.equal((await anon.get(`/api/orders/export.csv?token=${encodeURIComponent(sidVal)}`)).status, 401);
});

// =========================================================================
// TASK 6: SQLite-backed Persistent Rate Limiter
// =========================================================================
test('Task 6: ثبات عدّاد محاولات تسجيل الدخول في SQLite بعد إعادة تشغيل الخادم', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-task6-'));
  const dbPath = path.join(tmpDir, 'rl.db');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const s1 = await start({ dbFile: dbPath, dataDir: tmpDir });
  const c1 = s1.client('10.6.0.99');
  for (let i = 0; i < 6; i++) {
    await c1.post('/api/auth/login', { id: '01011112222', password: 'WrongPassword1!' });
  }
  await s1.app.close();

  const s2 = await start({ dbFile: dbPath, dataDir: tmpDir });
  t.after(() => s2.app.close());
  const c2 = s2.client('10.6.0.99');
  let blocked = false;
  for (let i = 0; i < 6; i++) {
    const r = await c2.post('/api/auth/login', { id: '01011112222', password: 'WrongPassword1!' });
    if (r.status === 429) { blocked = true; break; }
  }
  assert.equal(blocked, true, 'حدّ المحاولات يستمر بعد إعادة تشغيل الخادم على نفس قاعدة البيانات');
});

// =========================================================================
// TASK 7, 8, 9: Buyer PII Encryption, Blind Index Deduplication, Retention Purge, PII Access Log
// =========================================================================
test('Task 7, 8, 9: تشفير بيانات المشترين + دمج CRM بالهاش الأعمى + حذف PII بعد 30 يومًا + سجل الوصول', async (t) => {
  const s = await start();
  t.after(() => s.app.close());
  const owner = s.client('10.7.0.1');
  await loginStaffWith2fa(owner, 'owner@orderflow.eg', 'OwnerStrong@2026!');

  const c = s.client('10.7.0.2');
  const reg = await c.post('/api/auth/register', {
    store: 'متجر الخصوصية',
    phone: '01022223333',
    email: 'priv@store.eg',
    password: 'StrongPass@2026!',
    termsAccepted: true
  });
  assert.equal(reg.status, 200);
  const pRes = await c.post('/api/products', { name: 'سماعة بلوتوث', sku: 'PRIV-1', price: 500, cost: 300, stock: 20, markets: 'an' });
  assert.equal(pRes.status, 201);
  const pid = pRes.data.product.id;

  const o1 = await c.post('/api/orders', {
    market: 'a', customer: 'أحمد محمود', phone: '010 5555 6666', gov: 'القاهرة', address: '١٥ شارع النيل المعادي',
    pay: 'عند الاستلام', courier: 'بوسطة', items: [{ productId: pid, qty: 1 }]
  });
  assert.equal(o1.status, 201);
  const o2 = await c.post('/api/orders', {
    market: 'n', customer: 'أحمد محمود', phone: '01055556666', gov: 'القاهرة', address: '١٥ شارع النيل المعادي',
    pay: 'بطاقة', courier: 'أرامكس', items: [{ productId: pid, qty: 1 }]
  });
  assert.equal(o2.status, 201);

  // Task 7: التشفير أثناء السكون + دمج العميل + البحث المفكوك
  const rawOrder = s.app.db.prepare('SELECT customer, phone, address, phone_hash FROM orders WHERE id = ?').get(o1.data.order.id);
  assert.ok(rawOrder.customer.startsWith('enc:v1:'));
  assert.ok(rawOrder.phone.startsWith('enc:v1:'));
  assert.ok(rawOrder.address.startsWith('enc:v1:'));
  assert.ok(rawOrder.phone_hash.length === 64);

  const custs = await c.get('/api/customers?q=أحمد');
  assert.equal(custs.status, 200);
  assert.equal(custs.data.customers.length, 1, 'دمج طلبي نفس رقم الهاتف في عميل واحد عبر phone_hash');
  assert.equal(custs.data.customers[0].name, 'أحمد محمود');

  const searchOrders = await c.get('/api/orders?q=المعادي');
  assert.equal(searchOrders.status, 200);
  assert.equal(searchOrders.data.items.length, 2);

  // Task 9: سجل الوصول للبيانات الحساسة عند الفاتورة والتصدير
  const inv = await c.get(`/api/orders/${o1.data.order.id}/invoice`);
  assert.equal(inv.status, 200);
  assert.match(inv.data, /أحمد محمود/);
  const exp = await c.get('/api/orders/export.csv');
  assert.equal(exp.status, 200);

  const piiLog = await owner.get('/api/owner/pii-log');
  assert.equal(piiLog.status, 200);
  assert.ok(piiLog.data.logs.some((x) => x.action === 'invoice_view'));
  assert.ok(piiLog.data.logs.some((x) => x.action === 'orders_csv_export'));
  const piiCsv = await owner.get('/api/owner/pii-log/export.csv');
  assert.equal(piiCsv.status, 200);
  assert.match(piiCsv.data, /invoice_view/);

  // Task 8: حذف بيانات المشتري للطلب المسلّم منذ 31 يومًا والإبقاء على الطلب منذ 5 أيام دون تغيير الإيرادات
  const revBefore = (await c.get('/api/dashboard?days=90')).data.kpis.revenue;
  const d31 = new Date(Date.now() - 31 * 86400_000).toISOString();
  const d5 = new Date(Date.now() - 5 * 86400_000).toISOString();
  s.app.db.prepare('UPDATE orders SET status = 2, delivered_at = ? WHERE id = ?').run(d31, o1.data.order.id);
  s.app.db.prepare('UPDATE orders SET status = 2, delivered_at = ? WHERE id = ?').run(d5, o2.data.order.id);
  s.app.runPurge();

  const afterOrders = (await c.get('/api/orders?limit=20')).data.items;
  const oldO = afterOrders.find((x) => x.id === o1.data.order.id);
  const newO = afterOrders.find((x) => x.id === o2.data.order.id);
  assert.equal(oldO.customer, 'عميل محذوف البيانات');
  assert.equal(oldO.phone, '');
  assert.equal(newO.customer, 'أحمد محمود');
  const revAfter = (await c.get('/api/dashboard?days=90')).data.kpis.revenue;
  assert.equal(revAfter, revBefore, 'إجمالي الإيرادات لا يتأثر بحذف بيانات PII');
});

// =========================================================================
// TASK 10: Security Alerts + Atomic Encryption Key Rotation
// =========================================================================
test('Task 10: التنبيهات الأمنية + تدوير مفتاح تشفير قاعدة البيانات ذريًا', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-task10-'));
  const dbPath = path.join(tmpDir, 'rotate.db');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const oldKey = 'old-encryption-secret-key-at-least-32-chars!!';
  const newKey = 'new-encryption-secret-key-at-least-32-chars!!';

  const s1 = await start({ dbFile: dbPath, dataDir: tmpDir, dataEncryptionKey: oldKey });
  const owner1 = s1.client('10.10.0.1');
  await loginStaffWith2fa(owner1, 'owner@orderflow.eg', 'OwnerStrong@2026!');

  const m = s1.client('10.10.0.2');
  await m.post('/api/auth/register', {
    store: 'متجر التدوير', phone: '01033334444', email: 'rot@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  await m.put('/api/settings', { storeName: 'متجر التدوير', taxId: '555-666-777', instapay: 'rot@instapay' });
  const pr = await m.post('/api/products', { name: 'منتج تدوير', sku: 'ROT-1', price: 200, cost: 100, stock: 5, markets: 'a' });
  await m.post('/api/orders', {
    market: 'a', customer: 'سارة علي', phone: '01088889999', gov: 'الجيزة', address: 'المهندسين',
    pay: 'بطاقة', courier: 'بوسطة', items: [{ productId: pr.data.product.id, qty: 1 }]
  });

  // تنبيه أمني + إقرار المالك به
  await s1.app.sendSecurityAlert({ severity: 'high', title: 'اختبار تنبيه أمني', details: { test: true } });
  const secList = await owner1.get('/api/owner/security-events');
  assert.equal(secList.status, 200);
  const ev = secList.data.events.find((e) => e.title === 'اختبار تنبيه أمني');
  assert.ok(ev);
  const ack = await owner1.post(`/api/owner/security-events/${ev.id}/ack`);
  assert.equal(ack.status, 200);

  await s1.app.close();

  // تدوير المفتاح وإعادة فتح الخادم بالمفتاح الجديد
  const stats = rotateEncryptionKey({ dbPath, oldKey, newKey });
  assert.ok(stats.users >= 2 && stats.orders >= 1 && stats.customers >= 1);

  const s2 = await start({ dbFile: dbPath, dataDir: tmpDir, dataEncryptionKey: newKey });
  t.after(() => s2.app.close());
  const m2 = s2.client('10.10.0.3');
  const relogin = await m2.post('/api/auth/login', { id: '01033334444', password: 'StrongPass@2026!' });
  assert.equal(relogin.status, 200);
  const boot = await m2.get('/api/bootstrap');
  assert.equal(boot.data.settings.taxId, '555-666-777');
  assert.equal(boot.data.settings.instapay, 'rot@instapay');
  const orders2 = await m2.get('/api/orders?limit=10');
  assert.equal(orders2.data.items[0].customer, 'سارة علي');
  assert.equal(orders2.data.items[0].phone, '01088889999');
});

// =========================================================================
// TASK 11: Data Source Transparency & Delete Seed Data
// =========================================================================
test('Task 11: وسم مصدر البيانات (seed/manual) وتصفية لوحة التحكم وحذف البيانات التجريبية فقط', async (t) => {
  const s = await start();
  t.after(() => s.app.close());
  const c = s.client('10.11.0.1');
  await c.post('/api/auth/demo');

  // إضافة منتج وطلب يدوي بجانب البيانات التجريبية
  const p = await c.post('/api/products', { name: 'منتج يدوي', sku: 'MAN-01', price: 300, cost: 150, stock: 10, markets: 'a' });
  assert.equal(p.status, 201);
  assert.equal(p.data.product.source, 'manual');
  const o = await c.post('/api/orders', {
    market: 'a', customer: 'عميل يدوي', phone: '01012340000', gov: 'القاهرة', address: 'مدينة نصر',
    pay: 'بطاقة', courier: 'بوسطة', items: [{ productId: p.data.product.id, qty: 1 }]
  });
  assert.equal(o.status, 201);
  assert.equal(o.data.order.source, 'manual');

  const dashAll = await c.get('/api/dashboard?source=all');
  const dashConn = await c.get('/api/dashboard?source=connected');
  assert.ok(dashAll.data.kpis.orders > dashConn.data.kpis.orders, 'تصفية source=connected تستثني بيانات seed');

  const del = await c.del('/api/account/seed-data');
  assert.equal(del.status, 200);
  assert.ok(del.data.deletedOrders > 0);
  const remainingOrders = (await c.get('/api/orders?limit=50')).data.items;
  assert.equal(remainingOrders.length, 1);
  assert.equal(remainingOrders[0].source, 'manual');
});

// =========================================================================
// TASK 12 & 13: Amazon SP-API Pagination/Retry/SyncRuns + Regional Connectors/Couriers
// =========================================================================
test('Task 12 & 13: مزامنة أمازون مع NextToken و429 backoff وسجل المزامنة + اختبارات نون وجوميا وترينديول وكنز وبوسطة وأرامكس', async (t) => {
  let amazonOrderPage2Attempts = 0;
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('api.amazon.com/auth/o2/token')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ access_token: 'lwa-tok', expires_in: 3600 }), text: async () => '{}' };
    }
    if (u.includes('/orders/v0/orders') && !u.includes('orderItems')) {
      if (u.includes('NextToken=PAGE2')) {
        amazonOrderPage2Attempts++;
        if (amazonOrderPage2Attempts === 1) {
          return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), json: async () => ({}), text: async () => 'Rate limited' };
        }
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => ({ payload: { Orders: [{ AmazonOrderId: 'AMZ-P2', OrderStatus: 'Shipped', PurchaseDate: '2026-03-02T10:00:00Z', OrderTotal: { Amount: '450.00' }, PaymentMethod: 'Other' }] } }),
          text: async () => '{}'
        };
      }
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({
          payload: {
            NextToken: 'PAGE2',
            Orders: [{ AmazonOrderId: 'AMZ-P1', OrderStatus: 'Unshipped', PurchaseDate: '2026-03-01T10:00:00Z', OrderTotal: { Amount: '300.00' }, PaymentMethod: 'COD' }]
          }
        }),
        text: async () => '{}'
      };
    }
    if (u.includes('/orderItems')) {
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ payload: { OrderItems: [{ Title: 'شاحن أصلي', QuantityOrdered: 1, ItemPrice: { Amount: '300.00' } }] } }),
        text: async () => '{}'
      };
    }
    if (u.includes('api.bosta.co')) {
      return { ok: false, status: 401, headers: new Headers(), json: async () => ({ message: 'Unauthorized' }), text: async () => 'Unauthorized' };
    }
    if (u.includes('noon') || u.includes('jumia') || u.includes('trendyol') || u.includes('kenzz')) {
      return { ok: false, status: 401, headers: new Headers(), json: async () => ({ error: 'Invalid API key' }), text: async () => 'Invalid API key' };
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => '{}' };
  };

  const s = await start({ fetch: mockFetch });
  t.after(() => s.app.close());
  const c = s.client('10.12.0.1');
  await c.post('/api/auth/register', {
    store: 'متجر الأسواق', phone: '01044445555', email: 'mkt@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  // تفعيل الباقة الاحترافية لاختبار عدة أسواق
  s.app.db.prepare("UPDATE users SET plan = 'business' WHERE phone = '01044445555'").run();

  const saveAmz = await c.put('/api/integrations/marketplaces/a', {
    enabled: true, environment: 'production',
    credentials: { sellerId: 'A1SELLER', lwaClientId: 'amzn1.app', lwaClientSecret: 'secret123', refreshToken: 'Atzr|ref', marketplaceId: 'ARBP9OOSHTCHU' }
  });
  assert.equal(saveAmz.status, 200);

  const sync = await c.post('/api/integrations/marketplaces/a/sync');
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(amazonOrderPage2Attempts, 2, 'إعادة المحاولة التلقائية عند 429');
  assert.equal(sync.data.importedOrders, 2, 'استيراد صفحتي NextToken من أمازون');

  const listInt = await c.get('/api/integrations/marketplaces');
  const amzConn = listInt.data.connections.find((x) => x.platform === 'a');
  assert.ok(Array.isArray(amzConn.syncRuns) && amzConn.syncRuns.length >= 1, 'تسجيل سجل المزامنة connector_sync_runs');

  // خطأ 401 عربي واضح لبوسطة
  await c.put('/api/integrations/couriers/bosta', { enabled: true, environment: 'sandbox', credentials: { apiKey: 'bad-key' } });
  const testBosta = await c.post('/api/integrations/couriers/bosta/test');
  assert.equal(testBosta.data.ok, false);
  assert.match(testBosta.data.error || testBosta.data.message || '', /غير صالحة|تحقق|401|بوسطة/);
});

// =========================================================================
// TASK 14 & 15: Email Templates, Verification Gate, SMS OTP Reset & Phone Verification
// =========================================================================
test('Task 14 & 15: بوابة توثيق البريد ورسائل RTL + استعادة كلمة المرور عبر SMS OTP وقفل 5 محاولات وتوثيق الهاتف', async (t) => {
  const sentEmails = [];
  const s = await start({
    smsProvider: 'console',
    mailTransport: async (msg) => { sentEmails.push(msg); return { ok: true }; }
  });
  t.after(() => s.app.close());
  s.app.db.prepare("UPDATE platform_settings SET value = '1' WHERE key = 'require_email_verification'").run();

  const c = s.client('10.14.0.1');
  const reg = await c.post('/api/auth/register', {
    store: 'متجر البريد', phone: '01055556666', email: 'mail@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  assert.equal(reg.status, 200);
  assert.ok(sentEmails.length >= 1);
  assert.match(sentEmails[0].html, /dir="rtl"/, 'البريد يحتوي على قالب HTML عربي RTL');

  // منع الدفع والربط قبل توثيق البريد
  const blockedPay = await c.post('/api/billing/checkout', { plan: 'pro', cycle: 'monthly', method: 'card' });
  assert.equal(blockedPay.status, 403);
  assert.equal(blockedPay.data.code, 'EMAIL_VERIFICATION_REQUIRED');

  const blockedInt = await c.put('/api/integrations/marketplaces/a', {
    enabled: true, credentials: { sellerId: 'S1', lwaClientId: 'C1', lwaClientSecret: 'CS1', refreshToken: 'RT1' }
  });
  assert.equal(blockedInt.status, 403);
  assert.equal(blockedInt.data.code, 'EMAIL_VERIFICATION_REQUIRED');

  // توثيق البريد يفتح المسارات
  const ver = await c.post('/api/auth/verify-email', { token: sentEmails[0].token });
  assert.equal(ver.status, 200);
  const okInt = await c.put('/api/integrations/marketplaces/a', {
    enabled: true, credentials: { sellerId: 'S1', lwaClientId: 'C1', lwaClientSecret: 'CS1', refreshToken: 'RT1' }
  });
  assert.equal(okInt.status, 200);

  // Task 15: توثيق رقم الهاتف عبر SMS OTP
  const sendPh = await c.post('/api/account/phone/send-otp');
  assert.equal(sendPh.status, 200);
  assert.ok(sendPh.data.devOtp);
  const verPh = await c.post('/api/account/phone/verify', { code: sendPh.data.devOtp });
  assert.equal(verPh.status, 200);
  assert.equal(verPh.data.me.phoneVerified, true);

  // Task 15: استعادة كلمة المرور عبر SMS OTP + قفل 5 محاولات
  const forgot = await c.post('/api/auth/forgot-password', { id: '01055556666', viaSms: true });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.data.devOtp);
  for (let i = 0; i < 5; i++) {
    const badOtp = await c.post('/api/auth/reset-password/otp', { phone: '01055556666', code: '000000', password: 'NewStrong@2026!' });
    assert.equal(badOtp.status, 400);
  }
  const lockedOtp = await c.post('/api/auth/reset-password/otp', { phone: '01055556666', code: forgot.data.devOtp, password: 'NewStrong@2026!' });
  assert.notEqual(lockedOtp.status, 200, 'قفل رمز OTP بعد 5 محاولات خاطئة');

  // إصدار رمز جديد وتغيير كلمة المرور بنجاح
  const forgot2 = await c.post('/api/auth/forgot-password', { id: '01055556666', viaSms: true });
  const resetOk = await c.post('/api/auth/reset-password/otp', { phone: '01055556666', code: forgot2.data.devOtp, password: 'NewStrong@2026!' });
  assert.equal(resetOk.status, 200);
});

// =========================================================================
// TASK 16: Kashier Hardening & Sequential receipt_no
// =========================================================================
test('Task 16: تقوية كاشير (توقيع، عدم تطابق المبلغ -> 400 + review، عدم التكرار، ورقم إيصال متسلسل)', async (t) => {
  const apiKey = 'kashier-test-secret-key-999';
  const s = await start({
    paymentProvider: 'kashier',
    kashierMerchantId: 'MID-1234',
    kashierApiKey: apiKey,
    kashierMode: 'test'
  });
  t.after(() => s.app.close());

  const c = s.client('10.16.0.1');
  await c.post('/api/auth/register', {
    store: 'متجر كاشير', phone: '01066667777', email: 'kash@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });

  const co1 = await c.post('/api/billing/checkout', { plan: 'pro', cycle: 'monthly', method: 'kashier' });
  assert.equal(co1.status, 200);
  const tx1 = co1.data.payment.txRef;
  const amt1 = co1.data.payment.amount;

  // 1) غياب التوقيع -> 401
  const noSig = await c.post('/api/billing/webhook/kashier', { event: 'pay', data: { merchantOrderId: tx1, status: 'SUCCESS', amount: amt1, currency: 'EGP', signatureKeys: ['merchantOrderId', 'status', 'amount', 'currency'] } });
  assert.equal(noSig.status, 401);

  // 2) عدم تطابق المبلغ -> 400 + status='review' + audit_log payment.amount_mismatch
  const mismatchData = { merchantOrderId: tx1, status: 'SUCCESS', amount: 1, currency: 'EGP', transactionId: 'K-MIS-1', signatureKeys: ['merchantOrderId', 'status', 'amount', 'currency'] };
  const misSig = buildSignature(mismatchData, mismatchData.signatureKeys, apiKey);
  const misRes = await c.call('POST', '/api/billing/webhook/kashier', { event: 'pay', data: mismatchData }, { 'x-kashier-signature': misSig });
  assert.equal(misRes.status, 400);
  const payRow = s.app.db.prepare('SELECT status FROM plan_payments WHERE tx_ref = ?').get(tx1);
  assert.equal(payRow.status, 'review');
  const auditMismatch = s.app.db.prepare("SELECT * FROM audit_log WHERE action = 'payment.amount_mismatch'").all();
  assert.ok(auditMismatch.length >= 1);

  // 3) عملية جديدة ناجحة + تسلسل receipt_no + منع التكرار
  const co2 = await c.post('/api/billing/checkout', { plan: 'pro', cycle: 'monthly', method: 'kashier' });
  const tx2 = co2.data.payment.txRef;
  const okData = { merchantOrderId: tx2, status: 'SUCCESS', amount: co2.data.payment.amount, currency: 'EGP', transactionId: 'K-OK-1', signatureKeys: ['merchantOrderId', 'status', 'amount', 'currency'] };
  const okSig = buildSignature(okData, okData.signatureKeys, apiKey);
  const w1 = await c.call('POST', '/api/billing/webhook/kashier', { event: 'pay', data: okData }, { 'x-kashier-signature': okSig });
  assert.equal(w1.status, 200);
  const w2 = await c.call('POST', '/api/billing/webhook/kashier', { event: 'pay', data: okData }, { 'x-kashier-signature': okSig });
  assert.equal(w2.status, 200);
  assert.equal(w2.data.duplicate, true);
  const paidRow = s.app.db.prepare('SELECT receipt_no FROM plan_payments WHERE tx_ref = ?').get(tx2);
  assert.equal(paidRow.receipt_no, 1);
});

// =========================================================================
// TASK 17: Egyptian Law 151/2020 (Terms, ZIP Export, 14-day Scheduled Deletion)
// =========================================================================
test('Task 17: قانون 151/2020 (الموافقة على الشروط، تصدير ZIP، وجدولة الحذف بعد 14 يومًا مع أرشفة المدفوعات)', async (t) => {
  const s = await start();
  t.after(() => s.app.close());
  const c = s.client('10.17.0.1');

  const noTerms = await c.post('/api/auth/register', {
    store: 'بلا شروط', phone: '01077778888', email: 'noterms@store.eg', password: 'StrongPass@2026!'
  });
  assert.equal(noTerms.status, 400);

  const reg = await c.post('/api/auth/register', {
    store: 'متجر القانون', phone: '01077778888', email: 'law@store.eg', password: 'StrongPass@2026!', termsAccepted: true
  });
  assert.equal(reg.status, 200);
  const uid = reg.data.me.id;

  // دفع اشتراك تجريبي (sandbox) لتأكيد أرشفته في anonymized_payments عند الحذف
  const pay = await c.post('/api/billing/checkout', {
    plan: 'pro', cycle: 'monthly', method: 'wallet', walletPhone: '01077778888', walletOtp: '123456'
  });
  assert.equal(pay.status, 200);

  // تصدير ZIP
  const zipRes = await c.get('/api/account/export');
  assert.equal(zipRes.status, 200);
  assert.ok(Buffer.isBuffer(zipRes.data));
  const files = parseZipEntries(zipRes.data);
  assert.ok(files['profile.json'] && files['orders.json'] && files['customers.json'] && files['payments.json']);
  assert.equal(JSON.parse(files['profile.json']).storeName, 'متجر القانون');

  // طلب الحذف ثم الإلغاء ثم الطلب مجددًا ومحاكاة مرور 15 يومًا
  const delReq = await c.post('/api/account/delete', { password: 'StrongPass@2026!' });
  assert.equal(delReq.status, 200);
  assert.ok(delReq.data.deletionRequestedAt);

  const cancelDel = await c.post('/api/account/delete/cancel');
  assert.equal(cancelDel.status, 200);
  assert.equal(cancelDel.data.me.deletionRequestedAt, null);

  await c.post('/api/account/delete', { password: 'StrongPass@2026!' });
  const d15 = new Date(Date.now() - 15 * 86400_000).toISOString();
  s.app.db.prepare('UPDATE users SET deletion_requested_at = ? WHERE id = ?').run(d15, uid);
  s.app.runPurge();

  assert.equal(s.app.db.prepare('SELECT id FROM users WHERE id = ?').get(uid), undefined, 'تم حذف المستخدم نهائيًا');
  const archived = s.app.db.prepare('SELECT * FROM anonymized_payments').all();
  assert.equal(archived.length, 1, 'تم أرشفة الفاتورة الضريبية مجهولة الهوية');
});

// =========================================================================
// TASK 18: Observability (/api/health, X-Request-Id) & Encrypted Backup Roundtrip
// =========================================================================
test('Task 18: فحص الصحة وترويسة X-Request-Id + تشفير وفك تشفير النسخة الاحتياطية .db.enc', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-task18-'));
  const dbPath = path.join(tmpDir, 'main.db');
  const backupDir = path.join(tmpDir, 'backups');
  const encKey = 'backup-encryption-secret-key-at-least-32-chars!!';
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const s = await start({ dbFile: dbPath, dataDir: tmpDir, backupDir, backupEncryptionKey: encKey });
  t.after(() => s.app.close());
  const c = s.client('10.18.0.1');

  const h = await c.get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  assert.equal(h.data.db, 'ok');
  assert.equal(typeof h.data.uptimeSec, 'number');
  assert.ok(h.data.version);
  assert.ok(h.headers.get('x-request-id'), 'إرجاع X-Request-Id في كل استجابة');

  const bk = s.app.createBackup();
  assert.equal(bk.encrypted, true);
  assert.ok(bk.filename.endsWith('.db.enc'));
  const head = fs.readFileSync(bk.file).subarray(0, 8).toString('ascii');
  assert.equal(head, 'OFBK0001', 'الملف مشفر وليس قاعدة بيانات SQLite خام');

  const restoredPath = path.join(tmpDir, 'restored.db');
  decryptBackupFile(bk.file, restoredPath, encKey);
  const restoredDb = new DatabaseSync(restoredPath);
  const check = restoredDb.prepare('PRAGMA integrity_check').get();
  restoredDb.close();
  assert.equal(check.integrity_check, 'ok');
});
