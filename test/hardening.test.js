'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { generateTotpCode } = require('../src/auth');
const { createMailer } = require('../src/mailer');
const { isPrivateIp, assertSafeResolvedUrl } = require('../src/connectors');
const { resolveModelCandidates } = require('../src/ai');

async function startApp(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-harden-test-'));
  const inst = createApp({
    dbFile: overrides.dbFile ?? ':memory:',
    dataDir: tmpDir,
    backupDir: path.join(tmpDir, 'backups'),
    uploadsDir: path.join(tmpDir, 'uploads', 'products'),
    secret: 'hardening-session-secret-at-least-32-chars!!',
    dataEncryptionKey: 'hardening-data-enc-key-at-least-32-chars!!',
    ownerEmail: 'owner@orderflow.test',
    ownerPhone: '01088887777',
    ownerPassword: 'OwnerPass@2026!',
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
        ...(method !== 'GET' && method !== 'OPTIONS' ? { 'X-Requested-With': 'omniarab' } : {}),
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

async function loginStaffWith2fa(app, id, password) {
  const login = await app.req('POST', '/api/auth/login', { id, password });
  assert.equal(login.status, 200);
  let cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (login.json && login.json.setup2faRequired) {
    const setup = await app.req('POST', '/api/account/2fa/setup', {}, { Cookie: cookie });
    assert.equal(setup.status, 200);
    const en = await app.req('POST', '/api/account/2fa/enable', { code: generateTotpCode(setup.json.secret) }, { Cookie: cookie });
    assert.equal(en.status, 200);
    cookie = (en.headers.get('set-cookie') || '').split(';')[0] || cookie;
  }
  return cookie;
}

async function createActiveMerchant(app, ownerCookie, { store, email, phone, password }) {
  const reg = await app.req('POST', '/api/auth/register', { store, fullName: store, email, phone, password, termsAccepted: true });
  assert.equal(reg.status, 200);
  const userId = app.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const appr = await app.req('POST', `/api/owner/clients/${userId}/approve`, {}, { Cookie: ownerCookie });
  assert.equal(appr.status, 200);
  const login = await app.req('POST', '/api/auth/login', { id: email, password });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  return { userId, cookie };
}

describe('Hardening Suite: Security, Database, Backend & Business Logic', () => {
  it('enforces strict CSP without unsafe-inline or frame-ancestors * and SameSite=Lax cookies', async () => {
    const app = await startApp({ allowIframe: false });
    try {
      const r = await app.req('GET', '/api/health');
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
      assert.doesNotMatch(csp, /frame-ancestors\s+\*/);
      assert.match(csp, /frame-ancestors 'self'/);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');

      const login = await app.req('POST', '/api/auth/login', {
        id: 'owner@orderflow.test',
        password: 'OwnerPass@2026!'
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie') || '';
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
    } finally {
      await app.cleanup();
    }
  });

  it('never stores auth tokens in localStorage in public/js/app.js or web/src/lib/api.ts', () => {
    const legacyJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const nextApi = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'lib', 'api.ts'), 'utf8');
    assert.doesNotMatch(legacyJs, /localStorage\.setItem\(\s*['"]omni_token['"]/);
    assert.doesNotMatch(legacyJs, /localStorage\.getItem\(\s*['"]omni_token['"]/);
    assert.doesNotMatch(nextApi, /localStorage\.(getItem|setItem|removeItem)/);
  });

  it('handles CORS strictly for ALLOWED_ORIGINS only (OPTIONS preflight + rejection of unknown origins)', async () => {
    const app = await startApp({ allowedOrigins: ['https://app.orderflow.eg'] });
    try {
      const okPre = await app.req('OPTIONS', '/api/health', undefined, { Origin: 'https://app.orderflow.eg' });
      assert.equal(okPre.status, 204);
      assert.equal(okPre.headers.get('access-control-allow-origin'), 'https://app.orderflow.eg');
      assert.equal(okPre.headers.get('access-control-allow-credentials'), 'true');

      const badPre = await app.req('OPTIONS', '/api/health', undefined, { Origin: 'https://evil.example' });
      assert.equal(badPre.status, 403);
      assert.equal(badPre.headers.get('access-control-allow-origin'), null);

      const okGet = await app.req('GET', '/api/health', undefined, { Origin: 'https://app.orderflow.eg' });
      assert.equal(okGet.status, 200);
      assert.equal(okGet.headers.get('access-control-allow-origin'), 'https://app.orderflow.eg');
    } finally {
      await app.cleanup();
    }
  });

  it('blocks private, loopback, metadata, and IPv4-mapped IPv6 addresses via isPrivateIp and assertSafeResolvedUrl', async () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true);
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIp('10.0.0.5'), true);
    assert.equal(isPrivateIp('93.184.216.34'), false);

    await assert.rejects(
      () => assertSafeResolvedUrl('https://metadata.test/latest', 'test', {
        lookupFn: async () => [{ address: '169.254.169.254', family: 4 }]
      }),
      /غير مسموح|داخلي|خاص/
    );
    await assert.rejects(
      () => assertSafeResolvedUrl('https://v6map.test/api', 'test', {
        lookupFn: async () => [{ address: '::ffff:127.0.0.1', family: 6 }]
      }),
      /غير مسموح|داخلي|خاص/
    );
  });

  it('indexes encrypted Tax ID with blind index and finds clients by Tax ID in Owner and Admin routes', async () => {
    const app = await startApp();
    try {
      const ownerCookie = await loginStaffWith2fa(app, 'owner@orderflow.test', 'OwnerPass@2026!');

      const merch = await createActiveMerchant(app, ownerCookie, {
        store: 'متجر الضرائب',
        email: 'tax@merchant.eg',
        phone: '01011112222',
        password: 'MerchPass@2026!'
      });

      const save = await app.req('PUT', '/api/settings', { taxId: '777-888-999' }, { Cookie: merch.cookie });
      assert.equal(save.status, 200);

      // Verify raw DB tax_id is encrypted while tax_id_hash is indexed
      const row = app.db.prepare('SELECT tax_id, tax_id_hash FROM users WHERE id = ?').get(merch.userId);
      assert.ok(row.tax_id.startsWith('enc:v1:'));
      assert.equal(row.tax_id_hash.length, 64);

      const ownerSearch = await app.req('GET', '/api/owner/clients?q=777-888-999', undefined, { Cookie: ownerCookie });
      assert.equal(ownerSearch.status, 200);
      assert.equal(ownerSearch.json.clients.some((c) => c.id === merch.userId), true);

      const adminSearch = await app.req('GET', '/api/admin/clients?q=777888999', undefined, { Cookie: ownerCookie });
      assert.equal(adminSearch.status, 200);
      assert.equal(adminSearch.json.clients.some((c) => c.id === merch.userId), true);
    } finally {
      await app.cleanup();
    }
  });

  it('sends real emails via native SMTP and HMAC-signed Webhook without external dependencies', async () => {
    // 1. Native SMTP test against local mock SMTP server
    const receivedCommands = [];
    const smtpServer = net.createServer((socket) => {
      socket.write('220 mock.smtp.local ESMTP ready\r\n');
      let inData = false;
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (inData) {
          if (buf.includes('\r\n.\r\n')) {
            receivedCommands.push('DATA_BODY');
            inData = false;
            buf = '';
            socket.write('250 2.0.0 OK queued\r\n');
          }
          return;
        }
        const lines = buf.split('\r\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          receivedCommands.push(line);
          if (/^EHLO/i.test(line)) socket.write('250-mock.smtp.local\r\n250 AUTH PLAIN\r\n');
          else if (/^AUTH /i.test(line)) socket.write('235 Authentication succeeded\r\n');
          else if (/^MAIL FROM:/i.test(line)) socket.write('250 OK\r\n');
          else if (/^RCPT TO:/i.test(line)) socket.write('250 OK\r\n');
          else if (/^DATA$/i.test(line)) { inData = true; socket.write('354 Start mail input\r\n'); }
          else if (/^QUIT$/i.test(line)) { socket.write('221 Bye\r\n'); socket.end(); }
        }
      });
    });
    await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
    const smtpPort = smtpServer.address().port;

    try {
      const smtpMailer = createMailer({
        smtpHost: '127.0.0.1',
        smtpPort,
        smtpUser: 'mailer',
        smtpPass: 'secret',
        smtpStartTls: false,
        mailFrom: 'no-reply@orderflow.eg'
      });
      const res = await smtpMailer.send({ to: 'merchant@orderflow.eg', subject: 'اختبار SMTP', text: 'مرحبًا بك' });
      assert.equal(res.delivered, true);
      assert.equal(res.provider, 'smtp');
      assert.ok(receivedCommands.includes('DATA_BODY'));
    } finally {
      await new Promise((r) => smtpServer.close(r));
    }

    // 2. HMAC-SHA256 Webhook test
    let hookSig = '';
    let hookRaw = '';
    const hookSecret = 'webhook-hmac-secret-key';
    const hookServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        hookRaw = Buffer.concat(chunks).toString('utf8');
        hookSig = String(req.headers['x-orderflow-signature'] || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
    const hookPort = hookServer.address().port;
    try {
      const hookMailer = createMailer({
        mailWebhookUrl: `http://127.0.0.1:${hookPort}/mail`,
        mailWebhookSecret: hookSecret,
        mailFrom: 'no-reply@orderflow.eg'
      });
      const res = await hookMailer.send({ to: 'merchant@orderflow.eg', subject: 'اختبار Webhook', text: 'رسالة موقعة' });
      assert.equal(res.delivered, true);
      assert.equal(res.provider, 'webhook');
      const expected = 'sha256=' + crypto.createHmac('sha256', hookSecret).update(hookRaw).digest('hex');
      assert.equal(hookSig, expected);
    } finally {
      await new Promise((r) => hookServer.close(r));
    }
  });

  it('auto-downgrades expired plan with merchant notification and audit_log entry', async () => {
    const app = await startApp();
    try {
      const ownerCookie = await loginStaffWith2fa(app, 'owner@orderflow.test', 'OwnerPass@2026!');
      const merch = await createActiveMerchant(app, ownerCookie, {
        store: 'متجر الاشتراكات',
        email: 'exp@merchant.eg',
        phone: '01022223333',
        password: 'MerchPass@2026!'
      });

      // Force expired pro plan
      app.db.prepare("UPDATE users SET plan = 'pro', plan_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(merch.userId);

      const boot = await app.req('GET', '/api/bootstrap', undefined, { Cookie: merch.cookie });
      assert.equal(boot.status, 200);
      assert.equal(boot.json.me.plan, 'free');

      const notif = app.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND title LIKE ?').get(merch.userId, '%انتهى اشتراكك%');
      assert.ok(notif);

      const audit = app.db.prepare("SELECT * FROM audit_log WHERE action = 'plan.expired_downgrade' AND target_id = ?").get(merch.userId);
      assert.ok(audit);
    } finally {
      await app.cleanup();
    }
  });

  it('restores stock and notifies merchant when moderator rejects an order', async () => {
    const app = await startApp();
    try {
      const ownerCookie = await loginStaffWith2fa(app, 'owner@orderflow.test', 'OwnerPass@2026!');

      // Create moderator with review_products_orders permission
      const modRes = await app.req('POST', '/api/owner/moderators', {
        fullName: 'مشرف المراجعة',
        email: 'mod@orderflow.test',
        phone: '01077776666',
        password: 'ModPassword@123!',
        permissions: { view_pending_clients: true, approve_clients: true, reject_clients: true, review_products_orders: true }
      }, { Cookie: ownerCookie });
      assert.equal(modRes.status, 200);

      const modCookie = await loginStaffWith2fa(app, 'mod@orderflow.test', 'ModPassword@123!');

      const merch = await createActiveMerchant(app, ownerCookie, {
        store: 'متجر المخزون',
        email: 'stock@merchant.eg',
        phone: '01033334444',
        password: 'MerchPass@2026!'
      });

      const prod = await app.req('POST', '/api/products', {
        name: 'منتج اختبار مخزون',
        sku: 'MOD-STK-1',
        cat: 'إلكترونيات',
        price: 500,
        cost: 300,
        stock: 20,
        markets: 'an'
      }, { Cookie: merch.cookie });
      assert.equal(prod.status, 200);
      const pid = prod.json.product.id;

      // Create order taking 4 units -> stock becomes 16
      const ord = await app.req('POST', '/api/orders', {
        market: 'a',
        customer: 'أحمد علي',
        phone: '01012345678',
        gov: 'القاهرة',
        pay: 'عند الاستلام',
        courier: 'بوسطة',
        items: [{ productId: pid, qty: 4 }]
      }, { Cookie: merch.cookie });
      assert.equal(ord.status, 200);
      const oid = ord.json.order.id;
      assert.equal(app.db.prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock, 16);

      // Moderator rejects order -> stock restored to 20 & merchant notified
      const rej = await app.req('POST', `/api/moderator/approvals/order/${oid}/reject`, {
        reason: 'عنوان العميل غير مكتمل'
      }, { Cookie: modCookie });
      assert.equal(rej.status, 200);
      assert.equal(app.db.prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock, 20);

      const notif = app.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND title LIKE ?').get(merch.userId, '%تم رفض الطلب%');
      assert.ok(notif);
    } finally {
      await app.cleanup();
    }
  });

  it('supports Owner support ticket replies and expert service status updates with notifications and audit log', async () => {
    const app = await startApp();
    try {
      const ownerCookie = await loginStaffWith2fa(app, 'owner@orderflow.test', 'OwnerPass@2026!');

      const merch = await createActiveMerchant(app, ownerCookie, {
        store: 'متجر الدعم والخبراء',
        email: 'support@merchant.eg',
        phone: '01044445555',
        password: 'MerchPass@2026!'
      });

      const tCreate = await app.req('POST', '/api/support/tickets', {
        subject: 'مشكلة مزامنة أمازون',
        message: 'أحتاج مساعدة في ربط SP-API'
      }, { Cookie: merch.cookie });
      assert.equal(tCreate.status, 200);
      const ticketId = tCreate.json.ticket.id;

      const sCreate = await app.req('POST', '/api/services/requests', {
        serviceKey: 'account_setup',
        notes: 'أرغب بالبدء هذا الأسبوع'
      }, { Cookie: merch.cookie });
      assert.equal(sCreate.status, 200);
      const reqId = sCreate.json.request.id;

      const listT = await app.req('GET', '/api/owner/tickets', undefined, { Cookie: ownerCookie });
      assert.equal(listT.status, 200);
      assert.ok(listT.json.tickets.some((t) => t.id === ticketId));

      const replyT = await app.req('POST', `/api/owner/tickets/${ticketId}/reply`, {
        reply: 'تم تفعيل الربط ومراجعة حسابك بنجاح',
        status: 'resolved'
      }, { Cookie: ownerCookie });
      assert.equal(replyT.status, 200);
      assert.equal(replyT.json.ticket.status, 'resolved');
      assert.equal(replyT.json.ticket.reply, 'تم تفعيل الربط ومراجعة حسابك بنجاح');

      const listS = await app.req('GET', '/api/owner/services', undefined, { Cookie: ownerCookie });
      assert.equal(listS.status, 200);
      assert.ok(listS.json.requests.some((s) => s.id === reqId));

      const updS = await app.req('POST', `/api/owner/services/${reqId}/status`, {
        status: 'in_progress',
        adminNotes: 'تم تخصيص خبير الإطلاق'
      }, { Cookie: ownerCookie });
      assert.equal(updS.status, 200);
      assert.equal(updS.json.request.status, 'in_progress');
      assert.equal(updS.json.request.adminNotes, 'تم تخصيص خبير الإطلاق');

      const notifs = app.db.prepare('SELECT title FROM notifications WHERE user_id = ?').all(merch.userId).map((n) => n.title);
      assert.ok(notifs.some((t) => t.includes('تم الرد على تذكرة الدعم')));
      assert.ok(notifs.some((t) => t.includes('تحديث طلب الخدمة')));

      const audits = app.db.prepare('SELECT action FROM audit_log').all().map((a) => a.action);
      assert.ok(audits.includes('ticket.reply'));
      assert.ok(audits.includes('service_request.status'));
    } finally {
      await app.cleanup();
    }
  });

  it('imports and updates products via CSV respecting plan limits and validating rows', async () => {
    const app = await startApp();
    try {
      const demo = await app.req('POST', '/api/auth/demo');
      const merchCookie = (demo.headers.get('set-cookie') || '').split(';')[0];

      const csv = [
        'SKU,الاسم,الفئة,السعر,التكلفة,المخزون,الأسواق',
        'BULK-001,شاحن سريع 65 واط,إلكترونيات,850,500,30,"أمازون,نون"',
        'BULK-002,منتج غير صالح بدون سعر,عام,0,0,5,a',
        'BULK-003,باور بانك 20000 مللي,إلكترونيات,1450,900,15,"جوميا,كنز"'
      ].join('\n');

      const r1 = await app.req('POST', '/api/products/import', { csv }, { Cookie: merchCookie });
      assert.equal(r1.status, 200);
      assert.equal(r1.json.imported, 2);
      assert.equal(r1.json.updated, 0);
      assert.equal(r1.json.skipped, 1);
      assert.equal(r1.json.errors.length, 1);

      // Re-import with updated price for BULK-001 -> updates existing SKU
      const r2 = await app.req('POST', '/api/products/import', {
        csv: 'sku,name,price,cost,stock,markets\nBULK-001,شاحن سريع 65 واط محدث,899,510,45,an'
      }, { Cookie: merchCookie });
      assert.equal(r2.status, 200);
      assert.equal(r2.json.imported, 0);
      assert.equal(r2.json.updated, 1);
      const updated = r2.json.products.find((p) => p.sku === 'BULK-001');
      assert.equal(updated.price, 899);
      assert.equal(updated.stock, 45);
    } finally {
      await app.cleanup();
    }
  });

  it('prioritizes configured GEMINI_MODEL first with official fallback models in src/ai.js', () => {
    const custom = resolveModelCandidates('gemini-3.1-flash-lite', { search: false });
    assert.equal(custom[0].model, 'gemini-3.1-flash-lite');
    assert.equal(custom.some((c) => c.model === 'gemini-4-hydrogen'), true);
    assert.equal(new Set(custom.map((c) => c.model)).size, custom.length);

    const def = resolveModelCandidates('', { search: false });
    assert.equal(def[0].model, 'gemini-4-hydrogen');
  });
});
