'use strict';
/**
 * اختبارات شاملة (End-to-End Live Data Pipeline & Security Hardening):
 * 1. تتحقق أن جميع المنصات الخمس (أمازون SP-API، نون Partners، جوميا Vendor Center، ترينديول V2، كنز)
 *    تسحب البيانات الرسمية وتبني فعليًا كل صفحات الموقع بدقة (المنتجات، الطلبات، العملاء، المرتجعات، لوحة التحكم، COD، المستشار الذكي).
 * 2. تتحقق من عدم وجود أسعار أو تكاليف أو شركات شحن مختلقة، ومن الحفاظ على التكلفة اليدوية وتدوير Jumia Refresh Token و idempotency.
 * 3. تتحقق من جميع إصلاحات الأمان الحرجة (حماية /2fa/setup، ربط توثيق البريد، منع تصادم SMS OTP، توقيع Kashier، /api/auth/me، و AWB ids).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createApp } = require('../src/app');
const { generateTotpCode } = require('../src/auth');
const { verifyKashierWebhookSignature } = require('../src/payments/providers/kashier');

function mockRes(status, body, extraHeaders = {}) {
  const isBuf = Buffer.isBuffer(body);
  const textBody = isBuf ? body.toString('utf8') : (typeof body === 'string' ? body : JSON.stringify(body));
  const hdrs = new Map(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => {
        const v = hdrs.get(String(k).toLowerCase());
        return Array.isArray(v) ? v.join(', ') : (v ?? null);
      },
      getSetCookie: () => {
        const v = hdrs.get('set-cookie');
        if (!v) return [];
        return Array.isArray(v) ? v : [v];
      }
    },
    text: async () => textBody,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => {
      const b = isBuf ? body : Buffer.from(textBody, 'utf8');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
  };
}

function makeClient(base) {
  let cookie = '';
  async function req(method, path, body) {
    const headers = { 'X-Requested-With': 'omniarab' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p, b) => req('DELETE', p, b)
  };
}

test('End-to-end live pipeline across all 5 marketplaces builds Products, Orders, Customers, Returns, Dashboard, COD, and AI Advisor accurately', async (t) => {
  // حالة المحاكاة لكل منصة للتحقق من الطلبات والتدوير والتحديث في المزامنة الثانية
  let syncRound = 1;
  let amazon429Count = 0;
  let noonCookieSeen = 0;
  let noonUserAgentSeen = 0;
  let noonProjectSeen = 0;
  const jumiaRefreshTokensSent = [];
  let trendyolV2Calls = 0;
  let trendyolStorefrontSeen = 0;

  // توليد مفتاح RSA حقيقي لتجربة Noon RS256 + Session Cookie
  const { privateKey: noonPemKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  const nowIso = new Date().toISOString();

  const mockFetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const hdrs = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

    // ────────── 1. AMAZON SP-API (LWA + Reports GZIP TSV + FBA Summaries + Orders + Items) ──────────
    if (u.startsWith('https://api.amazon.com/auth/o2/token')) {
      return mockRes(200, { access_token: 'amz-lwa-live-token', expires_in: 3600 });
    }
    if (u.startsWith('https://sellingpartnerapi-eu.amazon.com/sellers/v1/marketplaceParticipations')) {
      return mockRes(200, { payload: [{ marketplace: { id: 'ARBP9OOSHTCHU', name: 'Amazon.eg' } }] });
    }
    if (u.startsWith('https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/reports') && method === 'POST') {
      return mockRes(202, { reportId: 'RPT-EG-001' });
    }
    if (u.endsWith('/reports/2021-06-30/reports/RPT-EG-001')) {
      return mockRes(200, { processingStatus: 'DONE', reportDocumentId: 'DOC-EG-001' });
    }
    if (u.endsWith('/reports/2021-06-30/documents/DOC-EG-001')) {
      return mockRes(200, {
        url: 'https://tortuga-prod-eu.s3-eu-west-1.amazonaws.com/listings-eg.tsv.gz',
        compressionAlgorithm: 'GZIP'
      });
    }
    if (u.startsWith('https://tortuga-prod-eu.s3-eu-west-1.amazonaws.com/listings-eg.tsv.gz')) {
      const stockFbm = syncRound === 1 ? '14' : '9';
      const tsv = [
        'item-name\tseller-sku\tprice\tquantity\tasin1\tfulfillment-channel\tstatus',
        `سماعة سوني لاسلكية WH-CH520\tAMZ-SONY-520\t1450.00\t18\tB09TEST01\tAMAZON_EU\tActive`,
        `كابل شحن أنكر 100 واط FBM\tAMZ-ANKER-100\t620.00\t${stockFbm}\tB09TEST02\tDEFAULT\tActive`
      ].join('\n');
      const gz = zlib.gzipSync(Buffer.from(tsv, 'utf8'));
      return mockRes(200, gz, { 'content-type': 'application/octet-stream' });
    }
    if (u.startsWith('https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries')) {
      // محاكاة 429 مرة واحدة للتحقق من retry-with-backoff التلقائي
      if (amazon429Count === 0) {
        amazon429Count++;
        return mockRes(429, { errors: [{ code: 'QuotaExceeded' }] }, { 'retry-after': '0' });
      }
      return mockRes(200, {
        payload: {
          inventorySummaries: [
            { sellerSku: 'AMZ-SONY-520', productName: 'سماعة سوني لاسلكية WH-CH520', totalQuantity: syncRound === 1 ? 22 : 20 }
          ]
        }
      });
    }
    if (u.startsWith('https://sellingpartnerapi-eu.amazon.com/orders/v0/orders?')) {
      return mockRes(200, {
        payload: {
          Orders: [
            {
              AmazonOrderId: '405-1111111-2222222',
              OrderStatus: 'Shipped',
              FulfillmentChannel: 'AFN',
              OrderTotal: { Amount: '2900.00', CurrencyCode: 'EGP' },
              PaymentMethod: 'Other',
              PurchaseDate: nowIso,
              BuyerInfo: { BuyerName: 'أحمد سامي', BuyerEmail: 'ahmed@example.eg' },
              ShippingAddress: { Name: 'أحمد سامي', City: 'القاهرة', StateOrRegion: 'القاهرة', AddressLine1: 'مدينة نصر', Phone: '01011112222' }
            },
            {
              AmazonOrderId: '405-3333333-4444444',
              OrderStatus: 'Returned',
              FulfillmentChannel: 'MFN',
              OrderTotal: { Amount: '620.00', CurrencyCode: 'EGP' },
              PaymentMethod: 'COD',
              PurchaseDate: nowIso,
              BuyerInfo: { BuyerName: 'سارة محمود' },
              ShippingAddress: { Name: 'سارة محمود', City: 'الجيزة', AddressLine1: 'الدقي', Phone: '01022223333' }
            }
          ]
        }
      });
    }
    if (u.includes('/orders/v0/orders/405-1111111-2222222/orderItems')) {
      return mockRes(200, {
        payload: {
          OrderItems: [
            { SellerSKU: 'AMZ-SONY-520', Title: 'سماعة سوني لاسلكية WH-CH520', QuantityOrdered: 2, ItemPrice: { Amount: '2900.00' } }
          ]
        }
      });
    }
    if (u.includes('/orders/v0/orders/405-3333333-4444444/orderItems')) {
      return mockRes(200, {
        payload: {
          OrderItems: [
            { SellerSKU: 'AMZ-ANKER-100', Title: 'كابل شحن أنكر 100 واط FBM', QuantityOrdered: 1, ItemPrice: { Amount: '620.00' } }
          ]
        }
      });
    }

    // ────────── 2. NOON PARTNERS API (JWT RS256 -> Set-Cookie + User-Agent + X-Project) ──────────
    if (u.startsWith('https://noon-api-gateway.noon.partners/identity/public/v1/api/login')) {
      assert.ok(hdrs['user-agent'], 'Noon login must send User-Agent');
      assert.equal(hdrs['x-project'], 'PRJ_EG_99', 'Noon login must send X-Project');
      return mockRes(200, { ok: true, user: 'noon-partner' }, { 'set-cookie': 'noon_sid=live_cookie_7788; Path=/; HttpOnly' });
    }
    if (u.startsWith('https://noon-api-gateway.noon.partners/identity/v1/whoami')) {
      if ((hdrs.cookie || '').includes('noon_sid=live_cookie_7788')) noonCookieSeen++;
      if (hdrs['user-agent']) noonUserAgentSeen++;
      if (hdrs['x-project'] === 'PRJ_EG_99') noonProjectSeen++;
      return mockRes(200, { project_code: 'PRJ_EG_99', authenticated: true });
    }
    if (u.startsWith('https://noon-api-gateway.noon.partners/stock/v1/stock-list')) {
      if ((hdrs.cookie || '').includes('noon_sid=live_cookie_7788')) noonCookieSeen++;
      if (hdrs['user-agent']) noonUserAgentSeen++;
      if (hdrs['x-project'] === 'PRJ_EG_99') noonProjectSeen++;
      return mockRes(200, {
        items: [
          { partner_sku: 'NOON-PWR-20K', title: 'باور بانك نون 20000 مللي أمبير', sale_price: 980, stock_gross: 15, category: 'إلكترونيات' }
        ]
      });
    }
    if (u.startsWith('https://noon-api-gateway.noon.partners/fbpi/v1/orders/search')) {
      if ((hdrs.cookie || '').includes('noon_sid=live_cookie_7788')) noonCookieSeen++;
      if (hdrs['user-agent']) noonUserAgentSeen++;
      if (hdrs['x-project'] === 'PRJ_EG_99') noonProjectSeen++;
      return mockRes(200, {
        orders: [
          {
            order_nr: 'NEGG-1001',
            status: 'delivered',
            total_amount: 980,
            payment_method: 'card',
            fulfillment_type: 'FBN',
            created_at: nowIso,
            customer_name: 'كريم عادل',
            customer_phone: '01133334444',
            city: 'الإسكندرية',
            items: [{ partner_sku: 'NOON-PWR-20K', title: 'باور بانك نون 20000 مللي أمبير', quantity: 1, unit_price: 980 }]
          },
          {
            order_nr: 'NEGG-1002',
            status: 'returned',
            total_amount: 980,
            payment_method: 'cod',
            fulfillment_type: 'FBN',
            return_reason: 'العميل رفض الاستلام',
            created_at: nowIso,
            customer_name: 'كريم عادل',
            customer_phone: '01133334444',
            city: 'الإسكندرية',
            items: [{ partner_sku: 'NOON-PWR-20K', title: 'باور بانك نون 20000 مللي أمبير', quantity: 1, unit_price: 980 }]
          }
        ]
      });
    }

    // ────────── 3. JUMIA VENDOR CENTER (Rotating refresh_token + /shops + variations[] + /orders/items Array) ──────────
    if (u.startsWith('https://vendor-api.jumia.com/token')) {
      const form = new URLSearchParams(String(opts.body || ''));
      const sentRt = form.get('refresh_token');
      jumiaRefreshTokensSent.push(sentRt);
      const nextRt = sentRt === 'jumia-initial-rt-v1' ? 'jumia-rotated-rt-v2' : 'jumia-rotated-rt-v3';
      return mockRes(200, { access_token: 'jumia-jwt-live', refresh_token: nextRt, expires_in: 3600 });
    }
    if (u.startsWith('https://vendor-api.jumia.com/shops')) {
      return mockRes(200, { shops: [{ id: 'SHOP-EG-AUTO-1', name: 'متجر جوميا مصر' }] });
    }
    if (u.startsWith('https://vendor-api.jumia.com/catalog/products')) {
      return mockRes(200, {
        products: [
          {
            name: 'ماكينة حلاقة فيليبس أصلية',
            category: { name: 'عناية شخصية' },
            variations: [
              { sellerSku: 'JUM-PHIL-01', name: 'أسود', globalPrice: { value: 1250 }, stock: 10 }
            ]
          }
        ]
      });
    }
    if (u.startsWith('https://vendor-api.jumia.com/catalog/stock')) {
      return mockRes(200, {
        products: [
          { sellerSku: 'JUM-PHIL-01', totalStock: 12, reservedStock: 2 }
        ]
      });
    }
    if (u.startsWith('https://vendor-api.jumia.com/orders/items')) {
      return mockRes(200, [
        {
          orderId: 'JUM-ORD-501',
          orderNumber: '300501999',
          items: [
            { sellerSku: 'JUM-PHIL-01', product: { name: 'ماكينة حلاقة فيليبس أصلية' }, paidPriceLocal: 1250, quantity: 1 }
          ]
        }
      ]);
    }
    if (u.startsWith('https://vendor-api.jumia.com/orders')) {
      return mockRes(200, {
        orders: [
          {
            id: 'JUM-ORD-501',
            number: '300501999',
            status: syncRound === 1 ? 'PENDING' : 'DELIVERED',
            totalAmountLocalValue: 1250,
            paymentMethod: 'COD',
            createdAt: nowIso,
            shippingAddress: { firstName: 'منى', lastName: 'حسن', city: 'المنصورة', address1: 'شارع الجمهورية', phone: '01244445555' }
          }
        ]
      });
    }

    // ────────── 4. TRENDYOL SUPPLIER API V2 (Basic Auth + storeFrontCode + V2 Orders + Claims) ──────────
    if (u.startsWith('https://apigw.trendyol.com/integration/product/sellers/778899/products')) {
      if (hdrs.storefrontcode === 'EG') trendyolStorefrontSeen++;
      assert.ok(hdrs.authorization && hdrs.authorization.startsWith('Basic '));
      assert.ok(hdrs['user-agent'] && hdrs['user-agent'].includes('778899'));
      return mockRes(200, {
        totalPages: 1,
        content: [
          { barcode: 'TRD-JACKET-M', stockCode: 'TRD-JACKET-M', title: 'جاكيت قطن ترينديول مقاس M', salePrice: 850, quantity: 25, categoryName: 'أزياء' }
        ]
      });
    }
    if (u.startsWith('https://apigw.trendyol.com/integration/order/sellers/778899/v2/orders')) {
      trendyolV2Calls++;
      if (hdrs.storefrontcode === 'EG') trendyolStorefrontSeen++;
      return mockRes(200, {
        totalPages: 1,
        content: [
          {
            shipmentPackageId: 990011,
            orderNumber: 'TY-EG-990011',
            shipmentPackageStatus: 'Delivered',
            packageGrossAmount: 850,
            orderDate: Date.now(),
            customerFirstName: 'ندى',
            customerLastName: 'خالد',
            cargoProviderName: 'أرامكس ترينديول',
            cargoTrackingNumber: 'TRK-TY-990011',
            cargoTrackingLink: 'https://track.trendyol.com/TRK-TY-990011',
            shipmentAddress: { fullName: 'ندى خالد', city: 'القاهرة', fullAddress: 'المعادي', phone: '01555556666' },
            lines: [{ merchantSku: 'TRD-JACKET-M', productName: 'جاكيت قطن ترينديول مقاس M', quantity: 1, lineUnitPrice: 850 }]
          },
          {
            shipmentPackageId: 990012,
            orderNumber: 'TY-EG-990012',
            shipmentPackageStatus: 'Delivered',
            packageGrossAmount: 850,
            orderDate: Date.now(),
            customerFirstName: 'يوسف',
            customerLastName: 'طارق',
            cargoProviderName: 'أرامكس ترينديول',
            shipmentAddress: { fullName: 'يوسف طارق', city: 'طنطا', fullAddress: 'وسط البلد', phone: '01566667777' },
            lines: [{ merchantSku: 'TRD-JACKET-M', productName: 'جاكيت قطن ترينديول مقاس M', quantity: 1, lineUnitPrice: 850 }]
          }
        ]
      });
    }
    if (u.startsWith('https://apigw.trendyol.com/integration/order/sellers/778899/claims')) {
      return mockRes(200, {
        totalPages: 1,
        content: [
          {
            orderNumber: 'TY-EG-990012',
            shipmentPackageId: 990012,
            claimItemStatus: 'Accepted',
            customerClaimItemReason: { name: 'المقاس غير مناسب' }
          }
        ]
      });
    }

    // ────────── 5. KENZZ PARTNER API (Products with real cost + Bosta COD Delivered Order) ──────────
    if (u.startsWith('https://partners-api.kenzz.com/v1/merchant/profile')) {
      if ((hdrs.authorization || '').includes('INVALID-KEY-401')) {
        return mockRes(401, { error: 'Unauthorized API key' });
      }
      assert.equal(hdrs['x-store-id'], 'KNZ-55');
      return mockRes(200, { storeId: 'KNZ-55', storeName: 'متجر كنز الاختباري', status: 'active' });
    }
    if (u.startsWith('https://partners-api.kenzz.com/v1/products')) {
      return mockRes(200, {
        products: [
          { sku: 'KNZ-BLENDER-1', name: 'خلاط مطبخ كنز 600 واط', price: 1100, cost: 720, stock: 4, category: 'أجهزة منزلية' }
        ]
      });
    }
    if (u.startsWith('https://partners-api.kenzz.com/v1/orders')) {
      return mockRes(200, {
        orders: [
          {
            id: 'KNZ-ORD-701',
            status: 'delivered',
            total: 1100,
            paymentMethod: 'cod',
            courier: 'بوسطة',
            shipFee: 45,
            createdAt: nowIso,
            customer: { name: 'حسام علي', phone: '01088889999', city: 'الجيزة', address: 'الشيخ زايد' },
            items: [{ sku: 'KNZ-BLENDER-1', name: 'خلاط مطبخ كنز 600 واط', qty: 1, price: 1100 }]
          }
        ]
      });
    }

    return mockRes(404, { error: `Unmocked URL: ${u}` });
  };

  const srv = createApp({
    dbFile: ':memory:',
    secret: 'live-pipeline-secret-key-2026-abcdef123456',
    fetch: mockFetch,
    allowPlanSelfService: true
  });
  await new Promise((res) => srv.server.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());

  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const c = makeClient(base);

  // تسجيل تاجر حقيقي وتفعيله وترقيته لباقة الأعمال (تسمح بـ 5 أسواق)
  const reg = await c.post('/api/auth/register', {
    store: 'متجر الاختبار الشامل',
    phone: '01090001122',
    email: 'live-merchant@orderflow.eg',
    password: 'LiveMerchant@2026!',
    termsAccepted: true
  });
  assert.equal(reg.status, 200);
  srv.app.q("UPDATE users SET status = 'active', plan = 'business' WHERE email = ?").run('live-merchant@orderflow.eg');
  const login = await c.post('/api/auth/login', {
    email: 'live-merchant@orderflow.eg',
    password: 'LiveMerchant@2026!'
  });
  assert.equal(login.status, 200);

  // التحقق من عدم وجود أي منتجات/طلبات قبل الربط
  const beforeProds = await c.get('/api/products');
  assert.equal(beforeProds.data.products.length, 0);

  // ── ربط جميع المنصات الخمس مع testNow: true + syncNow: true ──
  const amzPut = await c.put('/api/integrations/connections/a', {
    enabled: true,
    environment: 'production',
    testNow: true,
    syncNow: true,
    credentials: {
      sellerId: 'A2EGYPTLIVE',
      marketplaceId: 'ARBP9OOSHTCHU',
      clientId: 'amzn1.app.live',
      clientSecret: 'amzn-secret-live',
      refreshToken: 'Atzr|live-refresh'
    }
  });
  assert.equal(amzPut.status, 200, JSON.stringify(amzPut.data));
  assert.equal(amzPut.data.testResult.ok, true);
  assert.equal(amzPut.data.syncResult.ok, true);
  assert.equal(amzPut.data.syncResult.importedProducts, 2);
  assert.equal(amzPut.data.syncResult.importedOrders, 2);
  assert.equal(amazon429Count, 1, 'Amazon 429 retry-with-backoff must succeed seamlessly');

  const noonPut = await c.put('/api/integrations/connections/n', {
    enabled: true,
    environment: 'production',
    testNow: true,
    syncNow: true,
    credentials: {
      projectCode: 'PRJ_EG_99',
      keyId: 'noon-key-01',
      privateKey: noonPemKey
    }
  });
  assert.equal(noonPut.status, 200, JSON.stringify(noonPut.data));
  assert.equal(noonPut.data.testResult.ok, true);
  assert.equal(noonPut.data.syncResult.ok, true);
  assert.ok(noonCookieSeen >= 2, 'Noon must forward Set-Cookie session across stock and orders');
  assert.ok(noonUserAgentSeen >= 2 && noonProjectSeen >= 2);

  const jumiaPut = await c.put('/api/integrations/connections/j', {
    enabled: true,
    environment: 'production',
    testNow: true,
    syncNow: true,
    credentials: {
      // shopId متروك فارغًا لاختبار الاكتشاف التلقائي من GET /shops
      shopId: '',
      clientId: 'jumia-client-eg',
      apiKey: 'jumia-initial-rt-v1'
    }
  });
  assert.equal(jumiaPut.status, 200, JSON.stringify(jumiaPut.data));
  assert.equal(jumiaPut.data.testResult.ok, true);
  assert.equal(jumiaPut.data.syncResult.ok, true);
  assert.equal(jumiaPut.data.syncResult.importedProducts, 1);
  assert.equal(jumiaPut.data.syncResult.importedOrders, 1);

  const trendyolPut = await c.put('/api/integrations/connections/t', {
    enabled: true,
    environment: 'production',
    testNow: true,
    syncNow: true,
    credentials: {
      supplierId: '778899',
      apiKey: 'ty-key-live',
      apiSecret: 'ty-secret-live',
      storeFrontCode: 'EG'
    }
  });
  assert.equal(trendyolPut.status, 200, JSON.stringify(trendyolPut.data));
  assert.equal(trendyolPut.data.testResult.ok, true);
  assert.equal(trendyolPut.data.syncResult.ok, true);
  assert.ok(trendyolV2Calls >= 1, 'Trendyol must pull from Order V2 endpoint');
  assert.ok(trendyolStorefrontSeen >= 2, 'Trendyol must send storeFrontCode header');

  const kenzzPut = await c.put('/api/integrations/connections/k', {
    enabled: true,
    environment: 'production',
    testNow: true,
    syncNow: true,
    credentials: {
      storeId: 'KNZ-55',
      apiKey: 'knz-key-live',
      baseUrl: 'https://partners-api.kenzz.com/v1'
    }
  });
  assert.equal(kenzzPut.status, 200, JSON.stringify(kenzzPut.data));
  assert.equal(kenzzPut.data.testResult.ok, true);
  assert.equal(kenzzPut.data.syncResult.ok, true);

  // ── 1. التحقق من صفحة المنتجات: أسعار حقيقية (لا 100 مختلق) ولا تكلفة 65% مختلقة ──
  const prodsRes = await c.get('/api/products');
  assert.equal(prodsRes.status, 200);
  const prods = prodsRes.data.products;
  assert.equal(prods.length, 6, 'Should have 6 real products across all 5 marketplaces');
  const bySku = Object.fromEntries(prods.map((p) => [p.sku, p]));

  assert.equal(bySku['AMZ-SONY-520'].price, 1450, 'Amazon FBA real price from Listings Report');
  assert.equal(bySku['AMZ-SONY-520'].stock, 22, 'Amazon FBA stock merged from Inventory Summaries');
  assert.equal(bySku['AMZ-SONY-520'].cost, 0, 'Must NOT fabricate 65% cost when API omits cost');
  assert.equal(bySku['AMZ-ANKER-100'].price, 620, 'Amazon FBM product included from Listings Report');
  assert.equal(bySku['NOON-PWR-20K'].price, 980);
  assert.equal(bySku['JUM-PHIL-01'].price, 1250, 'Jumia nested variation price');
  assert.equal(bySku['JUM-PHIL-01'].stock, 10, 'Jumia stock merged from /catalog/stock (12 - 2 reserved)');
  assert.equal(bySku['TRD-JACKET-M'].price, 850);
  assert.equal(bySku['KNZ-BLENDER-1'].price, 1100);
  assert.equal(bySku['KNZ-BLENDER-1'].cost, 720, 'Kenzz real API cost preserved');

  // التاجر يُدخل التكلفة اليدوية لمنتج أمازون ثم نتحقق من حفظها في المزامنة الثانية
  const updCost = await c.put(`/api/products/${bySku['AMZ-SONY-520'].id}`, { cost: 910 });
  assert.equal(updCost.status, 200);
  assert.equal(updCost.data.product.cost, 910);

  // ── 2. التحقق من صفحة الطلبات وربط order_items.product_id و couriers الحقيقية ──
  const ordersRes = await c.get('/api/orders');
  assert.equal(ordersRes.status, 200);
  const orders = ordersRes.data.items;
  assert.equal(orders.length, 8, 'Should have 8 orders across all 5 platforms');

  const amzFbaOrd = orders.find((o) => o.externalRef === '405-1111111-2222222');
  assert.ok(amzFbaOrd);
  assert.equal(amzFbaOrd.courier, 'أمازون FBA', 'AFN order must NOT be labeled Bosta');
  assert.equal(amzFbaOrd.total, 2900);

  const tyReturnedOrd = orders.find((o) => o.externalRef === '990012' || o.externalRef === 'TY-EG-990012');
  assert.ok(tyReturnedOrd);
  assert.equal(tyReturnedOrd.status, 3, 'Trendyol claim must mark order Returned (status = 3)');

  const tyDeliveredOrd = orders.find((o) => o.externalRef === '990011' || o.externalRef === 'TY-EG-990011');
  assert.ok(tyDeliveredOrd);
  assert.equal(tyDeliveredOrd.awbNumber, 'TRK-TY-990011');

  // التحقق من ربط order_items بـ product_id الحقيقي وحساب cost_total لطلب كنز (تكلفة 720)
  const linkedItems = srv.app.q('SELECT COUNT(*) n FROM order_items WHERE product_id IS NOT NULL').get().n;
  assert.equal(linkedItems, 8, 'Every pulled order_item must be linked to its catalog product_id');
  const knzRawOrd = srv.app.q("SELECT cost_total, ship_fee FROM orders WHERE external_ref = 'KNZ-ORD-701'").get();
  assert.equal(knzRawOrd.cost_total, 720, 'Real cost_total must come from matched product cost');
  assert.equal(knzRawOrd.ship_fee, 45, 'Real ship_fee from API preserved');

  // التحقق من طباعة بوليصة AWB لطلب واحد عبر ?ids=<id>
  const singleAwb = await c.get(`/api/orders/awb?ids=${tyDeliveredOrd.id}`);
  assert.equal(singleAwb.status, 200);
  assert.match(singleAwb.data, /ندى خالد/);
  assert.doesNotMatch(singleAwb.data, /حسام علي/);

  // ── 3. التحقق من صفحة العملاء (CRM) ودمج عميل نون المتكرر وحساب returnedCount ──
  const custRes = await c.get('/api/customers');
  assert.equal(custRes.status, 200);
  const kareem = custRes.data.customers.find((x) => x.name === 'كريم عادل');
  assert.ok(kareem, 'Noon customer must be created in CRM');
  assert.equal(kareem.ordersCount, 2, 'Two Noon orders with same phone deduplicated into 1 CRM customer');
  assert.equal(kareem.returnedCount, 1, 'Returned Noon order counted in customer returnedCount');
  assert.equal(kareem.totalSpent, 980, 'totalSpent excludes returned order');

  // ── 4. التحقق من صفحة المرتجعات (RTO) ──
  const retRes = await c.get('/api/returns');
  assert.equal(retRes.status, 200);
  assert.equal(retRes.data.summary.count, 3, '3 returned orders (Amazon + Noon + Trendyol Claim)');
  assert.ok(retRes.data.summary.returnRate > 0);

  // ── 5. التحقق من لوحة التحكم (Dashboard) مع ?source=connected ──
  const dashRes = await c.get('/api/dashboard?source=connected&range=30');
  assert.equal(dashRes.status, 200);
  const kpis = dashRes.data.kpis;
  // الطلبات غير المرتجعة: AMZ(2900) + Noon(980) + Jumia(1250) + Trendyol(850) + Kenzz(1100) = 7080
  assert.equal(kpis.gross, 7080, 'Exact gross revenue across all 5 live platforms');
  assert.equal(kpis.orders, 8);
  assert.equal(kpis.returned, 3);
  assert.equal(kpis.avgOrder, 885);
  assert.equal(kpis.unpricedCostCount, 4, '4 products still have cost=0 (6 total - 1 Kenzz API cost - 1 manual Amazon cost)');
  assert.equal(dashRes.data.marketShare.a.amount, 2900);
  assert.equal(dashRes.data.marketShare.a.orders, 2);
  assert.equal(dashRes.data.marketShare.n.amount, 980);
  assert.equal(dashRes.data.marketShare.j.amount, 1250);
  assert.equal(dashRes.data.marketShare.t.amount, 850);
  assert.equal(dashRes.data.marketShare.k.amount, 1100);

  // ── 6. التحقق من صفحة COD: بوسطة تحسب طلب كنز COD المسلّم فقط (1100)، ولا تخلط أمازون FBA أو نون البطاقة ──
  const codRes = await c.get('/api/cod');
  assert.equal(codRes.status, 200);
  const bostaCod = codRes.data.couriers.find((x) => x.key === 'bosta');
  assert.equal(bostaCod.collected, 1100, 'Bosta COD must only count genuine delivered Bosta COD order');
  assert.equal(bostaCod.fees, 45);
  assert.equal(bostaCod.net, 1055);
  assert.equal(codRes.data.totals.collected, 1100, 'Total COD must NOT include FBA or prepaid orders');

  // ── 7. التحقق من المستشار الذكي (AI Advisor) يعكس المنتجات الحقيقية المسحوبة ──
  const aiRes = await c.post('/api/ai/advisor', {});
  assert.equal(aiRes.status, 200);
  assert.match(aiRes.data.advisor.data.headline, /6|٦/, 'AI advisor headline reflects 6 pulled products');
  assert.match(aiRes.data.advisor.data.urgentRestockTip, /خلاط مطبخ كنز/, 'AI advisor flags low-stock pulled Kenzz product');

  // ── 8. المزامنة الثانية (Idempotency + Jumia refresh_token rotation + تحديث حالة الطلب والمخزون + حفظ التكلفة اليدوية) ──
  syncRound = 2;
  const syncAll = await c.post('/api/sync', {});
  assert.equal(syncAll.status, 200);
  assert.equal(syncAll.data.liveResults.length, 5);
  assert.ok(syncAll.data.liveResults.every((r) => r.ok));

  // التحقق من استخدام Refresh Token المدوّر لجوميا في المزامنة الثانية
  assert.ok(
    jumiaRefreshTokensSent.includes('jumia-rotated-rt-v2'),
    `Expected rotated Jumia refresh_token to be persisted & reused, got: ${JSON.stringify(jumiaRefreshTokensSent)}`
  );

  // التحقق من عدم تكرار المنتجات أو الطلبات وتحديث المخزون والحالة والحفاظ على التكلفة اليدوية
  const prods2 = (await c.get('/api/products')).data.products;
  assert.equal(prods2.length, 6, 'Second sync must NOT duplicate products');
  const bySku2 = Object.fromEntries(prods2.map((p) => [p.sku, p]));
  assert.equal(bySku2['AMZ-SONY-520'].cost, 910, 'Manual merchant cost MUST survive subsequent syncs');
  assert.equal(bySku2['AMZ-SONY-520'].stock, 20, 'Stock updated on 2nd sync');
  assert.equal(bySku2['AMZ-ANKER-100'].stock, 9, 'FBM stock updated on 2nd sync');

  const orders2 = (await c.get('/api/orders')).data.items;
  assert.equal(orders2.length, 8, 'Second sync must NOT duplicate orders');
  const jumiaOrd2 = orders2.find((o) => o.externalRef === '300501999' || o.externalRef === 'JUM-ORD-501');
  assert.ok(jumiaOrd2);
  assert.equal(jumiaOrd2.status, 2, 'Jumia order status updated from PENDING(0) -> DELIVERED(2)');

  // التحقق من تسجيل سجل المزامنات
  const runsRes = await c.get('/api/integrations/sync-runs?limit=20');
  assert.ok(runsRes.data.runs.length >= 10, 'connector_sync_runs logged for both rounds');

  // ── 9. التحقق من رفض SSRF (IP خاص) برسالة عربية واضحة ──
  const ssrfRes = await c.put('/api/integrations/connections/k', {
    enabled: true,
    environment: 'production',
    credentials: {
      storeId: 'KNZ-55',
      apiKey: 'knz-key-live',
      baseUrl: 'https://169.254.169.254/latest/meta-data'
    }
  });
  assert.equal(ssrfRes.status, 400, 'SSRF metadata IP must be rejected with 400');

  // ── 10. التحقق من معالجة خطأ 401 (مفتاح خاطئ) برسالة عربية واضحة وحفظ status = error ──
  const badKeyRes = await c.put('/api/integrations/connections/k', {
    enabled: true,
    environment: 'production',
    testNow: true,
    syncNow: true,
    credentials: {
      storeId: 'KNZ-55',
      apiKey: 'INVALID-KEY-401',
      baseUrl: 'https://partners-api.kenzz.com/v1'
    }
  });
  assert.equal(badKeyRes.status, 200);
  assert.equal(badKeyRes.data.testResult.ok, false);
  assert.equal(badKeyRes.data.syncResult, null, 'Must not run sync when testNow fails');
  assert.equal(badKeyRes.data.connection.status, 'error');
  assert.ok(badKeyRes.data.connection.lastError.length > 0, 'lastError persisted for merchant visibility');
});

test('Security hardening regressions: /api/auth/me flag, 2FA /setup bypass blocked, email target binding, SMS OTP collision-safe, Kashier signatureKeys validation', async (t) => {
  const sentSms = [];
  const srv = createApp({
    dbFile: ':memory:',
    secret: 'sec-regression-secret-key-2026-abcdef1234',
    smsProvider: 'mock',
    smsSend: async (msg) => { sentSms.push(msg); return { delivered: true }; }
  });
  // تفعيل مزوّد SMS تجريبي داخل app للاختبار المباشر
  srv.app.sms.configured = true;
  srv.app.sms.send = async (msg) => { sentSms.push(msg); return { delivered: true }; };

  await new Promise((res) => srv.server.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());

  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const c1 = makeClient(base);
  const c2 = makeClient(base);

  // 1. تسجيل تاجرين وتفعيلهما
  await c1.post('/api/auth/register', {
    store: 'متجر أمان 1', phone: '01011001100', email: 'sec1@orderflow.eg', password: 'SecUserOne@2026!', termsAccepted: true
  });
  await c2.post('/api/auth/register', {
    store: 'متجر أمان 2', phone: '01022002200', email: 'sec2@orderflow.eg', password: 'SecUserTwo@2026!', termsAccepted: true
  });
  srv.app.q("UPDATE users SET status = 'active' WHERE email IN ('sec1@orderflow.eg', 'sec2@orderflow.eg')").run();
  await c1.post('/api/auth/login', { email: 'sec1@orderflow.eg', password: 'SecUserOne@2026!' });
  await c2.post('/api/auth/login', { email: 'sec2@orderflow.eg', password: 'SecUserTwo@2026!' });

  // 2. التحقق من /api/auth/me يعيد authenticated: true
  const me1 = await c1.get('/api/auth/me');
  assert.equal(me1.status, 200);
  assert.equal(me1.data.authenticated, true);
  assert.equal(me1.data.ok, true);
  assert.equal(me1.data.setup2faRequired, false);

  // 3. التحقق من حماية /api/account/2fa/setup ضد تعطيل 2FA المفعّل بالفعل
  const s1 = await c1.post('/api/account/2fa/setup', {});
  assert.equal(s1.status, 200);
  const rowPending = srv.app.q("SELECT totp_enabled, totp_secret_enc, totp_pending_secret_enc FROM users WHERE email = 'sec1@orderflow.eg'").get();
  assert.equal(rowPending.totp_enabled, 0);
  assert.ok(rowPending.totp_pending_secret_enc.length > 0, 'Pending secret stored in separate column');

  const en1 = await c1.post('/api/account/2fa/enable', { code: generateTotpCode(s1.data.secret) });
  assert.equal(en1.status, 200);
  assert.equal(en1.data.totpEnabled, true);

  // محاولة استدعاء /2fa/setup مرة أخرى بدون كلمة مرور ورمز حالي يجب أن تُرفض بـ 403 دون المساس بـ totp_enabled
  const bypassAttempt = await c1.post('/api/account/2fa/setup', {});
  assert.equal(bypassAttempt.status, 403);
  assert.equal(bypassAttempt.data.code, '2FA_ALREADY_ENABLED');
  const rowStillProtected = srv.app.q("SELECT totp_enabled FROM users WHERE email = 'sec1@orderflow.eg'").get();
  assert.equal(rowStillProtected.totp_enabled, 1, '2FA must remain enabled after blocked setup attempt');

  // 4. التحقق من رفض توثيق البريد القديم بعد تغيير البريد الإلكتروني (مع إعادة المصادقة الإلزامية)
  const sendMail = await c1.post('/api/account/verify-email/send', {});
  assert.equal(sendMail.status, 200);
  const oldEmailToken = sendMail.data.devToken;
  const changeEmail = await c1.put('/api/settings', {
    storeEmail: 'sec1-changed@orderflow.eg',
    currentPassword: 'SecUserOne@2026!',
    totpCode: generateTotpCode(s1.data.secret, Date.now() + 30_000)
  });
  assert.equal(changeEmail.status, 200, JSON.stringify(changeEmail.data));
  const verifyOld = await c1.post('/api/auth/verify-email', { token: oldEmailToken });
  assert.equal(verifyOld.status, 400, 'Old email verification token must be rejected after email change');
  const userAfterOld = srv.app.q("SELECT email_verified_at FROM users WHERE email = 'sec1-changed@orderflow.eg'").get();
  assert.equal(userAfterOld.email_verified_at, null);

  // 5. التحقق من أن SMS OTP يستخدم nonce فريد ولا يتصادم حتى عند تشابه الرمز السداسي بين مستخدمين
  const origRandomInt = crypto.randomInt;
  crypto.randomInt = () => 654321;
  try {
    const otp1 = await c1.post('/api/account/verify-phone/send', {});
    const otp2 = await c2.post('/api/account/verify-phone/send', {});
    assert.equal(otp1.status, 200);
    assert.equal(otp2.status, 200);
    assert.equal(otp1.data.devOtp, '654321');
    assert.equal(otp2.data.devOtp, '654321');
    const conf1 = await c1.post('/api/account/verify-phone/confirm', { code: '654321' });
    const conf2 = await c2.post('/api/account/verify-phone/confirm', { code: '654321' });
    assert.equal(conf1.status, 200);
    assert.equal(conf2.status, 200);
  } finally {
    crypto.randomInt = origRandomInt;
  }

  // 6. التحقق من رفض Kashier Webhook عند حذف الحقول المالية الحساسة من signatureKeys
  const apiKey = 'kashier-hardening-test-key';
  const weakPayload = {
    event: 'pay',
    data: {
      merchantOrderId: 'OF-PAY-1',
      amount: '1000.00',
      currency: 'EGP',
      status: 'SUCCESS',
      signatureKeys: ['currency'] // يغفل amount و status و merchantOrderId
    }
  };
  const weakSig = crypto.createHmac('sha256', apiKey).update('currency=EGP').digest('hex');
  assert.equal(
    verifyKashierWebhookSignature({ payload: weakPayload, signature: weakSig, apiKey }),
    false,
    'Kashier webhook must reject signatureKeys missing amount/status/orderRef'
  );
});
