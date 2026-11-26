'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

class Client {
  constructor(base, ip = '10.99.2.1') {
    this.base = base;
    this.ip = ip;
    this.cookie = '';
  }
  async call(method, path, body) {
    const headers = { 'x-forwarded-for': this.ip, 'x-requested-with': 'omniarab' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
}

async function setupMerchantApp(t, fetchStub) {
  const app = createApp({
    dbFile: ':memory:',
    secret: 's'.repeat(48),
    trustProxy: true,
    fetch: fetchStub
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const c = new Client(base);

  const reg = await c.post('/api/auth/register', {
    store: 'متجر المزامنة اللحظية',
    phone: '01099887766',
    email: 'sync@orderflow.eg',
    password: 'SyncFlow!9482',
    termsAccepted: true
  });
  assert.equal(reg.status, 200);
  const uRow = app.app.q("SELECT id FROM users WHERE email = 'sync@orderflow.eg'").get();
  app.app.q("UPDATE users SET status = 'active', plan = 'pro' WHERE id = ?").run(uRow.id);

  const login = await c.post('/api/auth/login', { email: 'sync@orderflow.eg', password: 'SyncFlow!9482' });
  assert.equal(login.status, 200);

  return { app, c, userId: uRow.id };
}

test('Two-way anti-overselling inventory sync: order import deducts stock once, respects safety_stock, pushes to Noon & Trendyol, and supports custom channel SKUs', async (t) => {
  const outboundPushes = [];

  const fetchStub = async (url, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : '';
    let parsedBody = null;
    try { parsedBody = bodyText ? JSON.parse(bodyText) : null; } catch (_) {}

    // Amazon LWA + SP-API
    if (url.includes('api.amazon.com/auth/o2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'amz_tok_sync' }) };
    }
    if (url.includes('/sellers/v1/marketplaceParticipations')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ payload: [{ marketplace: { id: 'ARBP9OOSHTCHU' } }] }) };
    }
    if (url.includes('/orders/v0/orders/') && url.includes('/orderItems')) {
      if (url.includes('AMZ-ORDER-100')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            payload: {
              OrderItems: [
                { SellerSKU: 'SKU-100', Title: 'سماعة أنكر', QuantityOrdered: 2, ItemPrice: { Amount: '1400.00' } }
              ]
            }
          })
        };
      }
      if (url.includes('AMZ-ORDER-MAP-1')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            payload: {
              OrderItems: [
                { SellerSKU: 'AMZ-1', Title: 'باور بانك مخصص', QuantityOrdered: 3, ItemPrice: { Amount: '900.00' } }
              ]
            }
          })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ payload: { OrderItems: [] } }) };
    }
    if (url.includes('/orders/v0/orders')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          payload: {
            Orders: [
              {
                AmazonOrderId: 'AMZ-ORDER-100',
                OrderStatus: 'Unshipped',
                OrderTotal: { Amount: '1400.00', CurrencyCode: 'EGP' },
                PaymentMethod: 'COD',
                ShippingAddress: { Name: 'أحمد محمود', StateOrRegion: 'القاهرة' },
                PurchaseDate: new Date().toISOString()
              },
              {
                AmazonOrderId: 'AMZ-ORDER-MAP-1',
                OrderStatus: 'Unshipped',
                OrderTotal: { Amount: '900.00', CurrencyCode: 'EGP' },
                PaymentMethod: 'Card',
                ShippingAddress: { Name: 'منى سمير', StateOrRegion: 'الجيزة' },
                PurchaseDate: new Date().toISOString()
              }
            ]
          }
        })
      };
    }

    // Noon Auth + Outbound Inventory Push
    if (url.includes('noon.partners/v1/auth') || url.includes('/partner/v1/whoami')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, token: 'noon_tok' }) };
    }
    if (url.includes('/partner/v1/inventory')) {
      outboundPushes.push({ platform: 'n', url, method: init.method, body: parsedBody });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }

    // Trendyol Auth + Outbound Inventory Push
    if (url.includes('trendyol.com') && url.includes('/products/price-and-inventory')) {
      outboundPushes.push({ platform: 't', url, method: init.method, body: parsedBody });
      return { ok: true, status: 200, text: async () => JSON.stringify({ batchRequestId: 'ty-batch-1' }) };
    }
    if (url.includes('trendyol.com')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: [], totalElements: 0 }) };
    }

    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  const { app, c, userId } = await setupMerchantApp(t, fetchStub);

  // Connect Amazon, Noon, and Trendyol
  assert.equal((await c.put('/api/integrations/connections/a', {
    credentials: { sellerId: 'A2EG', marketplaceId: 'ARBP9OOSHTCHU', clientId: 'cid', clientSecret: 'csec', refreshToken: 'Atzr|ref' },
    testNow: true
  })).status, 200);
  assert.equal((await c.put('/api/integrations/connections/n', {
    credentials: { projectCode: 'PRJ1', keyId: 'nk1', privateKey: 'npk1' },
    testNow: true
  })).status, 200);
  assert.equal((await c.put('/api/integrations/connections/t', {
    credentials: { supplierId: '778899', apiKey: 'tk1', apiSecret: 'ts1' },
    testNow: true
  })).status, 200);

  // Create Product 1: SKU-100, stock 10, safetyStock 1, markets 'ant'
  const p1Res = await c.post('/api/products', {
    name: 'سماعة أنكر Soundcore',
    sku: 'SKU-100',
    cat: 'إلكترونيات',
    price: 700,
    cost: 400,
    stock: 10,
    safetyStock: 1,
    autoPushStock: true,
    markets: 'ant'
  });
  assert.equal(p1Res.status, 200);
  const p1Id = p1Res.data.product.id;

  // Create Product 2: internal SKU MASTER-1, stock 12, safetyStock 2, mapped AMZ-1 -> Amazon & NOON-1 -> Noon
  const p2Res = await c.post('/api/products', {
    name: 'باور بانك مخصص',
    sku: 'MASTER-1',
    cat: 'إلكترونيات',
    price: 300,
    cost: 180,
    stock: 12,
    safetyStock: 2,
    autoPushStock: true,
    markets: 'an'
  });
  assert.equal(p2Res.status, 200);
  const p2Id = p2Res.data.product.id;

  // Approve both products so inventory sync worker pushes them
  app.app.q("UPDATE products SET approval_status = 'approved' WHERE id IN (?, ?)").run(p1Id, p2Id);

  // Configure custom per-channel SKU mapping for Product 2
  const chRes = await c.put(`/api/products/${p2Id}/channels`, {
    channels: [
      { platform: 'a', channelSku: 'AMZ-1' },
      { platform: 'n', channelSku: 'NOON-1' }
    ]
  });
  assert.equal(chRes.status, 200);

  // Clear any pushes from setup
  outboundPushes.length = 0;

  // 1. Trigger Amazon sync -> imports AMZ-ORDER-100 (qty 2 of SKU-100) and AMZ-ORDER-MAP-1 (qty 3 of AMZ-1)
  const sync1 = await c.post('/api/integrations/connections/a/sync');
  assert.equal(sync1.status, 200);
  assert.equal(sync1.data.importedOrders ?? sync1.data.ordersNew, 2);

  // Drain any remaining pending jobs in the inventory sync queue
  await new Promise((r) => setTimeout(r, 60));
  await app.app.connectors.processInventorySyncQueue({ limit: 50 });
  const doneCount = app.app.q("SELECT COUNT(*) n FROM inventory_sync_queue WHERE status = 'done'").get().n;
  assert.ok(doneCount >= 3, `expected >= 3 done jobs, got ${doneCount}`);

  // Verify stock deducted accurately:
  // Product 1: 10 - 2 = 8 -> publishable = 8 - 1 (safety_stock) = 7
  const p1After = app.app.q('SELECT stock FROM products WHERE id = ?').get(p1Id);
  assert.equal(p1After.stock, 8);

  // Product 2: 12 - 3 = 9 -> publishable = 9 - 2 (safety_stock) = 7
  const p2After = app.app.q('SELECT stock FROM products WHERE id = ?').get(p2Id);
  assert.equal(p2After.stock, 9);

  // Verify Noon received quantity 7 for SKU-100 AND quantity 7 for custom SKU NOON-1
  const noonSku100 = outboundPushes.find((x) => x.platform === 'n' && x.body?.partner_sku === 'SKU-100');
  assert.ok(noonSku100, 'Noon should receive stock push for SKU-100');
  assert.equal(noonSku100.body.quantity, 7);

  const trendyolSku100 = outboundPushes.find((x) => x.platform === 't' && JSON.stringify(x.body).includes('SKU-100'));
  assert.ok(trendyolSku100, 'Trendyol should receive stock push for SKU-100');
  assert.equal(trendyolSku100.body.items[0].quantity, 7);

  const noonMapped = outboundPushes.find((x) => x.platform === 'n' && x.body?.partner_sku === 'NOON-1');
  assert.ok(noonMapped, 'Noon should receive stock push using mapped channel SKU NOON-1');
  assert.equal(noonMapped.body.partner_sku, 'NOON-1');
  assert.equal(noonMapped.body.quantity, 7);

  // 2. Re-syncing the exact same Amazon orders must NOT double-deduct stock (idempotency)
  const sync2 = await c.post('/api/integrations/connections/a/sync');
  assert.equal(sync2.status, 200);
  assert.equal(sync2.data.importedOrders ?? sync2.data.ordersNew ?? 0, 0);
  assert.equal(app.app.q('SELECT stock FROM products WHERE id = ?').get(p1Id).stock, 8);
  assert.equal(app.app.q('SELECT stock FROM products WHERE id = ?').get(p2Id).stock, 9);
});

