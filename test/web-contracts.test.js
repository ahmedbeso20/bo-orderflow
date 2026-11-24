'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

async function startApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-contracts-'));
  const inst = createApp({
    dbFile: ':memory:',
    dataDir: tmpDir,
    backupDir: path.join(tmpDir, 'backups'),
    uploadsDir: path.join(tmpDir, 'uploads', 'products'),
    secret: 'contracts-session-secret-at-least-32-characters!!',
    dataEncryptionKey: 'contracts-data-encryption-key-32-characters-long!!',
    ownerEmail: 'owner@contracts.eg',
    ownerPhone: '01088887777',
    ownerPassword: 'OwnerContracts@2026!'
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
  return { ...inst, req, cleanup };
}

describe('Next.js Web Frontend ↔ Node.js Backend API Contracts', () => {
  it('validates all merchant dashboard, integrations, billing, AI, customers, returns, and AWB contracts', async () => {
    const app = await startApp();
    try {
      const demo = await app.req('POST', '/api/auth/demo', {});
      assert.equal(demo.status, 200, JSON.stringify(demo.json));
      const cookie = (demo.headers.get('set-cookie') || '').split(';')[0];
      const auth = { Cookie: cookie };

      // 1. /api/auth/me
      const me = await app.req('GET', '/api/auth/me', undefined, auth);
      assert.equal(me.status, 200);
      assert.equal(me.json.authenticated, true);
      assert.equal(me.json.me.role, 'client');

      // 2. /api/dashboard
      const dash = await app.req('GET', '/api/dashboard', undefined, auth);
      assert.equal(dash.status, 200, JSON.stringify(dash.json));
      assert.equal(typeof dash.json.kpis.delivered, 'number');
      assert.equal(typeof dash.json.kpis.returned, 'number');
      assert.equal(typeof dash.json.kpis.avgOrder, 'number');
      assert.ok(Array.isArray(dash.json.months) && dash.json.months.length === 12);
      assert.ok(Array.isArray(dash.json.marketShareList));
      assert.equal(typeof dash.json.marketShare, 'object');

      // 3. /api/integrations/connections & /api/couriers/connections
      const integ = await app.req('GET', '/api/integrations/connections', undefined, auth);
      assert.equal(integ.status, 200, JSON.stringify(integ.json));
      assert.ok(integ.json.schemas && integ.json.schemas.a);
      assert.ok(integ.json.schemas.a.fields.every((f) => typeof f.name === 'string' && f.name.length > 0));
      assert.ok(Array.isArray(integ.json.syncRuns));

      const cour = await app.req('GET', '/api/couriers/connections', undefined, auth);
      assert.equal(cour.status, 200, JSON.stringify(cour.json));
      assert.ok(cour.json.schemas.bosta);
      assert.ok(cour.json.schemas.aramex);
      assert.ok(cour.json.schemas.mylerz, 'Mylerz courier schema must be exposed');
      assert.ok(cour.json.schemas.aramex.fields.some((f) => f.name === 'userName'), 'Aramex schema must include userName');

      // 4. /api/billing
      const billing = await app.req('GET', '/api/billing', undefined, auth);
      assert.equal(billing.status, 200, JSON.stringify(billing.json));
      assert.ok(Array.isArray(billing.json.plans) && billing.json.plans.length >= 3);
      for (const pl of billing.json.plans) {
        assert.equal(typeof pl.priceMonthly, 'number');
        assert.equal(typeof pl.priceYearly, 'number');
      }
      assert.equal(typeof billing.json.gateway.providerName, 'string');

      // 5. /api/customers
      const cust = await app.req('GET', '/api/customers', undefined, auth);
      assert.equal(cust.status, 200, JSON.stringify(cust.json));
      assert.ok(Array.isArray(cust.json.customers) && cust.json.customers.length > 0);
      assert.equal(typeof cust.json.customers[0].returnedCount, 'number');
      assert.equal(typeof cust.json.customers[0].cancelledCount, 'number');
      assert.equal(typeof cust.json.summary.totalCustomers, 'number');
      assert.equal(typeof cust.json.summary.vipCustomers, 'number');
      assert.equal(typeof cust.json.summary.repeatCustomers, 'number');
      assert.equal(typeof cust.json.summary.avgLtv, 'number');

      // 6. /api/returns
      const ret = await app.req('GET', '/api/returns', undefined, auth);
      assert.equal(ret.status, 200, JSON.stringify(ret.json));
      assert.ok(Array.isArray(ret.json.returns));
      assert.equal(typeof ret.json.summary.returnRate, 'number');
      assert.ok(Array.isArray(ret.json.byCourier));

      // 7. /api/ai/listing, /api/ai/advisor, /api/ai/price-radar (fallback structured contracts)
      const listing = await app.req('POST', '/api/ai/listing', {
        name: 'سماعة بلوتوث لاسلكية',
        features: 'عزل ضوضاء، بطارية 30 ساعة',
        tone: 'احترافية'
      }, auth);
      assert.equal(listing.status, 200, JSON.stringify(listing.json));
      assert.equal(typeof listing.json.data.amazonTitle, 'string');
      assert.equal(typeof listing.json.data.noonTitle, 'string');
      assert.equal(typeof listing.json.data.jumiaTitle, 'string');
      assert.ok(Array.isArray(listing.json.data.bulletPoints));
      assert.ok(Array.isArray(listing.json.data.aplusHighlights));

      const advisor = await app.req('POST', '/api/ai/advisor', { thinking: false }, auth);
      assert.equal(advisor.status, 200, JSON.stringify(advisor.json));
      assert.equal(typeof advisor.json.advisor.data.headline, 'string');
      assert.equal(typeof advisor.json.advisor.data.urgentRestockTip, 'string');
      assert.equal(typeof advisor.json.advisor.data.strategicPlan, 'string');

      const radar = await app.req('POST', '/api/ai/price-radar', {
        name: 'سماعة بلوتوث'
      }, auth);
      assert.equal(radar.status, 200, JSON.stringify(radar.json));
      assert.equal(typeof radar.json.market.minPrice, 'number');
      assert.equal(typeof radar.json.market.avgPrice, 'number');
      assert.equal(typeof radar.json.market.maxPrice, 'number');
      assert.equal(typeof radar.json.market.recommended, 'number');
      assert.ok(Array.isArray(radar.json.market.platforms));

      // 8. AWB routes exist (not 404)
      const ordersRes = await app.req('GET', '/api/orders', undefined, auth);
      const oid = (ordersRes.json.items || ordersRes.json.orders)[0].id;
      const awbCreate = await app.req('POST', `/api/orders/${oid}/awb/create`, { courier: 'bosta' }, auth);
      assert.notEqual(awbCreate.status, 404, '/api/orders/:id/awb/create route must exist');
      const awbTrack = await app.req('POST', `/api/orders/${oid}/awb/track`, {}, auth);
      assert.notEqual(awbTrack.status, 404, '/api/orders/:id/awb/track route must exist');

      // 9. Public endpoints: /api/contact and /api/consultations
      const contactRes = await app.req('POST', '/api/contact', {
        name: 'كريم محمد',
        contact: 'karim@store.eg',
        subject: 'استفسار ربط أمازون',
        message: 'أرغب في معرفة تفاصيل ربط متجر أمازون مصر.'
      });
      assert.equal(contactRes.status, 200, JSON.stringify(contactRes.json));
      assert.ok(contactRes.json.ticketId > 0);

      const consultRes = await app.req('POST', '/api/consultations', {
        name: 'سارة علي',
        phone: '01022334455',
        storeName: 'متجر سارة',
        monthlyOrders: '١٠٠ - ٥٠٠ طلب',
        platforms: 'أمازون مصر · نون'
      });
      assert.equal(consultRes.status, 200, JSON.stringify(consultRes.json));
      assert.ok(consultRes.json.request.ref_code);
    } finally {
      await app.cleanup();
    }
  });
});
