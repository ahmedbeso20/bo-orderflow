'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, bad, text, integer, nowIso, parseJson } = require('../util');
const { MARKETS, PLANS } = require('../domain');
const ai = require('../ai');

const STATUS_LABEL = ['قيد التجهيز', 'تم الشحن', 'تم التسليم', 'مرتجع'];

module.exports = (r, app) => {
  const { q, cfg, limiter, model } = app;

  /** يحتسب طلب ذكاء اصطناعي ضمن حدّ الدقيقة والحدّ اليومي للباقة (لحماية مفتاح Gemini من الاستنزاف) */
  function quota(user) {
    if (!limiter.hit(`ai:${user.id}`, 12, 60_000)) throw new HttpError(429, 'انتظر قليلًا قبل طلب جديد من الذكاء الاصطناعي');
    const plan = PLANS[user.plan] || PLANS.free;
    const day = new Date().toISOString().slice(0, 10);
    const { n } = q('INSERT INTO ai_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET n = n + 1 RETURNING n').get(user.id, day);
    if (n > plan.ai) throw new HttpError(429, `استهلكت حدّ الذكاء الاصطناعي اليومي (${plan.ai} طلبًا) في ${plan.name}. رقّ باقتك أو حاول غدًا.`, { code: 'PLAN_LIMIT' });
  }
  const saveCache = (user, key, value) => {
    const c = parseJson(user.ai_cache, {});
    c[key] = value;
    q('UPDATE users SET ai_cache = ? WHERE id = ?').run(JSON.stringify(c), user.id);
  };
  /** يجرّب Gemini، وعند أي فشل غير الحصة يعيد null ليُستخدم البديل الجاهز */
  async function tryGemini(user, req) {
    if (!cfg.geminiKey) return null;
    try { quota(user); return await ai.gemini(cfg, req); } catch (e) { if (e.status === 429) throw e; return null; }
  }
  const isObj = (d) => d && typeof d === 'object' && !Array.isArray(d);

  r.post('/api/ai/listing', async ({ user, body }) => {
    const name = text(body.name, 'اسم المنتج', { min: 2, max: 140 });
    const features = text(body.features, 'المميزات', { max: 400, optional: true });
    const tone = text(body.tone, 'النبرة', { max: 120, optional: true }) || 'احترافية مقنعة تناسب المتسوق المصري';
    const res = await tryGemini(user, ai.listingPrompt({ name, features, tone }));
    if (res && isObj(res.data)) return { source: 'gemini', data: ai.normalizeListing(res.data) };
    return { source: 'template', data: ai.templateListing(name, features), notice: cfg.geminiKey ? 'تعذر الاتصال بـ Gemini حاليًا، استخدمنا قالبًا جاهزًا.' : '' };
  });

  r.post('/api/ai/market', async ({ user, body }) => {
    const name = text(body.name, 'اسم المنتج', { min: 2, max: 140 });
    if (!cfg.geminiKey) throw new HttpError(503, 'فحص أسعار السوق يحتاج تفعيل مفتاح Gemini (GEMINI_API_KEY) على الخادم.', { code: 'AI_OFF' });
    quota(user);
    const res = await ai.gemini(cfg, {
      search: true,
      system: 'أنت محلل أسعار تجارة إلكترونية في مصر. قدم ملخصًا موجزًا وواضحًا باللغة العربية عن النطاق السعري للمنتج في مصر (بالجنيه المصري) على المتاجر مثل أمازون مصر ونون وجوميا، مع نصيحة للتاجر حول أفضل سعر تنافسي.',
      prompt: `ابحث عن أسعار "${name}" الحالية في السوق المصري بالجنيه المصري (EGP)، واذكر النطاق السعري التقريبي (أقل سعر ومتوسط السعر)، وقدم نصيحة تسعير مختصرة للتاجر في 3 نقاط واضحة.`
    });
    const market = { name, text: ai.str(res.text, 3000), sources: res.sources, at: nowIso() };
    saveCache(user, 'market', market);
    return { market };
  });

  r.post('/api/ai/advisor', async ({ user, body = {} }) => {
    const thinking = Boolean(body.thinking);
    const input = {
      storeName: user.store_name,
      products: q('SELECT name, price, cost, stock FROM products WHERE user_id = ? ORDER BY stock').all(user.id),
      codReady: model.codBalances(user.id).totals.net,
      orderCount: q('SELECT COUNT(*) n FROM orders WHERE user_id = ?').get(user.id).n,
      thinking
    };
    const res = await tryGemini(user, ai.advisorPrompt({ ...input, products: input.products.slice(0, 40) }));
    const advisor = res && isObj(res.data)
      ? { source: thinking ? 'gemini-thinking' : 'gemini', thinking, data: ai.normalizeAdvisor(res.data), at: nowIso() }
      : { source: 'rules', thinking, data: ai.rulesAdvisor(input), at: nowIso() };
    saveCache(user, 'advisor', advisor);
    return { advisor };
  });

  r.post('/api/ai/order-message', async ({ user, body }) => {
    const rawOrder = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(integer(body.orderId, 'الطلب', { min: 1, max: 2 ** 31 }), user.id);
    if (!rawOrder) throw new HttpError(404, 'الطلب غير موجود');
    const dec = (v) => (app.cipher ? app.cipher.decrypt(v) : String(v || ''));
    const o = { ...rawOrder, customer: dec(rawOrder.customer), phone: dec(rawOrder.phone), address: dec(rawOrder.address) };
    const res = await tryGemini(user, ai.orderMessagePrompt(o, user.store_name, MARKETS[o.market].name, STATUS_LABEL[o.status]));
    if (res && res.text) return { source: 'gemini', text: ai.str(res.text, 1200) };
    return { source: 'template', text: ai.templateOrderMessage(o, user.store_name) };
  });

  /** مساعد البائعين الذكي (محادثة تفاعلية حول أمازون ونون وجوميا وترينديول والربحية) */
  r.post('/api/ai/chat', async ({ user, body }) => {
    const question = text(body.question, 'السؤال', { min: 2, max: 600 });
    const productCount = q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(user.id).n;
    const lowStockCount = q('SELECT COUNT(*) n FROM products WHERE user_id = ? AND stock <= 10').get(user.id).n;
    const codReady = model.codBalances(user.id).totals.net;
    const ctx = { question, storeName: user.store_name, productCount, lowStockCount, codReady };
    const res = await tryGemini(user, ai.sellerChatPrompt(ctx));
    if (res && res.text) {
      return { source: 'gemini', answer: ai.str(res.text, 2500), at: nowIso() };
    }
    return { source: 'rules', answer: ai.rulesSellerAssistant(question, ctx), at: nowIso() };
  });

  /** رادار أسعار المنافسين (يعمل بالبحث المباشر مع Gemini أو بتحليل مرجعي فوري للسوق المصري) */
  r.post('/api/ai/price-radar', async ({ user, body }) => {
    const name = text(body.name, 'اسم المنتج', { min: 2, max: 140 });
    const catalogProducts = q('SELECT name, price, cost, stock FROM products WHERE user_id = ?').all(user.id);
    const bench = ai.priceRadarBenchmark(name, catalogProducts);
    if (cfg.geminiKey) {
      try {
        quota(user);
        const res = await ai.gemini(cfg, {
          search: true,
          system: 'أنت محلل أسعار تجارة إلكترونية في مصر. قدم ملخصًا موجزًا وواضحًا باللغة العربية عن النطاق السعري للمنتج في مصر (بالجنيه المصري) على المتاجر مثل أمازون مصر ونون وجوميا وترينديول، مع نصيحة للتاجر حول أفضل سعر تنافسي.',
          prompt: `ابحث عن أسعار "${name}" الحالية في السوق المصري بالجنيه المصري (EGP)، واذكر النطاق السعري التقريبي (أقل سعر ومتوسط السعر)، وقدم نصيحة تسعير مختصرة للتاجر في 3 نقاط واضحة.`
        });
        const market = { ...bench, text: ai.str(res.text, 3000), sources: res.sources || [], source: 'gemini', at: nowIso() };
        saveCache(user, 'market', market);
        return { market };
      } catch (e) {
        if (e.status === 429) throw e;
      }
    }
    const market = { ...bench, at: nowIso() };
    saveCache(user, 'market', market);
    return { market };
  });

  /** استوديو الصور الذكي للمنتجات (Gemini Image + التحقق من Magic Bytes + حفظ مباشر في معرض المنتج) */
  r.post('/api/ai/photo-studio', async ({ user, body }) => {
    const rawInput = String(body.dataUrl || body.imageBase64 || body.image || '').trim();
    if (!rawInput) throw bad('أرسل صورة المنتج بصيغة Base64 (PNG أو JPEG أو WEBP).');
    if (/^data:image\/svg/i.test(rawInput) || /<svg[\s>]/i.test(rawInput)) {
      throw bad('ملفات SVG غير مسموحة لأسباب أمنية. ارفع صورة PNG أو JPEG أو WEBP فقط.');
    }

    let base64Str = rawInput;
    let mimeHint = '';
    const dataUrlMatch = rawInput.match(/^data:([^;]+);base64,(.+)$/is);
    if (dataUrlMatch) {
      mimeHint = String(dataUrlMatch[1] || '').toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mimeHint)) {
        throw bad('صيغة الصورة غير مدعومة. يُسمح بـ PNG أو JPEG أو WEBP فقط.');
      }
      base64Str = dataUrlMatch[2];
    }

    const cleanB64 = base64Str.replace(/\s+/g, '');
    if (cleanB64.length > Math.ceil(4 * 1024 * 1024 * 1.4)) {
      throw bad('حجم الصورة كبير جدًا (الحد الأقصى ٤ ميجابايت).');
    }
    const imageBuffer = Buffer.from(cleanB64, 'base64');
    const detected = ai.detectStudioImageMagicBytes(imageBuffer);
    if (!detected) {
      throw bad('محتوى الملف لا يطابق صورة PNG أو JPEG أو WEBP صالحة (فشل التحقق من Magic Bytes).');
    }

    const preset = Object.prototype.hasOwnProperty.call(ai.STUDIO_PRESETS, body.preset)
      ? body.preset
      : 'amazon_main_white';
    const aspectRatio = body.aspectRatio === '4:5' ? '4:5' : '1:1';
    const customHint = text(body.customHint || '', 'التعليمات الإضافية', { max: 220, optional: true });
    let product = null;
    if (body.productId !== undefined && body.productId !== null && body.productId !== '') {
      const pid = integer(body.productId, 'المنتج', { min: 1, max: 2 ** 31 });
      product = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(pid, user.id);
      if (!product) throw new HttpError(404, 'المنتج غير موجود');
    }

    const productName = product?.name || text(body.productName || 'المنتج', 'اسم المنتج', { max: 140, optional: true });
    const category = product?.cat || text(body.category || '', 'الفئة', { max: 60, optional: true });

    if (cfg.geminiKey) {
      quota(user);
    }

    const gen = await ai.generateProductStudioImage(cfg, {
      imageBuffer,
      mimeType: detected.mime,
      productName,
      category,
      preset,
      customHint,
      aspectRatio
    });

    if (gen.source === 'client-studio-fallback') {
      return {
        ok: true,
        source: 'client-studio-fallback',
        preset: gen.preset,
        notice: gen.notice
      };
    }

    const uploadsDir = path.resolve(cfg.uploadsDir);
    fs.mkdirSync(uploadsDir, { recursive: true });
    const filename = `prod-studio-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${gen.ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), gen.buffer);
    const imageUrl = `/api/uploads/products/${filename}`;
    const now = nowIso();
    try {
      q('INSERT INTO user_uploads (user_id, filename, size_bytes, created_at) VALUES (?, ?, ?, ?)')
        .run(user.id, filename, gen.buffer.length, now);
    } catch (_) {}

    let imageRecord = null;
    let updatedProduct = null;
    if (product) {
      const setAsMain = Boolean(body.setAsMain);
      const countRow = q('SELECT COUNT(*) n FROM product_images WHERE user_id = ? AND product_id = ?').get(user.id, product.id);
      if (Number(countRow?.n || 0) >= 7) {
        const oldest = q("SELECT id FROM product_images WHERE user_id = ? AND product_id = ? AND role != 'main' ORDER BY id ASC LIMIT 1").get(user.id, product.id);
        if (oldest) q('DELETE FROM product_images WHERE id = ?').run(oldest.id);
      }
      if (setAsMain) {
        q("UPDATE product_images SET role = 'gallery' WHERE user_id = ? AND product_id = ? AND role = 'main'").run(user.id, product.id);
        q('UPDATE products SET image = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(imageUrl, now, product.id, user.id);
      }
      const role = setAsMain ? 'main' : 'gallery';
      const width = aspectRatio === '4:5' ? 1280 : 1600;
      const height = 1600;
      const imgId = Number(q(`INSERT INTO product_images
        (user_id, product_id, url, role, preset, width, height, compliance_score, compliance_json, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_studio', ?)`)
        .run(user.id, product.id, imageUrl, role, preset, width, height, Number(body.complianceScore || 95), body.compliance ? JSON.stringify(body.compliance).slice(0, 4000) : '', now).lastInsertRowid);
      imageRecord = {
        id: imgId,
        productId: product.id,
        url: imageUrl,
        role,
        preset,
        width,
        height,
        source: 'ai_studio',
        createdAt: now
      };
      updatedProduct = model.productOf(q('SELECT * FROM products WHERE id = ?').get(product.id));
    }

    return {
      ok: true,
      source: gen.source,
      model: gen.model,
      preset: gen.preset,
      imageUrl,
      imageRecord,
      product: updatedProduct
    };
  }, { maxBody: 6_500_000 });
};
