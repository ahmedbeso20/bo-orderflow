'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

class Client {
  constructor(base, ip = '10.99.3.1') {
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
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p); }
}

async function setupPnlApp(t, fetchStub) {
  const app = createApp({
    dbFile: ':memory:',
    secret: 'p'.repeat(48),
    trustProxy: true,
    fetch: fetchStub
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const c = new Client(base);

  const reg = await c.post('/api/auth/register', {
    store: 'متجر الربحية الدقيقة',
    phone: '01055443322',
    email: 'pnl@orderflow.eg',
    password: 'ProfitEngine!9482',
    termsAccepted: true
  });
  assert.equal(reg.status, 200);
  const uRow = app.app.q("SELECT id FROM users WHERE email = 'pnl@orderflow.eg'").get();
  app.app.q("UPDATE users SET status = 'active', plan = 'pro' WHERE id = ?").run(uRow.id);

  const login = await c.post('/api/auth/login', { email: 'pnl@orderflow.eg', password: 'ProfitEngine!9482' });
  assert.equal(login.status, 200);

  return { app, c, userId: uRow.id };
}

test('FIFO batch COGS consumes oldest batches accurately and restores quantities on order cancellation', async (t) => {
  const { app, c } = await setupPnlApp(t);

  // Create product with stock 0 (will add via two FIFO batches)
  const pRes = await c.post('/api/products', {
    name: 'شاحن GaN 65W',
    sku: 'GAN-65W',
    cat: 'إلكترونيات',
    price: 500,
    cost: 100,
    packagingCost: 5,
    stock: 0,
    markets: 'a'
  });
  assert.equal(pRes.status, 200);
  const pid = pRes.data.product.id;

  // Batch 1: 10 units @ 100 EGP (older)
  const b1 = await c.post(`/api/products/${pid}/batches`, {
    qty: 10,
    unitCost: 100,
    batchCode: 'B-OLD',
    purchasedAt: '2026-01-01T00:00:00.000Z',
    addToStock: true
  });
  assert.equal(b1.status, 200);

  // Batch 2: 10 units @ 150 EGP (newer)
  const b2 = await c.post(`/api/products/${pid}/batches`, {
    qty: 10,
    unitCost: 150,
    batchCode: 'B-NEW',
    purchasedAt: '2026-02-01T00:00:00.000Z',
    addToStock: true
  });
  assert.equal(b2.status, 200);

  // Place an order for 12 units -> 10 @ 100 + 2 @ 150 = 1300 EGP COGS!
  const ordRes = await c.post('/api/orders', {
    market: 'a',
    customer: 'عميل FIFO',
    phone: '01011223344',
    gov: 'القاهرة',
    pay: 'بطاقة بنكية',
    courier: 'بوسطة',
    items: [{ productId: pid, qty: 12 }]
  });
  assert.equal(ordRes.status, 200);
  const orderId = ordRes.data.order.id;

  const ordRow = app.app.q('SELECT cost_total, packaging_total FROM orders WHERE id = ?').get(orderId);
  assert.equal(ordRow.cost_total, 1300);
  assert.equal(ordRow.packaging_total, 60); // 12 * 5

  // Verify remaining batches: Batch 1 -> 0, Batch 2 -> 8
  const batchesMid = await c.get(`/api/products/${pid}/batches`);
  assert.equal(batchesMid.data.batches[0].qtyRemaining, 0);
  assert.equal(batchesMid.data.batches[1].qtyRemaining, 8);

  // Verify Order Fee Drilldown exposes consumed FIFO batches
  const feesRes = await c.get(`/api/orders/${orderId}/fees`);
  assert.equal(feesRes.status, 200);
  assert.equal(feesRes.data.batches.length, 2);
  assert.equal(feesRes.data.financials.cogsFifo, 1300);

  // Cancel order -> restores Batch 1 to 10 and Batch 2 to 10
  const cancelRes = await c.post(`/api/orders/${orderId}/cancel`, { reason: 'إلغاء العميل' });
  assert.equal(cancelRes.status, 200);

  const batchesRestored = await c.get(`/api/products/${pid}/batches`);
  assert.equal(batchesRestored.data.batches[0].qtyRemaining, 10);
  assert.equal(batchesRestored.data.batches[1].qtyRemaining, 10);
});

test('Amazon Finances sync, CSV settlement import, monthly pro-rated expenses, and P&L CSV export compute penny-accurate net profit', async (t) => {
  const fetchStub = async (url) => {
    if (url.includes('api.amazon.com/auth/o2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'amz_fin_tok' }) };
    }
    if (url.includes('/sellers/v1/marketplaceParticipations')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ payload: [{ marketplace: { id: 'ARBP9OOSHTCHU' } }] }) };
    }
    if (url.includes('/finances/v0/financialEvents')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          payload: {
            FinancialEvents: {
              ShipmentEventList: [
                {
                  AmazonOrderId: 'AMZ-SETTLE-1',
                  ShipmentItemList: [
                    {
                      ItemFeeList: [
                        { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -115.5, CurrencyCode: 'EGP' } },
                        { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -32.25, CurrencyCode: 'EGP' } },
                        { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -16.17, CurrencyCode: 'EGP' } }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        })
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  const { app, c, userId } = await setupPnlApp(t, fetchStub);

  // Connect Amazon
  assert.equal((await c.put('/api/integrations/connections/a', {
    credentials: { sellerId: 'A2EG', marketplaceId: 'ARBP9OOSHTCHU', clientId: 'cid', clientSecret: 'csec', refreshToken: 'Atzr|ref' },
    testNow: true
  })).status, 200);

  // Create product (cost 400, price 1000)
  const pRes = await c.post('/api/products', {
    name: 'ساعة ذكية',
    sku: 'WATCH-1',
    cat: 'إلكترونيات',
    price: 1000,
    cost: 400,
    stock: 20,
    markets: 'an'
  });
  const pid = pRes.data.product.id;

  // Create Amazon order (will be settled by Finances API) and Noon order (will be settled by CSV)
  const amzOrd = await c.post('/api/orders', {
    market: 'a',
    customer: 'عميل أمازون',
    phone: '01012345678',
    gov: 'القاهرة',
    pay: 'بطاقة بنكية',
    courier: 'بوسطة',
    items: [{ productId: pid, qty: 1 }]
  });
  assert.equal(amzOrd.status, 200);
  const amzOrdId = amzOrd.data.order.id;
  app.app.q("UPDATE orders SET external_ref = 'AMZ-SETTLE-1', ship_fee = 0, created_at = '2026-11-05T10:00:00.000Z' WHERE id = ?").run(amzOrdId);

  const noonOrd = await c.post('/api/orders', {
    market: 'n',
    customer: 'عميل نون',
    phone: '01087654321',
    gov: 'الإسكندرية',
    pay: 'عند الاستلام',
    courier: 'بوسطة',
    items: [{ productId: pid, qty: 1 }]
  });
  assert.equal(noonOrd.status, 200);
  const noonOrdId = noonOrd.data.order.id;
  app.app.q("UPDATE orders SET external_ref = 'NOON-CSV-1', ship_fee = 40, created_at = '2026-11-06T10:00:00.000Z' WHERE id = ?").run(noonOrdId);

  // Sync Amazon Finances -> replaces estimated fees with exact settled fee lines
  const finSync = await c.post('/api/integrations/connections/a/sync-finances');
  assert.equal(finSync.status, 200);
  assert.equal(finSync.data.settledOrders, 1);

  const amzFeeDetail = await c.get(`/api/orders/${amzOrdId}/fees`);
  assert.equal(amzFeeDetail.status, 200);
  assert.equal(amzFeeDetail.data.financials.isSettled, true);
  assert.equal(amzFeeDetail.data.financials.marketplaceCommissions, 147.75); // 115.50 + 32.25
  assert.equal(amzFeeDetail.data.financials.vat, 16.17);
  // Net profit = 1000 - 147.75 - 16.17 - 400 (COGS) = 436.08 EGP exactly!
  assert.equal(amzFeeDetail.data.financials.netProfit, 436.08);

  // Import Noon CSV settlement
  const csvRes = await c.post('/api/finance/settlements/import', {
    csv: 'external_ref,market,commission,shipping_fee,return_penalty,ad_fee,vat\nNOON-CSV-1,n,95,25,0,20,13.3'
  });
  assert.equal(csvRes.status, 200);
  assert.equal(csvRes.data.matchedOrders, 1);

  const noonRow = app.app.q('SELECT fees_source FROM orders WHERE id = ?').get(noonOrdId);
  assert.equal(noonRow.fees_source, 'csv_settled');

  // Add monthly recurring expense (3000 EGP/month rent) starting 2026-11-01
  const expRes = await c.post('/api/finance/expenses', {
    title: 'إيجار المخزن',
    category: 'rent',
    amount: 3000,
    recurrence: 'monthly',
    expenseDate: '2026-11-01'
  });
  assert.equal(expRes.status, 200);

  // Query 10-day P&L window (2026-11-01 .. 2026-11-10 inclusive = 10 days -> pro-rated rent = 3000 * 10/30 = 1000 EGP!)
  const pnlRes = await c.get('/api/finance/pnl?from=2026-11-01&to=2026-11-10');
  assert.equal(pnlRes.status, 200);
  assert.equal(pnlRes.data.selected.operatingExpenses, 1000);
  assert.equal(pnlRes.data.selected.settledOrdersPct, 100);
  assert.equal(pnlRes.data.selected.grossSales, 2000);

  // Verify P&L CSV export responds cleanly with UTF-8 CSV
  const csvExport = await c.get('/api/finance/pnl/export.csv?from=2026-11-01&to=2026-11-10');
  assert.equal(csvExport.status, 200);
  assert.ok(String(csvExport.data).includes('إجمالي المبيعات'));

  // Verify GET /api/dashboard stays backward-compatible and includes missingCogsCount at top-level and kpis
  const dashRes = await c.get('/api/dashboard?range=30&market=all');
  assert.equal(dashRes.status, 200);
  assert.equal(typeof dashRes.data.missingCogsCount, 'number');
  assert.equal(dashRes.data.missingCogsCount, dashRes.data.kpis.missingCogsCount);
  assert.ok(dashRes.data.kpis && typeof dashRes.data.kpis.net === 'number');

  // Verify PUT /api/finance/fee-rules defaults cat to 'all' and applies to estimated orders
  const rulePut = await c.put('/api/finance/fee-rules', {
    market: 'j',
    commissionPct: 18,
    fulfillmentFee: 10,
    closingFee: 5,
    rtoShipMultiplier: 2
  });
  assert.equal(rulePut.status, 200);
  const jRule = rulePut.data.rules.find((r) => r.market === 'j');
  assert.ok(jRule);
  assert.equal(jRule.cat, 'all');
  assert.equal(jRule.commissionPct, 18);

  // Verify manual order with cost_is_estimated=1 product marks order.cost_estimated = 1
  const estProd = await c.post('/api/products', {
    name: 'منتج بتكلفة تقديرية',
    sku: 'EST-001',
    cat: 'عام',
    price: 400,
    cost: 0,
    costIsEstimated: true,
    stock: 10,
    markets: 'j'
  });
  assert.equal(estProd.status, 200);
  const estOrd = await c.post('/api/orders', {
    market: 'j',
    customer: 'عميل جوميا',
    phone: '01099112233',
    gov: 'القاهرة',
    pay: 'عند الاستلام',
    courier: 'بوسطة',
    items: [{ productId: estProd.data.product.id, qty: 1 }]
  });
  assert.equal(estOrd.status, 200);
  assert.equal(estOrd.data.order.costEstimated, true);

  const estFees = await c.get(`/api/orders/${estOrd.data.order.id}/fees`);
  assert.equal(estFees.status, 200);
  // 18% of 400 = 72 commission, fulfillmentFee 10 + closingFee 5 = 15 extra, VAT = (72 + 15) * 0.14 = 12.18
  assert.equal(estFees.data.financials.marketplaceCommissions, 72);
  assert.equal(estFees.data.financials.vat, 12.18);
});
