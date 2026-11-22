'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { deriveSubkey } = require('./security');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ملف .env اختياري */ }

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const FALLBACK_SECRET = crypto.randomBytes(48).toString('hex');

/** يبني الإعدادات من متغيرات البيئة، ويمكن تجاوزها (للاختبارات) عبر o */
function load(o = {}) {
  const e = process.env;
  const nodeEnv = o.nodeEnv || (o.production === true ? 'production' : (e.NODE_ENV || 'development'));
  const production = o.production !== undefined ? Boolean(o.production) : nodeEnv === 'production';
  const isAiStudioPreview = !production && /^https:\/\/ais-(dev|pre)-/i.test(String(e.APP_URL || ''));
  const allowIframe = flag(o.allowIframe ?? e.ALLOW_IFRAME, isAiStudioPreview);
  const hasExplicitDataDir = Boolean(o.dataDir || e.DATA_DIR);
  const dataDir = path.resolve(o.dataDir || e.DATA_DIR || path.join(ROOT, 'data'));
  const dbFile = o.dbFile || e.DB_FILE || path.join(dataDir, 'omniarab.db');
  if (production && !hasExplicitDataDir && !o.dbFile && !e.DB_FILE) {
    console.warn(`[config] تحذير: لم يُحدد DATA_DIR في بيئة الإنتاج — سيتم تخزين قاعدة البيانات في المجلد الافتراضي: ${dataDir}`);
  }
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });

  const isCloud = Boolean(e.K_SERVICE || e.APP_URL || production);
  const isHttps = Boolean((e.APP_URL && e.APP_URL.startsWith('https')) || production);

  const rawSessionSecret = o.secret !== undefined ? o.secret : e.SESSION_SECRET;
  const rawDataEncKey = o.dataEncryptionKey !== undefined ? o.dataEncryptionKey : e.DATA_ENCRYPTION_KEY;

  if (production) {
    if (!rawSessionSecret || String(rawSessionSecret).length < 32) {
      throw new Error('[security] لا يمكن تشغيل الخادم في بيئة الإنتاج: متغير SESSION_SECRET غير مضبوط أو أقل من 32 حرفًا.');
    }
    if (!rawDataEncKey || String(rawDataEncKey).length < 32) {
      throw new Error('[security] لا يمكن تشغيل الخادم في بيئة الإنتاج: متغير DATA_ENCRYPTION_KEY غير مضبوط أو أقل من 32 حرفًا.');
    }
  }

  const secret = (rawSessionSecret && String(rawSessionSecret).length >= 32) ? String(rawSessionSecret) : FALLBACK_SECRET;
  const rawEncSecret = (rawDataEncKey && String(rawDataEncKey).length >= 32) ? String(rawDataEncKey) : secret;
  const sessionKey = deriveSubkey(secret, 'session-hmac-v1', 32);
  const receiptKey = deriveSubkey(secret, 'receipt-hmac-v1', 32);
  const encryptionKey = deriveSubkey(rawEncSecret, 'db-field-aes256gcm-v1', 32);

  const backupDir = path.resolve(o.backupDir || path.join(dataDir, 'backups'));
  const uploadsDir = path.resolve(o.uploadsDir || path.join(dataDir, 'uploads', 'products'));
  const autoSyncRaw = o.autoSyncIntervalMin !== undefined ? o.autoSyncIntervalMin : e.AUTO_SYNC_INTERVAL_MIN;
  const autoSyncIntervalMin = autoSyncRaw === undefined || autoSyncRaw === ''
    ? (dbFile === ':memory:' ? 0 : 15)
    : Math.max(0, Number(autoSyncRaw) || 0);

  return Object.freeze({
    port: +(o.port ?? e.PORT ?? 3000),
    host: o.host || e.HOST || '0.0.0.0',
    dataDir,
    dbFile,
    backupDir,
    uploadsDir,
    backupKeepCount: Math.max(1, Number(o.backupKeepCount ?? e.BACKUP_KEEP_COUNT ?? 7) || 7),
    autoSyncIntervalMin,
    publicDir: path.join(ROOT, 'public'),
    secret,
    sessionKey,
    receiptKey,
    encryptionKey,
    cookieName: 'omni_sid',
    secureCookie: flag(o.secureCookie ?? e.COOKIE_SECURE, isHttps),
    hsts: production,
    allowIframe,
    // لا نثق بترويسة X-Forwarded-For إلا خلف وسيط معروف (وإلا يستطيع أي عميل انتحال IP وتجاوز حدود الطلبات)
    trustProxy: flag(o.trustProxy ?? e.TRUST_PROXY, isCloud),
    geminiKey: o.geminiKey ?? e.GEMINI_API_KEY ?? '',
    geminiModel: o.geminiModel || e.GEMINI_MODEL || 'gemini-4-hydrogen',
    // بيانات حساب المالك الوحيد للنظام (تُقرأ من البيئة أو الإعدادات)
    ownerName: String(o.ownerName ?? e.OWNER_NAME ?? 'مالك منصة OrderFlow').trim(),
    ownerEmail: String(o.ownerEmail ?? e.OWNER_EMAIL ?? e.ADMIN_EMAIL ?? (!production ? 'owner@orderflow.eg' : '')).trim().toLowerCase(),
    ownerPhone: String(o.ownerPhone ?? o.adminPhone ?? e.OWNER_PHONE ?? e.ADMIN_PHONE ?? (!production ? '01099990000' : '')).trim(),
    ownerPassword: String(o.ownerPassword ?? o.adminPassword ?? e.OWNER_PASSWORD ?? e.ADMIN_PASSWORD ?? (!production ? 'Owner@2026!' : '')),
    adminPhone: String(o.adminPhone ?? o.ownerPhone ?? e.ADMIN_PHONE ?? e.OWNER_PHONE ?? '').trim(),
    adminPassword: String(o.adminPassword ?? o.ownerPassword ?? e.ADMIN_PASSWORD ?? e.OWNER_PASSWORD ?? ''),
    mailTransport: o.mailTransport || null,
    mailApiKey: String(o.mailApiKey ?? o.resendApiKey ?? e.RESEND_API_KEY ?? e.MAIL_API_KEY ?? '').trim(),
    mailApiUrl: String(o.mailApiUrl ?? e.MAIL_API_URL ?? 'https://api.resend.com/emails').trim(),
    mailFrom: String(o.mailFrom ?? e.MAIL_FROM ?? '').trim(),
    smtpHost: String(o.smtpHost ?? e.SMTP_HOST ?? '').trim(),
    smtpPort: Number(o.smtpPort ?? e.SMTP_PORT ?? 587) || 587,
    smtpUser: String(o.smtpUser ?? e.SMTP_USER ?? '').trim(),
    smtpPass: String(o.smtpPass ?? e.SMTP_PASS ?? '').trim(),
    smtpSecure: flag(o.smtpSecure ?? e.SMTP_SECURE, Number(o.smtpPort ?? e.SMTP_PORT ?? 587) === 465),
    smtpStartTls: flag(o.smtpStartTls ?? e.SMTP_STARTTLS, true),
    mailWebhookUrl: String(o.mailWebhookUrl ?? e.MAIL_WEBHOOK_URL ?? '').trim(),
    mailWebhookSecret: String(o.mailWebhookSecret ?? e.MAIL_WEBHOOK_SECRET ?? '').trim(),
    platformTaxId: String(o.platformTaxId ?? e.PLATFORM_TAX_ID ?? '').trim(),
    platformLegalName: String(o.platformLegalName ?? e.PLATFORM_LEGAL_NAME ?? '').trim(),
    // تغيير الباقة دون دفع مسموح في بيئة التطوير فقط
    allowPlanSelfService: flag(o.allowPlanSelfService ?? e.ALLOW_PLAN_SELF_SERVICE, !production),
    allowedOrigins: String(o.allowedOrigins ?? e.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    appUrl: (o.appUrl || e.APP_URL || '').replace(/\/+$/, ''),
    nodeEnv,
    production,
    payments: Object.freeze({
      // sandbox | hosted | kashier | اسم ملف داخل src/payments/providers — وفي الإنتاج لا شيء افتراضيًا حتى تُضبط بوابة حقيقية
      provider: String(o.paymentProvider ?? e.PAYMENT_PROVIDER ?? (production ? '' : 'sandbox')).trim().toLowerCase(),
      allowSandboxInProduction: flag(o.paymentAllowSandbox ?? e.PAYMENT_ALLOW_SANDBOX, false),
      apiUrl: o.paymentApiUrl ?? e.PAYMENT_API_URL ?? '',
      apiKey: o.paymentApiKey ?? e.PAYMENT_API_KEY ?? '',
      webhookSecret: o.paymentWebhookSecret ?? e.PAYMENT_WEBHOOK_SECRET ?? '',
      signatureHeader: String(e.PAYMENT_SIGNATURE_HEADER || 'x-signature').toLowerCase(),
      signatureEncoding: e.PAYMENT_SIGNATURE_ENCODING === 'base64' ? 'base64' : 'hex',
      amountUnit: e.PAYMENT_AMOUNT_UNIT === 'minor' ? 'minor' : 'major',
      methods: String(e.PAYMENT_METHODS || 'wallet,kashier,instapay,card').split(',').map((s) => s.trim()).filter(Boolean),
      kashierMerchantId: String(o.kashierMerchantId ?? e.KASHIER_MERCHANT_ID ?? '').trim(),
      kashierApiKey: String(o.kashierApiKey ?? e.KASHIER_API_KEY ?? '').trim(),
      kashierMode: String(o.kashierMode ?? e.KASHIER_MODE ?? (production ? 'live' : 'test')).trim().toLowerCase(),
      kashierAllowedMethods: String(o.kashierAllowedMethods ?? e.KASHIER_ALLOWED_METHODS ?? 'wallet').trim(),
      walletNumber: String(o.paymentWalletNumber ?? e.PAYMENT_WALLET_NUMBER ?? '').trim(),
      currency: 'EGP'
    }),
    maxDemos: +(o.maxDemos ?? e.MAX_DEMOS ?? 500),
    demoTtlSec: 24 * 3600,
    fetch: o.fetch || globalThis.fetch,
    dnsLookup: o.dnsLookup || null
  });
}

module.exports = { load };

