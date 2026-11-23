'use strict';
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const { HttpError, bad, nowIso, parseJson } = require('../util');
const { MARKETS } = require('../domain');

const PLATFORM_KEYS = ['a', 'n', 'j', 't', 'k'];
const PLATFORM_SOURCE = Object.freeze({ a: 'amazon', n: 'noon', j: 'jumia', t: 'trendyol', k: 'kenzz' });
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * تعريف حقول الربط الرسمية لكل منصة بيع (تُعرض ديناميكيًا في شاشة التكاملات)
 * secret: true => يُشفَّر بـ AES-256-GCM في قاعدة البيانات ولا يُعاد أبدًا بالنص الصريح للواجهة
 */
const PLATFORM_SCHEMAS = Object.freeze({
  a: {
    key: 'a',
    name: 'أمازون مصر (Amazon SP-API)',
    docsUrl: 'https://developer-docs.amazon.com/sp-api/docs',
    authMethod: 'LWA OAuth2 Refresh Token -> x-amz-access-token',
    docsHint: 'احصل على مفاتيح LWA و Refresh Token من Seller Central ← Apps & Services ← Develop Apps.',
    defaultBaseUrl: 'https://sellingpartnerapi-eu.amazon.com',
    sandboxBaseUrl: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
    sandboxUnverified: false,
    fields: [
      { name: 'sellerId', label: 'معرّف البائع (Seller ID)', placeholder: 'مثال: A2EUQ1WTGCTBG2', required: true, secret: false },
      { name: 'marketplaceId', label: 'معرّف سوق مصر (Marketplace ID)', placeholder: 'ARBP9OOSHTCHU', defaultValue: 'ARBP9OOSHTCHU', required: false, secret: false },
      { name: 'clientId', label: 'LWA Client ID', placeholder: 'amzn1.application-oa2-client.xxxx', required: true, secret: false },
      { name: 'clientSecret', label: 'LWA Client Secret', placeholder: 'amzn1.oa2-cs.v1.xxxx', required: true, secret: true },
      { name: 'refreshToken', label: 'LWA Refresh Token', placeholder: 'Atzr|IwEBIA...', required: true, secret: true }
    ]
  },
  n: {
    key: 'n',
    name: 'نون مصر والخليج (Noon Partners API)',
    docsUrl: 'https://docs.noon.partners/',
    authMethod: 'JWT (RS256/HS256) login -> Bearer session token + X-Project-Code',
    docsHint: 'أنشئ مفتاح API من Noon Seller Lab / Partners Portal ← API Keys واربطه بـ Project Code.',
    defaultBaseUrl: 'https://noon-api-gateway.noon.partners',
    // TODO: verify sandbox URL with official docs
    sandboxBaseUrl: 'https://noon-api-gateway.noon.partners',
    sandboxUnverified: true,
    fields: [
      { name: 'projectCode', label: 'كود المشروع (Project Code)', placeholder: 'مثال: PRJ1234', required: true, secret: false },
      { name: 'keyId', label: 'معرّف المفتاح (Key ID)', placeholder: 'مثال: noon_partner_key_01', required: true, secret: false },
      { name: 'privateKey', label: 'المفتاح الخاص (Private Key PEM أو API Token)', placeholder: '-----BEGIN PRIVATE KEY----- أو Bearer Token', required: true, secret: true, multiline: true },
      { name: 'baseUrl', label: 'رابط البوابة (اختياري)', placeholder: 'https://noon-api-gateway.noon.partners', defaultValue: 'https://noon-api-gateway.noon.partners', required: false, secret: false, isUrl: true }
    ]
  },
  j: {
    key: 'j',
    name: 'جوميا مصر (Jumia Vendor Center API)',
    docsUrl: 'https://vendor-api.jumia.com/docs',
    authMethod: 'OAuth2 Refresh Token -> Bearer token + X-Shop-Id',
    docsHint: 'احصل على Client ID و Refresh Token أو مفتاح API من Jumia Vendor Center ← Settings ← Integration.',
    defaultBaseUrl: 'https://vendor-api.jumia.com',
    // TODO: verify sandbox URL with official docs
    sandboxBaseUrl: 'https://vendor-api-staging.jumia.com',
    sandboxUnverified: true,
    fields: [
      { name: 'shopId', label: 'معرّف المتجر أو بريد البائع (Shop ID / Email)', placeholder: 'مثال: shop_eg_1029 أو seller@store.eg', required: true, secret: false },
      { name: 'clientId', label: 'معرّف التطبيق (Client ID)', placeholder: 'مثال: jumia-client-xxxx', required: true, secret: false },
      { name: 'apiKey', label: 'مفتاح API أو OAuth Refresh Token', placeholder: 'أدخل Refresh Token أو API Key', required: true, secret: true },
      { name: 'baseUrl', label: 'رابط Jumia API (اختياري)', placeholder: 'https://vendor-api.jumia.com', defaultValue: 'https://vendor-api.jumia.com', required: false, secret: false, isUrl: true }
    ]
  },
  t: {
    key: 't',
    name: 'ترينديول (Trendyol Supplier API)',
    docsUrl: 'https://developers.trendyol.com/en',
    authMethod: 'HTTP Basic Auth (apiKey:apiSecret) + Supplier User-Agent',
    docsHint: 'احصل على Supplier ID و API Key و API Secret من Trendyol Partner Panel ← Account Info ← Integration Info.',
    defaultBaseUrl: 'https://apigw.trendyol.com',
    sandboxBaseUrl: 'https://stageapigw.trendyol.com',
    sandboxUnverified: false,
    fields: [
      { name: 'supplierId', label: 'معرّف المورّد (Supplier ID)', placeholder: 'مثال: 123456', required: true, secret: false },
      { name: 'apiKey', label: 'مفتاح الربط (API Key)', placeholder: 'أدخل Trendyol API Key', required: true, secret: true },
      { name: 'apiSecret', label: 'الرمز السري (API Secret)', placeholder: 'أدخل Trendyol API Secret', required: true, secret: true },
      { name: 'storeFrontCode', label: 'كود الدولة / السوق (اختياري)', placeholder: 'EG أو TR', defaultValue: 'EG', required: false, secret: false }
    ]
  },
  k: {
    key: 'k',
    name: 'كنز مصر (Kenzz Partner API)',
    docsUrl: 'https://kenzz.com/partners',
    authMethod: 'Bearer Partner API Key + X-Store-Id (+ optional X-Api-Secret)',
    docsHint: 'أدخل Store ID ومفتاح الربط المعتمد من فريق شركاء Kenzz Egypt لتفعيل المزامنة الفورية.',
    defaultBaseUrl: 'https://partners-api.kenzz.com/v1',
    // TODO: verify sandbox URL with official docs
    sandboxBaseUrl: 'https://sandbox-partners-api.kenzz.com/v1',
    sandboxUnverified: true,
    fields: [
      { name: 'storeId', label: 'معرّف المتجر (Store ID)', placeholder: 'مثال: KNZ-EG-8821', required: true, secret: false },
      { name: 'apiKey', label: 'مفتاح الربط (Partner API Key)', placeholder: 'knz_live_xxxx', required: true, secret: true },
      { name: 'apiSecret', label: 'الرمز السري (API Secret — اختياري)', placeholder: 'اتركه فارغًا إن لم يُطلب', required: false, secret: true },
      { name: 'baseUrl', label: 'رابط Kenzz API (اختياري)', placeholder: 'https://partners-api.kenzz.com/v1', defaultValue: 'https://partners-api.kenzz.com/v1', required: false, secret: false, isUrl: true }
    ]
  }
});