test('Inventory sync HTTP 429 schedules exponential backoff retry and succeeds on retry tick', async (t) => {
  let failNextPush = true;
  let noonAttempts = 0;
  const fetchStub = async (url) => {
    if (url.includes('/partner/v1/whoami') || url.includes('/v1/auth') || url.includes('/identity/')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    if (url.includes('/partner/v1/inventory')) {
      noonAttempts++;
      if (failNextPush) {
        return { ok: false, status: 429, text: async () => JSON.stringify({ message: 'Rate limit exceeded' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  const { app, c } = await setupMerchantApp(t, fetchStub);

  assert.equal((await c.put('/api/integrations/connections/n', {
    credentials: { projectCode: 'PRJ1', keyId: 'nk1', privateKey: 'npk1' },
    testNow: true
  })).status, 200);

  const pRes = await c.post('/api/products', {
    name: 'ماكينة قهوة',
    sku: 'COFFEE-429',
    cat: 'أجهزة',
    price: 1200,
    cost: 700,
    stock: 15,
    safetyStock: 2,
    autoPushStock: true,
    markets: 'n'
  });
  const pid = pRes.data.product.id;
  app.app.q("UPDATE products SET approval_status = 'approved' WHERE id = ?").run(pid);

  // Adjust stock via endpoint -> enqueues sync job
  const adj = await c.post(`/api/products/${pid}/stock`, { delta: -3, reason: 'manual_adjustment' });
  assert.equal(adj.status, 200);
  assert.equal(adj.data.product.stock, 12);

  // Wait for auto-scheduled queue tick to hit 429
  await new Promise((r) => setTimeout(r, 60));
  if (noonAttempts === 0) {
    await app.app.connectors.processInventorySyncQueue({ limit: 10 });
  }
  const jobAfter1 = app.app.q('SELECT * FROM inventory_sync_queue WHERE product_id = ?').get(pid);
  assert.equal(jobAfter1.status, 'pending');
  assert.ok(jobAfter1.attempts >= 1);
  assert.ok(Date.parse(jobAfter1.next_retry_at) > Date.now() - 1000);

  // Now simulate Noon recovering + backoff elapsed, then run worker tick -> succeeds!
  failNextPush = false;
  app.app.q("UPDATE inventory_sync_queue SET next_retry_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(jobAfter1.id);
  const tick2 = await app.app.connectors.processInventorySyncQueue({ limit: 10 });
  assert.equal(tick2.succeeded, 1);

  const overview = await c.get('/api/integrations/inventory-sync');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.counts.synced24h, 1);
  assert.equal(overview.data.byProduct[pid].n.status, 'synced');
  assert.equal(overview.data.byProduct[pid].n.lastStock, 10); // 12 - 2 safetyStock
});
