'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { deriveSubkey } = require('./security');
const { password: validatePassword } = require('./util');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ملف .env اختياري */ }

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

function isLocalUrl(rawUrl) {
  if (!rawUrl) return true;
  try {
    const u = new URL(String(rawUrl));
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function loadOrCreateDevSecrets(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dataDir, '.dev-secrets.json');
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (
        parsed &&
        typeof parsed.sessionSecret === 'string' && parsed.sessionSecret.length >= 32 &&
        typeof parsed.dataEncryptionKey === 'string' && parsed.dataEncryptionKey.length >= 32
      ) {
        return parsed;
      }
    }
  } catch {
    // إعادة توليد الملف إذا كان تالفًا
  }
  const generated = {
    sessionSecret: crypto.randomBytes(48).toString('hex'),
    dataEncryptionKey: crypto.randomBytes(48).toString('hex')
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(generated, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // في حالة عدم إمكانية الكتابة (مثل نظام ملفات للقراءة فقط) نتابع بالقيم المولّدة
  }
  return generated;
}

/** يبني الإعدادات من متغيرات البيئة، ويمكن تجاوزها (للاختبارات) عبر o */
function load(o = {}) {
  const e = process.env;
  const nodeEnv = o.nodeEnv || (o.production === true ? 'production' : (e.NODE_ENV || 'development'));
  const production = o.production !== undefined ? Boolean(o.production) : nodeEnv === 'production';

  const rawAppUrl = String(o.appUrl !== undefined ? o.appUrl : (e.APP_URL || '')).trim().replace(/\/+$/, '');
  const rawKService = String(o.kService !== undefined ? o.kService : (e.K_SERVICE || '')).trim();
  const isAiStudioPreview = !production && o.appUrl === undefined && o.kService === undefined && /^https:\/\/ais-(dev|pre)-/i.test(String(e.APP_URL || ''));
  const allowInsecureDev = flag(o.allowInsecureDev ?? e.ALLOW_INSECURE_DEV, false);
  const allowDevDefaultOwner = flag(o.allowDevDefaultOwner ?? e.ALLOW_DEV_DEFAULT_OWNER, false);

  const nonLocalAppUrl = Boolean(rawAppUrl) && !isLocalUrl(rawAppUrl) && !isAiStudioPreview;
  const hasDeployedKService = Boolean(rawKService) && !isAiStudioPreview;
  const deployed = Boolean(production || nonLocalAppUrl || hasDeployedKService);
  const enforcedProd = deployed && !allowInsecureDev;

  const allowIframe = flag(o.allowIframe ?? e.ALLOW_IFRAME, isAiStudioPreview);
  const hasExplicitDataDir = Boolean(o.dataDir || e.DATA_DIR);
  const dataDir = path.resolve(o.dataDir || e.DATA_DIR || path.join(ROOT, 'data'));
  const dbFile = o.dbFile || e.DB_FILE || e.DB_PATH || path.join(dataDir, 'omniarab.db');
  if (enforcedProd && !hasExplicitDataDir && !o.dbFile && !e.DB_FILE && !e.DB_PATH) {
    console.warn(`[config] تحذير: لم يُحدد DATA_DIR في بيئة الإنتاج — سيتم تخزين قاعدة البيانات في المجلد الافتراضي: ${dataDir}`);
  }
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });

  const isHttps = Boolean((rawAppUrl && rawAppUrl.startsWith('https')) || enforcedProd);

  const rawSessionSecret = o.secret !== undefined ? o.secret : e.SESSION_SECRET;
  const rawDataEncKey = o.dataEncryptionKey !== undefined ? o.dataEncryptionKey : e.DATA_ENCRYPTION_KEY;

  if (enforcedProd) {
    if (!rawSessionSecret || String(rawSessionSecret).length < 32) {
      throw new Error('[security] لا يمكن تشغيل الخادم في بيئة الإنتاج/النشر: متغير SESSION_SECRET غير مضبوط أو أقل من 32 حرفًا.');
    }
    if (!rawDataEncKey || String(rawDataEncKey).length < 32) {
      throw new Error('[security] لا يمكن تشغيل الخادم في بيئة الإنتاج/النشر: متغير DATA_ENCRYPTION_KEY غير مضبوط أو أقل من 32 حرفًا.');
    }
  }

  let devSecrets = null;
  const needsDevSession = !rawSessionSecret || String(rawSessionSecret).length < 32;
  const needsDevEnc = !rawDataEncKey || String(rawDataEncKey).length < 32;
  if (!enforcedProd && (needsDevSession || needsDevEnc)) {
    devSecrets = loadOrCreateDevSecrets(dataDir);
  }

  const secret = !needsDevSession ? String(rawSessionSecret) : devSecrets.sessionSecret;
  const rawEncSecret = !needsDevEnc ? String(rawDataEncKey) : (devSecrets ? devSecrets.dataEncryptionKey : secret);
  const sessionKey = deriveSubkey(secret, 'session-hmac-v1', 32);
  const receiptKey = deriveSubkey(secret, 'receipt-hmac-v1', 32);
  const encryptionKey = deriveSubkey(rawEncSecret, 'db-field-aes256gcm-v1', 32);

  // بيانات حساب المالك الوحيد للنظام: الافتراضية فقط في التطوير المحلي مع ALLOW_DEV_DEFAULT_OWNER=1
  const useDefaultDevOwner = !deployed && allowDevDefaultOwner;
  const explicitOwnerPass = o.ownerPassword ?? o.adminPassword ?? e.OWNER_PASSWORD ?? e.ADMIN_PASSWORD;
  const ownerPassword = explicitOwnerPass !== undefined && String(explicitOwnerPass) !== ''
    ? String(explicitOwnerPass)
    : (useDefaultDevOwner ? 'Owner@2026!' : '');

  if (explicitOwnerPass !== undefined && String(explicitOwnerPass) !== '') {
    if (ownerPassword.length < 12 || !validatePassword(ownerPassword)) {
      throw new Error('[security] يجب أن تكون كلمة مرور المالك (OWNER_PASSWORD) 12 حرفًا على الأقل وغير ضعيفة أو شائعة.');
    }
  }

  const ownerEmail = String(
    o.ownerEmail ?? e.OWNER_EMAIL ?? e.ADMIN_EMAIL ?? (useDefaultDevOwner ? 'owner@orderflow.eg' : '')
  ).trim().toLowerCase();
  const ownerPhone = String(
    o.ownerPhone ?? o.adminPhone ?? e.OWNER_PHONE ?? e.ADMIN_PHONE ?? (useDefaultDevOwner ? '01099990000' : '')
  ).trim();

  const backupDir = path.resolve(o.backupDir || path.join(dataDir, 'backups'));
  const uploadsDir = path.resolve(o.uploadsDir || path.join(dataDir, 'uploads', 'products'));
  const autoSyncRaw = o.autoSyncIntervalMin !== undefined ? o.autoSyncIntervalMin : e.AUTO_SYNC_INTERVAL_MIN;
  const autoSyncIntervalMin = autoSyncRaw === undefined || autoSyncRaw === ''
    ? (dbFile === ':memory:' ? 0 : 15)
    : Math.max(0, Number(autoSyncRaw) || 0);

  // لا نثق بترويسة X-Forwarded-For افتراضيًا إلا عند تفعيل TRUST_PROXY=1 أو داخل Cloud Run (K_SERVICE)
  const trustProxy = flag(o.trustProxy ?? e.TRUST_PROXY, Boolean(rawKService));
  const trustProxyHops = Math.max(1, Number(o.trustProxyHops ?? e.TRUST_PROXY_HOPS ?? 1) || 1);

  const smsProvider = String(
    o.smsProvider !== undefined ? o.smsProvider : (e.SMS_PROVIDER ?? (!enforcedProd ? 'console' : ''))
  ).trim().toLowerCase();

  return Object.freeze({
    port: +(o.port ?? e.PORT ?? 3000),
    host: o.host || e.HOST || '0.0.0.0',
    dataDir,
    dbFile,
    backupDir,
    uploadsDir,
    backupKeepCount: Math.max(1, Number(o.backupKeepCount ?? e.BACKUP_KEEP_COUNT ?? 7) || 7),
    backupEncryptionKey: String(o.backupEncryptionKey ?? e.BACKUP_ENCRYPTION_KEY ?? '').trim(),
    backupS3Endpoint: String(o.backupS3Endpoint ?? e.BACKUP_S3_ENDPOINT ?? '').trim(),
    backupS3Bucket: String(o.backupS3Bucket ?? e.BACKUP_S3_BUCKET ?? '').trim(),
    backupS3AccessKey: String(o.backupS3AccessKey ?? e.BACKUP_S3_ACCESS_KEY ?? '').trim(),
    backupS3Secret: String(o.backupS3Secret ?? e.BACKUP_S3_SECRET ?? '').trim(),
    backupS3Region: String(o.backupS3Region ?? e.BACKUP_S3_REGION ?? 'auto').trim(),
    autoSyncIntervalMin,
    publicDir: path.join(ROOT, 'public'),
    secret,
    sessionKey,
    receiptKey,
    encryptionKey,
    cookieName: 'omni_sid',
    secureCookie: flag(o.secureCookie ?? e.COOKIE_SECURE, isHttps),
    hsts: enforcedProd,
    allowIframe,
    trustProxy,
    trustProxyHops,
    geminiKey: o.geminiKey ?? e.GEMINI_API_KEY ?? '',
    geminiModel: o.geminiModel || e.GEMINI_MODEL || 'gemini-4-hydrogen',
    ownerName: String(o.ownerName ?? e.OWNER_NAME ?? 'مالك منصة OrderFlow').trim(),
    ownerEmail,
    ownerPhone,
    ownerPassword,
    adminPhone: String(o.adminPhone ?? ownerPhone ?? '').trim(),
    adminPassword: String(o.adminPassword ?? ownerPassword ?? ''),
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
    smsProvider,
    smsApiUrl: String(o.smsApiUrl ?? e.SMS_API_URL ?? '').trim(),
    smsApiKey: String(o.smsApiKey ?? e.SMS_API_KEY ?? '').trim(),
    smsSender: String(o.smsSender ?? e.SMS_SENDER ?? 'OrderFlow').trim(),
    smsBodyTemplate: String(o.smsBodyTemplate ?? e.SMS_BODY_TEMPLATE ?? '{"to":"{to}","message":"{message}","sender":"{sender}"}').trim(),
    twilioAccountSid: String(o.twilioAccountSid ?? e.TWILIO_ACCOUNT_SID ?? '').trim(),
    twilioAuthToken: String(o.twilioAuthToken ?? e.TWILIO_AUTH_TOKEN ?? '').trim(),
    twilioFrom: String(o.twilioFrom ?? e.TWILIO_FROM ?? '').trim(),
    platformTaxId: String(o.platformTaxId ?? e.PLATFORM_TAX_ID ?? '').trim(),
    platformLegalName: String(o.platformLegalName ?? e.PLATFORM_LEGAL_NAME ?? '').trim(),
    piiRetentionDays: Math.max(1, Number(o.piiRetentionDays ?? e.PII_RETENTION_DAYS ?? 30) || 30),
    alertWebhookUrl: String(o.alertWebhookUrl ?? e.ALERT_WEBHOOK_URL ?? '').trim(),
    errorWebhookUrl: String(o.errorWebhookUrl ?? e.ERROR_WEBHOOK_URL ?? '').trim(),
    turnstileSiteKey: String(o.turnstileSiteKey ?? e.TURNSTILE_SITE_KEY ?? '').trim(),
    turnstileSecretKey: String(o.turnstileSecretKey ?? e.TURNSTILE_SECRET_KEY ?? '').trim(),
    amazonPiiEnabled: flag(o.amazonPiiEnabled ?? e.AMAZON_PII_ENABLED, false),
    // تغيير الباقة دون دفع مسموح في بيئة التطوير غير المنشورة فقط
    allowPlanSelfService: flag(o.allowPlanSelfService ?? e.ALLOW_PLAN_SELF_SERVICE, !enforcedProd),
    allowedOrigins: String(o.allowedOrigins ?? e.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    appUrl: rawAppUrl,
    nodeEnv,
    production,
    deployed,
    enforcedProd,
    allowInsecureDev,
    allowDevDefaultOwner,
    payments: Object.freeze({
      // sandbox | hosted | kashier | اسم ملف داخل src/payments/providers — وفي الإنتاج/النشر لا شيء افتراضيًا حتى تُضبط بوابة حقيقية
      provider: String(o.paymentProvider ?? e.PAYMENT_PROVIDER ?? (enforcedProd ? '' : 'sandbox')).trim().toLowerCase(),
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
      kashierMode: String(o.kashierMode ?? e.KASHIER_MODE ?? (enforcedProd ? 'live' : 'test')).trim().toLowerCase(),
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