/**
 * فحص عناوين IPv4/IPv6 الخاصة أو المحلية أو المحجوزة (لمنع SSRF و DNS Rebinding)
 */
function isPrivateOrReservedIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return true;
    }
    return false;
  }
  if (ipVersion === 6) {
    if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') return true;
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
          return isPrivateOrReservedIp(v4);
        }
      }
      return true;
    }
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/i.test(ip) || ip.startsWith('100::')) return true;
    return false;
  }
  return false;
}

/**
 * حماية SSRF صارمة: السماح فقط بروابط HTTPS عامة ومنع العناوين المحلية أو الشبكات الداخلية
 */
function assertSafeExternalUrl(raw, label = 'رابط الـ API') {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${label}: صيغة الرابط غير صحيحة`);
  }
  if (u.protocol !== 'https:') {
    throw bad(`${label}: يجب أن يبدأ الرابط ببروتوكول https:// الآمن فقط`);
  }
  if (u.username || u.password) {
    throw bad(`${label}: لا يُسمح بتضمين بيانات مصادقة داخل الرابط`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw bad(`${label}: غير مسموح بالاتصال بعناوين محلية أو داخلية`);
  }
  if (net.isIP(host) && isPrivateOrReservedIp(host)) {
    throw bad(`${label}: غير مسموح بالاتصال بعناوين IP خاصة أو محلية`);
  }
  return u.toString().replace(/\/+$/, '');
}

/**
 * فحص SSRF مع حل DNS فعلي لمنع هجمات DNS Rebinding قبل تنفيذ أي طلب خارجي
 */
async function assertSafeExternalUrlWithDns(raw, label = 'رابط الـ API', { lookupFn } = {}) {
  const normalized = assertSafeExternalUrl(raw, label);
  if (!normalized) return '';
  const u = new URL(normalized);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return normalized;

  const resolver = typeof lookupFn === 'function' ? lookupFn : dns.promises.lookup;
  let records;
  try {
    records = await resolver(host, { all: true });
  } catch (err) {
    throw new HttpError(400, `${label}: تعذّر التحقق من عنوان النطاق عبر DNS (${err?.code || 'DNS_ERROR'})`);
  }
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  if (!list.length) {
    throw bad(`${label}: لم يُرجع النطاق أي عنوان IP صالح`);
  }
  for (const rec of list) {
    const addr = typeof rec === 'string' ? rec : rec?.address;
    if (!addr || isPrivateOrReservedIp(addr)) {
      throw bad(`${label}: غير مسموح بالاتصال بنطاق يؤول إلى عنوان IP خاص أو محلي`);
    }
  }
  return normalized;
}

function maskSecret(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

function maskCredentials(platform, rawCreds = {}) {
  const schema = PLATFORM_SCHEMAS[platform];
  if (!schema) return {};
  const out = {};
  for (const f of schema.fields) {
    const val = String(rawCreds[f.name] ?? '').trim();
    if (f.secret) {
      out[f.name] = { configured: Boolean(val), masked: maskSecret(val) };
    } else {
      out[f.name] = val || f.defaultValue || '';
    }
  }
  return out;
}

function validateAndMergeCredentials(platform, inputCreds = {}, existingCreds = {}) {
  const schema = PLATFORM_SCHEMAS[platform];
  if (!schema) throw bad('منصة غير مدعومة');
  if (!inputCreds || typeof inputCreds !== 'object' || Array.isArray(inputCreds)) {
    throw bad('بيانات الربط غير صالحة');
  }

  const merged = {};
  for (const f of schema.fields) {
    let val = inputCreds[f.name] !== undefined && inputCreds[f.name] !== null
      ? String(inputCreds[f.name]).trim()
      : '';
    if (!val && f.secret && existingCreds[f.name]) {
      val = String(existingCreds[f.name]).trim();
    }
    if (!val && f.defaultValue) {
      val = f.defaultValue;
    }
    if (val.length > 4000) {
      throw bad(`${f.label}: القيمة طويلة جدًا`);
    }
    if (f.isUrl && val) {
      val = assertSafeExternalUrl(val, f.label);
    }
    if (f.required && !val) {
      throw bad(`حقل "${f.label}" مطلوب لإتمام الربط مع ${schema.name}`);
    }
    merged[f.name] = val;
  }
  return merged;
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return String(v ?? '');
  }
  return '';
}

/**
 * استدعاء JSON آمن مع حماية SSRF + DNS Rebinding ومنع إعادة التوجيه ومهلة زمنية صارمة
 */
