'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { generateTotpCode } = require('../src/auth');
const { verifyKashierWebhookSignature } = require('../src/payments/providers/kashier');

async function startApp(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-p34-test-'));
  const inst = createApp({
    dbFile: overrides.dbFile ?? ':memory:',
    dataDir: tmpDir,
    backupDir: path.join(tmpDir, 'backups'),
    uploadsDir: path.join(tmpDir, 'uploads', 'products'),
    secret: 'phase34-session-secret-at-least-32-characters!!',
    dataEncryptionKey: 'phase34-data-encryption-key-32-characters-long!!',
    ownerEmail: 'owner@p34.eg',
    ownerPhone: '01099990099',
    ownerPassword: 'OwnerP34@2026!',
    courierWebhookSecret: 'courier-webhook-hmac-secret-32chars!',
    ...overrides
  });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const { port } = inst.server.address();
  const base = `http://127.0.0.1:${port}`;
  const req = async (method, p, body, headers = {}) => {
    const raw = typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined;
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'omniarab' } : {}),
        ...headers
      },
      body: raw
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
  return { ...inst, q: inst.app.q, cipher: inst.app.cipher, base, req, tmpDir, cleanup };
}

async function createActiveMerchant(app, { phone, email, password = 'Merchant@2026!', store = 'متجر اختبار' }) {
  const reg = await app.req('POST', '/api/auth/register', {
    store,
    fullName: store,
    phone,
    email,
    password,
    termsAccepted: true
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  app.q("UPDATE users SET status = 'active' WHERE phone = ?").run(phone);
  const login = await app.req('POST', '/api/auth/login', { id: email, password });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, me: login.json.me };
}

async function loginOwnerWith2fa(app) {
  const r = await app.req('POST', '/api/auth/login', { id: 'owner@p34.eg', password: 'OwnerP34@2026!' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (r.json.setup2faRequired) {
    const setup = await app.req('POST', '/api/account/2fa/setup', {}, { Cookie: cookie });
    assert.equal(setup.status, 200, JSON.stringify(setup.json));
    const en = await app.req('POST', '/api/account/2fa/enable', { code: generateTotpCode(setup.json.secret) }, { Cookie: cookie });
    assert.equal(en.status, 200, JSON.stringify(en.json));
    cookie = (en.headers.get('set-cookie') || '').split(';')[0] || cookie;
  }
  return { cookie };
}

describe('Phase 1–4 Hardening & Production Features', () => {
  it('1. 2FA /setup returns 403 when already enabled without re-auth, uses totp_pending_secret_enc without disabling active 2FA', async () => {
    const app = await startApp();
    try {
      const { cookie } = await createActiveMerchant(app, {
        phone: '01011112201',
        email: 'm2fa@p34.eg'
      });

      const s1 = await app.req('POST', '/api/account/2fa/setup', {}, { Cookie: cookie });
      assert.equal(s1.status, 200, JSON.stringify(s1.json));
      const secret1 = s1.json.secret;
      assert.ok(secret1);

      const en1 = await app.req('POST', '/api/account/2fa/enable', { code: generateTotpCode(secret1) }, { Cookie: cookie });
      assert.equal(en1.status, 200, JSON.stringify(en1.json));

      // Attempt /setup without password + totpCode -> 403 2FA_ALREADY_ENABLED
      const blocked = await app.req('POST', '/api/account/2fa/setup', {}, { Cookie: cookie });
      assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
      assert.equal(blocked.json.code, '2FA_ALREADY_ENABLED');

      // Active 2FA must still be enabled in DB
      const rowBefore = app.q('SELECT totp_enabled, totp_secret_enc, totp_pending_secret_enc FROM users WHERE email = ?').get('m2fa@p34.eg');
      assert.equal(rowBefore.totp_enabled, 1);
      assert.ok(rowBefore.totp_secret_enc.length > 0);

      // Re-authenticate with password + fresh TOTP (next step by resetting totp_last_step to allow same-second test)
      app.q('UPDATE users SET totp_last_step = 0 WHERE email = ?').run('m2fa@p34.eg');
      const s2 = await app.req('POST', '/api/account/2fa/setup', {
        password: 'Merchant@2026!',
        totpCode: generateTotpCode(secret1)
      }, { Cookie: cookie });
      assert.equal(s2.status, 200, JSON.stringify(s2.json));
      assert.notEqual(s2.json.secret, secret1);

      // Pending secret stored separately while active totp_enabled stays 1 and totp_secret_enc unchanged
      const rowMid = app.q('SELECT totp_enabled, totp_secret_enc, totp_pending_secret_enc FROM users WHERE email = ?').get('m2fa@p34.eg');
      assert.equal(rowMid.totp_enabled, 1);
      assert.equal(rowMid.totp_secret_enc, rowBefore.totp_secret_enc);
      assert.ok(rowMid.totp_pending_secret_enc.length > 0);
    } finally {
      await app.cleanup();
    }
  });

  it('2. TOTP replay protection blocks reusing same code on 2fa/disable, password change, and account/delete', async () => {
    const app = await startApp();
    try {
      const { cookie } = await createActiveMerchant(app, {
        phone: '01011112202',
        email: 'replay@p34.eg'
      });

      const s1 = await app.req('POST', '/api/account/2fa/setup', {}, { Cookie: cookie });
      const code = generateTotpCode(s1.json.secret);
      const en = await app.req('POST', '/api/account/2fa/enable', { code }, { Cookie: cookie });
      assert.equal(en.status, 200);

      // Same step code must be rejected on password change
      const pwReplay = await app.req('POST', '/api/account/password', {
        current: 'Merchant@2026!',
        next: 'NewMerchant@2027!',
        totpCode: code
      }, { Cookie: cookie });
      assert.equal(pwReplay.status, 401, JSON.stringify(pwReplay.json));

      // Same step code must be rejected on 2fa/disable
      const disReplay = await app.req('POST', '/api/account/2fa/disable', {
        password: 'Merchant@2026!',
        code
      }, { Cookie: cookie });
      assert.equal(disReplay.status, 401, JSON.stringify(disReplay.json));

      // Same step code must be rejected on account/delete
      const delReplay = await app.req('POST', '/api/account/delete', {
        password: 'Merchant@2026!',
        totpCode: code,
        confirmText: 'حذف حسابي نهائيا'
      }, { Cookie: cookie });
      assert.equal(delReplay.status, 401, JSON.stringify(delReplay.json));
    } finally {
      await app.cleanup();
    }
  });

  it('3. Re-authentication required for storeEmail/storePhone changes & email verification token bound strictly to target email', async () => {
    const app = await startApp();
    try {
      const { cookie } = await createActiveMerchant(app, {
        phone: '01011112203',
        email: 'orig@p34.eg'
      });

      // Request email verification token for orig@p34.eg
      const send1 = await app.req('POST', '/api/account/verify-email/send', {}, { Cookie: cookie });
      assert.equal(send1.status, 200, JSON.stringify(send1.json));
      const oldToken = send1.json.devToken;
      assert.ok(oldToken);

      // Changing email without currentPassword fails with 403 REAUTH_REQUIRED
      const noPw = await app.req('PUT', '/api/settings', {
        storeEmail: 'new@p34.eg'
      }, { Cookie: cookie });
      assert.equal(noPw.status, 403, JSON.stringify(noPw.json));
      assert.equal(noPw.json.code, 'REAUTH_REQUIRED');

      // Changing email WITH currentPassword succeeds
      const withPw = await app.req('PUT', '/api/settings', {
        storeEmail: 'new@p34.eg',
        currentPassword: 'Merchant@2026!'
      }, { Cookie: cookie });
      assert.equal(withPw.status, 200, JSON.stringify(withPw.json));

      // Old verification token bound to orig@p34.eg MUST fail for new@p34.eg
      const verifyOld = await app.req('POST', '/api/auth/verify-email', { token: oldToken });
      assert.equal(verifyOld.status, 400, JSON.stringify(verifyOld.json));
    } finally {
      await app.cleanup();
    }
  });

  it('4. SMS OTP non-collision across users and HMAC verification', async () => {
    const app = await startApp({ smsProvider: 'console' });
    try {
      await createActiveMerchant(app, { phone: '01011112204', email: 'sms1@p34.eg' });
      await createActiveMerchant(app, { phone: '01011112205', email: 'sms2@p34.eg' });

      const r1 = await app.req('POST', '/api/auth/forgot-password', { id: '01011112204', viaSms: true });
      const r2 = await app.req('POST', '/api/auth/forgot-password', { id: '01011112205', viaSms: true });
      assert.equal(r1.status, 200, JSON.stringify(r1.json));
      assert.equal(r2.status, 200, JSON.stringify(r2.json));
      assert.ok(r1.json.devOtp);
      assert.ok(r2.json.devOtp);

      // Wrong user trying user1's OTP must fail
      const crossReset = await app.req('POST', '/api/auth/reset-password/otp', {
        phone: '01011112205',
        code: r1.json.devOtp,
        password: 'NewPassword@2027!'
      });
      if (r1.json.devOtp !== r2.json.devOtp) {
        assert.equal(crossReset.status, 401, JSON.stringify(crossReset.json));
      }

      // Correct user resetting with their OTP succeeds
      const okReset = await app.req('POST', '/api/auth/reset-password/otp', {
        phone: '01011112204',
        code: r1.json.devOtp,
        password: 'NewPassword@2027!'
      });
      assert.equal(okReset.status, 200, JSON.stringify(okReset.json));
    } finally {
      await app.cleanup();
    }
  });

  it('5. Split login lockout + requiresCaptcha after 2 failures when Turnstile enabled & /api/auth/me authenticated: true', async () => {
    const app = await startApp({
      turnstileSiteKey: '1x00000000000000000000AA',
      turnstileSecretKey: '1x0000000000000000000000000000000AA'
    });
    try {
      // Create merchant directly in DB to bypass register captcha
      const reg = await app.req('POST', '/api/auth/demo', {}, {});
      // Demo fails without captcha when turnstile enabled
      assert.equal(reg.status, 400);

      // Seed active merchant directly for login test
      const { hashPassword } = require('../src/auth');
      const pwHash = await hashPassword('Merchant@2026!');
      app.q(`INSERT INTO users (phone, email, pass_hash, store_name, full_name, role, status, plan, created_at)
        VALUES (?, ?, ?, ?, ?, 'client', 'active', 'pro', ?)`).run(
        '01011112206', 'cap@p34.eg', pwHash, 'متجر كابتشا', 'متجر كابتشا', new Date().toISOString()
      );

      // 1st failed attempt -> 401
      const f1 = await app.req('POST', '/api/auth/login', { id: 'cap@p34.eg', password: 'WrongPassword1!' });
      assert.equal(f1.status, 401);
      // 2nd failed attempt -> 401 with requiresCaptcha: true
      const f2 = await app.req('POST', '/api/auth/login', { id: 'cap@p34.eg', password: 'WrongPassword2!' });
      assert.equal(f2.status, 401);
      assert.equal(f2.json.requiresCaptcha, true);

      // 3rd attempt even with right password without turnstileToken -> requiresCaptcha
      const f3 = await app.req('POST', '/api/auth/login', { id: 'cap@p34.eg', password: 'Merchant@2026!' });
      assert.equal(f3.status, 400);
      assert.equal(f3.json.requiresCaptcha, true);
    } finally {
      await app.cleanup();
    }

    // Separate app without Turnstile to verify /api/auth/me returns authenticated: true
    const app2 = await startApp();
    try {
      const { cookie } = await createActiveMerchant(app2, { phone: '01011112207', email: 'me@p34.eg' });
      const me = await app2.req('GET', '/api/auth/me', undefined, { Cookie: cookie });
      assert.equal(me.status, 200);
      assert.equal(me.json.authenticated, true);
      assert.equal(me.json.me.email, 'me@p34.eg');
    } finally {
      await app2.cleanup();
    }
  });

  it('6. Kashier webhook signature rejects missing required signatureKeys', () => {
    const apiKey = 'kashier-test-secret-key-12345';
    const data = {
      merchantOrderId: 'OF-1001',
      amount: '499.00',
      currency: 'EGP',
      status: 'SUCCESS',
      // Attacker omits amount & status from signatureKeys!
      signatureKeys: ['merchantOrderId', 'currency']
    };
    const qs = data.signatureKeys.map((k) => `${k}=${data[k]}`).join('&');
    const forgedSig = crypto.createHmac('sha256', apiKey).update(qs).digest('hex');

    const okForged = verifyKashierWebhookSignature({ payload: { data }, signature: forgedSig, apiKey });
    assert.equal(okForged, false, 'Must reject webhook when required keys are missing from signatureKeys');

    // Valid signature including all required keys must pass
    const validData = {
      merchantOrderId: 'OF-1001',
      amount: '499.00',
      currency: 'EGP',
      status: 'SUCCESS',
      signatureKeys: ['amount', 'currency', 'merchantOrderId', 'status']
    };
    const validQs = validData.signatureKeys.map((k) => `${k}=${validData[k]}`).join('&');
    const validSig = crypto.createHmac('sha256', apiKey).update(validQs).digest('hex');
    const okValid = verifyKashierWebhookSignature({ payload: { data: validData }, signature: validSig, apiKey });
    assert.equal(okValid, true);
  });

  it('7. GET /api/orders/awb?ids= filters strictly, indexed search works, and bulk CSV export rate limits on 4th attempt', async () => {
    const app = await startApp();
    try {
      const demo = await app.req('POST', '/api/auth/demo', {});
      assert.equal(demo.status, 200);
      const cookie = (demo.headers.get('set-cookie') || '').split(';')[0];

      const list = await app.req('GET', '/api/orders', undefined, { Cookie: cookie });
      assert.equal(list.status, 200);
      const ordersArr = list.json.items || list.json.orders || [];
      assert.ok(ordersArr.length >= 2);
      const first = ordersArr[0];
      const second = ordersArr[1];

      // Filter AWB print strictly to first.id
      const awb = await app.req('GET', `/api/orders/awb?ids=${first.id}`, undefined, { Cookie: cookie });
      assert.equal(awb.status, 200);
      assert.equal((awb.text.match(/class="label"/g) || []).length, 1);
      assert.ok(awb.text.includes(first.customer));

      // Indexed search by exact order number
      const searchNo = await app.req('GET', `/api/orders?q=${encodeURIComponent(first.no)}`, undefined, { Cookie: cookie });
      assert.equal(searchNo.status, 200);
      assert.ok((searchNo.json.items || searchNo.json.orders || []).some((o) => o.id === first.id));

      // Bulk CSV export rate limit: 3 allowed, 4th returns 429
      for (let i = 0; i < 3; i++) {
        const exp = await app.req('GET', '/api/orders/export.csv', undefined, { Cookie: cookie });
        assert.equal(exp.status, 200);
      }
      const exp4 = await app.req('GET', '/api/orders/export.csv', undefined, { Cookie: cookie });
      assert.equal(exp4.status, 429);
    } finally {
      await app.cleanup();
    }
  });

  it('8. sync_outbox enqueue on product update & Mylerz webhook HMAC verification + stock restore on return', async () => {
    const app = await startApp();
    try {
      const { cookie, me } = await createActiveMerchant(app, {
        phone: '01011112208',
        email: 'sync@p34.eg'
      });

      // Create product + order
      const pRes = await app.req('POST', '/api/products', {
        name: 'سماعة اختبار',
        sku: 'SKU-MYLERZ-1',
        price: 500,
        cost: 250,
        stock: 10,
        markets: ['a', 'n']
      }, { Cookie: cookie });
      assert.equal(pRes.status, 200, JSON.stringify(pRes.json));
      const prodId = pRes.json.product.id;

      // Save an enabled marketplace connection (amazon) via API so outbox enqueues
      const connRes = await app.req('PUT', '/api/integrations/connections/a', {
        enabled: true,
        credentials: { sellerId: 'S1', refreshToken: 'RT', clientId: 'CID', clientSecret: 'CS' }
      }, { Cookie: cookie });
      assert.equal(connRes.status, 200, JSON.stringify(connRes.json));

      const oRes = await app.req('POST', '/api/orders', {
        customer: 'أحمد علي',
        phone: '01099887766',
        gov: 'القاهرة',
        market: 'a',
        pay: 'عند الاستلام',
        courier: 'بوسطة',
        items: [{ productId: prodId, qty: 2 }]
      }, { Cookie: cookie });
      assert.equal(oRes.status, 200, JSON.stringify(oRes.json));
      const orderId = oRes.json.order.id;

      // Verify stock decremented to 8 and sync_outbox has an entry
      const prodAfterOrder = app.q('SELECT stock FROM products WHERE id = ?').get(prodId);
      assert.equal(prodAfterOrder.stock, 8);
      const outboxRes = await app.req('GET', '/api/integrations/outbox', undefined, { Cookie: cookie });
      assert.equal(outboxRes.status, 200);
      assert.ok(outboxRes.json.items.length >= 1, 'Expected sync_outbox entry after order creation');

      // Attach a Mylerz AWB to order and trigger Mylerz webhook return
      app.q("UPDATE orders SET awb_number = 'MYL-998877', courier = 'mylerz', status = 1 WHERE id = ?").run(orderId);
      const webhookPayload = JSON.stringify({ trackingNumber: 'MYL-998877', status: 'Returned to Sender' });

      // Invalid HMAC -> 401
      const badHook = await app.req('POST', '/api/webhooks/couriers/mylerz', webhookPayload, {
        'x-courier-signature': 'deadbeef'
      });
      assert.equal(badHook.status, 401);

      // Valid HMAC -> 200, order status = 3 (returned), stock restored back to 10
      const validHmac = crypto.createHmac('sha256', 'courier-webhook-hmac-secret-32chars!').update(webhookPayload).digest('hex');
      const okHook = await app.req('POST', '/api/webhooks/couriers/mylerz', webhookPayload, {
        'x-courier-signature': `sha256=${validHmac}`
      });
      assert.equal(okHook.status, 200, JSON.stringify(okHook.json));
      assert.equal(okHook.json.matched, true);
      assert.equal(okHook.json.status, 3);

      const prodAfterReturn = app.q('SELECT stock FROM products WHERE id = ?').get(prodId);
      assert.equal(prodAfterReturn.stock, 10, 'Stock must be restored when courier webhook marks order returned');
    } finally {
      await app.cleanup();
    }
  });

  it('9. Owner payment refund marks payment refunded and downgrades merchant plan', async () => {
    const app = await startApp();
    try {
      const { me } = await createActiveMerchant(app, { phone: '01011112209', email: 'refund@p34.eg' });
      const { cookie: ownerCookie } = await loginOwnerWith2fa(app);

      // Simulate a paid subscription
      app.q("UPDATE users SET plan = 'pro', plan_cycle = 'monthly' WHERE id = ?").run(me.id);
      const now = new Date().toISOString();
      const end = new Date(Date.now() + 30 * 86400_000).toISOString();
      const payId = Number(app.q(`INSERT INTO plan_payments (user_id, tx_ref, plan, cycle, amount, currency, method, status, period_start, period_end, created_at, updated_at)
        VALUES (?, 'OF-REF-1', 'pro', 'monthly', 499, 'EGP', 'kashier', 'paid', ?, ?, ?, ?)`).run(
        me.id, now, end, now, now
      ).lastInsertRowid);

      const refRes = await app.req('POST', `/api/owner/payments/${payId}/refund`, {
        reason: 'استرداد خلال 14 يومًا',
        downgrade: true
      }, { Cookie: ownerCookie });
      assert.equal(refRes.status, 200, JSON.stringify(refRes.json));
      assert.equal(refRes.json.payment.status, 'refunded');

      const userAfter = app.q('SELECT plan FROM users WHERE id = ?').get(me.id);
      assert.equal(userAfter.plan, 'free');

      // Double refund must be rejected with 409
      const dupRef = await app.req('POST', `/api/owner/payments/${payId}/refund`, {
        reason: 'مكرر'
      }, { Cookie: ownerCookie });
      assert.equal(dupRef.status, 409);
    } finally {
      await app.cleanup();
    }
  });
});
