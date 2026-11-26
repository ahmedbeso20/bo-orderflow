'use strict';
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { HttpError, bad, round2, nowIso, parseJson } = require('../util');
const { MARKETS } = require('../domain');
const { consumeFifoCost, parseAmazonFinancialEvents } = require('../profit-engine');

const INVENTORY_BACKOFF_SECONDS = [15, 60, 300, 900];

function pushInventoryHttpError(providerLabel, res, action = 'دفع المخزون') {
  const status = Number(res?.status || 0);
  const msg = `${providerLabel}: فشل ${action} (HTTP ${status || 'ERR'})`;
  const err = new Error(msg);
  err.statusCode = status;
  err.retryable = status === 0 || status === 429 || status >= 500;
  if (status === 401 || status === 403) err.authFailure = true;
  return err;
}

const PLATFORM_KEYS = ['a', 'n', 'j', 't', 'k'];
const PLATFORM_SOURCE = Object.freeze({ a: 'amazon', n: 'noon', j: 'jumia', t: 'trendyol', k: 'kenzz' });
const DEFAULT_PLATFORM_COURIER = Object.freeze({
  a: 'أمازون FBA',
  n: 'نون Express',
  j: 'جوميا Express',
  t: 'ترينديول شحن',
  k: 'كنز شحن'
});
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
    docsHint: 'احصل على مفاتيح LWA و Refresh Token من Seller Central ← Apps & Services ← Develop Apps. يدعم FBA و FBM وتقارير الأسعار الفعلية.',
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
    authMethod: 'JWT (RS256/HS256) login -> Session Cookie (Set-Cookie) + X-Project + User-Agent',
    docsHint: 'أنشئ Service Account Key من Noon Seller Lab ← API Keys، ويمكنك لصق المفتاح الخاص PEM أو ملف JSON مباشرةً.',
    defaultBaseUrl: 'https://noon-api-gateway.noon.partners',
    sandboxBaseUrl: 'https://noon-api-gateway.noon.partners',
    sandboxUnverified: true,
    fields: [
      { name: 'projectCode', label: 'كود المشروع (Project Code)', placeholder: 'مثال: PRJ1234', required: true, secret: false },
      { name: 'keyId', label: 'معرّف المفتاح (Key ID)', placeholder: 'مثال: noon_partner_key_01', required: true, secret: false },
      { name: 'privateKey', label: 'المفتاح الخاص (Private Key PEM أو JSON Key أو API Secret)', placeholder: '-----BEGIN PRIVATE KEY----- أو {"private_key":...}', required: true, secret: true, multiline: true },
      { name: 'baseUrl', label: 'رابط البوابة (اختياري)', placeholder: 'https://noon-api-gateway.noon.partners', defaultValue: 'https://noon-api-gateway.noon.partners', required: false, secret: false, isUrl: true }
    ]
  },
  j: {
    key: 'j',
    name: 'جوميا مصر (Jumia Vendor Center API)',
    docsUrl: 'https://vendorcenter.jumia.com/api-docs/',
    authMethod: 'OAuth2 Self-Authorization Refresh Token (مع تدوير وحفظ تلقائي) -> Bearer JWT',
    docsHint: 'أنشئ تطبيق Self Authorization من Jumia Vendor Center ← Settings ← Applications ← Generate Token. يتم تدوير وحفظ الـ Refresh Token الجديد تلقائيًا بعد كل اتصال.',
    defaultBaseUrl: 'https://vendor-api.jumia.com',
    sandboxBaseUrl: 'https://vendor-api-staging.jumia.com',
    sandboxUnverified: false,
    fields: [
      { name: 'shopId', label: 'معرّف المتجر (Shop ID — اختياري، يُكتشف تلقائيًا)', placeholder: 'اتركه فارغًا للاكتشاف التلقائي أو أدخل Shop ID', required: false, secret: false },
      { name: 'clientId', label: 'معرّف التطبيق (Client ID)', placeholder: 'مثال: jumia-client-xxxx', required: true, secret: false },
      { name: 'apiKey', label: 'رمز التحديث (OAuth2 Refresh Token)', placeholder: 'أدخل Refresh Token من Vendor Center', required: true, secret: true },
      { name: 'baseUrl', label: 'رابط Jumia API (اختياري)', placeholder: 'https://vendor-api.jumia.com', defaultValue: 'https://vendor-api.jumia.com', required: false, secret: false, isUrl: true }
    ]
  },
  t: {
    key: 't',
    name: 'ترينديول (Trendyol Supplier API v2)',
    docsUrl: 'https://developers.trendyol.com/en',
    authMethod: 'HTTP Basic Auth (apiKey:apiSecret) + User-Agent + storeFrontCode (Order V2)',
    docsHint: 'احصل على Supplier ID و API Key و API Secret من Trendyol Partner Panel ← Account Info ← Integration Info. يدعم Order V2 وسحب المرتجعات تلقائيًا.',
    defaultBaseUrl: 'https://apigw.trendyol.com',
    sandboxBaseUrl: 'https://stageapigw.trendyol.com',
    sandboxUnverified: false,
    fields: [
      { name: 'supplierId', label: 'معرّف المورّد (Supplier ID)', placeholder: 'مثال: 123456', required: true, secret: false },
      { name: 'apiKey', label: 'مفتاح الربط (API Key)', placeholder: 'أدخل Trendyol API Key', required: true, secret: true },
      { name: 'apiSecret', label: 'الرمز السري (API Secret)', placeholder: 'أدخل Trendyol API Secret', required: true, secret: true },
      { name: 'storeFrontCode', label: 'كود الدولة / السوق (storeFrontCode)', placeholder: 'EG أو TR', defaultValue: 'EG', required: false, secret: false }
    ]
  },
  k: {
    key: 'k',
    name: 'كنز مصر (Kenzz Partner API)',
    docsUrl: 'https://kenzz.com/partners',
    authMethod: 'Bearer Partner API Key + X-Store-Id (+ optional X-Api-Secret)',
    docsHint: 'احصل على رابط Partner API ومفتاح الربط من مدير حسابك في فريق شركاء Kenzz Egypt، ويمكنك تعديل رابط البوابة إذا زوّدك الفريق بنطاق مخصص.',
    defaultBaseUrl: 'https://partners-api.kenzz.com/v1',
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
 * توحيد حالات الطلب عبر جميع الأسواق الخمسة إلى حالات OrderFlow:
 * 0 = قيد التجهيز، 1 = تم الشحن، 2 = تم التسليم، 3 = مرتجع، 4 = ملغي
 */
function normalizeMarketplaceStatus(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (/return|refund|rto|rejectedbybuyer|undeliveredandreturned|failed[_\s-]?delivery|returnedtoseller|returningtoseller/i.test(s)) return 3;
  if (/cancel|unsupplied|void/i.test(s)) return 4;
  if (/deliver|completed/i.test(s)) return 2;
  if (/ship|transit|picked|dispatched|out[\s_-]*for[\s_-]*delivery|in[\s_-]*cargo/i.test(s)) return 1;
  return 0;
}

/**
 * تحليل ملفات TSV (مثل تقرير Amazon SP-API GET_MERCHANT_LISTINGS_ALL_DATA)
 */
function parseTsv(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      if (headers[j]) obj[headers[j]] = (cols[j] ?? '').trim();
    }
    rows.push(obj);
  }
  return rows;
}

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

  // دعم لصق ملف JSON الخاص بحساب الخدمة في نون مباشرة داخل حقل privateKey
  const normalizedInput = { ...inputCreds };
  if (platform === 'n' && typeof normalizedInput.privateKey === 'string' && normalizedInput.privateKey.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(normalizedInput.privateKey.trim());
      if (parsed && typeof parsed === 'object') {
        if (parsed.private_key || parsed.privateKey) normalizedInput.privateKey = String(parsed.private_key || parsed.privateKey);
        if (!normalizedInput.keyId && (parsed.key_id || parsed.keyId)) normalizedInput.keyId = String(parsed.key_id || parsed.keyId);
        if (!normalizedInput.projectCode && (parsed.project_code || parsed.projectCode)) normalizedInput.projectCode = String(parsed.project_code || parsed.projectCode);
      }
    } catch { /* نتركها كما هي */ }
  }

  const merged = {};
  for (const f of schema.fields) {
    let val = normalizedInput[f.name] !== undefined && normalizedInput[f.name] !== null
      ? String(normalizedInput[f.name]).trim()
      : '';
    if (!val && f.secret && existingCreds[f.name]) {
      val = String(existingCreds[f.name]).trim();
    }
    if (!val && f.defaultValue) {
      val = f.defaultValue;
    }
    if (val.length > 8000) {
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
    if (k.toLowerCase() === target) return Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  return '';
}

/** استخراج أزواج الكوكيز (name=value) من ترويسات Set-Cookie (ضروري لجلسة Noon Partners API) */
function getSetCookies(headers) {
  if (!headers) return [];
  let rawList = [];
  if (typeof headers.getSetCookie === 'function') {
    rawList = headers.getSetCookie();
  } else {
    const raw = getHeader(headers, 'set-cookie');
    if (raw) {
      // فصل آمن يتجنب الفواصل داخل تواريخ Expires=Thu, 01 Jan ...
      rawList = raw.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
    }
  }
  const pairs = [];
  const seen = new Map();
  for (const item of rawList) {
    const firstPart = String(item || '').split(';')[0].trim();
    const eq = firstPart.indexOf('=');
    if (eq > 0) {
      const k = firstPart.slice(0, eq).trim();
      const v = firstPart.slice(eq + 1).trim();
      if (k) seen.set(k, `${k}=${v}`);
    }
  }
  for (const v of seen.values()) pairs.push(v);
  return pairs;
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
 * تنزيل مستند نصي/مضغوط (مثل تقارير Amazon SP-API TSV/GZIP) مع نفس حماية SSRF والمهلة الزمنية
 */
async function callRaw(fetchFn, url, opts = {}) {
  assertSafeExternalUrl(url, opts.label || 'رابط المستند');
  if (opts.dnsLookup || opts.verifyDns === true || fetchFn === globalThis.fetch) {
    await assertSafeExternalUrlWithDns(url, opts.label || 'رابط المستند', { lookupFn: opts.dnsLookup });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      redirect: 'error',
      signal: controller.signal
    });
    if (res && Number(res.status) >= 300 && Number(res.status) < 400) {
      throw new HttpError(400, 'تم رفض إعادة التوجيه التلقائية لأسباب أمنية (حماية SSRF)');
    }
    let buf;
    if (typeof res.arrayBuffer === 'function') {
      buf = Buffer.from(await res.arrayBuffer());
    } else if (typeof res.text === 'function') {
      buf = Buffer.from(await res.text(), 'utf8');
    } else {
      buf = Buffer.alloc(0);
    }
    const isGzip = String(opts.compressionAlgorithm || '').toUpperCase() === 'GZIP'
      || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
    const plainBuf = isGzip && buf.length >= 2 ? zlib.gunzipSync(buf) : buf;
    return { ok: Boolean(res.ok), status: Number(res.status || 0), text: plainBuf.toString('utf8'), headers: res.headers || {} };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err && err.name === 'AbortError') throw new HttpError(504, 'انتهت مهلة تحميل التقرير من سيرفر المنصة');
    throw new HttpError(502, `تعذّر تحميل مستند التقرير: ${err?.message || 'خطأ شبكة'}`);
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
  const keyStr = String(privateKey || '').trim();
  const isPem = keyStr.includes('BEGIN');
  const header = base64Url(JSON.stringify({ alg: isPem ? 'RS256' : 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({ sub: keyId, iat: now, exp: now + 300, jti: crypto.randomUUID() }));
  const signingInput = `${header}.${payload}`;
  if (isPem) {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const sig = signer.sign(keyStr, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${signingInput}.${sig}`;
  }
  const sig = crypto.createHmac('sha256', keyStr).update(signingInput).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
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
   * Catalog: Reports API (GET_MERCHANT_LISTINGS_ALL_DATA for FBA+FBM real prices) + FBA Inventory Summaries + Listings fallback
   * Orders: Orders v0 (with 5m overlap + NextToken pagination + OrderItems real unit prices)
   */
  a: {
    async getAccessToken(creds, fetchFn, ctx = {}) {
      const cacheKey = `amz:${ctx.userId || 0}:${creds.sellerId || ''}:${creds.clientId || ''}`;
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
      const easyStatus = String(o.EasyShipShipmentStatus || '');
      if (easyStatus) {
        const mapped = normalizeMarketplaceStatus(easyStatus);
        if (mapped !== 0) return mapped;
      }
      if (o.IsReturned || o.ReturnStatus) return 3;
      return normalizeMarketplaceStatus(o.OrderStatus);
    },

    /** سحب الكتالوج الكامل (FBA + FBM + الأسعار الحقيقية) عبر SP-API Reports API */
    async pullListingsReport(base, mpId, headers, fetchFn, ctx = {}) {
      try {
        const createRes = await callWithRetry(() => callJson(fetchFn, `${base}/reports/2021-06-30/reports`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
            marketplaceIds: [mpId]
          })
        }), { ...ctx.retryOpts, maxRetries: 1 });
        const reportId = createRes.ok ? createRes.data?.reportId : null;
        if (!reportId) return [];

        let documentId = createRes.data?.reportDocumentId || null;
        const sleep = ctx.retryOpts?.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const pollDelay = ctx.reportPollDelayMs ?? (ctx.retryOpts?.baseDelayMs ? Math.min(200, ctx.retryOpts.baseDelayMs) : 1200);
        for (let i = 0; i < 6 && !documentId; i++) {
          const stRes = await callJson(fetchFn, `${base}/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, { headers });
          if (!stRes.ok) break;
          const st = String(stRes.data?.processingStatus || '').toUpperCase();
          if (st === 'DONE' && stRes.data?.reportDocumentId) {
            documentId = stRes.data.reportDocumentId;
            break;
          }
          if (st === 'FATAL' || st === 'CANCELLED') break;
          await sleep(pollDelay);
        }
        if (!documentId) return [];

        const docRes = await callJson(fetchFn, `${base}/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`, { headers });
        if (!docRes.ok || !docRes.data?.url) return [];
        const rawDoc = await callRaw(fetchFn, docRes.data.url, {
          compressionAlgorithm: docRes.data.compressionAlgorithm
        });
        if (!rawDoc.ok || !rawDoc.text) return [];

        const parsed = parseTsv(rawDoc.text);
        return parsed.map((row) => ({
          sku: String(row['seller-sku'] || row.sku || '').trim(),
          name: String(row['item-name'] || row.title || row['seller-sku'] || 'منتج أمازون').trim(),
          price: Number(row.price || 0) || 0,
          stock: Math.max(0, Number(row.quantity || 0) || 0),
          cat: /amazon/i.test(String(row['fulfillment-channel'] || '')) ? 'أمازون FBA' : 'أمازون مصر'
        })).filter((p) => p.sku);
      } catch {
        return [];
      }
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
      const token = await this.getAccessToken(creds, fetchFn, ctx);
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.a.sandboxBaseUrl : PLATFORM_SCHEMAS.a.defaultBaseUrl;
      const mpId = creds.marketplaceId || 'ARBP9OOSHTCHU';

      // طلب RDT للبيانات الشخصية فقط عند تفعيل AMAZON_PII_ENABLED=1
      let ordersToken = token;
      if (ctx.amazonPiiEnabled) {
        ordersToken = await this.getRestrictedDataToken(base, token, fetchFn, ctx);
      }

      const orderHeaders = { 'x-amz-access-token': ordersToken, accept: 'application/json' };
      const invHeaders = { 'x-amz-access-token': token, accept: 'application/json' };

      // المزامنة التراكمية مع هامش أمان ٥ دقائق لتفادي فقدان أي طلب عند الحدود الزمنية
      let timeParam;
      if (ctx.lastSyncAt && Number.isFinite(Date.parse(ctx.lastSyncAt))) {
        const safeSince = new Date(Math.max(0, Date.parse(ctx.lastSyncAt) - 5 * 60_000)).toISOString();
        timeParam = `LastUpdatedAfter=${encodeURIComponent(safeSince)}`;
      } else {
        timeParam = `CreatedAfter=${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}`;
      }

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

      // 1) سحب الكتالوج الكامل (FBA + FBM + الأسعار الحقيقية) من Reports API
      const productBySku = new Map();
      const reportProducts = await this.pullListingsReport(base, mpId, invHeaders, fetchFn, ctx);
      for (const p of reportProducts) {
        productBySku.set(p.sku, p);
      }

      // 2) دمج كميات مخزون FBA اللحظية مع الحفاظ على الأسعار الفعلية من التقرير
      let nextInvToken = null;
      for (let page = 0; page < 20; page++) {
        const invUrl = nextInvToken
          ? `${base}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${encodeURIComponent(mpId)}&marketplaceIds=${encodeURIComponent(mpId)}&nextToken=${encodeURIComponent(nextInvToken)}`
          : `${base}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${encodeURIComponent(mpId)}&marketplaceIds=${encodeURIComponent(mpId)}`;
        const invRes = await callWithRetry(() => callJson(fetchFn, invUrl, { headers: invHeaders }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
        if (!invRes.ok) break;
        const batch = invRes.data?.payload?.inventorySummaries || invRes.data?.inventorySummaries || [];
        for (const p of batch) {
          const sku = String(p.sellerSku || p.asin || '').trim();
          if (!sku) continue;
          const prev = productBySku.get(sku);
          const stock = Math.max(0, Number(p.inventoryDetails?.fulfillableQuantity ?? p.totalQuantity ?? 0) || 0);
          const price = Number(p.price || 0) || (prev ? prev.price : 0);
          productBySku.set(sku, {
            sku,
            name: String(p.productName || prev?.name || sku || 'منتج أمازون').trim(),
            price,
            stock,
            cat: prev?.cat || 'أمازون مصر'
          });
        }
        nextInvToken = invRes.data?.pagination?.nextToken || invRes.data?.payload?.nextToken || invRes.data?.nextToken || null;
        if (!nextInvToken) break;
      }

      // 3) محاولة جلب السعر الحقيقي عبر Listings Items API لأي منتج FBA بلا سعر (حد أقصى 15 منتجًا في المزامنة)
      let priceLookups = 0;
      for (const p of productBySku.values()) {
        if (p.price > 0 || priceLookups >= 15 || !creds.sellerId) continue;
        priceLookups++;
        try {
          const lRes = await callJson(
            fetchFn,
            `${base}/listings/2021-08-01/items/${encodeURIComponent(creds.sellerId)}/${encodeURIComponent(p.sku)}?marketplaceIds=${encodeURIComponent(mpId)}&includedData=summaries,offers`,
            { headers: invHeaders }
          );
          if (lRes.ok && lRes.data) {
            const offerPrice = Number(lRes.data.offers?.[0]?.price?.amount ?? lRes.data.summaries?.[0]?.price?.amount ?? 0);
            if (offerPrice > 0) p.price = round2(offerPrice);
          }
        } catch { /* اختياري */ }
      }

      const products = [...productBySku.values()];

      const orders = [];
      for (const o of rawOrders) {
        const externalRef = String(o.AmazonOrderId || '').trim();
        if (!externalRef) continue;
        let itemsText = `طلب أمازون #${externalRef}`;
        let orderItems = [];
        let itemsLineSum = 0;
        let shippingCharge = Number(o.ShippingPrice?.Amount || 0) || 0;
        try {
          const itRes = await callWithRetry(
            () => callJson(fetchFn, `${base}/orders/v0/orders/${encodeURIComponent(externalRef)}/orderItems`, { headers: invHeaders }),
            { ...ctx.retryOpts, maxRetries: 2 }
          );
          if (itRes.ok) {
            const list = itRes.data?.payload?.OrderItems || itRes.data?.OrderItems || [];
            if (list.length) {
              orderItems = list.map((it) => {
                const qty = Math.max(1, Number(it.QuantityOrdered || 1));
                const lineAmt = Number(it.ItemPrice?.Amount || 0);
                const unitPrice = qty > 0 && lineAmt > 0 ? round2(lineAmt / qty) : round2(lineAmt);
                itemsLineSum += lineAmt;
                shippingCharge += Number(it.ShippingPrice?.Amount || 0) || 0;
                return {
                  sku: String(it.SellerSKU || it.ASIN || '').trim(),
                  name: String(it.Title || it.SellerSKU || 'منتج أمازون').trim(),
                  qty,
                  price: unitPrice
                };
              });
              itemsText = orderItems.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(' + ').slice(0, 240);
            }
          }
        } catch (_) {}

        const rawTotal = Number(o.OrderTotal?.Amount || 0);
        const total = rawTotal > 0 ? round2(rawTotal) : (itemsLineSum > 0 ? round2(itemsLineSum) : 0);
        const isFba = String(o.FulfillmentChannel || '').toUpperCase() === 'AFN';
        const courier = isFba
          ? 'أمازون FBA'
          : (o.EasyShipShipmentStatus ? 'أمازون EasyShip' : (String(o.ShipServiceLevel || '').includes('Bosta') ? 'بوسطة' : 'شحن التاجر (MFN)'));
        const status = this.mapOrderStatus(o);

        orders.push({
          externalRef,
          customer: String(o.BuyerInfo?.BuyerName || o.ShippingAddress?.Name || 'عميل أمازون').trim(),
          phone: String(o.ShippingAddress?.Phone || '').trim(),
          gov: String(o.ShippingAddress?.StateOrRegion || o.ShippingAddress?.City || 'القاهرة').trim(),
          address: String(o.ShippingAddress?.AddressLine1 || '').trim(),
          total: Math.max(0, total),
          pay: String(o.PaymentMethod || '').toUpperCase() === 'COD' ? 'عند الاستلام' : 'بطاقة بنكية',
          courier,
          fulfillmentChannel: String(o.FulfillmentChannel || (isFba ? 'AFN' : 'MFN')).toUpperCase(),
          shipFee: isFba ? 0 : round2(shippingCharge),
          status,
          returnReason: status === 3 ? String(o.EasyShipShipmentStatus || o.ReturnStatus || 'مرتجع أمازون') : '',
          items: itemsText,
          orderItems,
          createdAt: o.PurchaseDate || nowIso()
        });
      }

      return { products, orders };
    },

    async pushStock(creds, env, sku, qty, fetchFn, ctx = {}) {
      const token = await this.getAccessToken(creds, fetchFn, ctx);
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.a.sandboxBaseUrl : PLATFORM_SCHEMAS.a.defaultBaseUrl;
      const mpId = creds.marketplaceId || 'ARBP9OOSHTCHU';
      const url = `${base}/listings/2021-08-01/items/${encodeURIComponent(creds.sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${encodeURIComponent(mpId)}`;
      const res = await callWithRetry(() => callJson(fetchFn, url, {
        method: 'PATCH',
        headers: { 'x-amz-access-token': token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          productType: 'PRODUCT',
          patches: [{
            op: 'replace',
            path: '/attributes/fulfillment_availability',
            value: [{ fulfillment_channel_code: 'DEFAULT', quantity: Math.max(0, Math.round(Number(qty) || 0)) }]
          }]
        })
      }), ctx.retryOpts);
      if (!res.ok) throw connectorHttpError('Amazon SP-API', res, 'تحديث مخزون');
      return { ok: true, sku, qty };
    },

    async pushInventory(creds, env, item, fetchFn, ctx = {}) {
      const sku = String(item?.sku || '').trim();
      const quantity = Math.max(0, Math.floor(Number(item?.quantity ?? 0) || 0));
      const token = await this.getAccessToken(creds, fetchFn, ctx);
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.a.sandboxBaseUrl : PLATFORM_SCHEMAS.a.defaultBaseUrl;
      const sellerId = item?.sellerId || creds.sellerId;
      const mpId = item?.marketplaceId || creds.marketplaceId || 'ARBP9OOSHTCHU';
      const url = `${base}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${encodeURIComponent(mpId)}`;
      const res = await callJson(fetchFn, url, {
        method: 'PATCH',
        headers: { 'x-amz-access-token': token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          productType: 'PRODUCT',
          patches: [{
            op: 'replace',
            path: '/attributes/fulfillment_availability',
            value: [{ fulfillment_channel_code: 'DEFAULT', quantity }]
          }]
        })
      });
      if (!res.ok) throw pushInventoryHttpError('Amazon SP-API', res, 'دفع المخزون');
      return { ok: true, sku, quantity };
    },

    async syncFinances(creds, env, sinceIso, fetchFn, ctx = {}) {
      const token = await this.getAccessToken(creds, fetchFn, ctx);
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.a.sandboxBaseUrl : PLATFORM_SCHEMAS.a.defaultBaseUrl;
      const headers = { 'x-amz-access-token': token, accept: 'application/json' };
      const postedAfter = sinceIso || new Date(Date.now() - 30 * 86400_000).toISOString();

      const mergedByOrder = new Map();
      const allServiceFees = [];
      let nextToken = null;
      for (let page = 0; page < 15; page++) {
        const url = nextToken
          ? `${base}/finances/v0/financialEvents?NextToken=${encodeURIComponent(nextToken)}`
          : `${base}/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(postedAfter)}`;
        const res = await callWithRetry(() => callJson(fetchFn, url, { headers }), ctx.retryOpts);
        if (!res.ok) throw connectorHttpError('Amazon SP-API Finances', res, 'سحب التسويات المالية');
        const parsed = parseAmazonFinancialEvents(res.data);
        for (const entry of parsed.orders) {
          const prev = mergedByOrder.get(entry.externalRef);
          if (prev) {
            prev.feeLines.push(...entry.feeLines);
            prev.hasRefund = prev.hasRefund || entry.hasRefund;
          } else {
            mergedByOrder.set(entry.externalRef, entry);
          }
        }
        allServiceFees.push(...parsed.serviceFees);
        nextToken = parsed.nextToken;
        if (!nextToken) break;
      }

      return { orders: [...mergedByOrder.values()], serviceFees: allServiceFees };
    }
  },

  /**
   * 2. Noon Egypt — Noon Partners API
   * Docs: https://docs.noon.partners/
   * Auth: Signed JWT (RS256/HS256) login to /identity/public/v1/api/login -> Session Cookies (Set-Cookie) + User-Agent + X-Project
   */
  n: {
    async getAuthHeaders(creds, fetchFn, ctx = {}, { forceRefresh = false } = {}) {
      const base = assertSafeExternalUrl(creds.baseUrl || PLATFORM_SCHEMAS.n.defaultBaseUrl, 'رابط نون API');
      const cacheKey = `noon:${ctx.userId || 0}:${creds.projectCode || ''}:${creds.keyId || ''}`;
      if (!forceRefresh && ctx.tokenCache) {
        const cached = ctx.tokenCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() + 60_000) {
          return { base, headers: cached.headers };
        }
      }

      const token = buildNoonJwt(creds.keyId, creds.privateKey);
      const loginHeaders = {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'OrderFlow-NoonConnector/1.0',
        'x-project': creds.projectCode,
        'x-project-code': creds.projectCode
      };
      const loginRes = await callWithRetry(() => callJson(fetchFn, `${base}/identity/public/v1/api/login`, {
        method: 'POST',
        headers: loginHeaders,
        body: JSON.stringify({ token, default_project_code: creds.projectCode })
      }), ctx.retryOpts);
      if (!loginRes.ok) {
        throw connectorHttpError('Noon Partners', loginRes, 'مصادقة');
      }

      const cookies = getSetCookies(loginRes.headers);
      const sessionToken = loginRes.data?.token || loginRes.data?.access_token || '';
      const headers = {
        'user-agent': 'OrderFlow-NoonConnector/1.0',
        'x-project': creds.projectCode,
        'x-project-code': creds.projectCode,
        'content-type': 'application/json',
        accept: 'application/json'
      };
      if (cookies.length) {
        headers.cookie = cookies.join('; ');
      }
      if (sessionToken) {
        headers.authorization = `Bearer ${sessionToken}`;
      } else if (!cookies.length) {
        headers.authorization = `Bearer ${token}`;
      }

      if (ctx.tokenCache) {
        ctx.tokenCache.set(cacheKey, { headers, expiresAt: Date.now() + 25 * 60_000 });
      }
      return { base, headers };
    },

    async test(creds, _env, fetchFn, ctx = {}) {
      await this.getAuthHeaders(creds, fetchFn, ctx, { forceRefresh: true });
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب نون (${creds.projectCode}).`,
        meta: { projectCode: creds.projectCode }
      };
    },

    async sync(creds, _env, fetchFn, ctx = {}) {
      let auth = await this.getAuthHeaders(creds, fetchFn, ctx);

      const postAuthed = async (pathStr, payload) => {
        let res = await callWithRetry(
          () => callJson(fetchFn, `${auth.base}${pathStr}`, { method: 'POST', headers: auth.headers, body: JSON.stringify(payload) }),
          ctx.retryOpts
        );
        if (res.status === 401) {
          auth = await this.getAuthHeaders(creds, fetchFn, ctx, { forceRefresh: true });
          res = await callWithRetry(
            () => callJson(fetchFn, `${auth.base}${pathStr}`, { method: 'POST', headers: auth.headers, body: JSON.stringify(payload) }),
            ctx.retryOpts
          );
        }
        return res;
      };

      const rawOrders = [];
      let ordersOk = false;
      let lastOrdersRes = null;
      let orderCursor = null;
      for (let page = 1; page <= 20; page++) {
        const body = { limit: 50, page, country_code: 'eg', ...(orderCursor ? { cursor: orderCursor } : {}) };
        const res = await postAuthed('/fbpi/v1/orders/search', body).catch((e) => ({ ok: false, status: e.status || 502, data: { message: e.message } }));
        lastOrdersRes = res;
        if (!res.ok) break;
        ordersOk = true;
        const batch = res.data?.orders || res.data?.items || res.data?.data || [];
        if (!Array.isArray(batch) || !batch.length) break;
        rawOrders.push(...batch);
        orderCursor = res.data?.next_cursor || res.data?.nextCursor || null;
        const hasMore = Boolean(orderCursor || res.data?.has_more || (res.data?.total_pages && page < Number(res.data.total_pages)));
        if (!hasMore) break;
      }

      const rawProducts = [];
      let stockOk = false;
      let stockCursor = null;
      for (let page = 1; page <= 20; page++) {
        const body = { limit: 50, page, country_code: 'eg', ...(stockCursor ? { cursor: stockCursor } : {}) };
        const res = await postAuthed('/stock/v1/stock-list', body).catch(() => ({ ok: false, data: {} }));
        if (!res.ok) break;
        stockOk = true;
        const batch = res.data?.items || res.data?.data || res.data?.stocks || [];
        if (!Array.isArray(batch) || !batch.length) break;
        rawProducts.push(...batch);
        stockCursor = res.data?.next_cursor || res.data?.nextCursor || null;
        const hasMore = Boolean(stockCursor || res.data?.has_more || (res.data?.total_pages && page < Number(res.data.total_pages)));
        if (!hasMore) break;
      }

      if (!ordersOk && !stockOk) {
        throw connectorHttpError('Noon Partners', lastOrdersRes || { status: 400 }, 'سحب بيانات');
      }

      const products = rawProducts.map((p) => ({
        sku: String(p.partner_sku || p.sku || '').trim(),
        name: String(p.title || p.name || p.partner_sku || 'منتج نون').trim(),
        price: Number(p.sale_price ?? p.offer_price ?? p.price ?? 0) || 0,
        cost: Number(p.cost || 0) || 0,
        stock: Math.max(0, Number(p.quantity ?? p.stock_net ?? p.stock_gross ?? p.stock ?? 0) || 0),
        cat: String(p.category || 'نون مصر')
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => {
        const rawItems = Array.isArray(o.items) ? o.items : (Array.isArray(o.order_items) ? o.order_items : []);
        const orderItems = rawItems.map((it) => ({
          sku: String(it.partner_sku || it.sku || '').trim(),
          name: String(it.title || it.name || it.partner_sku || 'منتج نون').trim(),
          qty: Math.max(1, Number(it.quantity ?? it.qty ?? 1)),
          price: Number(it.unit_price ?? it.price ?? 0) || 0
        }));
        const status = normalizeMarketplaceStatus(o.status || o.order_status);
        const itemsText = orderItems.length
          ? orderItems.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(' + ').slice(0, 240)
          : `طلب نون #${o.fbpi_order_nr || o.order_nr || o.id || ''}`;
        const itemsSum = orderItems.reduce((s, it) => s + it.price * it.qty, 0);
        const total = Number(o.total_amount ?? o.total ?? o.price ?? 0) || itemsSum;
        return {
          externalRef: String(o.fbpi_order_nr || o.order_nr || o.id || '').trim(),
          customer: String(o.customer_name || o.customer?.name || 'عميل نون').trim(),
          phone: String(o.customer_phone || o.customer?.phone || o.phone || '').trim(),
          gov: String(o.city || o.governorate || 'القاهرة').trim(),
          address: String(o.address || o.shipping_address || '').trim(),
          total: round2(Math.max(0, total)),
          pay: /cod|cash/i.test(String(o.payment_method || '')) ? 'عند الاستلام' : 'بطاقة بنكية',
          courier: String(o.courier || (String(o.fulfillment_type || '').toUpperCase() === 'FBN' ? 'نون Express' : 'نون FBPI')),
          fulfillmentChannel: /fbn|express/i.test(String(o.fulfillment_type || o.fulfillment_channel || '')) ? 'FBN' : 'FBP',
          shipFee: round2(Number(o.shipping_fee ?? o.ship_fee ?? 0) || 0),
          awbNumber: String(o.awb_number || o.tracking_number || '').trim(),
          status,
          returnReason: status === 3 ? String(o.return_reason || 'مرتجع نون') : '',
          items: itemsText,
          orderItems,
          createdAt: o.created_at || o.order_date || nowIso()
        };
      }).filter((o) => o.externalRef);

      return { products, orders };
    },

    async pushStock(creds, _env, sku, qty, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, fetchFn, ctx);
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/stock/v1/stock-update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: [{ partner_sku: sku, quantity: Math.max(0, Math.round(Number(qty) || 0)) }] })
      }), ctx.retryOpts);
      if (!res.ok) throw connectorHttpError('Noon Partners', res, 'تحديث مخزون');
      return { ok: true, sku, qty };
    },

    async pushInventory(creds, _env, item, fetchFn, ctx = {}) {
      const sku = String(item?.sku || '').trim();
      const quantity = Math.max(0, Math.floor(Number(item?.quantity ?? 0) || 0));
      const { base, headers } = await this.getAuthHeaders(creds, fetchFn, ctx);
      const res = await callJson(fetchFn, `${base}/partner/v1/inventory`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ partner_sku: sku, quantity })
      });
      if (!res.ok) throw pushInventoryHttpError('Noon Partners', res, 'دفع المخزون');
      return { ok: true, sku, quantity };
    }
  },

  /**
   * 3. Jumia Egypt — Jumia Vendor Center API (GPM + GOP)
   * Docs: https://vendorcenter.jumia.com/api-docs/
   * Auth: OAuth2 Self-Authorization Refresh Token (/token) -> rotates refresh_token on EVERY call!
   * Catalog: /catalog/products (paginated + variations[]) + /catalog/stock
   * Orders: /orders (paginated) + /orders/items?orderId=...
   */
  j: {
    async getAuthHeaders(creds, env, fetchFn, ctx = {}) {
      const base = assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS.j.sandboxBaseUrl : PLATFORM_SCHEMAS.j.defaultBaseUrl),
        'رابط جوميا API'
      );
      const cacheKey = `jumia:${ctx.userId || 0}:${creds.clientId || ''}:${env}`;
      const cached = ctx.tokenCache && ctx.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() + 60_000) {
        const headers = { authorization: `Bearer ${cached.token}`, accept: 'application/json' };
        if (creds.shopId) headers['x-shop-id'] = creds.shopId;
        return { base, headers };
      }

      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.clientId,
        refresh_token: creds.apiKey
      });
      const tokRes = await callWithRetry(() => callJson(fetchFn, `${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString()
      }), ctx.retryOpts);

      if (!tokRes.ok || !tokRes.data?.access_token) {
        throw connectorHttpError('Jumia Vendor Center OAuth', tokRes, 'مصادقة');
      }

      // تدوير وحفظ الـ Refresh Token الجديد فورًا (إلزامي في Jumia Self-Authorization)
      const rotatedRefresh = String(tokRes.data.refresh_token || '').trim();
      if (rotatedRefresh && rotatedRefresh !== creds.apiKey) {
        creds.apiKey = rotatedRefresh;
        if (typeof ctx.onCredentialsUpdated === 'function') {
          ctx.onCredentialsUpdated({ ...creds, apiKey: rotatedRefresh });
        }
      }

      const accessToken = tokRes.data.access_token;
      const ttlSec = Math.max(120, Number(tokRes.data.expires_in) || 1800);
      if (ctx.tokenCache) {
        ctx.tokenCache.set(cacheKey, { token: accessToken, expiresAt: Date.now() + ttlSec * 1000 });
      }
      const headers = {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json'
      };
      if (creds.shopId) headers['x-shop-id'] = creds.shopId;
      return { base, headers };
    },

    async test(creds, env, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, env, fetchFn, ctx);
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/shops`, { headers }), ctx.retryOpts);
      if (!res.ok) {
        throw connectorHttpError('Jumia Vendor Center', res, 'التحقق من حساب');
      }
      const shops = Array.isArray(res.data?.shops) ? res.data.shops : (Array.isArray(res.data) ? res.data : []);
      const discoveredShopId = !creds.shopId && shops[0]?.id ? String(shops[0].id) : creds.shopId;
      if (!creds.shopId && discoveredShopId && typeof ctx.onCredentialsUpdated === 'function') {
        creds.shopId = discoveredShopId;
        ctx.onCredentialsUpdated({ ...creds, shopId: discoveredShopId });
      }
      return {
        ok: true,
        message: `تم الاتصال بنجاح بحساب جوميا${discoveredShopId ? ` (${discoveredShopId})` : ''}${shops.length ? ` — ${shops.length} متجر` : ''}.`,
        meta: { shopId: discoveredShopId || '', shops: shops.length }
      };
    },

    async sync(creds, env, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, env, fetchFn, ctx);
      const shopParam = creds.shopId ? `&shopId=${encodeURIComponent(creds.shopId)}` : '';

      // 1) سحب الطلبات مع Pagination (nextToken)
      const rawOrders = [];
      let nextOrderToken = null;
      let firstOrdersOk = false;
      let lastOrdersRes = null;
      for (let page = 0; page < 20; page++) {
        const url = nextOrderToken
          ? `${base}/orders?size=50${shopParam}&token=${encodeURIComponent(nextOrderToken)}`
          : `${base}/orders?size=50${shopParam}`;
        const ordersRes = await callWithRetry(() => callJson(fetchFn, url, { headers }), ctx.retryOpts);
        lastOrdersRes = ordersRes;
        if (!ordersRes.ok) break;
        firstOrdersOk = true;
        const batch = ordersRes.data?.orders || ordersRes.data?.items || [];
        if (Array.isArray(batch)) rawOrders.push(...batch);
        nextOrderToken = ordersRes.data?.nextToken || null;
        if (!nextOrderToken) break;
      }

      // 2) سحب المنتجات مع Pagination (nextToken) ودعم variations[]
      const rawProducts = [];
      let nextProdToken = null;
      let prodOk = false;
      let lastProdRes = null;
      for (let page = 0; page < 20; page++) {
        const url = nextProdToken
          ? `${base}/catalog/products?size=50${shopParam}&token=${encodeURIComponent(nextProdToken)}`
          : `${base}/catalog/products?size=50${shopParam}`;
        const prodRes = await callWithRetry(() => callJson(fetchFn, url, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
        lastProdRes = prodRes;
        if (!prodRes.ok) break;
        prodOk = true;
        const batch = prodRes.data?.products || prodRes.data?.items || [];
        if (Array.isArray(batch)) rawProducts.push(...batch);
        nextProdToken = prodRes.data?.nextToken || null;
        if (!nextProdToken) break;
      }

      if (!firstOrdersOk && !prodOk) {
        throw connectorHttpError('Jumia Vendor Center', lastOrdersRes || lastProdRes || { status: 400 }, 'سحب بيانات');
      }

      // 3) سحب المخزون المحدّث من /catalog/stock (اختياري/مدمج)
      const stockBySku = new Map();
      let nextStockToken = null;
      for (let page = 0; page < 20; page++) {
        const url = nextStockToken
          ? `${base}/catalog/stock?size=50${shopParam}&token=${encodeURIComponent(nextStockToken)}`
          : `${base}/catalog/stock?size=50${shopParam}`;
        const stRes = await callWithRetry(() => callJson(fetchFn, url, { headers }), { ...ctx.retryOpts, maxRetries: 1 }).catch(() => ({ ok: false, data: {} }));
        if (!stRes.ok) break;
        const list = stRes.data?.products || stRes.data?.stocks || stRes.data?.items || [];
        for (const s of list) {
          const sku = String(s.sellerSku || s.sku || '').trim();
          const rawTotal = Number(s.totalStock ?? s.stock ?? s.quantity);
          const reserved = Number(s.reservedStock ?? 0) || 0;
          const qty = s.availableStock !== undefined ? Number(s.availableStock) : (Number.isFinite(rawTotal) ? rawTotal - reserved : NaN);
          if (sku && Number.isFinite(qty)) stockBySku.set(sku, Math.max(0, Math.round(qty)));
        }
        nextStockToken = stRes.data?.nextToken || null;
        if (!nextStockToken) break;
      }

      const productMap = new Map();
      for (const p of rawProducts) {
        const baseName = typeof p.name === 'object' ? (p.name?.value || '') : (p.name || p.title || '');
        const cat = String(p.category?.name || p.category || 'جوميا مصر').trim();
        if (Array.isArray(p.variations) && p.variations.length) {
          for (const v of p.variations) {
            const sku = String(v.sellerSku || v.sku || v.id || '').trim();
            if (!sku) continue;
            const rawPrice = v.globalPrice?.salePrice ?? v.globalPrice?.value ?? v.price?.value ?? v.globalPrice ?? v.price ?? p.price?.value ?? p.price ?? 0;
            const stock = stockBySku.has(sku) ? stockBySku.get(sku) : Math.max(0, Number(v.stock ?? v.quantity ?? p.stock ?? 0) || 0);
            const varLabel = v.variation ? ` (${v.variation})` : '';
            productMap.set(sku, {
              sku,
              name: String(`${baseName || sku}${varLabel}`).trim(),
              price: Number(rawPrice) || 0,
              stock,
              cat
            });
          }
        } else {
          const sku = String(p.sellerSku || p.sku || p.id || '').trim();
          if (!sku) continue;
          const rawPrice = p.price?.value ?? p.globalPrice?.value ?? p.price ?? 0;
          const stock = stockBySku.has(sku) ? stockBySku.get(sku) : Math.max(0, Number(p.stock ?? p.quantity ?? 0) || 0);
          productMap.set(sku, {
            sku,
            name: String(baseName || sku || 'منتج جوميا').trim(),
            price: Number(rawPrice) || 0,
            stock,
            cat
          });
        }
      }
      const products = [...productMap.values()];

      // 4) سحب تفاصيل عناصر الطلبات من /orders/items
      const itemsByOrderId = new Map();
      const orderIds = rawOrders.map((o) => String(o.id || '').trim()).filter(Boolean);
      for (let i = 0; i < orderIds.length; i += 20) {
        const chunk = orderIds.slice(i, i + 20);
        const qs = chunk.map((id) => `orderId=${encodeURIComponent(id)}`).join('&');
        try {
          const itRes = await callWithRetry(() => callJson(fetchFn, `${base}/orders/items?${qs}`, { headers }), { ...ctx.retryOpts, maxRetries: 1 });
          if (itRes.ok && itRes.data) {
            const entries = Array.isArray(itRes.data)
              ? itRes.data
              : (Array.isArray(itRes.data.orders) ? itRes.data.orders : (Array.isArray(itRes.data.items) ? [{ orderId: chunk[0], items: itRes.data.items }] : []));
            for (const entry of entries) {
              const oid = String(entry.orderId || entry.id || '');
              const list = Array.isArray(entry.items) ? entry.items : [];
              if (oid && list.length) itemsByOrderId.set(oid, list);
            }
          }
        } catch { /* اختياري */ }
      }

      const orders = rawOrders.map((o) => {
        const oid = String(o.id || '').trim();
        const externalRef = String(o.number || oid || '').trim();
        const rawIts = itemsByOrderId.get(oid) || (Array.isArray(o.items) ? o.items : []);
        const orderItems = rawIts.map((it) => ({
          sku: String(it.sellerSku || it.product?.sellerSku || it.sku || '').trim(),
          name: String(it.product?.name || it.name || it.sellerSku || 'منتج جوميا').trim(),
          qty: Math.max(1, Number(it.quantity ?? it.qty ?? 1)),
          price: Number(it.paidPriceLocal ?? it.itemPriceLocal ?? it.price?.value ?? it.price ?? 0) || 0
        }));
        const itemsText = orderItems.length
          ? orderItems.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(' + ').slice(0, 240)
          : `طلب جوميا #${externalRef}`;
        const itemsSum = orderItems.reduce((s, it) => s + it.price * it.qty, 0);
        const total = Number(o.totalAmountLocalValue ?? o.totalAmountLocal ?? o.total ?? 0) || itemsSum;
        const status = normalizeMarketplaceStatus(o.status);
        return {
          externalRef,
          customer: String(o.shippingAddress?.firstName ? `${o.shippingAddress.firstName} ${o.shippingAddress.lastName || ''}`.trim() : (o.customerName || 'عميل جوميا')).trim(),
          phone: String(o.shippingAddress?.phone || o.phone || '').trim(),
          gov: String(o.shippingAddress?.city || o.city || 'القاهرة').trim(),
          address: String(o.shippingAddress?.address || o.shippingAddress?.address1 || '').trim(),
          total: round2(Math.max(0, total)),
          pay: /cod|cash/i.test(String(o.paymentMethod || '')) ? 'عند الاستلام' : 'بطاقة بنكية',
          courier: String(o.shipmentProvider || o.shippingProvider || 'جوميا Express'),
          shipFee: round2(Number(o.shippingAmountLocal ?? o.shippingFee ?? 0) || 0),
          awbNumber: String(o.trackingNumber || rawIts[0]?.trackingNumber || '').trim(),
          status,
          returnReason: status === 3 ? String(o.returnReason || 'مرتجع جوميا') : '',
          items: itemsText,
          orderItems,
          createdAt: o.createdAt || nowIso()
        };
      }).filter((o) => o.externalRef);

      return { products, orders };
    },

    async pushStock(creds, env, sku, qty, fetchFn, ctx = {}) {
      const { base, headers } = await this.getAuthHeaders(creds, env, fetchFn, ctx);
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/catalog/stock`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ products: [{ sellerSku: sku, stock: Math.max(0, Math.round(Number(qty) || 0)) }] })
      }), ctx.retryOpts);
      if (!res.ok) throw connectorHttpError('Jumia Vendor Center', res, 'تحديث مخزون');
      return { ok: true, sku, qty };
    },

    async pushInventory(creds, env, item, fetchFn, ctx = {}) {
      const sku = String(item?.sku || '').trim();
      const quantity = Math.max(0, Math.floor(Number(item?.quantity ?? 0) || 0));
      const { base, headers } = await this.getAuthHeaders(creds, env, fetchFn, ctx);
      const res = await callJson(fetchFn, `${base}/feeds/products/stock`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ sellerSku: sku, quantity })
      });
      if (!res.ok) throw pushInventoryHttpError('Jumia Vendor Center', res, 'دفع المخزون');
      return { ok: true, sku, quantity };
    }
  },

  /**
   * 4. Trendyol — Official Supplier API (Order V2 + Claims + Products)
   * Docs: https://developers.trendyol.com/en
   * Auth: HTTP Basic Auth (base64(apiKey:apiSecret)) + User-Agent: "<supplierId> - SelfIntegration" + storeFrontCode
   */
  t: {
    headers(creds) {
      const basic = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
      const h = {
        authorization: `Basic ${basic}`,
        'user-agent': `${creds.supplierId} - SelfIntegration`,
        accept: 'application/json'
      };
      if (creds.storeFrontCode) h.storeFrontCode = String(creds.storeFrontCode).trim().toUpperCase();
      return h;
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

      // 1) سحب المنتجات (مع Pagination)
      const rawProducts = [];
      let prodOk = false;
      let lastProdRes = null;
      for (let page = 0; page < 20; page++) {
        const res = await callWithRetry(() => callJson(fetchFn, `${base}/integration/product/sellers/${sid}/products?size=50&page=${page}`, { headers }), ctx.retryOpts);
        lastProdRes = res;
        if (!res.ok) break;
        prodOk = true;
        rawProducts.push(...(res.data?.content || []));
        const totalPages = Number(res.data?.totalPages || 1);
        if (page + 1 >= totalPages) break;
      }

      // 2) سحب الطلبات عبر Order V2 (شرائح 14 يومًا كحد أقصى حسب مواصفات Trendyol V2) مع fallback لـ V1
      const nowMs = Date.now();
      const windowStartMs = ctx.lastSyncAt && Number.isFinite(Date.parse(ctx.lastSyncAt))
        ? Math.max(nowMs - 30 * 86400_000, Date.parse(ctx.lastSyncAt) - 5 * 60_000)
        : nowMs - 28 * 86400_000;
      const SLICE_MS = 14 * 86400_000;

      const rawOrders = [];
      let ordersOk = false;
      let useV1Fallback = false;

      for (let sStart = windowStartMs; sStart < nowMs && !useV1Fallback; sStart += SLICE_MS) {
        const sEnd = Math.min(nowMs, sStart + SLICE_MS);
        for (let page = 0; page < 20; page++) {
          const v2Url = `${base}/integration/order/sellers/${sid}/v2/orders?startDate=${sStart}&endDate=${sEnd}&size=200&page=${page}`;
          const res = await callWithRetry(() => callJson(fetchFn, v2Url, { headers }), ctx.retryOpts).catch(() => ({ ok: false, status: 502, data: {} }));
          if (!res.ok) {
            if (page === 0 && !ordersOk && (res.status === 404 || res.status === 405)) {
              useV1Fallback = true;
            }
            break;
          }
          ordersOk = true;
          rawOrders.push(...(res.data?.content || []));
          const totalPages = Number(res.data?.totalPages || 1);
          if (page + 1 >= totalPages) break;
        }
      }

      if (useV1Fallback) {
        for (let page = 0; page < 10; page++) {
          const v1Url = `${base}/integration/order/sellers/${sid}/orders?size=50&page=${page}`;
          const res = await callWithRetry(() => callJson(fetchFn, v1Url, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
          if (!res.ok) break;
          ordersOk = true;
          rawOrders.push(...(res.data?.content || []));
          const totalPages = Number(res.data?.totalPages || 1);
          if (page + 1 >= totalPages) break;
        }
      }

      if (!prodOk && !ordersOk) {
        throw connectorHttpError('Trendyol', lastProdRes || { status: 400 }, 'سحب بيانات');
      }

      // 3) سحب المرتجعات (/claims) لربطها مباشرة بالطلبات المرتجعة
      const returnedByOrderNo = new Map();
      try {
        const claimsUrl = `${base}/integration/order/sellers/${sid}/claims?startDate=${windowStartMs}&endDate=${nowMs}&size=100`;
        const claimsRes = await callWithRetry(() => callJson(fetchFn, claimsUrl, { headers }), { ...ctx.retryOpts, maxRetries: 1 });
        if (claimsRes.ok && Array.isArray(claimsRes.data?.content)) {
          for (const cl of claimsRes.data.content) {
            const ordNo = String(cl.orderNumber || '').trim();
            const reason = String(cl.claimItemReason?.name || cl.customerClaimItemReason?.name || cl.reason || 'مرتجع ترينديول').trim();
            if (ordNo) returnedByOrderNo.set(ordNo, reason);
          }
        }
      } catch { /* اختياري */ }

      const products = rawProducts.map((p) => ({
        sku: String(p.stockCode || p.barcode || p.productCode || '').trim(),
        name: String(p.title || p.stockCode || 'منتج ترينديول').trim(),
        price: Number(p.salePrice ?? p.listPrice ?? 0) || 0,
        stock: Math.max(0, Number(p.quantity ?? 0) || 0),
        cat: String(p.categoryName || 'ترينديول').trim()
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => {
        const orderNo = String(o.orderNumber || o.shipmentPackageId || o.id || '').trim();
        const rawLines = Array.isArray(o.lines) ? o.lines : [];
        const orderItems = rawLines.map((l) => ({
          sku: String(l.merchantSku || l.stockCode || l.barcode || '').trim(),
          name: String(l.productName || l.merchantSku || 'منتج ترينديول').trim(),
          qty: Math.max(1, Number(l.quantity || 1)),
          price: Number(l.lineUnitPrice ?? l.price ?? l.amount ?? 0) || 0
        }));
        const itemsText = orderItems.length
          ? orderItems.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(' + ').slice(0, 240)
          : `طلب ترينديول #${orderNo}`;
        const linesSum = rawLines.reduce((s, l) => s + Number(l.lineGrossAmount ?? (Number(l.lineUnitPrice ?? l.price ?? 0) * Math.max(1, Number(l.quantity || 1)))), 0);
        const total = Number(o.totalPrice ?? o.grossAmount ?? o.packageTotalPrice ?? 0) || linesSum;
        const claimReason = returnedByOrderNo.get(orderNo) || '';
        const rawStatus = o.shipmentPackageStatus || o.status || '';
        const status = claimReason ? 3 : normalizeMarketplaceStatus(rawStatus);
        return {
          externalRef: orderNo,
          customer: String(`${o.customerFirstName || ''} ${o.customerLastName || ''}`.trim() || o.shipmentAddress?.fullName || 'عميل ترينديول'),
          phone: String(o.shipmentAddress?.phone || '').trim(),
          gov: String(o.shipmentAddress?.city || 'القاهرة').trim(),
          address: String(o.shipmentAddress?.fullAddress || o.shipmentAddress?.address1 || '').trim(),
          total: round2(Math.max(0, total)),
          pay: /cod|cash/i.test(String(o.paymentMethod || '')) ? 'عند الاستلام' : 'بطاقة بنكية',
          courier: String(o.cargoProviderName || 'ترينديول شحن'),
          shipFee: round2(Number(o.cargoShippingCost || 0) || 0),
          awbNumber: String(o.cargoTrackingNumber || '').trim(),
          trackingUrl: String(o.cargoTrackingLink || '').trim(),
          status,
          returnReason: claimReason || (status === 3 ? 'مرتجع ترينديول' : ''),
          items: itemsText,
          orderItems,
          createdAt: o.orderDate ? new Date(o.orderDate).toISOString() : nowIso()
        };
      }).filter((o) => o.externalRef);

      return { products, orders };
    },

    async pushStock(creds, env, sku, qty, fetchFn, ctx = {}) {
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.t.sandboxBaseUrl : PLATFORM_SCHEMAS.t.defaultBaseUrl;
      const sid = encodeURIComponent(creds.supplierId);
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/integration/inventory/sellers/${sid}/products/price-and-inventory`, {
        method: 'POST',
        headers: { ...this.headers(creds), 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ barcode: sku, quantity: Math.max(0, Math.round(Number(qty) || 0)) }] })
      }), ctx.retryOpts);
      if (!res.ok) throw connectorHttpError('Trendyol', res, 'تحديث مخزون');
      return { ok: true, sku, qty };
    },

    async pushInventory(creds, env, item, fetchFn) {
      const sku = String(item?.sku || '').trim();
      const quantity = Math.max(0, Math.floor(Number(item?.quantity ?? 0) || 0));
      const base = env === 'sandbox' ? PLATFORM_SCHEMAS.t.sandboxBaseUrl : PLATFORM_SCHEMAS.t.defaultBaseUrl;
      const sid = encodeURIComponent(creds.supplierId);
      const res = await callJson(fetchFn, `${base}/integration/inventory/sellers/${sid}/products/price-and-inventory`, {
        method: 'POST',
        headers: { ...this.headers(creds), 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ barcode: sku, quantity }] })
      });
      if (!res.ok) throw pushInventoryHttpError('Trendyol', res, 'دفع المخزون');
      return { ok: true, sku, quantity };
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

      const rawProducts = [];
      let prodOk = false;
      let lastProdRes = null;
      let prodCursor = null;
      for (let page = 1; page <= 20; page++) {
        const url = prodCursor
          ? `${base}/products?limit=50&cursor=${encodeURIComponent(prodCursor)}`
          : (page === 1 ? `${base}/products?limit=50` : `${base}/products?limit=50&page=${page}`);
        const res = await callWithRetry(() => callJson(fetchFn, url, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
        lastProdRes = res;
        if (!res.ok) break;
        prodOk = true;
        const batch = res.data?.products || res.data?.data || res.data?.items || [];
        if (!Array.isArray(batch) || !batch.length) break;
        rawProducts.push(...batch);
        prodCursor = res.data?.nextCursor || res.data?.next_cursor || res.data?.nextToken || null;
        const hasMore = Boolean(prodCursor || res.data?.hasMore || res.data?.has_more || (res.data?.totalPages && page < Number(res.data.totalPages)));
        if (!hasMore) break;
      }

      const rawOrders = [];
      let ordersOk = false;
      let ordCursor = null;
      for (let page = 1; page <= 20; page++) {
        const url = ordCursor
          ? `${base}/orders?limit=50&cursor=${encodeURIComponent(ordCursor)}`
          : (page === 1 ? `${base}/orders?limit=50` : `${base}/orders?limit=50&page=${page}`);
        const res = await callWithRetry(() => callJson(fetchFn, url, { headers }), ctx.retryOpts).catch(() => ({ ok: false, data: {} }));
        if (!res.ok) break;
        ordersOk = true;
        const batch = res.data?.orders || res.data?.data || res.data?.items || [];
        if (!Array.isArray(batch) || !batch.length) break;
        rawOrders.push(...batch);
        ordCursor = res.data?.nextCursor || res.data?.next_cursor || res.data?.nextToken || null;
        const hasMore = Boolean(ordCursor || res.data?.hasMore || res.data?.has_more || (res.data?.totalPages && page < Number(res.data.totalPages)));
        if (!hasMore) break;
      }

      if (!prodOk && !ordersOk) {
        throw connectorHttpError('Kenzz', lastProdRes || { status: 400 }, 'سحب بيانات');
      }

      const products = rawProducts.map((p) => ({
        sku: String(p.sku || p.id || '').trim(),
        name: String(p.name || p.title || 'منتج كنز').trim(),
        price: Number(p.price || 0) || 0,
        cost: Number(p.cost || 0) || 0,
        stock: Math.max(0, Number(p.stock ?? p.quantity ?? 0) || 0),
        cat: String(p.category || 'كنز مصر').trim()
      })).filter((p) => p.sku);

      const orders = rawOrders.map((o) => {
        const rawIts = Array.isArray(o.items) ? o.items : (Array.isArray(o.order_items) ? o.order_items : []);
        const orderItems = rawIts.map((it) => ({
          sku: String(it.sku || '').trim(),
          name: String(it.name || it.title || it.sku || 'منتج كنز').trim(),
          qty: Math.max(1, Number(it.qty ?? it.quantity ?? 1)),
          price: Number(it.price || 0) || 0
        }));
        const itemsText = orderItems.length
          ? orderItems.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(' + ').slice(0, 240)
          : `طلب كنز #${o.order_id || o.id || ''}`;
        const itemsSum = orderItems.reduce((s, it) => s + it.price * it.qty, 0);
        const total = Number(o.total ?? o.amount ?? 0) || itemsSum;
        const status = normalizeMarketplaceStatus(o.status);
        return {
          externalRef: String(o.order_id || o.id || '').trim(),
          customer: String(o.customerName || o.customer_name || o.customer?.name || 'عميل كنز').trim(),
          phone: String(o.customerPhone || o.customer_phone || o.phone || '').trim(),
          gov: String(o.governorate || o.city || 'القاهرة').trim(),
          address: String(o.address || '').trim(),
          total: round2(Math.max(0, total)),
          pay: /cod|cash|استلام/i.test(String(o.paymentMethod || o.payment_method || '')) ? 'عند الاستلام' : 'إنستاباي',
          courier: String(o.courier || 'كنز شحن'),
          shipFee: round2(Number(o.shipping_fee ?? o.shipFee ?? 0) || 0),
          awbNumber: String(o.awbNumber || o.awb_number || o.trackingNumber || '').trim(),
          status,
          returnReason: status === 3 ? String(o.returnReason || o.return_reason || 'مرتجع كنز') : '',
          items: itemsText,
          orderItems,
          createdAt: o.createdAt || o.created_at || nowIso()
        };
      }).filter((o) => o.externalRef);

      return { products, orders };
    },

    async pushStock(creds, env, sku, qty, fetchFn, ctx = {}) {
      const base = assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS.k.sandboxBaseUrl : PLATFORM_SCHEMAS.k.defaultBaseUrl),
        'رابط كنز API'
      );
      const res = await callWithRetry(() => callJson(fetchFn, `${base}/products/${encodeURIComponent(sku)}/stock`, {
        method: 'PATCH',
        headers: { ...this.headers(creds), 'content-type': 'application/json' },
        body: JSON.stringify({ sku, stock: Math.max(0, Math.round(Number(qty) || 0)) })
      }), ctx.retryOpts);
      if (!res.ok) throw connectorHttpError('Kenzz', res, 'تحديث مخزون');
      return { ok: true, sku, qty };
    },

    async pushInventory(creds, env, item, fetchFn) {
      const sku = String(item?.sku || '').trim();
      const quantity = Math.max(0, Math.floor(Number(item?.quantity ?? 0) || 0));
      const base = assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? PLATFORM_SCHEMAS.k.sandboxBaseUrl : PLATFORM_SCHEMAS.k.defaultBaseUrl),
        'رابط كنز API'
      );
      const res = await callJson(fetchFn, `${base}/products/${encodeURIComponent(sku)}/inventory`, {
        method: 'PUT',
        headers: { ...this.headers(creds), 'content-type': 'application/json' },
        body: JSON.stringify({ sku, stock: quantity })
      });
      if (!res.ok) throw pushInventoryHttpError('Kenzz', res, 'دفع المخزون');
      return { ok: true, sku, quantity };
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
  let inventoryQueueRunning = false;
  let closed = false;

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

  /** حفظ تحديث تلقائي لمفاتيح الاتصال (مثل تدوير Jumia Refresh Token أو اكتشاف Shop ID) مشفّرًا بـ AES-256-GCM */
  function persistUpdatedCreds(userId, platform, nextCreds) {
    try {
      const enc = cipher.encrypt(JSON.stringify(nextCreds));
      q('UPDATE marketplace_connections SET creds_enc = ?, updated_at = ? WHERE user_id = ? AND platform = ?')
        .run(enc, nowIso(), userId, platform);
    } catch (_) { /* لا نوقف المزامنة عند خطأ حفظ عارض */ }
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

    // مسح أي توكن مخزن مؤقتًا لهذا المستخدم والمنصة بعد تحديث المفاتيح
    for (const k of tokenCache.keys()) {
      if (k.includes(`:${userId}:`)) tokenCache.delete(k);
    }

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
    for (const k of tokenCache.keys()) {
      if (k.includes(`:${userId}:`)) tokenCache.delete(k);
    }
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
      const res = await adapter.test(creds, row.environment || 'production', guardedFetch, {
        userId,
        tokenCache,
        retryOpts,
        onCredentialsUpdated: (nextCreds) => persistUpdatedCreds(userId, platform, nextCreds)
      });
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
   * سحب المنتجات والطلبات الحقيقية من المنصة وبناء كامل بيانات الموقع منها بدون تكرار (Idempotent)
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
    const defaultCourier = DEFAULT_PLATFORM_COURIER[platform] || 'بوسطة';
    const runId = Number(q('INSERT INTO connector_sync_runs (user_id, platform, started_at) VALUES (?, ?, ?)').run(userId, platform, startedAt).lastInsertRowid);

    try {
      const pulled = await adapter.sync(creds, row.environment || 'production', guardedFetch, {
        userId,
        lastSyncAt: row.last_sync_at || null,
        amazonPiiEnabled: Boolean(cfg.amazonPiiEnabled),
        tokenCache,
        retryOpts,
        onCredentialsUpdated: (nextCreds) => persistUpdatedCreds(userId, platform, nextCreds)
      });
      authFailCounts.delete(lockKey);
      const now = nowIso();
      const summary = tx(() => {
        let importedProducts = 0;
        let updatedProducts = 0;
        let importedOrders = 0;
        let updatedOrders = 0;
        let skippedOrders = 0;

        // 1) تحديث/إضافة المنتجات أولًا مع الحفاظ الكامل على تكلفة الشراء اليدوية التي أدخلها التاجر
        const syncedProductIds = new Set();
        const stockAffectedProductIds = new Set();
        for (const p of pulled.products || []) {
          const sku = String(p.sku || '').slice(0, 40);
          if (!sku) continue;
          const incomingPrice = Number(p.price) > 0 ? round2(Number(p.price)) : 0;
          const incomingCost = Number(p.cost) > 0 ? round2(Number(p.cost)) : 0;
          const incomingStock = Math.max(0, Math.round(Number(p.stock) || 0));
          const linkMatch = q('SELECT product_id FROM product_channel_links WHERE user_id = ? AND platform = ? AND LOWER(channel_sku) = LOWER(?)').get(userId, platform, sku);
          const existing = (linkMatch && q('SELECT id, price, cost, cost_is_estimated, markets, stock FROM products WHERE id = ? AND user_id = ?').get(linkMatch.product_id, userId))
            || q('SELECT id, price, cost, cost_is_estimated, markets, stock FROM products WHERE user_id = ? AND sku = ?').get(userId, sku);
          let prodId;
          if (existing) {
            const mSet = new Set(String(existing.markets || '').split('').filter(Boolean));
            mSet.add(platform);
            const nextPrice = incomingPrice > 0 ? incomingPrice : Number(existing.price || 0);
            // لا نستبدل أبدًا تكلفة الشراء الحقيقية التي أدخلها التاجر؛ نحدّثها فقط إن كانت 0 ووصلت تكلفة من الـ API
            const nextCost = Number(existing.cost || 0) > 0 ? Number(existing.cost) : incomingCost;
            const nextCostEst = nextCost > 0 ? 0 : Number(existing.cost_is_estimated || 1);
            q('UPDATE products SET name = ?, price = ?, cost = ?, cost_is_estimated = ?, stock = ?, markets = ?, updated_at = ? WHERE id = ?')
              .run(String(p.name || sku).slice(0, 120), nextPrice, nextCost, nextCostEst, incomingStock, [...mSet].join(''), now, existing.id);
            prodId = Number(existing.id);
            syncedProductIds.add(prodId);
            updatedProducts++;
          } else {
            const costIsEst = incomingCost > 0 ? 0 : 1;
            const insProd = q(`INSERT INTO products (user_id, name, sku, cat, markets, price, cost, cost_is_estimated, stock, approval_status, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`)
              .run(userId, String(p.name || sku).slice(0, 120), sku, String(p.cat || 'عام').slice(0, 40), platform, incomingPrice, incomingCost, costIsEst, incomingStock, sourceName, now, now);
            prodId = Number(insProd.lastInsertRowid);
            syncedProductIds.add(prodId);
            importedProducts++;
          }
          q(`INSERT INTO product_channel_links (user_id, product_id, platform, channel_sku, external_id, sync_status, updated_at)
             VALUES (?, ?, ?, ?, ?, 'idle', ?)
             ON CONFLICT(user_id, product_id, platform) DO UPDATE SET
               channel_sku = COALESCE(NULLIF(product_channel_links.channel_sku, ''), excluded.channel_sku),
               updated_at = excluded.updated_at`)
            .run(userId, prodId, platform, sku, String(p.externalId || ''), now);
        }

        // خريطة المنتجات بالـ SKU وبروابط القنوات المخصصة (product_channel_links) لربط order_items الحقيقية
        const prodRows = q('SELECT id, sku, name, cost, packaging_cost, stock, safety_stock, auto_push_stock, markets FROM products WHERE user_id = ?').all(userId);
        const prodById = new Map(prodRows.map((pr) => [Number(pr.id), pr]));
        const prodBySku = new Map(prodRows.map((pr) => [String(pr.sku).toLowerCase(), pr]));
        const prodByName = new Map(prodRows.map((pr) => [String(pr.name).toLowerCase(), pr]));
        const linkRows = q('SELECT product_id, channel_sku FROM product_channel_links WHERE user_id = ? AND platform = ?').all(userId, platform);
        const prodByChannelSku = new Map();
        for (const lr of linkRows) {
          const pr = prodById.get(Number(lr.product_id));
          if (pr && lr.channel_sku) prodByChannelSku.set(String(lr.channel_sku).toLowerCase(), pr);
        }

        // 2) تحديث/إضافة الطلبات + ربط العملاء (CRM) + ربط order_items + استهلاك FIFO COGS + خصم المخزون
        const userRow = q('SELECT order_seq FROM users WHERE id = ?').get(userId);
        let nextSeq = Number(userRow?.order_seq || 1000);
        for (const o of pulled.orders || []) {
          const extRef = String(o.externalRef || '').slice(0, 80);
          if (!extRef) continue;
          const nextStatus = Number(o.status || 0);
          const incomingTotal = round2(Math.max(0, Number(o.total) || 0));
          const incomingAwb = String(o.awbNumber || '').trim().slice(0, 80);
          const incomingTrack = String(o.trackingUrl || '').trim().slice(0, 400);
          const incomingReturnReason = String(o.returnReason || '').trim().slice(0, 200);

          const exists = q('SELECT id, status, total, delivered_at, cancelled_at, return_reason, awb_number, tracking_url FROM orders WHERE user_id = ? AND market = ? AND external_ref = ?')
            .get(userId, platform, extRef);
          if (exists) {
            const nextDeliveredAt = nextStatus === 2 && !exists.delivered_at ? now : exists.delivered_at;
            const nextCancelledAt = nextStatus === 4 && !exists.cancelled_at ? now : exists.cancelled_at;
            const nextReturnReason = incomingReturnReason || exists.return_reason || '';
            const nextAwb = incomingAwb || exists.awb_number || '';
            const nextTrack = incomingTrack || exists.tracking_url || '';
            const nextTotal = incomingTotal > 0 ? incomingTotal : Number(exists.total || 0);
            const changed = exists.status !== nextStatus
              || nextAwb !== (exists.awb_number || '')
              || nextTrack !== (exists.tracking_url || '')
              || nextReturnReason !== (exists.return_reason || '')
              || (incomingTotal > 0 && Math.abs(nextTotal - Number(exists.total || 0)) >= 0.01);

            if (changed) {
              q(`UPDATE orders
                 SET status = ?, total = ?, delivered_at = ?, cancelled_at = ?, return_reason = ?, awb_number = ?, tracking_url = ?
                 WHERE id = ?`)
                .run(nextStatus, nextTotal, nextDeliveredAt, nextCancelledAt, nextReturnReason, nextAwb, nextTrack, exists.id);
              updatedOrders++;
            } else {
              skippedOrders++;
            }
            continue;
          }

          nextSeq += 1;
          const resolvedItems = [];
          if (Array.isArray(o.orderItems) && o.orderItems.length) {
            for (const it of o.orderItems) {
              const skuKey = String(it.sku || '').trim().toLowerCase();
              const nameKey = String(it.name || '').trim().toLowerCase();
              const matched = (skuKey && prodByChannelSku.get(skuKey))
                || (skuKey && prodBySku.get(skuKey))
                || (nameKey && prodByName.get(nameKey))
                || null;
              const qty = Math.max(1, Number(it.qty) || 1);
              const price = round2(Math.max(0, Number(it.price) || 0));
              resolvedItems.push({
                productId: matched ? matched.id : null,
                matched,
                name: String(it.name || matched?.name || 'منتج').slice(0, 120),
                qty,
                price,
                cost: matched && Number(matched.cost) > 0 ? round2(Number(matched.cost)) : 0
              });
            }
          }

          const total = incomingTotal > 0
            ? incomingTotal
            : round2(resolvedItems.reduce((s, it) => s + it.price * it.qty, 0));
          const fulfillmentChannel = String(o.fulfillmentChannel || '').trim();
          const isMarketplaceFulfilled = /^(AFN|FBN|FBJ)$/i.test(fulfillmentChannel);
          const courier = String(o.courier || defaultCourier).slice(0, 60);
          const shipFee = Number.isFinite(Number(o.shipFee)) && Number(o.shipFee) >= 0 ? round2(Number(o.shipFee)) : 0;

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
          const cancelledAt = nextStatus === 4 ? now : null;

          const orderId = Number(q(`INSERT INTO orders
             (user_id, customer_id, no, market, customer, phone, phone_hash, gov, address, pay, courier, total, cost_total, packaging_total, cost_estimated, ship_fee, fulfillment_channel, status, items, approval_status, external_ref, source, delivered_at, cancelled_at, return_reason, awb_number, tracking_url, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              userId, customerId, nextSeq, platform,
              encName, encPhone, phHash, custGov, encAddr,
              String(o.pay || 'عند الاستلام'),
              courier,
              total, shipFee, fulfillmentChannel,
              nextStatus,
              String(o.items || `طلب ${MARKETS[platform]?.name || platform}`).slice(0, 240),
              extRef,
              sourceName,
              deliveredAt,
              cancelledAt,
              incomingReturnReason,
              incomingAwb,
              incomingTrack,
              String(o.createdAt || now)
            ).lastInsertRowid);

          let matchedCostTotal = 0;
          let packagingTotal = 0;
          let anyMissingCost = resolvedItems.length === 0;
          for (const it of resolvedItems) {
            let unitCost = it.cost;
            if (it.productId && nextStatus !== 4) {
              const fifo = consumeFifoCost(q, { userId, productId: it.productId, qty: it.qty, orderId });
              unitCost = fifo.unitCostAvg;
              matchedCostTotal += fifo.totalCost;
              packagingTotal += fifo.packagingTotal;
              if (fifo.costMissing) anyMissingCost = true;
            } else {
              matchedCostTotal += unitCost * it.qty;
              if (unitCost <= 0) anyMissingCost = true;
            }
            q('INSERT INTO order_items (order_id, product_id, name, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?)')
              .run(orderId, it.productId, it.name, it.qty, it.price, unitCost);
            // خصم المخزون المركزي الذري لمرة واحدة لكل طلب جديد غير ملغي (ومزامنة باقي القنوات لمنع البيع الزائد)
            if (it.productId && !syncedProductIds.has(Number(it.productId)) && !isMarketplaceFulfilled && nextStatus !== 3 && nextStatus !== 4) {
              q('UPDATE products SET stock = MAX(0, stock - ?), updated_at = ? WHERE id = ? AND user_id = ?')
                .run(it.qty, now, it.productId, userId);
              stockAffectedProductIds.add(Number(it.productId));
            }
          }
          q('UPDATE orders SET cost_total = ?, packaging_total = ?, cost_estimated = ? WHERE id = ?')
            .run(round2(matchedCostTotal), round2(packagingTotal), anyMissingCost ? 1 : 0, orderId);
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

        return { ...stats, stockAffectedProductIds: [...stockAffectedProductIds] };
      });

      // دفع تحديث المخزون اللحظي لباقي القنوات المتصلة (باستثناء المنصة التي ورد منها الطلب) لمنع البيع الزائد
      let stockSyncQueued = 0;
      for (const pid of summary.stockAffectedProductIds || []) {
        stockSyncQueued += enqueueStockSyncForProduct(userId, pid, {
          excludePlatform: platform,
          reason: `order_imported:${platform}`
        });
      }

      const { stockAffectedProductIds: _drop, ...cleanSummary } = summary;
      return {
        live: true,
        ok: true,
        platform,
        name: MARKETS[platform]?.name || platform,
        ...cleanSummary,
        stockSyncQueued,
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

  /**
   * جدولة دفع تحديثات المخزون ثنائي الاتجاه إلى جميع الأسواق المتصلة للمنتج عبر طابور SQLite (sync_outbox)
   */
  function enqueueStockPush(userId, product) {
    if (!product || !product.sku) return 0;
    const marketsStr = String(product.markets || '');
    const activeConns = q(`SELECT platform FROM marketplace_connections
      WHERE user_id = ? AND enabled = 1 AND creds_enc <> '' AND status IN ('connected', 'configured')`).all(userId);
    const now = nowIso();
    let queued = 0;
    for (const c of activeConns) {
      if (marketsStr && !marketsStr.includes(c.platform)) continue;
      const existing = q("SELECT id FROM sync_outbox WHERE user_id = ? AND platform = ? AND sku = ? AND status = 'pending'").get(userId, c.platform, product.sku);
      if (existing) {
        q('UPDATE sync_outbox SET qty = ?, product_id = ?, next_retry_at = ?, updated_at = ? WHERE id = ?')
          .run(Math.max(0, Number(product.stock) || 0), product.id || null, now, now, existing.id);
      } else {
        q(`INSERT INTO sync_outbox (user_id, platform, product_id, sku, qty, status, attempts, next_retry_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, '', ?, ?)`)
          .run(userId, c.platform, product.id || null, product.sku, Math.max(0, Number(product.stock) || 0), now, now, now);
      }
      queued++;
    }
    return queued;
  }

  let outboxRunning = false;
  async function processSyncOutbox(limit = 20) {
    if (outboxRunning) return { skipped: true, processed: 0, succeeded: 0, failed: 0 };
    outboxRunning = true;
    let processed = 0, succeeded = 0, failed = 0;
    try {
      const now = nowIso();
      const jobs = q(`SELECT * FROM sync_outbox
        WHERE status = 'pending' AND next_retry_at <= ?
        ORDER BY id ASC LIMIT ?`).all(now, Math.min(100, Math.max(1, Number(limit) || 20)));
      for (const job of jobs) {
        processed++;
        const row = q('SELECT * FROM marketplace_connections WHERE user_id = ? AND platform = ?').get(job.user_id, job.platform);
        const adapter = ADAPTERS[job.platform];
        if (!row || !row.creds_enc || !adapter || typeof adapter.pushStock !== 'function') {
          q("UPDATE sync_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
            .run('لا يوجد اتصال نشط بهذه المنصة', nowIso(), job.id);
          failed++;
          continue;
        }
        try {
          const creds = decryptRowCreds(row);
          await adapter.pushStock(creds, row.environment || 'production', job.sku, job.qty, guardedFetch, {
            userId: job.user_id,
            tokenCache,
            retryOpts,
            onCredentialsUpdated: (updated) => persistUpdatedCreds(job.user_id, job.platform, updated)
          });
          q("UPDATE sync_outbox SET status = 'done', last_error = '', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
          succeeded++;
        } catch (err) {
          const attempts = Number(job.attempts || 0) + 1;
          const errMsg = String(err?.message || 'فشل دفع تحديث المخزون').slice(0, 300);
          if (attempts >= 5) {
            q("UPDATE sync_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
              .run(attempts, errMsg, nowIso(), job.id);
          } else {
            const backoffSec = (2 ** attempts) * 30;
            const nextRetry = new Date(Date.now() + backoffSec * 1000).toISOString();
            q("UPDATE sync_outbox SET attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
              .run(attempts, nextRetry, errMsg, nowIso(), job.id);
          }
          failed++;
        }
      }
      return { skipped: false, processed, succeeded, failed };
    } finally {
      outboxRunning = false;
    }
  }

  function listOutbox(userId, limit = 20) {
    return q('SELECT * FROM sync_outbox WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, Math.min(50, Math.max(1, Number(limit) || 20)))
      .map((j) => ({
        id: j.id,
        platform: j.platform,
        platformName: MARKETS[j.platform]?.name || j.platform,
        productId: j.product_id,
        sku: j.sku,
        qty: j.qty,
        status: j.status,
        attempts: j.attempts,
        nextRetryAt: j.next_retry_at,
        lastError: j.last_error || '',
        createdAt: j.created_at,
        updatedAt: j.updated_at
      }));
  }

  // ── Task 1: Two-Way Real-Time Anti-Overselling Inventory Sync Queue & Channel Links ──

  function getProductChannelLinks(userId, productId = null) {
    const rows = productId != null
      ? q('SELECT * FROM product_channel_links WHERE user_id = ? AND product_id = ? ORDER BY platform ASC').all(userId, Number(productId))
      : q('SELECT * FROM product_channel_links WHERE user_id = ? ORDER BY product_id DESC, platform ASC').all(userId);
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      platform: r.platform,
      platformName: MARKETS[r.platform]?.name || r.platform,
      channelSku: r.channel_sku,
      externalId: r.external_id || '',
      lastPushedStock: r.last_pushed_stock == null ? null : Number(r.last_pushed_stock),
      lastPushedAt: r.last_pushed_at || null,
      syncStatus: r.sync_status || 'idle',
      lastError: r.last_error || '',
      updatedAt: r.updated_at
    }));
  }

  function setProductChannelLinks(userId, productId, channelsInput = {}) {
    const prod = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(Number(productId), userId);
    if (!prod) throw new HttpError(404, 'المنتج غير موجود');
    const now = nowIso();
    const entries = Array.isArray(channelsInput)
      ? channelsInput.map((c) => [c?.platform, c?.channelSku ?? c?.channel_sku, c?.externalId ?? c?.external_id ?? ''])
      : Object.entries(channelsInput || {}).map(([platform, val]) => (
        typeof val === 'object' && val !== null
          ? [platform, val.channelSku ?? val.channel_sku ?? '', val.externalId ?? val.external_id ?? '']
          : [platform, val, '']
      ));

    tx(() => {
      for (const [platform, rawSku, rawExtId] of entries) {
        if (!PLATFORM_KEYS.includes(platform)) continue;
        const channelSku = String(rawSku || '').trim().slice(0, 80);
        const externalId = String(rawExtId || '').trim().slice(0, 120);
        if (!channelSku) {
          q('DELETE FROM product_channel_links WHERE user_id = ? AND product_id = ? AND platform = ?')
            .run(userId, prod.id, platform);
          continue;
        }
        q(`INSERT INTO product_channel_links (user_id, product_id, platform, channel_sku, external_id, sync_status, updated_at)
           VALUES (?, ?, ?, ?, ?, 'idle', ?)
           ON CONFLICT(user_id, product_id, platform) DO UPDATE SET
             channel_sku = excluded.channel_sku,
             external_id = COALESCE(NULLIF(excluded.external_id, ''), product_channel_links.external_id),
             updated_at = excluded.updated_at`)
          .run(userId, prod.id, platform, channelSku, externalId, now);
      }
    });
    return getProductChannelLinks(userId, prod.id);
  }

  let immediateScheduled = false;
  function scheduleInventoryQueueProcess() {
    if (closed || immediateScheduled) return;
    immediateScheduled = true;
    setImmediate(() => {
      immediateScheduled = false;
      if (closed) return;
      processInventorySyncQueue({ limit: 25 }).catch(() => {});
    });
  }

  /**
   * جدولة دفع المخزون الفعّال (stock - safety_stock) إلى جميع القنوات المتصلة للمنتج مع منع التكرار
   */
  function enqueueStockSyncForProduct(userId, productId, { excludePlatform = null, reason = '', force = false, autoProcess = true } = {}) {
    if (closed) return 0;
    const prod = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(Number(productId), userId);
    if (!prod) return 0;
    if (!force && Number(prod.auto_push_stock) === 0) return 0;

    const publishedStock = Math.max(0, Math.floor(Number(prod.stock || 0)) - Math.max(0, Math.floor(Number(prod.safety_stock || 0))));
    const activeConns = q(`SELECT platform FROM marketplace_connections
      WHERE user_id = ? AND enabled = 1 AND creds_enc <> ''`).all(userId);
    if (!activeConns.length) return 0;

    const links = q('SELECT * FROM product_channel_links WHERE user_id = ? AND product_id = ?').all(userId, prod.id);
    const linkByPlatform = new Map(links.map((l) => [l.platform, l]));
    const marketSet = new Set(String(prod.markets || '').split('').filter(Boolean));
    for (const l of links) marketSet.add(l.platform);

    const now = nowIso();
    let queued = 0;

    for (const conn of activeConns) {
      const p = conn.platform;
      if (excludePlatform && p === excludePlatform) continue;
      if (!marketSet.has(p)) continue;

      const link = linkByPlatform.get(p);
      const channelSku = String(link?.channel_sku || prod.sku || '').trim();
      if (!channelSku) continue;

      if (!force && link && link.sync_status === 'synced' && link.last_pushed_stock === publishedStock) {
        continue;
      }

      // ضمان وجود رابط القناة لتتبع الحالة لحظيًا
      if (!link) {
        q(`INSERT INTO product_channel_links (user_id, product_id, platform, channel_sku, external_id, sync_status, updated_at)
           VALUES (?, ?, ?, ?, '', 'pending', ?)
           ON CONFLICT(user_id, product_id, platform) DO UPDATE SET sync_status = 'pending', updated_at = excluded.updated_at`)
          .run(userId, prod.id, p, channelSku, now);
      } else {
        q("UPDATE product_channel_links SET sync_status = 'pending', updated_at = ? WHERE id = ?").run(now, link.id);
      }

      // منع التكرار: تحديث المهمة المعلّقة إن وُجدت لنفس (user_id, product_id, platform)
      const pendingJob = q(`SELECT id FROM inventory_sync_queue
        WHERE user_id = ? AND product_id = ? AND platform = ? AND status = 'pending'
        ORDER BY id DESC LIMIT 1`).get(userId, prod.id, p);

      if (pendingJob) {
        q(`UPDATE inventory_sync_queue
           SET channel_sku = ?, desired_stock = ?, reason = ?, next_retry_at = ?, updated_at = ?
           WHERE id = ?`)
          .run(channelSku, publishedStock, String(reason || ''), now, now, pendingJob.id);
      } else {
        q(`INSERT INTO inventory_sync_queue
           (user_id, product_id, platform, channel_sku, desired_stock, reason, status, attempts, next_retry_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, '', ?, ?)`)
          .run(userId, prod.id, p, channelSku, publishedStock, String(reason || ''), now, now, now);
      }
      queued++;
    }

    if (queued > 0 && autoProcess) {
      scheduleInventoryQueueProcess();
    }
    return queued;
  }

  /**
   * عامل الخلفية لطابور مزامنة المخزون (يدفع عبر adapter.pushInventory مع backoff أسي 15s / 60s / 300s / 900s)
   */
  async function processInventorySyncQueue({ limit = 25 } = {}) {
    if (closed || inventoryQueueRunning) {
      return { skipped: true, processed: 0, succeeded: 0, failed: 0, retrying: 0 };
    }
    inventoryQueueRunning = true;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let retrying = 0;
    try {
      const now = nowIso();
      const jobs = q(`SELECT * FROM inventory_sync_queue
        WHERE status = 'pending' AND next_retry_at <= ?
        ORDER BY id ASC LIMIT ?`).all(now, Math.min(100, Math.max(1, Number(limit) || 25)));

      for (const job of jobs) {
        if (closed) break;
        processed++;
        const row = q('SELECT * FROM marketplace_connections WHERE user_id = ? AND platform = ? AND enabled = 1').get(job.user_id, job.platform);
        const adapter = ADAPTERS[job.platform];
        const tsNow = nowIso();

        if (!row || !row.creds_enc || !adapter || typeof adapter.pushInventory !== 'function') {
          const msg = 'لا يوجد اتصال API نشط لهذه المنصة';
          q("UPDATE inventory_sync_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
            .run(msg, tsNow, job.id);
          q("UPDATE product_channel_links SET sync_status = 'error', last_error = ?, updated_at = ? WHERE user_id = ? AND product_id = ? AND platform = ?")
            .run(msg, tsNow, job.user_id, job.product_id, job.platform);
          failed++;
          continue;
        }

        q("UPDATE inventory_sync_queue SET status = 'processing', updated_at = ? WHERE id = ?").run(tsNow, job.id);

        try {
          const creds = decryptRowCreds(row);
          const linkRow = q('SELECT external_id FROM product_channel_links WHERE user_id = ? AND product_id = ? AND platform = ?')
            .get(job.user_id, job.product_id, job.platform);
          await adapter.pushInventory(
            creds,
            row.environment || 'production',
            {
              sku: job.channel_sku,
              quantity: Math.max(0, Math.floor(Number(job.desired_stock) || 0)),
              sellerId: creds.sellerId || '',
              marketplaceId: creds.marketplaceId || '',
              externalId: linkRow?.external_id || ''
            },
            guardedFetch,
            {
              userId: job.user_id,
              tokenCache,
              retryOpts: { ...retryOpts, maxRetries: 0 },
              onCredentialsUpdated: (updated) => persistUpdatedCreds(job.user_id, job.platform, updated)
            }
          );

          const doneAt = nowIso();
          q("UPDATE inventory_sync_queue SET status = 'done', last_error = '', updated_at = ? WHERE id = ?")
            .run(doneAt, job.id);
          q(`INSERT INTO product_channel_links (user_id, product_id, platform, channel_sku, last_pushed_stock, last_pushed_at, sync_status, last_error, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'synced', '', ?)
             ON CONFLICT(user_id, product_id, platform) DO UPDATE SET
               last_pushed_stock = excluded.last_pushed_stock,
               last_pushed_at = excluded.last_pushed_at,
               sync_status = 'synced',
               last_error = '',
               updated_at = excluded.updated_at`)
            .run(job.user_id, job.product_id, job.platform, job.channel_sku, job.desired_stock, doneAt, doneAt);
          succeeded++;
        } catch (err) {
          const failAt = nowIso();
          const attempts = Number(job.attempts || 0) + 1;
          const errMsg = String(err?.message || 'فشل دفع تحديث المخزون للمنصة').slice(0, 300);
          const isRetryable = err?.retryable !== false;
          if (attempts >= 5 || !isRetryable) {
            q("UPDATE inventory_sync_queue SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
              .run(attempts, errMsg, failAt, job.id);
            q("UPDATE product_channel_links SET sync_status = 'error', last_error = ?, updated_at = ? WHERE user_id = ? AND product_id = ? AND platform = ?")
              .run(errMsg, failAt, job.user_id, job.product_id, job.platform);
            failed++;
          } else {
            const delaySec = INVENTORY_BACKOFF_SECONDS[Math.min(attempts - 1, INVENTORY_BACKOFF_SECONDS.length - 1)] || 900;
            const nextRetry = new Date(Date.now() + delaySec * 1000).toISOString();
            q("UPDATE inventory_sync_queue SET status = 'pending', attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
              .run(attempts, nextRetry, errMsg, failAt, job.id);
            q("UPDATE product_channel_links SET sync_status = 'pending', last_error = ?, updated_at = ? WHERE user_id = ? AND product_id = ? AND platform = ?")
              .run(errMsg, failAt, job.user_id, job.product_id, job.platform);
            retrying++;
          }
        }
      }
      return { skipped: false, processed, succeeded, failed, retrying };
    } finally {
      inventoryQueueRunning = false;
    }
  }

  function getInventorySyncOverview(userId) {
    const since24h = new Date(Date.now() - 86400_000).toISOString();
    const pending = Number(q("SELECT COUNT(*) n FROM inventory_sync_queue WHERE user_id = ? AND status IN ('pending','processing')").get(userId)?.n || 0);
    const synced24h = Number(q("SELECT COUNT(*) n FROM inventory_sync_queue WHERE user_id = ? AND status = 'done' AND updated_at >= ?").get(userId, since24h)?.n || 0);
    const failed = Number(q("SELECT COUNT(*) n FROM inventory_sync_queue WHERE user_id = ? AND status = 'failed'").get(userId)?.n || 0);

    const jobs = q(`SELECT q.*, p.name AS product_name, p.sku AS product_sku
      FROM inventory_sync_queue q
      LEFT JOIN products p ON p.id = q.product_id
      WHERE q.user_id = ?
      ORDER BY q.id DESC LIMIT 30`).all(userId).map((j) => ({
      id: j.id,
      productId: j.product_id,
      productName: j.product_name || '',
      productSku: j.product_sku || '',
      platform: j.platform,
      platformName: MARKETS[j.platform]?.name || j.platform,
      channelSku: j.channel_sku,
      desiredStock: j.desired_stock,
      reason: j.reason || '',
      status: j.status,
      attempts: j.attempts,
      nextRetryAt: j.next_retry_at,
      lastError: j.last_error || '',
      createdAt: j.created_at,
      updatedAt: j.updated_at
    }));

    const links = getProductChannelLinks(userId);
    return { summary: { pending, synced24h, failed }, jobs, links };
  }

  function retryInventorySyncJob(userId, jobId) {
    const job = q('SELECT * FROM inventory_sync_queue WHERE id = ? AND user_id = ?').get(Number(jobId) || 0, userId);
    if (!job) throw new HttpError(404, 'مهمة مزامنة المخزون غير موجودة');
    const now = nowIso();
    q("UPDATE inventory_sync_queue SET status = 'pending', attempts = 0, next_retry_at = ?, last_error = '', updated_at = ? WHERE id = ?")
      .run(now, now, job.id);
    q("UPDATE product_channel_links SET sync_status = 'pending', last_error = '', updated_at = ? WHERE user_id = ? AND product_id = ? AND platform = ?")
      .run(now, userId, job.product_id, job.platform);
    scheduleInventoryQueueProcess();
    return q('SELECT * FROM inventory_sync_queue WHERE id = ?').get(job.id);
  }

  function pushAllApprovedInventory(userId) {
    const prods = q("SELECT id FROM products WHERE user_id = ? AND approval_status = 'approved'").all(userId);
    let queued = 0;
    for (const p of prods) {
      queued += enqueueStockSyncForProduct(userId, p.id, { force: true, reason: 'manual_push_all', autoProcess: false });
    }
    if (queued > 0) scheduleInventoryQueueProcess();
    return { queued, productsScanned: prods.length };
  }

  // ── Task 2: Real Marketplace Settlement Fee Pull (Amazon Finances API) ──

  async function syncFinances(userId, platform, sinceIso = null) {
    if (!PLATFORM_KEYS.includes(platform)) throw bad('منصة غير مدعومة');
    const row = getRow(userId, platform);
    if (!row || !row.creds_enc) {
      throw bad(`أضف بيانات API الخاصة بمنصة ${MARKETS[platform]?.name || platform} أولًا.`);
    }
    const adapter = ADAPTERS[platform];
    if (!adapter || typeof adapter.syncFinances !== 'function') {
      throw bad('سحب التسويات المالية التلقائي عبر API متاح حاليًا لأمازون مصر؛ يمكنك رفع ملف تسويات نون وجوميا عبر استيراد CSV.');
    }
    const creds = decryptRowCreds(row);
    const pulled = await adapter.syncFinances(creds, row.environment || 'production', sinceIso, guardedFetch, {
      userId,
      tokenCache,
      retryOpts,
      onCredentialsUpdated: (updated) => persistUpdatedCreds(userId, platform, updated)
    });

    const now = nowIso();
    const summary = tx(() => {
      let settledOrders = 0;
      let feeLinesInserted = 0;
      let unmatchedRefs = 0;

      for (const entry of pulled.orders || []) {
        const order = q('SELECT id, status FROM orders WHERE user_id = ? AND market = ? AND external_ref = ?')
          .get(userId, platform, entry.externalRef);
        if (!order) {
          unmatchedRefs++;
          continue;
        }
        // استبدال بنود التسوية السابقة لهذا الطلب لمنع التكرار (Idempotent)
        q('DELETE FROM order_fee_lines WHERE user_id = ? AND order_id = ?').run(userId, order.id);

        let marketFees = 0;
        let adFees = 0;
        let otherFees = 0;
        let returnShipFee = 0;

        for (const fl of entry.feeLines || []) {
          q(`INSERT INTO order_fee_lines (user_id, order_id, external_ref, market, fee_code, fee_label, amount, vat_amount, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(userId, order.id, entry.externalRef, platform, fl.feeCode, fl.feeLabel, round2(fl.amount), round2(fl.vatAmount || 0), now);
          feeLinesInserted++;

          if (fl.category === 'ad') adFees += Number(fl.amount || 0);
          else if (fl.category === 'other') otherFees += Number(fl.amount || 0);
          else if (fl.feeCode === 'ReturnShippingFee') returnShipFee += Number(fl.amount || 0);
          else marketFees += Number(fl.amount || 0);
        }

        q(`UPDATE orders
           SET actual_market_fees = ?,
               ad_fee_alloc = ?,
               other_platform_fees = ?,
               return_ship_fee = CASE WHEN ? > 0 THEN ? ELSE return_ship_fee END,
               fees_source = 'api_settled',
               financial_settled_at = ?
           WHERE id = ?`)
          .run(round2(marketFees), round2(adFees), round2(otherFees), round2(returnShipFee), round2(returnShipFee), now, order.id);
        settledOrders++;
      }

      return { settledOrders, feeLinesInserted, unmatchedRefs };
    });

    return { ok: true, platform, ...summary };
  }

  function stop() {
    closed = true;
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
    syncAllActiveConnections,
    enqueueStockPush,
    processSyncOutbox,
    listOutbox,
    getProductChannelLinks,
    setProductChannelLinks,
    enqueueStockSyncForProduct,
    processInventorySyncQueue,
    getInventorySyncOverview,
    retryInventorySyncJob,
    pushAllApprovedInventory,
    syncFinances,
    stop
  };
}

module.exports = {
  PLATFORM_KEYS,
  PLATFORM_SCHEMAS,
  PLATFORM_SOURCE,
  normalizeMarketplaceStatus,
  parseTsv,
  getSetCookies,
  isPrivateOrReservedIp,
  isPrivateIp: isPrivateOrReservedIp,
  assertSafeExternalUrl,
  assertSafeExternalUrlWithDns,
  assertSafeResolvedUrl: assertSafeExternalUrlWithDns,
  callJson,
  callRaw,
  callWithRetry,
  maskSecret,
  maskCredentials,
  validateAndMergeCredentials,
  createConnectors
};
