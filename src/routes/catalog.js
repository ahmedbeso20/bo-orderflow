'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, bad, text, money, integer, toCsv, nowIso } = require('../util');
const { MARKETS } = require('../domain');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2MB

/** التحقق الفعلي من بايتات البداية (Magic Bytes) لضمان أن الملف صورة حقيقية */
function detectImageMagicBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return { ext: 'png', mime: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // GIF: GIF87a أو GIF89a
  const hdr6 = buf.subarray(0, 6).toString('ascii');
  if (hdr6 === 'GIF87a' || hdr6 === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }
  // WEBP: RIFF....WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

function saveBase64Image(dataUri, uploadsDir) {
  const m = String(dataUri || '').trim().match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) throw bad('صيغة الصورة غير مدعومة. يُسمح بـ PNG أو JPEG أو WEBP أو GIF فقط.');
  const rawBase64 = m[2].replace(/\s+/g, '');
  if (rawBase64.length > Math.ceil(MAX_UPLOAD_BYTES * 1.4)) {
    throw bad('حجم الصورة كبير جدًا (الحد الأقصى ٢ ميجابايت)');
  }
  const buf = Buffer.from(rawBase64, 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD_BYTES) {
    throw bad('حجم الصورة غير صالح (الحد الأقصى ٢ ميجابايت)');
  }
  const detected = detectImageMagicBytes(buf);
  if (!detected) {
    throw bad('محتوى الملف لا يطابق صورة صالحة (فشل التحقق من Magic Bytes)');
  }
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `prod-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${detected.ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buf);
  return `/api/uploads/products/${filename}`;
}

function cleanImage(v, uploadsDir) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  // منع data:image/svg+xml (ثغرة XSS محتملة) ومنع الروابط النسبية للبروتوكول //
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) {
    if (s.length > 2048) throw bad('رابط الصورة طويل جدًا');
    return s;
  }
  if (/^\/(?!\/)[^\s"'<>]+$/.test(s)) {
    if (s.length > 512) throw bad('مسار الصورة طويل جدًا');
    return s;
  }
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(s)) {
    return saveBase64Image(s, uploadsDir);
  }
  throw bad('رابط أو صيغة الصورة غير صالحة');
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

module.exports = (r, { q, model, cfg, limiter, sendSecurityAlert }) => {
  const uploadsDir = path.resolve(cfg.uploadsDir);

  const find = (uid, id) => {
    const p = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(Number(id) || 0, uid);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    return p;
  };
  const dupSku = (fn) => {
    try { return fn(); } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'كود SKU مستخدم بالفعل لمنتج آخر'); throw e; }
  };

  /** يتحقق من الحقول المرسلة فقط (partial) أو من كلها عند الإنشاء */
  function read(b, partial) {
    const o = {};
    const need = (k) => !partial || b[k] !== undefined;
    if (need('name')) o.name = text(b.name, 'اسم المنتج', { min: 2, max: 140 });
    if (need('sku')) o.sku = text(b.sku, 'كود SKU', { min: 1, max: 40 });
    if (need('cat')) o.cat = text(b.cat, 'الفئة', { max: 40, optional: true }) || 'عام';
    if (need('price')) o.price = money(b.price, 'سعر البيع', { min: 0.01 });
    if (need('cost')) o.cost = money(b.cost ?? 0, 'تكلفة الشراء');
    if (need('stock')) o.stock = integer(b.stock ?? 0, 'الكمية');
    if (b.image !== undefined || !partial) o.image = cleanImage(b.image, uploadsDir);
    if (need('markets')) {
      const set = new Set(String(b.markets ?? 'a').split(''));
      o.markets = Object.keys(MARKETS).filter((k) => set.has(k)).join('');
      if (!o.markets) throw bad('اختر سوقًا واحدًا على الأقل');
    }
    return o;
  }

  // رفع صورة منتج إلى نظام الملفات مع التحقق من Magic Bytes وإرجاع رابط آمن
  r.post('/api/products/upload-image', ({ user, body }) => {
    if (limiter && !limiter.hit(`upload:${user.id}`, 40, 600_000)) {
      throw new HttpError(429, 'طلبات رفع كثيرة، انتظر قليلًا');
    }
    const raw = body.dataUrl || body.image || '';
    const url = saveBase64Image(raw, uploadsDir);
    return { ok: true, url };
  });

  // تقديم صور المنتجات المرفوعة من data/uploads/products بأمان (محصور داخل المجلد مع منع تنفيذ السكربتات)
  r.get('/api/uploads/products/:filename', ({ params, res }) => {
    const name = String(params.filename || '');
    if (!/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp|gif)$/i.test(name)) {
      throw new HttpError(404, 'الصورة غير موجودة');
    }
    const full = path.resolve(uploadsDir, name);
    if (!full.startsWith(uploadsDir + path.sep) && full !== uploadsDir) {
      throw new HttpError(403, 'مسار غير مسموح');
    }
    if (!fs.existsSync(full)) throw new HttpError(404, 'الصورة غير موجودة');
    const ext = path.extname(full).toLowerCase();
    const buf = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(buf);
  }, { auth: false });

  r.get('/api/products', ({ user }) => ({ products: model.productsOf(user.id) }));

  r.post('/api/products', ({ user, body }) => {
    const plan = model.planOf(user);
    const used = q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(user.id).n;
    if (plan.limit != null && used >= plan.limit) {
      throw new HttpError(402, `وصلت للحد الأقصى (${plan.limit} منتج) في ${plan.name}. رقّ باقتك لإضافة المزيد.`, { code: 'PLAN_LIMIT' });
    }
    const p = read(body, false);
    const now = nowIso();
    const approvalStatus = user.role === 'owner' ? 'approved' : 'pending';
    const id = dupSku(() => q("INSERT INTO products (user_id,name,sku,cat,markets,price,cost,stock,image,approval_status,reject_reason,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'manual',?,?)")
      .run(user.id, p.name, p.sku, p.cat, p.markets, p.price, p.cost, p.stock, p.image, approvalStatus, '', now, now).lastInsertRowid);
    return { product: model.productOf(find(user.id, id)), ...model.meta(user) };
  });

  r.put('/api/products/:id', ({ user, params, body }) => {
    const cur = find(user.id, params.id);
    const patch = read(body, true);
    if (cur.approval_status === 'rejected' && user.role !== 'owner') {
      patch.approval_status = 'pending';
      patch.reject_reason = '';
    }
    const keys = Object.keys(patch); // أسماء الأعمدة ثابتة من read() فقط
    if (!keys.length) throw bad('لا توجد تغييرات للحفظ');
    dupSku(() => q(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(...keys.map((k) => patch[k]), nowIso(), cur.id, user.id));
    return { product: model.productOf(find(user.id, cur.id)), ...model.meta(user) };
  });

  r.post('/api/products/:id/restock', ({ user, params, body }) => {
    const qty = body.qty === undefined ? 10 : integer(body.qty, 'الكمية', { min: 1, max: 100000 });
    const p = find(user.id, params.id);
    q('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').run(qty, nowIso(), p.id);
    return { product: model.productOf(find(user.id, p.id)), ...model.meta(user) };
  });

  r.delete('/api/products/:id', ({ user, params }) => {
    const p = find(user.id, params.id);
    q('DELETE FROM products WHERE id = ?').run(p.id);
    return { ok: true, ...model.meta(user) };
  });

  r.get('/api/products/export.csv', ({ user, res, ip }) => {
    if (limiter && sendSecurityAlert && !limiter.hit(`bulk-exp:${user.id}`, 3, 600_000)) {
      sendSecurityAlert({
        severity: 'high',
        title: 'تصدير بيانات متكرر بشكل غير معتاد',
        details: { userId: user.id, storeName: user.store_name, target: 'products.csv', ip }
      }).catch(() => {});
    }
    const rows = [['المنتج', 'SKU', 'الفئة', 'الأسواق', 'التكلفة', 'السعر', 'المخزون', 'حالة الاعتماد', 'المصدر']];
    for (const p of q('SELECT * FROM products WHERE user_id = ? ORDER BY id').all(user.id)) {
      rows.push([p.name, p.sku, p.cat, p.markets.split('').map((k) => MARKETS[k].name).join(' + '), p.cost, p.price, p.stock, p.approval_status, p.source || 'manual']);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="omniarab-products.csv"', 'Cache-Control': 'no-store' });
    res.end(toCsv(rows));
  });

  /** محلل CSV قياسي (RFC 4180) يدعم UTF-8 BOM والاقتباسات والفواصل داخل النص */
  function parseCsvRows(csvText) {
    const src = String(csvText || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"' && src[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field.trim());
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field.trim());
        if (row.some((cell) => cell !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) rows.push(row);
    return rows;
  }

  function normalizeMarketTokens(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'a';
    const set = new Set();
    const lower = s.toLowerCase();
    if (/أمازون|امازون|amazon/.test(lower)) set.add('a');
    if (/نون|noon/.test(lower)) set.add('n');
    if (/جوميا|jumia/.test(lower)) set.add('j');
    if (/ترينديول|trendyol/.test(lower)) set.add('t');
    if (/كنز|kenzz/.test(lower)) set.add('k');
    if (!set.size) {
      for (const ch of lower.replace(/[^anjtk]/g, '')) set.add(ch);
    }
    const out = Object.keys(MARKETS).filter((k) => set.has(k)).join('');
    return out || 'a';
  }

  const HEADER_ALIASES = {
    name: ['name', 'title', 'product', 'المنتج', 'اسم المنتج', 'الاسم', 'اسم'],
    sku: ['sku', 'code', 'كود', 'كود sku', 'رمز المنتج'],
    cat: ['cat', 'category', 'الفئة', 'التصنيف'],
    markets: ['markets', 'market', 'channels', 'الأسواق', 'الاسواق', 'المنصات'],
    cost: ['cost', 'buy_price', 'التكلفة', 'تكلفة الشراء'],
    price: ['price', 'sale_price', 'السعر', 'سعر البيع'],
    stock: ['stock', 'qty', 'quantity', 'المخزون', 'الكمية'],
    image: ['image', 'image_url', 'الصورة']
  };

  function mapHeaderKey(h) {
    const norm = String(h || '').trim().toLowerCase();
    for (const [key, list] of Object.entries(HEADER_ALIASES)) {
      if (list.includes(norm)) return key;
    }
    return null;
  }

  // استيراد وتحديث المنتجات بالجملة عبر CSV مع احترام حد الباقة والتحقق من كل صف
  r.post('/api/products/import', ({ user, body }) => {
    let rawItems = [];
    if (typeof body.csv === 'string' && body.csv.trim()) {
      const parsed = parseCsvRows(body.csv);
      if (parsed.length < 2) throw bad('ملف CSV يجب أن يحتوي على صف العناوين وصف منتج واحد على الأقل');
      const headers = parsed[0].map(mapHeaderKey);
      if (!headers.includes('name') || !headers.includes('sku') || !headers.includes('price')) {
        throw bad('يجب أن يحتوي ملف CSV على أعمدة: المنتج (name)، SKU (sku)، السعر (price)');
      }
      for (let i = 1; i < parsed.length; i++) {
        const obj = { __row: i + 1 };
        headers.forEach((key, idx) => {
          if (key) obj[key] = parsed[i][idx] ?? '';
        });
        rawItems.push(obj);
      }
    } else if (Array.isArray(body.rows)) {
      rawItems = body.rows.map((rItem, idx) => ({ ...(rItem || {}), __row: idx + 1 }));
    } else {
      throw bad('أرسل محتوى CSV في حقل csv أو مصفوفة منتجات في حقل rows');
    }

    if (!rawItems.length) throw bad('لا توجد صفوف منتجات للاستيراد');
    if (rawItems.length > 500) throw bad('الحد الأقصى للاستيراد في الدفعة الواحدة هو ٥٠٠ منتج');

    const plan = model.planOf(user);
    let currentCount = q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(user.id).n;
    const now = nowIso();
    const approvalStatus = user.role === 'owner' ? 'approved' : 'pending';

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const item of rawItems) {
      const rowNo = item.__row;
      try {
        const normalized = {
          name: item.name,
          sku: item.sku,
          cat: item.cat || 'عام',
          markets: normalizeMarketTokens(item.markets),
          price: item.price,
          cost: item.cost === '' || item.cost === undefined ? 0 : item.cost,
          stock: item.stock === '' || item.stock === undefined ? 0 : item.stock,
          image: item.image || ''
        };
        const p = read(normalized, false);
        const existing = q('SELECT id FROM products WHERE user_id = ? AND sku = ?').get(user.id, p.sku);
        if (existing) {
          q('UPDATE products SET name = ?, cat = ?, markets = ?, price = ?, cost = ?, stock = ?, image = COALESCE(NULLIF(?, \'\'), image), updated_at = ? WHERE id = ? AND user_id = ?')
            .run(p.name, p.cat, p.markets, p.price, p.cost, p.stock, p.image, now, existing.id, user.id);
          updated++;
        } else {
          if (plan.limit != null && currentCount >= plan.limit) {
            skipped++;
            errors.push({
              row: rowNo,
              sku: p.sku,
              error: `وصلت للحد الأقصى (${plan.limit} منتج) في ${plan.name}`
            });
            continue;
          }
          q("INSERT INTO products (user_id,name,sku,cat,markets,price,cost,stock,image,approval_status,reject_reason,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'csv',?,?)")
            .run(user.id, p.name, p.sku, p.cat, p.markets, p.price, p.cost, p.stock, p.image, approvalStatus, '', now, now);
          currentCount++;
          imported++;
        }
      } catch (err) {
        skipped++;
        errors.push({
          row: rowNo,
          sku: String(item.sku || '').slice(0, 40),
          error: err instanceof HttpError ? err.message : 'بيانات الصف غير صالحة'
        });
      }
    }

    return {
      ok: true,
      imported,
      updated,
      skipped,
      totalRows: rawItems.length,
      errors,
      products: model.productsOf(user.id),
      ...model.meta(user)
    };
  });
};