async function callJson(fetchFn, url, opts = {}) {
  assertSafeExternalUrl(url, opts.label || 'رابط الـ API');
  if (opts.dnsLookup || opts.verifyDns === true || fetchFn === globalThis.fetch) {
    await assertSafeExternalUrlWithDns(url, opts.label || 'رابط الـ API', { lookupFn: opts.dnsLookup });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      redirect: 'error',
      signal: controller.signal
    });
    if (res && Number(res.status) >= 300 && Number(res.status) < 400) {
      throw new HttpError(400, 'تم رفض إعادة التوجيه التلقائية لأسباب أمنية (حماية SSRF)');
    }
    const textBody = typeof res.text === 'function'
      ? await res.text()
      : JSON.stringify(await res.json());
    let data = null;
    try { data = textBody ? JSON.parse(textBody) : {}; } catch { data = { raw: textBody.slice(0, 300) }; }
    return { ok: Boolean(res.ok), status: Number(res.status || 0), data, headers: res.headers || {} };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err && err.name === 'AbortError') {
      throw new HttpError(504, 'انتهت مهلة الاتصال بسيرفر المنصة (12 ثانية). تأكد من صحة رابط API والإنترنت.');
    }
    if (err && /redirect/i.test(String(err.message || err.cause?.message || ''))) {
      throw new HttpError(400, 'تم رفض إعادة التوجيه التلقائية لأسباب أمنية (حماية SSRF)');
    }
    throw new HttpError(502, `تعذّر الوصول إلى سيرفر المنصة: ${err?.message || 'خطأ في الشبكة'}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * إعادة المحاولة الذكية (Exponential Backoff + Jitter) لتعامل سليم مع 429 / QuotaExceeded / 5xx
 * يحترم ترويسة Retry-After و x-amzn-RateLimit-Limit عند توفرها.
 */
async function callWithRetry(fn, { maxRetries = 5, baseDelayMs = 60, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastRes = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fn(attempt);
    lastRes = res;
    const isQuota = res && res.data && (
      res.data.code === 'QuotaExceeded'
      || (Array.isArray(res.data.errors) && res.data.errors.some((e) => e && /QuotaExceeded/i.test(String(e.code || e.message || ''))))
    );
    const retryable = res && (res.status === 429 || res.status >= 500 || isQuota);
    if (!retryable || attempt === maxRetries) return res;

    let delayMs = baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * baseDelayMs);
    const retryAfter = Number(getHeader(res.headers, 'retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      delayMs = Math.min(5000, Math.max(delayMs, retryAfter * 100));
    } else {
      const rateLimit = Number(getHeader(res.headers, 'x-amzn-ratelimit-limit'));
      if (Number.isFinite(rateLimit) && rateLimit > 0 && rateLimit < 1) {
        delayMs = Math.min(3000, Math.max(delayMs, Math.round(100 / rateLimit)));
      }
    }
    await sleep(delayMs);
  }
  return lastRes;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildNoonJwt(keyId, privateKey) {
  const header = base64Url(JSON.stringify({ alg: privateKey.includes('BEGIN') ? 'RS256' : 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({ sub: keyId, iat: now, exp: now + 300, jti: crypto.randomUUID() }));
  const signingInput = `${header}.${payload}`;
  if (privateKey.includes('BEGIN')) {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const sig = signer.sign(privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${signingInput}.${sig}`;
  }
  const sig = crypto.createHmac('sha256', privateKey).update(signingInput).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${sig}`;
}

function apiErrorDetail(res) {
  const d = res?.data;
  if (!d) return `HTTP ${res?.status || 'ERR'}`;
  if (typeof d === 'string') return d.slice(0, 180);
  const msg = d.error_description || d.message || d.error || (Array.isArray(d.errors) && (d.errors[0]?.message || d.errors[0])) || d.raw || '';
  return `HTTP ${res.status}${msg ? ` — ${String(msg).slice(0, 160)}` : ''}`;
}

function connectorHttpError(platformLabel, res, actionLabel = 'الاتصال') {
  const status = Number(res?.status || 0);
  if (status === 401 || status === 403) {
    const err = new HttpError(400, `مفاتيح API أو الصلاحيات غير صحيحة لـ ${platformLabel} (HTTP ${status}). تحقق من البيانات أو بيئة التشغيل (إنتاج/تجربة).`);
    err.authFailure = true;
    err.upstreamStatus = status;
    return err;
  }
  if (status === 404) {
    return new HttpError(400, `رابط أو بيئة ${platformLabel} غير مطابقة (HTTP 404). تأكد من اختيار بيئة التشغيل الصحيحة.`);
  }
  if (status === 429) {
    return new HttpError(429, `تم تجاوز حد الطلبات المسموح به لدى ${platformLabel} (HTTP 429). حاول بعد قليل.`);
  }
  return new HttpError(400, `فشل ${actionLabel} مع ${platformLabel}: ${apiErrorDetail(res)}`);
}

/* ==========================================================================
   الموصّلات الحقيقية للمنصات الخمس (Amazon · Noon · Jumia · Trendyol · Kenzz)
   ========================================================================== */

const ADAPTERS = {
  /**
   * 1. Amazon Egypt — Selling Partner API (SP-API EU)
   * Docs: https://developer-docs.amazon.com/sp-api/docs
   * Auth: LWA OAuth2 refresh_token exchange -> x-amz-access-token header
   */
  a: {
    async getAccessToken(creds, fetchFn, ctx = {}) {
      const cacheKey = `${ctx.userId || 0}:${creds.sellerId || ''}:${creds.clientId || ''}`;
      const cached = ctx.tokenCache && ctx.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() + 60_000) {
        return cached.token;
      }
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret
      });
      const res = await callWithRetry(() => callJson(fetchFn, 'https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      }), ctx.retryOpts);
      if (!res.ok || !res.data?.access_token) {
        throw connectorHttpError('Amazon LWA', res, 'مصادقة');
      }
      const ttlSec = Math.max(120, Number(res.data.expires_in) || 3600);
      if (ctx.tokenCache) {
        ctx.tokenCache.set(cacheKey, { token: res.data.access_token, expiresAt: Date.now() + ttlSec * 1000 });
      }
      return res.data.access_token;
    },

    async getRestrictedDataToken(base, accessToken, fetchFn, ctx = {}) {
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/tokens/2021-03-01/restrictedDataToken`, {
        method: 'POST',
        headers: { 'x-amz-access-token': accessToken, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          restrictedResources: [
            { method: 'GET', path: '/orders/v0/orders', dataElements: ['buyerInfo', 'shippingAddress'] }
          ]
        })
      }), ctx.retryOpts);
      if (res.ok && res.data?.restrictedDataToken) return res.data.restrictedDataToken;
      return accessToken;
    },

    mapOrderStatus(o) {
      if (String(o.EasyShipShipmentStatus || '').toLowerCase() === 'delivered') return 2;
      const st = String(o.OrderStatus || '');
      if (st === 'Delivered') return 2;
      if (st === 'Shipped') return 1;
      if (st === 'Canceled' || st === 'Cancelled') return 4;
      // Pending, Unshipped, PartiallyShipped -> 0 (قيد التجهيز)
      return 0;
    },

    async test(creds, env, fetchFn, ctx = {}) {
      const token = await this.getAccessToken(creds, fetchFn, ctx);
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.a.sandboxBaseUrl : PLATFORM_SCHEMAS.a.defaultBaseUrl;
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/sellers/v1/marketplaceParticipations`, {
        headers: { 'x-amz-access-token': token, accept: 'application/json' }
      }), ctx.retryOpts);
      if (!res.ok) {
        throw connectorHttpError('Amazon SP-API', res, 'التحقق من حساب');
      }
      const list = Array.isArray(res.data?.payload) ? res.data.payload : [];
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب أمازون (${creds.sellerId})${list.length ? ` — ${list.length} سوق نشط` : ''}.`,
        meta: { sellerId: creds.sellerId, marketplaces: list.length }
      };
    },

    async sync(creds, env, fetchFn, ctx = {}) {
      let token = await this.getAccessToken(creds, fetchFn, ctx);
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.a.sandboxBaseUrl : PLATFORM_SCHEMAS.a.defaultBaseUrl;
      const mpId = creds.marketplaceId || 'ARBP9OOSHTCHU';

      // طلب RDT للبيانات الشخصية فقط عند تفعيل AMAZON_PII_ENABLED=1
      let ordersToken = token;
      if (ctx.amazonPiiEnabled) {
        ordersToken = await this.getRestrictedDataToken(base, token, fetchFn, ctx);
      }

      const orderHeaders = { 'x-amz-access-token': ordersToken, accept: 'application/json' };
      const invHeaders = { 'x-amz-access-token': token, accept: 'application/json' };

      // المزامنة التراكمية: نستخدم LastUpdatedAfter عند توفر آخر مزامنة، وإلا آخر ٣٠ يومًا
      const timeParam = ctx.lastSyncAt
        ? `LastUpdatedAfter=${encodeURIComponent(ctx.lastSyncAt)}`
        : `CreatedAfter=${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}`;

      const rawOrders = [];
      let nextOrdersToken = null;
      for (let page = 0; page < 20; page++) {
        const ordersUrl = nextOrdersToken
          ? `${base}/orders/v0/orders?MarketplaceIds=${encodeURIComponent(mpId)}&NextToken=${encodeURIComponent(nextOrdersToken)}`
          : `${base}/orders/v0/orders?MarketplaceIds=${encodeURIComponent(mpId)}&${timeParam}`;
        const ordersRes = await callWithRetry(() => callJson(fetchFn, ordersUrl, { headers: orderHeaders }), ctx.retryOpts);
        if (!ordersRes.ok) {
          throw connectorHttpError('Amazon SP-API', ordersRes, 'سحب طلبات');
        }
        const batch = ordersRes.data?.payload?.Orders || ordersRes.data?.Orders || [];
        rawOrders.push(...batch);
        nextOrdersToken = ordersRes.data?.payload?.NextToken || ordersRes.data?.NextToken || null;
        if (!nextOrdersToken) break;
      }

      const rawProducts = [];
      let nextInvToken = null;
      for (let page = 0; page < 20; page++) {
        const invUrl = nextInvToken
          ? `${base}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${encodeURIComponent(mpId)}&marketplaceIds=${encodeURIComponent(mpId)}&nextToken=${encodeURIComponent(nextInvToken)}`
          : `${base}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${encodeURIComponent(mpId)}&marketplaceIds=${encodeURIComponent(mpId)}`;
        const invRes = await callWithRetry(() => callJson(fetchFn, invUrl, { headers: invHeaders }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
        if (!invRes.ok) break;
        const batch = invRes.data?.payload?.inventorySummaries || invRes.data?.inventorySummaries || [];
        rawProducts.push(...batch);
        nextInvToken = invRes.data?.pagination?.nextToken || invRes.data?.payload?.nextToken || invRes.data?.nextToken || null;
        if (!nextInvToken) break;
      }

      const products = rawProducts.map((p) => ({
        sku: String(p.sellerSku || p.asin || '').trim(),
        name: String(p.productName || p.sellerSku || 'منتج أمازون').trim(),
        price: Number(p.price || 0) || 100,
        stock: Math.max(0, Number(p.totalQuantity ?? p.inventoryDetails?.fulfillableQuantity ?? 0) || 0),
        cat: 'أمازون مصر'
      })).filter((p) => p.sku);

      const orders = [];
      for (const o of rawOrders) {
        const externalRef = String(o.AmazonOrderId || '').trim();
        if (!externalRef) continue;
        let itemsText = `طلب أمازون #${externalRef}`;
        let orderItems = [];
        // جلب تفاصيل عناصر الطلب عند الإمكان (بدون إيقاف المزامنة إذا فشل)
        try {
          const itRes = await callWithRetry(
            () => callJson(fetchFn, `${base}/orders/v0/orders/${encodeURIComponent(externalRef)}/orderItems`, { headers: invHeaders }),
            { ...ctx.retryOpts, maxRetries: 2 }
          );
          if (itRes.ok) {
            const list = itRes.data?.payload?.OrderItems || itRes.data?.OrderItems || [];
            if (list.length) {
              orderItems = list.map((it) => ({
                sku: String(it.SellerSKU || it.ASIN || '').trim(),
                name: String(it.Title || it.SellerSKU || 'منتج أمازون').trim(),
                qty: Math.max(1, Number(it.QuantityOrdered || 1)),
                price: Number(it.ItemPrice?.Amount || 0)
              }));
              itemsText = orderItems.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(' + ').slice(0, 240);
            }
          }
        } catch (_) {}

        orders.push({
          externalRef,
          customer: String(o.BuyerInfo?.BuyerName || o.ShippingAddress?.Name || 'عميل أمازون').trim(),
          phone: String(o.ShippingAddress?.Phone || '').trim(),
          gov: String(o.ShippingAddress?.StateOrRegion || o.ShippingAddress?.City || 'القاهرة').trim(),
          address: String(o.ShippingAddress?.AddressLine1 || '').trim(),
          total: Math.max(1, Number(o.OrderTotal?.Amount || 0) || 1),
          pay: o.PaymentMethod === 'COD' ? 'عند الاستلام' : 'بطاقة بنكية',
          status: this.mapOrderStatus(o),
          items: itemsText,
          orderItems,
          createdAt: o.PurchaseDate || nowIso()
        });
      }

      return { products, orders };
    }
  },

  /**
   * 2. Noon Egypt — Noon Partners API
   * Docs: https://docs.noon.partners/
   * Auth: Signed JWT (RS256/HS256) login to /identity/public/v1/api/login -> Bearer token + X-Project-Code
   */
  n: {
    async getAuthHeaders(creds, fetchFn, ctx = {}) {
      const base = assertSafeExternalUrl(creds.baseUrl || PLATFORM_SCHEMAS.n.defaultBaseUrl, 'رابط نون API');
      const token = buildNoonJwt(creds.keyId, creds.privateKey);
      const loginRes = await callWithRetry(() => callJson(fetchFn, `${base}/identity/public/v1/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-project-code': creds.projectCode },
        body: JSON.stringify({ token, default_project_code: creds.projectCode })
      }), ctx.retryOpts);
      if (!loginRes.ok) {
        throw connectorHttpError('Noon Partners', loginRes, 'مصادقة');
      }
      const sessionToken = loginRes.data?.token || loginRes.data?.access_token || token;
      return {
        base,
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'x-project-code': creds.projectCode,
          'content-type': 'application/json',
          accept: 'application/json'
        }
      };
    },

    async test(creds, _env, fetchFn, ctx = {}) {
      await this.getAuthHeaders(creds, fetchFn, ctx);
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب نون (${creds.projectCode}).`,
        meta: { projectCode: creds.projectCode }
      };
    },

    async sync(creds, _env, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, fetchFn, ctx);
      const [ordersRes, stockRes] = await Promise.all([
        callWithRetry(() => callJson(fetchFn, `${base}/fbpi/v1/orders/search`, { method: 'POST', headers, body: JSON.stringify({ limit: 50 }) }), ctx.retryOpts),
        callWithRetry(() => callJson(fetchFn, `${base}/stock/v1/stock-list`, { method: 'POST', headers, body: JSON.stringify({ limit: 50 }) }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }))
      ]);
      if (!ordersRes.ok && !stockRes.ok) {
        throw connectorHttpError('Noon Partners', ordersRes, 'سحب بيانات');
      }
      const rawProducts = stockRes.ok ? (stockRes.data?.items || stockRes.data?.data || []) : [];
      const rawOrders = ordersRes.ok ? (ordersRes.data?.orders || ordersRes.data?.items || ordersRes.data?.data || []) : [];

      const products = rawProducts.map((p) => ({
        sku: String(p.partner_sku || p.sku || '').trim(),
        name: String(p.title || p.name || p.partner_sku || 'منتج نون').trim(),
        price: Number(p.price || p.sale_price || 0) || 100,
        stock: Math.max(0, Number(p.quantity ?? p.stock ?? 0) || 0),
        cat: 'نون مصر'
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => ({
        externalRef: String(o.order_nr || o.id || '').trim(),
        customer: String(o.customer_name || 'عميل نون').trim(),
        phone: String(o.customer_phone || o.phone || '').trim(),
        gov: String(o.city || o.governorate || 'القاهرة').trim(),
        address: String(o.address || '').trim(),
        total: Math.max(1, Number(o.total_amount || o.price || 0) || 1),
        pay: /cod/i.test(String(o.payment_method || '')) ? 'عند الاستلام' : 'بطاقة بنكية',
        status: /deliver/i.test(String(o.status || '')) ? 2 : /ship/i.test(String(o.status || '')) ? 1 : /cancel/i.test(String(o.status || '')) ? 4 : 0,
        items: `طلب نون #${o.order_nr || o.id || ''}`,
        createdAt: o.created_at || nowIso()
      })).filter((o) => o.externalRef);

      return { products, orders };
    }
  },

  /**
   * 3. Jumia Egypt — Jumia Vendor Center API
   * Docs: https://vendor-api.jumia.com/docs
   * Auth: OAuth2 Refresh Token (/token) -> Bearer token + X-Shop-Id header
   */
  j: {
    async getAuthHeaders(creds, env, fetchFn, ctx = {}) {
      const base = assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS.j.sandboxBaseUrl : PLATFORM_SCHEMAS.j.defaultBaseUrl),
        'رابط جوميا API'
      );
      let bearer = creds.apiKey;
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.clientId,
        refresh_token: creds.apiKey
      });
      const tokRes = await callWithRetry(() => callJson(fetchFn, `${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
      if (tokRes.ok && tokRes.data?.access_token) {
        bearer = tokRes.data.access_token;
      }
      return {
        base,
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-shop-id': creds.shopId,
          accept: 'application/json'
        }
      };
    },

    async test(creds, env, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, env, fetchFn, ctx);
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/shops`, { headers }), ctx.retryOpts);
      if (!res.ok) {
        throw connectorHttpError('Jumia Vendor Center', res, 'التحقق من حساب');
      }
      const shops = Array.isArray(res.data?.shops) ? res.data.shops : (Array.isArray(res.data) ? res.data : []);
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب جوميا (${creds.shopId})${shops.length ? ` — ${shops.length} متجر` : ''}.`,
        meta: { shopId: creds.shopId, shops: shops.length }
      };
    },

    async sync(creds, env, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, env, fetchFn, ctx);
      const rawOrders = [];
      let nextToken = null;
      let firstOrdersOk = false;
      for (let page = 0; page < 10; page++) {
        const url = nextToken ? `${base}/orders?size=50&token=${encodeURIComponent(nextToken)}` : `${base}/orders?size=50`;
        const ordersRes = await callWithRetry(() => callJson(fetchFn, url, { headers }), ctx.retryOpts);
        if (!ordersRes.ok) {
          if (page === 0) break;
          break;
        }
        firstOrdersOk = true;
        rawOrders.push(...(ordersRes.data?.orders || ordersRes.data?.items || []));
        nextToken = ordersRes.data?.nextToken || null;
        if (!nextToken) break;
      }
      const prodRes = await callWithRetry(() => callJson(fetchFn, `${base}/catalog/products?size=50`, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
      if (!firstOrdersOk && !prodRes.ok) {
        throw connectorHttpError('Jumia Vendor Center', prodRes, 'سحب بيانات');
      }
      const rawProducts = prodRes.ok ? (prodRes.data?.products || prodRes.data?.items || []) : [];

      const products = rawProducts.map((p) => ({
        sku: String(p.sellerSku || p.sku || p.id || '').trim(),
        name: String(p.name || p.title || p.sellerSku || 'منتج جوميا').trim(),
        price: Number(p.price?.value ?? p.price ?? 0) || 100,
        stock: Math.max(0, Number(p.stock ?? p.quantity ?? 0) || 0),
        cat: 'جوميا مصر'
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => ({
        externalRef: String(o.number || o.id || '').trim(),
        customer: String(o.shippingAddress?.firstName ? `${o.shippingAddress.firstName} ${o.shippingAddress.lastName || ''}`.trim() : (o.customerName || 'عميل جوميا')).trim(),
        phone: String(o.shippingAddress?.phone || o.phone || '').trim(),
        gov: String(o.shippingAddress?.city || o.city || 'القاهرة').trim(),
        address: String(o.shippingAddress?.address || '').trim(),
        total: Math.max(1, Number(o.totalAmountLocalValue || o.total || 0) || 1),
        pay: /cod|cash/i.test(String(o.paymentMethod || '')) ? 'عند الاستلام' : 'بطاقة بنكية',
        status: /deliver/i.test(String(o.status || '')) ? 2 : /ship/i.test(String(o.status || '')) ? 1 : /cancel/i.test(String(o.status || '')) ? 4 : 0,
        items: `طلب جوميا #${o.number || o.id || ''}`,
        createdAt: o.createdAt || nowIso()
      })).filter((o) => o.externalRef);

      return { products, orders };
    }
  },

  /**
   * 4. Trendyol — Official Supplier API
   * Docs: https://developers.trendyol.com/en
   * Auth: HTTP Basic Auth (base64(apiKey:apiSecret)) + User-Agent: "<supplierId> - SelfIntegration"
   */
  t: {
    headers(creds) {
      const basic = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
      return {
        authorization: `Basic ${basic}`,
        'user-agent': `${creds.supplierId} - SelfIntegration`,
        accept: 'application/json'
      };
    },

    async test(creds, env, fetchFn, ctx = {}) {
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.t.sandboxBaseUrl : PLATFORM_SCHEMAS.t.defaultBaseUrl;
      const url = `${base}/integration/product/sellers/${encodeURIComponent(creds.supplierId)}/products?size=1`;
      const res = await callWithRetry(() => callJson(fetchFn, url, { headers: this.headers(creds) }), ctx.retryOpts);
      if (!res.ok) {
        throw connectorHttpError('Trendyol', res, 'التحقق من حساب');
      }
      const total = Number(res.data?.totalElements ?? 0);
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب ترينديول (#${creds.supplierId}) — ${total} منتج متاح.`,
        meta: { supplierId: creds.supplierId, totalProducts: total }
      };
    },

    async sync(creds, env, fetchFn, ctx = {}) {
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.t.sandboxBaseUrl : PLATFORM_SCHEMAS.t.defaultBaseUrl;
      const headers = this.headers(creds);
      const sid = encodeURIComponent(creds.supplierId);

      const rawProducts = [];
      let prodOk = false;
      for (let page = 0; page < 10; page++) {
        const res = await callWithRetry(() => callJson(fetchFn, `${base}/integration/product/sellers/${sid}/products?size=50&page=${page}`, { headers }), ctx.retryOpts);
        if (!res.ok) {
          if (page === 0) {
            const ordTry = await callWithRetry(() => callJson(fetchFn, `${base}/integration/order/sellers/${sid}/orders?size=50`, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
            if (!ordTry.ok) throw connectorHttpError('Trendyol', res, 'سحب بيانات');
          }
          break;
        }
        prodOk = true;
        rawProducts.push(...(res.data?.content || []));
        const totalPages = Number(res.data?.totalPages || 1);
        if (page + 1 >= totalPages) break;
      }

      const rawOrders = [];
      for (let page = 0; page < 10; page++) {
        const res = await callWithRetry(() => callJson(fetchFn, `${base}/integration/order/sellers/${sid}/orders?size=50&page=${page}`, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
        if (!res.ok) break;
        rawOrders.push(...(res.data?.content || []));
        const totalPages = Number(res.data?.totalPages || 1);
        if (page + 1 >= totalPages) break;
      }
      if (!prodOk && !rawOrders.length) {
        throw new HttpError(400, 'فشل سحب بيانات ترينديول');
      }

      const products = rawProducts.map((p) => ({
        sku: String(p.stockCode || p.barcode || p.productCode || '').trim(),
        name: String(p.title || p.stockCode || 'منتج ترينديول').trim(),
        price: Number(p.salePrice ?? p.listPrice ?? 0) || 100,
        stock: Math.max(0, Number(p.quantity ?? 0) || 0),
        cat: String(p.categoryName || 'ترينديول').trim()
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => ({
        externalRef: String(o.orderNumber || o.id || '').trim(),
        customer: String(`${o.customerFirstName || ''} ${o.customerLastName || ''}`.trim() || 'عميل ترينديول'),
        phone: String(o.shipmentAddress?.phone || '').trim(),
        gov: String(o.shipmentAddress?.city || 'القاهرة').trim(),
        address: String(o.shipmentAddress?.fullAddress || '').trim(),
        total: Math.max(1, Number(o.totalPrice || o.grossAmount || 0) || 1),
        pay: 'بطاقة بنكية',
        status: /deliver/i.test(String(o.status || '')) ? 2 : /ship/i.test(String(o.status || '')) ? 1 : /cancel/i.test(String(o.status || '')) ? 4 : 0,
        items: Array.isArray(o.lines) && o.lines.length
          ? o.lines.map((l) => `${l.productName || l.merchantSku || 'منتج'} ×${l.quantity || 1}`).join('، ')
          : `طلب ترينديول #${o.orderNumber || o.id || ''}`,
        createdAt: o.orderDate ? new Date(o.orderDate).toISOString() : nowIso()
      })).filter((o) => o.externalRef);

      return { products, orders };
    }
  },

  /**
   * 5. Kenzz Egypt — Kenzz Partner API
   * Docs: https://kenzz.com/partners
   * Auth: Bearer Partner API Key + X-Store-Id (+ optional X-Api-Secret)
   */
  k: {
    headers(creds) {
      const h = {
        authorization: `Bearer ${creds.apiKey}`,
        'x-store-id': creds.storeId,
        accept: 'application/json'
      };
      if (creds.apiSecret) h['x-api-secret'] = creds.apiSecret;
      return h;
    },

    async test(creds, env, fetchFn, ctx = {}) {
      const base = assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS.k.sandboxBaseUrl : PLATFORM_SCHEMAS.k.defaultBaseUrl),
        'رابط كنز API'
      );
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/merchant/profile`, { headers: this.headers(creds) }), ctx.retryOpts);
      if (!res.ok) {
        throw connectorHttpError('Kenzz', res, 'التحقق من حساب');
      }
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب كنز (${creds.storeId}).`,
        meta: { storeId: creds.storeId, storeName: res.data?.name || res.data?.storeName || '' }
      };
    },

    async sync(creds, env, fetchFn, ctx = {}) {
      const base = assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS.k.sandboxBaseUrl : PLATFORM_SCHEMAS.k.defaultBaseUrl),
        'رابط كنز API'
      );
      const headers = this.headers(creds);
      const [prodRes, ordersRes] = await Promise.all([
        callWithRetry(() => callJson(fetchFn, `${base}/products?limit=50`, { headers }), ctx.retryOpts),
        callWithRetry(() => callJson(fetchFn, `${base}/orders?limit=50`, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }))
      ]);
      if (!prodRes.ok && !ordersRes.ok) {
        throw connectorHttpError('Kenzz', prodRes, 'سحب بيانات');
      }
      const rawProducts = prodRes.ok ? (prodRes.data?.products || prodRes.data?.data || []) : [];
      const rawOrders = ordersRes.ok ? (ordersRes.data?.orders || ordersRes.data?.data || []) : [];

      const products = rawProducts.map((p) => ({
        sku: String(p.sku || p.id || '').trim(),
        name: String(p.name || p.title || 'منتج كنز').trim(),
        price: Number(p.price || 0) || 100,
        stock: Math.max(0, Number(p.stock ?? p.quantity ?? 0) || 0),
        cat: String(p.category || 'كنز مصر').trim()
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => ({
        externalRef: String(o.order_id || o.id || '').trim(),
        customer: String(o.customer_name || o.customer?.name || 'عميل كنز').trim(),
        phone: String(o.customer_phone || o.phone || '').trim(),
        gov: String(o.governorate || o.city || 'القاهرة').trim(),
        address: String(o.address || '').trim(),
        total: Math.max(1, Number(o.total || o.amount || 0) || 1),
        pay: /cod|cash|استلام/i.test(String(o.payment_method || '')) ? 'عند الاستلام' : 'إنستاباي',
        status: /deliver/i.test(String(o.status || '')) ? 2 : /ship/i.test(String(o.status || '')) ? 1 : /cancel/i.test(String(o.status || '')) ? 4 : 0,
        items: `طلب كنز #${o.order_id || o.id || ''}`,
        createdAt: o.created_at || nowIso()
      })).filter((o) => o.externalRef);

      return { products, orders };
    }
  }
};

/**
 * إنشاء خدمة الموصّلات المربوطة بقاعدة البيانات والتشفير (AES-256-GCM)
 */
function createConnectors(app) {
  const { q, tx, cfg, cipher, notify, model } = app;
  const activeLocks = new Set();
  const tokenCache = new Map();
  const authFailCounts = new Map();
  let autoSyncRunning = false;

  const safeFetch = (url, init = {}) => cfg.fetch(url, init);
  const guardedFetch = cfg.dnsLookup
    ? async (url, init = {}) => {
      await assertSafeExternalUrlWithDns(url, 'رابط الـ API', { lookupFn: cfg.dnsLookup });
      return safeFetch(url, init);
    }
    : cfg.fetch;

  const retryOpts = { baseDelayMs: cfg.connectorRetryBaseMs ?? 40 };

  function decryptRowCreds(row) {
    if (!row || !row.creds_enc) return {};
    try {
      const plain = cipher.decrypt(row.creds_enc);
      return parseJson(plain, {});
    } catch {
      return {};
    }
  }

  function formatRow(platform, row) {
    const schema = PLATFORM_SCHEMAS[platform];
    if (!row) {
      return {
        platform,
        name: schema.name,
        sandboxUnverified: Boolean(schema.sandboxUnverified),
        configured: false,
        enabled: false,
        environment: 'production',
        status: 'disconnected',
        credentials: maskCredentials(platform, {}),
        lastTestedAt: null,
        lastSyncAt: null,
        lastError: '',
        stats: {}
      };
    }
    const rawCreds = decryptRowCreds(row);
    const masked = maskCredentials(platform, rawCreds);
    const hasRequired = schema.fields.filter((f) => f.required).every((f) => Boolean(rawCreds[f.name]));
    return {
      platform,
      name: schema.name,
      sandboxUnverified: Boolean(schema.sandboxUnverified),
      configured: hasRequired,
      enabled: Boolean(row.enabled),
      environment: row.environment || 'production',
      status: row.status || (hasRequired ? 'configured' : 'disconnected'),
      credentials: masked,
      lastTestedAt: row.last_tested_at || null,
      lastSyncAt: row.last_sync_at || null,
      lastError: row.last_error || '',
      stats: parseJson(row.stats_json, {})
    };
  }

  function listForUser(userId) {
    const rows = q('SELECT * FROM marketplace_connections WHERE user_id = ?').all(userId);
    const byPlatform = new Map(rows.map((r) => [r.platform, r]));
    return PLATFORM_KEYS.map((p) => formatRow(p, byPlatform.get(p)));
  }

  function listSyncRuns(userId, limit = 10) {
    return q(`SELECT id, platform, started_at, finished_at, orders_new, orders_updated, error
      FROM connector_sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
      .all(userId, Math.min(50, Math.max(1, Number(limit) || 10)))
      .map((r) => ({
        id: r.id,
        platform: r.platform,
        platformName: MARKETS[r.platform]?.name || r.platform,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        ordersNew: r.orders_new,
        ordersUpdated: r.orders_updated,
        error: r.error || ''
      }));
  }

  function getRow(userId, platform) {
    if (!PLATFORM_KEYS.includes(platform)) throw bad('منصة غير مدعومة');
    return q('SELECT * FROM marketplace_connections WHERE user_id = ? AND platform = ?').get(userId, platform);
  }

  function saveConnection(userId, platform, { credentials, environment = 'production', enabled = true }) {
    if (!PLATFORM_KEYS.includes(platform)) throw bad('منصة غير مدعومة');
    const env = environment === 'sandbox' ? 'sandbox' : 'production';
    const existingRow = getRow(userId, platform);
    const existingCreds = decryptRowCreds(existingRow);
    const merged = validateAndMergeCredentials(platform, credentials, existingCreds);
    const enc = cipher.encrypt(JSON.stringify(merged));
    const now = nowIso();
    const endpointUrl = merged.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS[platform].sandboxBaseUrl : PLATFORM_SCHEMAS[platform].defaultBaseUrl);

    if (existingRow) {
      q(`UPDATE marketplace_connections
         SET enabled = ?, environment = ?, creds_enc = ?, endpoint_url = ?, status = 'configured', last_error = '', updated_at = ?
         WHERE user_id = ? AND platform = ?`)
        .run(enabled ? 1 : 0, env, enc, endpointUrl, now, userId, platform);
    } else {
      q(`INSERT INTO marketplace_connections
         (user_id, platform, enabled, environment, creds_enc, endpoint_url, status, last_error, stats_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'configured', '', '{}', ?, ?)`)
        .run(userId, platform, enabled ? 1 : 0, env, enc, endpointUrl, now, now);
    }
    return formatRow(platform, getRow(userId, platform));
  }

  function deleteConnection(userId, platform) {
    if (!PLATFORM_KEYS.includes(platform)) throw bad('منصة غير مدعومة');
    q('DELETE FROM marketplace_connections WHERE user_id = ? AND platform = ?').run(userId, platform);
    return formatRow(platform, null);
  }

  function recordAuthFailure(userId, platform, err) {
    const key = `${userId}:${platform}`;
    if (!err || !err.authFailure) {
      authFailCounts.delete(key);
      return;
    }
    const next = (authFailCounts.get(key) || 0) + 1;
    authFailCounts.set(key, next);
    if (next >= 3 && typeof app.sendSecurityAlert === 'function') {
      authFailCounts.set(key, 0);
      app.sendSecurityAlert({
        severity: 'medium',
        title: `فشل متكرر في مصادقة موصّل ${MARKETS[platform]?.name || platform}`,
        details: { userId, platform, status: err.upstreamStatus || 401 }
      }).catch(() => {});
    }
  }

  async function testConnection(userId, platform) {
    const row = getRow(userId, platform);
    if (!row || !row.creds_enc) {
      throw bad(`أضف بيانات API الخاصة بمنصة ${MARKETS[platform]?.name || platform} أولًا قبل اختبار الاتصال.`);
    }
    const creds = decryptRowCreds(row);
    const adapter = ADAPTERS[platform];
    const now = nowIso();
    try {
      const res = await adapter.test(creds, row.environment || 'production', guardedFetch, { userId, tokenCache, retryOpts });
      authFailCounts.delete(`${userId}:${platform}`);
      q(`UPDATE marketplace_connections
         SET status = 'connected', last_tested_at = ?, last_error = '', updated_at = ?
         WHERE user_id = ? AND platform = ?`)
        .run(now, now, userId, platform);
      return { ok: true, message: res.message, meta: res.meta || {}, connection: formatRow(platform, getRow(userId, platform)) };
    } catch (err) {
      recordAuthFailure(userId, platform, err);
      const errMsg = String(err?.message || 'فشل الاتصال بالمنصة').slice(0, 300);
      q(`UPDATE marketplace_connections
         SET status = 'error', last_tested_at = ?, last_error = ?, updated_at = ?
         WHERE user_id = ? AND platform = ?`)
        .run(now, errMsg, now, userId, platform);
      return { ok: false, message: errMsg, connection: formatRow(platform, getRow(userId, platform)) };
    }
  }

  /**
   * سحب المنتجات والطلبات الحقيقية من المنصة وتخزينها في قاعدة البيانات بدون تكرار (Idempotent) مع تسجيل connector_sync_runs
   */
  async function syncPlatform(userId, platform) {
    const lockKey = `${userId}:${platform}`;
    if (activeLocks.has(lockKey)) {
      return { live: true, ok: false, skipped: true, platform, reason: 'عملية مزامنة جارية بالفعل لهذه المنصة' };
    }
    const row = getRow(userId, platform);
    if (!row || !row.creds_enc) {
      return { live: false, platform, skipped: true, reason: 'لم يتم إدخال مفتاح API بعد' };
    }
    activeLocks.add(lockKey);
    const creds = decryptRowCreds(row);
    const adapter = ADAPTERS[platform];
    const startedAt = nowIso();
    const sourceName = PLATFORM_SOURCE[platform] || platform;
    const runId = Number(q('INSERT INTO connector_sync_runs (user_id, platform, started_at) VALUES (?, ?, ?)').run(userId, platform, startedAt).lastInsertRowid);

    try {
      const pulled = await adapter.sync(creds, row.environment || 'production', guardedFetch, {
        userId,
        lastSyncAt: row.last_sync_at || null,
        amazonPiiEnabled: Boolean(cfg.amazonPiiEnabled),
        tokenCache,
        retryOpts
      });
      authFailCounts.delete(lockKey);
      const now = nowIso();
      const summary = tx(() => {
        let importedProducts = 0;
        let updatedProducts = 0;
        let importedOrders = 0;
        let updatedOrders = 0;
        let skippedOrders = 0;

        for (const p of pulled.products || []) {
          const sku = String(p.sku || '').slice(0, 40);
          if (!sku) continue;
          const existing = q('SELECT id, markets FROM products WHERE user_id = ? AND sku = ?').get(userId, sku);
          if (existing) {
            const mSet = new Set(String(existing.markets || '').split('').filter(Boolean));
            mSet.add(platform);
            q('UPDATE products SET name = ?, price = ?, stock = ?, markets = ?, updated_at = ? WHERE id = ?')
              .run(String(p.name || sku).slice(0, 120), Math.max(1, Number(p.price) || 100), Math.max(0, Math.round(Number(p.stock) || 0)), [...mSet].join(''), now, existing.id);
            updatedProducts++;
          } else {
            const price = Math.max(1, Number(p.price) || 100);
            const cost = Math.round(price * 0.65);
            q(`INSERT INTO products (user_id, name, sku, cat, markets, price, cost, stock, approval_status, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`)
              .run(userId, String(p.name || sku).slice(0, 120), sku, String(p.cat || 'عام').slice(0, 40), platform, price, cost, Math.max(0, Math.round(Number(p.stock) || 0)), sourceName, now, now);
            importedProducts++;
          }
        }

        const userRow = q('SELECT order_seq FROM users WHERE id = ?').get(userId);
        let nextSeq = Number(userRow?.order_seq || 1000);
        for (const o of pulled.orders || []) {
          const extRef = String(o.externalRef || '').slice(0, 80);
          if (!extRef) continue;
          const nextStatus = Number(o.status || 0);
          const exists = q('SELECT id, status, delivered_at FROM orders WHERE user_id = ? AND market = ? AND external_ref = ?').get(userId, platform, extRef);
          if (exists) {
            if (exists.status !== nextStatus) {
              const delAt = nextStatus === 2 && !exists.delivered_at ? now : exists.delivered_at;
              q('UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?').run(nextStatus, delAt, exists.id);
              updatedOrders++;
            } else {
              skippedOrders++;
            }
            continue;
          }
          nextSeq += 1;
          const total = Math.max(1, Number(o.total) || 1);
          const costTotal = Math.round(total * 0.65);
          const custName = String(o.customer || 'عميل المنصة').slice(0, 80);
          const custPhone = String(o.phone || '').slice(0, 30);
          const custGov = String(o.gov || 'القاهرة').slice(0, 40);
          const custAddr = String(o.address || '').slice(0, 200);
          const customerId = model?.upsertCustomerForOrder
            ? model.upsertCustomerForOrder({ userId, name: custName, phone: custPhone, gov: custGov, address: custAddr, now: String(o.createdAt || now) })
            : null;
          const encName = model?.enc ? model.enc(custName) : custName;
          const encPhone = model?.enc ? model.enc(custPhone) : custPhone;
          const phHash = model?.phoneHash ? model.phoneHash(custPhone) : '';
          const encAddr = model?.enc ? model.enc(custAddr) : custAddr;
          const deliveredAt = nextStatus === 2 ? now : null;
          const orderId = Number(q(`INSERT INTO orders (user_id, customer_id, no, market, customer, phone, phone_hash, gov, address, pay, courier, total, cost_total, ship_fee, status, items, approval_status, external_ref, source, delivered_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'بوسطة', ?, ?, 38, ?, ?, 'approved', ?, ?, ?, ?)`)
            .run(
              userId, customerId, nextSeq, platform,
              encName, encPhone, phHash, custGov, encAddr,
              String(o.pay || 'عند الاستلام'),
              total, costTotal,
              nextStatus,
              String(o.items || `طلب ${MARKETS[platform]?.name || platform}`).slice(0, 240),
              extRef,
              sourceName,
              deliveredAt,
              String(o.createdAt || now)
            ).lastInsertRowid);
          if (Array.isArray(o.orderItems) && o.orderItems.length) {
            for (const it of o.orderItems) {
              q('INSERT INTO order_items (order_id, product_id, name, qty, price, cost) VALUES (?, NULL, ?, ?, ?, ?)')
                .run(orderId, String(it.name || 'منتج').slice(0, 120), Math.max(1, Number(it.qty) || 1), Number(it.price) || 0, Math.round((Number(it.price) || 0) * 0.65));
            }
          }
          importedOrders++;
        }
        q('UPDATE users SET order_seq = ?, last_sync_at = ? WHERE id = ?').run(nextSeq, now, userId);

        const stats = { importedProducts, updatedProducts, importedOrders, updatedOrders, skippedOrders, lastRunAt: now };
        q(`UPDATE marketplace_connections
           SET status = 'connected', last_sync_at = ?, last_tested_at = COALESCE(last_tested_at, ?), last_error = '', stats_json = ?, updated_at = ?
           WHERE user_id = ? AND platform = ?`)
          .run(now, now, JSON.stringify(stats), now, userId, platform);

        q('UPDATE connector_sync_runs SET finished_at = ?, orders_new = ?, orders_updated = ?, error = \'\' WHERE id = ?')
          .run(now, importedOrders, updatedOrders, runId);

        return stats;
      });

      return {
        live: true,
        ok: true,
        platform,
        name: MARKETS[platform]?.name || platform,
        ...summary,
        connection: formatRow(platform, getRow(userId, platform))
      };
    } catch (err) {
      recordAuthFailure(userId, platform, err);
      const finishedAt = nowIso();
      const errMsg = String(err?.message || 'فشلت مزامنة البيانات مع المنصة').slice(0, 300);
      q(`UPDATE marketplace_connections
         SET status = 'error', last_error = ?, updated_at = ?
         WHERE user_id = ? AND platform = ?`)
        .run(errMsg, finishedAt, userId, platform);
      q('UPDATE connector_sync_runs SET finished_at = ?, error = ? WHERE id = ?').run(finishedAt, errMsg, runId);
      return {
        live: true,
        ok: false,
        platform,
        name: MARKETS[platform]?.name || platform,
        error: errMsg,
        connection: formatRow(platform, getRow(userId, platform))
      };
    } finally {
      activeLocks.delete(lockKey);
    }
  }

  async function syncAllActiveConnections() {
    if (autoSyncRunning) return { skipped: true, reason: 'already_running', results: [] };
    autoSyncRunning = true;
    const results = [];
    try {
      const rows = q(`SELECT mc.user_id, mc.platform
        FROM marketplace_connections mc
        JOIN users u ON u.id = mc.user_id
        WHERE mc.status = 'connected' AND mc.enabled = 1 AND u.status = 'active' AND u.is_demo = 0`).all();

      for (const row of rows) {
        const res = await syncPlatform(row.user_id, row.platform);
        results.push({ userId: row.user_id, ...res });
        if (typeof notify === 'function' && res && res.live) {
          if (res.ok && res.importedOrders > 0) {
            notify(
              row.user_id,
              'ok',
              `وصلت ${res.importedOrders} طلبات جديدة من ${res.name}`,
              `تم سحب ${res.importedOrders} طلب جديد وتحديث ${res.updatedProducts + res.importedProducts} منتج عبر المزامنة التلقائية.`,
              '#/ord'
            );
          } else if (!res.ok && !res.skipped) {
            notify(
              row.user_id,
              'error',
              `تعذّرت المزامنة التلقائية مع ${res.name}`,
              res.error || 'تحقق من صلاحية مفاتيح API من صفحة التكاملات.',
              '#/int'
            );
          }
        }
      }
      return { skipped: false, count: results.length, results };
    } finally {
      autoSyncRunning = false;
    }
  }

  return {
    PLATFORM_KEYS,
    PLATFORM_SCHEMAS,
    listForUser,
    listSyncRuns,
    saveConnection,
    deleteConnection,
    testConnection,
    syncPlatform,
    syncAllActiveConnections
  };
}

module.exports = {
  PLATFORM_KEYS,
  PLATFORM_SCHEMAS,
  PLATFORM_SOURCE,
  isPrivateOrReservedIp,
  isPrivateIp: isPrivateOrReservedIp,
  assertSafeExternalUrl,
  assertSafeExternalUrlWithDns,
  assertSafeResolvedUrl: assertSafeExternalUrlWithDns,
  callJson,
  callWithRetry,
  maskSecret,
  maskCredentials,
  validateAndMergeCredentials,
  createConnectors
};
