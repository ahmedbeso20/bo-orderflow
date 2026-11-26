'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { evaluateImageCompliance } = require('../src/image-compliance');

// Valid minimal 1x1 PNG buffer (Magic Bytes: 89 50 4E 47 0D 0A 1A 0A)
const VALID_1X1_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_1X1_PNG_B64}`;

class Client {
  constructor(base, ip = '10.99.4.1') {
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
  del(p) { return this.call('DELETE', p); }
}

/** Helper to generate an RGBA pixel buffer with a background color and centered product rectangle */
function makeSyntheticImage(width, height, bgRgb, fgRgb, fillFraction) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bgRgb[0];
    rgba[i * 4 + 1] = bgRgb[1];
    rgba[i * 4 + 2] = bgRgb[2];
    rgba[i * 4 + 3] = 255;
  }
  const boxW = Math.round(width * fillFraction);
  const boxH = Math.round(height * fillFraction);
  const startX = Math.floor((width - boxW) / 2);
  const startY = Math.floor((height - boxH) / 2);
  for (let y = startY; y < startY + boxH; y++) {
    for (let x = startX; x < startX + boxW; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = fgRgb[0];
      rgba[idx + 1] = fgRgb[1];
      rgba[idx + 2] = fgRgb[2];
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

test('evaluateImageCompliance fails 800x800 off-white #EFEFEF 45% fill image and passes 1600x1600 #FFFFFF 85% fill image', () => {
  // Failing image: 800x800 (low res < 1000), #EFEFEF background (239,239,239 < 250), 45% fill (< 75%)
  const badRgba = makeSyntheticImage(200, 200, [239, 239, 239], [30, 80, 140], 0.45);
  const badReport = evaluateImageCompliance({
    width: 800,
    height: 800,
    sampleWidth: 200,
    sampleHeight: 200,
    rgbaPixels: badRgba,
    marketplace: 'amazon'
  });
  assert.equal(badReport.passed, false);
  assert.ok(badReport.score < 60, `expected low compliance score, got ${badReport.score}`);
  assert.equal(badReport.metrics.borderHex, '#EFEFEF');
  assert.equal(badReport.checks.find((c) => c.code === 'RESOLUTION').passed, false);
  assert.equal(badReport.checks.find((c) => c.code === 'PURE_WHITE_BG').passed, false);
  assert.equal(badReport.checks.find((c) => c.code === 'FRAME_FILL_RATIO').passed, false);

  // Passing image: 1600x1600, pure white #FFFFFF, 85% product fill
  const goodRgba = makeSyntheticImage(200, 200, [255, 255, 255], [20, 60, 110], 0.85);
  const goodReport = evaluateImageCompliance({
    width: 1600,
    height: 1600,
    sampleWidth: 200,
    sampleHeight: 200,
    rgbaPixels: goodRgba,
    marketplace: 'amazon'
  });
  assert.equal(goodReport.passed, true);
  assert.equal(goodReport.score, 100);
  assert.equal(goodReport.metrics.borderHex, '#FFFFFF');
  assert.ok(goodReport.checks.every((c) => c.passed));
});

test('POST /api/ai/photo-studio rejects invalid Magic Bytes & SVG, enforces quota, generates & links product_images, and updates main product photo', async (t) => {
  const fetchStub = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: VALID_1X1_PNG_B64
                    }
                  }
                ]
              }
            }
          ]
        })
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  const app = createApp({
    dbFile: ':memory:',
    secret: 'i'.repeat(48),
    trustProxy: true,
    geminiKey: 'test_gemini_key_123',
    fetch: fetchStub
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const c = new Client(base);

  assert.equal((await c.post('/api/auth/register', {
    store: 'متجر استوديو الصور',
    phone: '01077665544',
    email: 'studio@orderflow.eg',
    password: 'PhotoStudio!9482',
    termsAccepted: true
  })).status, 200);
  const uRow = app.app.q("SELECT id FROM users WHERE email = 'studio@orderflow.eg'").get();
  app.app.q("UPDATE users SET status = 'active', plan = 'free' WHERE id = ?").run(uRow.id);
  assert.equal((await c.post('/api/auth/login', { email: 'studio@orderflow.eg', password: 'PhotoStudio!9482' })).status, 200);

  // Create a product
  const pRes = await c.post('/api/products', {
    name: 'سماعة استوديو',
    sku: 'ST-001',
    cat: 'إلكترونيات',
    price: 850,
    cost: 450,
    stock: 10,
    markets: 'an'
  });
  assert.equal(pRes.status, 200);
  const pid = pRes.data.product.id;

  // 1. Reject disguised non-image bytes with image/png header
  const fakePayload = `data:image/png;base64,${Buffer.from('not-a-real-png-file-at-all').toString('base64')}`;
  const badMagic = await c.post('/api/ai/photo-studio', {
    productId: pid,
    imageDataUrl: fakePayload,
    preset: 'amazon_main_white'
  });
  assert.equal(badMagic.status, 400);

  // 2. Reject SVG / XML script payloads
  const svgPayload = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  const badSvg = await c.post('/api/ai/photo-studio', {
    productId: pid,
    imageDataUrl: svgPayload,
    preset: 'amazon_main_white'
  });
  assert.equal(badSvg.status, 400);

  // 3. Valid PNG + setAsMain: true -> generates via mocked Gemini, saves to product_images, updates products.image
  const genRes = await c.post('/api/ai/photo-studio', {
    productId: pid,
    imageDataUrl: VALID_PNG_DATA_URL,
    preset: 'amazon_main_white',
    marketplace: 'amazon',
    setAsMain: true
  });
  assert.equal(genRes.status, 200);
  assert.equal(genRes.data.source, 'gemini-image');
  assert.ok(genRes.data.image.url.startsWith('/api/uploads/products/'));

  const prodAfter = app.app.q('SELECT image FROM products WHERE id = ?').get(pid);
  assert.equal(prodAfter.image, genRes.data.image.url);

  const galRes = await c.get(`/api/products/${pid}/images`);
  assert.equal(galRes.status, 200);
  assert.equal(galRes.data.images.length, 1);
  assert.equal(galRes.data.images[0].role, 'main');

  // 4. Exhaust free plan daily AI quota -> next call returns 429
  const todayStr = new Date().toISOString().slice(0, 10);
  app.app.q('INSERT INTO ai_usage (user_id, day, n) VALUES (?, ?, 999) ON CONFLICT (user_id, day) DO UPDATE SET n = 999').run(uRow.id, todayStr);
  const quotaRes = await c.post('/api/ai/photo-studio', {
    productId: pid,
    imageDataUrl: VALID_PNG_DATA_URL,
    preset: 'amazon_main_white'
  });
  assert.equal(quotaRes.status, 429);
});
