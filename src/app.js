'use strict';
const http = require('node:http');
const { load } = require('./config');
const { openDb, backupDatabase, listBackups, uploadBackupToS3, testS3Connection } = require('./db');
const { createSession, hashPasswordSync, requireOwner, requireModerator, requirePermission, requireAdmin } = require('./auth');
const { ROLES, requiredRoleForPath, canAccessPanel } = require('./rbac');
const { createModel, normalizePhoneForIndex } = require('./model');
const { createRouter, createLimiter, createSqliteLimiter, createStatic, readBody, clientIp, sendJson, sendText, securityHeaders } = require('./http');
const { HttpError, phone, email, clean, esc, nowIso } = require('./util');
const { createFieldCipher, sanitizePayload } = require('./security');
const { createPayments } = require('./payments');
const { createMailer } = require('./mailer');
const { createSms } = require('./sms');
const { createConnectors } = require('./connectors');
const { createCouriers } = require('./couriers');
const { createLogger } = require('./logger');
const { sendSecurityAlert, trackOwnerLoginIp } = require('./alerts');
const pkg = require('../package.json');

const SECURITY_LIMIT_PREFIXES = ['login-', '2fa-', 'reg:', 'forgot-', 'reset-', 'contact:', 'otp-', 'export-', 'verify-resend:', 'demo:', 'bulk-exp:'];
const isSecurityLimitKey = (key) => SECURITY_LIMIT_PREFIXES.some((p) => String(key || '').startsWith(p));

/** يضمن وجود حساب المالك الوحيد فقط (1 Owner Max — محمي بفهرس فريد في قاعدة البيانات) */
function ensureSingleOwner(cfg, q) {
  if (!cfg.ownerPassword || (!cfg.ownerPhone && !cfg.ownerEmail)) {
    const existingOwner = q("SELECT id FROM users WHERE role = 'owner'").get();
    if (!existingOwner) {
      console.warn('[security] تنبيه: لم يُضبط متغير OWNER_PASSWORD — تم تخطي إنشاء حساب المالك. عيّن OWNER_PASSWORD (12 حرفًا على الأقل) أو ALLOW_DEV_DEFAULT_OWNER=1 في التطوير المحلي.');
    }
    return;
  }
  let ph = '';
  try { ph = cfg.ownerPhone ? phone(cfg.ownerPhone) : '01099990000'; } catch { ph = clean(cfg.ownerPhone) || '01099990000'; }
  let mail = null;
  try { mail = cfg.ownerEmail ? email(cfg.ownerEmail) : 'owner@orderflow.eg'; } catch { mail = 'owner@orderflow.eg'; }
  const ownerName = clean(cfg.ownerName) || 'مالك منصة OrderFlow';

  const existingOwner = q("SELECT * FROM users WHERE role = 'owner'").get();
  if (existingOwner) {
    // لا نعيد كتابة كلمة مرور المالك عند كل تشغيل إلا عند تفعيل OWNER_FORCE_RESET=1 صراحةً
    if (cfg.ownerForceReset) {
      const hash = hashPasswordSync(cfg.ownerPassword);
      q("UPDATE users SET phone = ?, email = ?, pass_hash = ?, store_name = ?, full_name = ?, status = 'active' WHERE id = ?")
        .run(ph, mail, hash, ownerName, ownerName, existingOwner.id);
    }
    return;
  }

  const hash = hashPasswordSync(cfg.ownerPassword);

  const byCred = q('SELECT * FROM users WHERE phone = ? OR (email IS NOT NULL AND email = ?)').get(ph, mail);
  if (byCred) {
    q("UPDATE users SET phone = ?, email = ?, pass_hash = ?, store_name = ?, full_name = ?, role = 'owner', status = 'active', plan = 'business' WHERE id = ?")
      .run(ph, mail, hash, ownerName, ownerName, byCred.id);
    return;
  }

  q(`INSERT INTO users (phone, email, pass_hash, store_name, full_name, role, status, plan, created_at)
     VALUES (?, ?, ?, ?, ?, 'owner', 'active', 'business', ?)`)
    .run(ph, mail, hash, ownerName, ownerName, nowIso());
}

/** صفحة 404 Not Found حقيقية تُعاد من الخادم مباشرةً عند محاولة الدخول المباشر إلى مسار لوحة المالك أو المشرف دون صلاحية */
function renderServer404Html(badPath) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 — الصفحة غير موجودة | OrderFlow</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--tx)">
  <main style="max-width:520px;width:100%;text-align:center">
    <div class="card" style="padding:48px 32px">
      <div style="font-size:64px;font-weight:900;color:var(--pr);line-height:1;font-family:var(--font-mono)">404</div>
      <h1 style="font-size:24px;margin:16px 0 8px;color:var(--tx)">الصفحة المطلوبة غير موجودة</h1>
      <p class="mu" style="margin-bottom:24px;font-size:15px">المسار <code dir="ltr">${esc(badPath)}</code> غير متاح أو ربما تم نقله.</p>
      <a class="btn btn-ac" href="/">العودة إلى الصفحة الرئيسية</a>
    </div>
  </main>
</body>
</html>`;
}

/** المسارات المسموح بها مؤقتًا عند فرض تفعيل المصادقة الثنائية للمالك أو المشرف */
function isAllowedDuring2faSetup(method, pathname) {
  if (method === 'GET' && pathname === '/api/auth/me') return true;
  if (method === 'POST' && pathname === '/api/auth/logout') return true;
  if (pathname.startsWith('/api/account/2fa/')) return true;
  return false;
}

function createApp(overrides = {}) {
  const startedAtMs = Date.now();
  const cfg = load(overrides);
  const store = openDb(cfg.dbFile);
  const logger = createLogger(cfg);
  const memLimiter = createLimiter();
  const sqliteLimiter = createSqliteLimiter(store.q);

  // محدّد مركّب: المفاتيح الأمنية الحساسة دائمة في SQLite، وحد api:<ip> العام سريع في الذاكرة
  const limiter = {
    hit(key, max, windowMs) {
      return isSecurityLimitKey(key) ? sqliteLimiter.hit(key, max, windowMs) : memLimiter.hit(key, max, windowMs);
    },
    reset(key) {
      if (isSecurityLimitKey(key)) sqliteLimiter.reset(key);
      else memLimiter.reset(key);
    },
    size() {
      return memLimiter.size() + sqliteLimiter.size();
    },
    purge() {
      return sqliteLimiter.purge();
    },
    stop() {
      memLimiter.stop();
      sqliteLimiter.stop();
    }
  };

  let decryptAlertRaised = false;
  let appRef = null;
  const cipher = createFieldCipher(cfg.encryptionKey || cfg.secret, {
    onDecryptFailure() {
      if (!decryptAlertRaised && appRef) {
        decryptAlertRaised = true;
        sendSecurityAlert(appRef, {
          severity: 'critical',
          title: 'عدم تطابق مفتاح تشفير البيانات (DATA_ENCRYPTION_KEY mismatch)',
          details: { hint: 'تحقق من DATA_ENCRYPTION_KEY فورًا' }
        }).catch(() => {});
      }
    }
  });

  const session = createSession(cfg, store.q);
  const mailer = createMailer(cfg);
  const sms = createSms(cfg);

  if (cfg.enforcedProd && !mailer.configured) {
    console.warn('[mailer] تحذير إنتاج: لم يُضبط أي مزود بريد إلكتروني (Resend أو SMTP أو Mail Webhook) — لن تصل رسائل التأكيد والتنبيهات.');
  }
  if (cfg.enforcedProd && (!cfg.backupEncryptionKey || cfg.backupEncryptionKey.length < 32)) {
    console.warn('[backup] تحذير إنتاج: لم يُضبط BACKUP_ENCRYPTION_KEY (32 حرفًا على الأقل) — النسخ الاحتياطية ستُحفظ بدون تشفير.');
  }

  const notify = (userId, type, title, body = '', link = '') => {
    try {
      store.q('INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, type || 'info', String(title || '').slice(0, 200), String(body || '').slice(0, 600), String(link || ''), nowIso());
    } catch (_) {}
  };

  const logAudit = (actorId, action, targetType = '', targetId = null, details = {}, ip = '') => {
    const actor = actorId ? store.q('SELECT id, store_name, full_name, email, role FROM users WHERE id = ?').get(actorId) : null;
    const actorName = actor ? (actor.full_name || actor.store_name || '') : 'النظام';
    const actorEmail = actor ? (actor.email || '') : '';
    const actorRole = actor ? (actor.role || 'owner') : 'system';
    const info = store.q(`INSERT INTO audit_log
      (admin_id, actor_name, actor_email, actor_role, action, target_type, target_id, details, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(actor ? actor.id : null, actorName, actorEmail, actorRole, String(action), String(targetType || ''), targetId == null ? null : Number(targetId), JSON.stringify(details || {}), String(ip || ''), nowIso());
    return Number(info.lastInsertRowid);
  };

  /** TASK 9: تسجيل كل عملية وصول لبيانات المشترين الحساسة (Amazon DPP) */
  const logPiiAccess = ({ actorId, ownerUserId, action, targetType = '', targetId = null, count = 1, ip = '' }) => {
    try {
      store.q(`INSERT INTO pii_access_log (actor_id, owner_user_id, action, target_type, target_id, count, ip, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          actorId == null ? null : Number(actorId),
          ownerUserId == null ? null : Number(ownerUserId),
          String(action || 'view'),
          String(targetType || ''),
          targetId == null ? null : Number(targetId),
          Math.max(1, Number(count) || 1),
          String(ip || ''),
          nowIso()
        );
    } catch (_) {}
  };

  const getPlatformSettings = () => {
    const rows = store.q('SELECT key, value FROM platform_settings').all();
    const out = {
      platform_name: 'OrderFlow',
      platform_legal_name: cfg.platformLegalName || 'OrderFlow لتقنيات التجارة الإلكترونية',
      platform_tax_id: cfg.platformTaxId || '',
      support_email: 'support@orderflow.eg',
      support_phone: '+20 100 000 0000',
      registration_open: '1',
      require_client_approval: '1',
      require_email_verification: cfg.enforcedProd ? '1' : '0',
      pii_retention_days: String(cfg.piiRetentionDays || 30),
      maintenance_notice: '',
      last_backup_at: '',
      last_backup_file: '',
      last_backup_upload_status: '',
      last_backup_uploaded_at: '',
      last_backup_s3_key: '',
      last_backup_encrypted: '0'
    };
    for (const row of rows) {
      if ((row.key === 'platform_tax_id' || row.key === 'platform_legal_name') && !row.value && out[row.key]) {
        continue;
      }
      out[row.key] = row.value;
    }
    return out;
  };

  const setPlatformSetting = (key, value) => {
    store.q(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(String(key), String(value ?? ''), nowIso());
  };

  ensureSingleOwner(cfg, store.q);

  // تعبئة الفهرس الأعمى tax_id_hash تلقائيًا لأي عملاء سابقين لديهم رقم ضريبي مشفّر قبل الترحيل 9
  try {
    const missingTaxHash = store.q("SELECT id, tax_id FROM users WHERE tax_id <> '' AND (tax_id_hash IS NULL OR tax_id_hash = '')").all();
    for (const row of missingTaxHash) {
      const plainTax = cipher.decrypt(row.tax_id);
      const h = plainTax ? cipher.blindIndex(plainTax) : '';
      if (h) store.q('UPDATE users SET tax_id_hash = ? WHERE id = ?').run(h, row.id);
    }
  } catch (_) {}

  // TASK 7 #4: ترحيل idempotent مرة واحدة عند التشغيل لتشفير بيانات المشترين النصية القديمة وتعبئة phone_hash
  try {
    store.tx(() => {
      const plainOrders = store.q(
        `SELECT id, customer, phone, address, phone_hash FROM orders
         WHERE (customer <> '' AND customer NOT LIKE 'enc:v1:%')
            OR (phone <> '' AND phone NOT LIKE 'enc:v1:%')
            OR (address <> '' AND address NOT LIKE 'enc:v1:%')
            OR (phone <> '' AND (phone_hash IS NULL OR phone_hash = ''))`
      ).all();
      for (const o of plainOrders) {
        const plainCust = cipher.isEncrypted(o.customer) ? cipher.decrypt(o.customer) : String(o.customer || '');
        const plainPhone = cipher.isEncrypted(o.phone) ? cipher.decrypt(o.phone) : String(o.phone || '');
        const plainAddr = cipher.isEncrypted(o.address) ? cipher.decrypt(o.address) : String(o.address || '');
        const pHash = plainPhone ? cipher.blindIndex(normalizePhoneForIndex(plainPhone)) : '';
        store.q('UPDATE orders SET customer = ?, phone = ?, address = ?, phone_hash = ? WHERE id = ?')
          .run(
            plainCust ? cipher.encrypt(plainCust) : '',
            plainPhone ? cipher.encrypt(plainPhone) : '',
            plainAddr ? cipher.encrypt(plainAddr) : '',
            pHash,
            o.id
          );
      }

      const plainCustomers = store.q(
        `SELECT id, user_id, name, phone, email, address, phone_hash FROM customers
         WHERE (name <> '' AND name NOT LIKE 'enc:v1:%')
            OR (phone <> '' AND phone NOT LIKE 'enc:v1:%')
            OR (email <> '' AND email NOT LIKE 'enc:v1:%')
            OR (address <> '' AND address NOT LIKE 'enc:v1:%')
            OR (phone <> '' AND (phone_hash IS NULL OR phone_hash = ''))`
      ).all();
      for (const c of plainCustomers) {
        const plainName = cipher.isEncrypted(c.name) ? cipher.decrypt(c.name) : String(c.name || '');
        const plainPhone = cipher.isEncrypted(c.phone) ? cipher.decrypt(c.phone) : String(c.phone || '');
        const plainEmail = cipher.isEncrypted(c.email) ? cipher.decrypt(c.email) : String(c.email || '');
        const plainAddr = cipher.isEncrypted(c.address) ? cipher.decrypt(c.address) : String(c.address || '');
        let pHash = plainPhone ? cipher.blindIndex(normalizePhoneForIndex(plainPhone)) : '';
        if (pHash) {
          const dup = store.q('SELECT id FROM customers WHERE user_id = ? AND phone_hash = ? AND id <> ?').get(c.user_id, pHash, c.id);
          if (dup) pHash = '';
        }
        store.q('UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, phone_hash = ? WHERE id = ?')
          .run(
            plainName ? cipher.encrypt(plainName) : '',
            plainPhone ? cipher.encrypt(plainPhone) : '',
            plainEmail ? cipher.encrypt(plainEmail) : '',
            plainAddr ? cipher.encrypt(plainAddr) : '',
            pHash,
            c.id
          );
      }
    });
  } catch (err) {
    logger.error('pii_startup_migration_error', { error: err?.message || String(err) });
  }

  const appUrlPath = (routePath) => {
    const base = (cfg.appUrl || 'http://localhost:3000').replace(/\/+$/, '');
    const cleanPath = String(routePath || '/').startsWith('/') ? String(routePath) : `/${String(routePath)}`;
    if (cfg.frontendRouting === 'path') {
      const mapped = cleanPath === '/pay' ? '/dashboard/billing' : cleanPath;
      return `${base}${mapped}`;
    }
    return `${base}/#${cleanPath}`;
  };

  const handlePlanExpired = (u, prevPlanArg) => {
    const prevPlan = prevPlanArg || u.prevPlan || 'paid';
    logAudit(null, 'plan.expired_downgrade', 'user', u.id, {
      from: prevPlan,
      to: 'free',
      expiredAt: u.expiredAt || null,
      storeName: u.store_name || ''
    });
    notify(
      u.id,
      'warning',
      'انتهى اشتراكك وتم تحويل حسابك للباقة المجانية',
      `انتهت صلاحية باقتك (${prevPlan}) وتم تحويل الحساب تلقائيًا إلى الباقة المجانية. يمكنك التجديد في أي وقت من صفحة الفوترة.`,
      '#/pay'
    );
    if (u.email) {
      const payUrl = appUrlPath('/dashboard/billing');
      Promise.resolve(mailer.send({
        to: u.email,
        subject: 'انتهى اشتراكك في OrderFlow — تم التحويل للباقة المجانية',
        type: 'plan_expired',
        url: payUrl,
        text: `مرحبًا ${u.store_name || ''}، انتهت صلاحية اشتراكك في باقة (${prevPlan}) وتم تحويل حسابك تلقائيًا إلى الباقة المجانية. يمكنك التجديد عبر: ${payUrl}`
      })).catch(() => {});
    }
  };

  const app = {
    cfg,
    ...store,
    logger,
    limiter,
    sqliteLimiter,
    cipher,
    session,
    mailer,
    sms,
    notify,
    logAudit,
    logPiiAccess,
    appUrlPath,
    sendSecurityAlert: (opts) => sendSecurityAlert(app, opts),
    trackOwnerLoginIp: (ownerUser, ip) => trackOwnerLoginIp(app, ownerUser, ip),
    getPlatformSettings,
    setPlatformSetting,
    requireOwner,
    requireModerator,
    requirePermission,
    requireAdmin,
    model: createModel(store.q, cipher, { onPlanExpired: handlePlanExpired })
  };
  appRef = app;
  app.payments = createPayments(app);
  app.connectors = createConnectors(app);
  app.couriers = createCouriers(app);

  app.testS3Connection = () => testS3Connection(cfg);
  app.createBackup = () => {
    const res = backupDatabase(store.db, cfg.backupDir, cfg.backupKeepCount, {
      encryptionKey: cfg.backupEncryptionKey || ''
    });
    setPlatformSetting('last_backup_at', res.createdAt);
    setPlatformSetting('last_backup_file', res.filename);
    setPlatformSetting('last_backup_encrypted', res.encrypted ? '1' : '0');
    const s3Configured = Boolean(cfg.backupS3Endpoint && cfg.backupS3Bucket && cfg.backupS3AccessKey && cfg.backupS3Secret);
    if (s3Configured) {
      setPlatformSetting('last_backup_upload_status', 'uploading');
      app.lastBackupUpload = { status: 'uploading', uploadedAt: null, key: '' };
      res.uploadPromise = uploadBackupToS3(res.file, cfg)
        .then((u) => {
          const status = u.uploaded ? `uploaded:${u.key}` : 'skipped';
          const uploadedAt = u.uploaded ? nowIso() : '';
          app.lastBackupUpload = { status, uploadedAt: uploadedAt || null, key: u.key || '' };
          try {
            setPlatformSetting('last_backup_upload_status', status);
            if (u.uploaded) {
              setPlatformSetting('last_backup_uploaded_at', uploadedAt);
              setPlatformSetting('last_backup_s3_key', u.key || '');
            }
          } catch (_) {}
          return u;
        })
        .catch((err) => {
          const errMsg = String(err?.message || 'error').slice(0, 120);
          const status = `failed:${errMsg}`;
          app.lastBackupUpload = { status, uploadedAt: null, key: '', error: errMsg };
          try {
            setPlatformSetting('last_backup_upload_status', status);
            app.sendSecurityAlert({
              severity: 'high',
              title: 'فشل رفع النسخة الاحتياطية إلى التخزين الخارجي S3',
              details: { file: res.filename, error: String(err?.message || '').slice(0, 180) }
            }).catch(() => {});
          } catch (_) {}
          return { uploaded: false, error: errMsg };
        });
    } else {
      setPlatformSetting('last_backup_upload_status', 'local_only');
      app.lastBackupUpload = { status: 'local_only', uploadedAt: null, key: '' };
    }
    return res;
  };
  app.listBackups = () => listBackups(cfg.backupDir);

  const router = createRouter();
  const serveStatic = createStatic(cfg.publicDir);

  for (const name of ['auth', 'catalog', 'orders', 'finance', 'account', 'integrations', 'billing', 'ai', 'services', 'owner', 'moderator', 'admin']) {
    require(`./routes/${name}`)(router, app);
  }
  router.get('/api/health', () => {
    let dbOk = false;
    try {
      dbOk = store.q('SELECT 1 AS ok').get()?.ok === 1;
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      db: dbOk,
      uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
      version: pkg.version || '1.0.0'
    };
  }, { auth: false });

  // مهمة الصيانة الدورية (كل ساعة): تنظيف التجريبي، حدود الطلبات، الباقات، إخفاء PII، سجل الوصول، حذف الحسابات، مطابقة كاشير، ومراقبة النسخ الاحتياطي
  const purge = () => {
    const now = nowIso();
    store.q('DELETE FROM users WHERE is_demo = 1 AND created_at < ?').run(new Date(Date.now() - cfg.demoTtlSec * 1000).toISOString());
    try {
      store.q('DELETE FROM auth_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)').run(now, new Date(Date.now() - 86400_000).toISOString());
    } catch (_) {}

    // TASK 6: تنظيف صفوف rate_limits المنتهية
    try { sqliteLimiter.purge(); } catch (_) {}

    // 1) تخفيض الباقات المنتهية تلقائيًا إلى free وإشعار التاجر
    try {
      const expired = store.q("SELECT * FROM users WHERE role = 'client' AND is_demo = 0 AND plan <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?").all(now);
      for (const u of expired) {
        app.model.enforcePlanExpiry(u);
      }
    } catch (_) {}

    // 2) تذكير قبل 3 أيام من انتهاء الاشتراك (مرة واحدة لكل دورة)
    try {
      const inThreeDays = new Date(Date.now() + 3 * 86400_000).toISOString();
      const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
      const soon = store.q(`SELECT * FROM users
        WHERE role = 'client' AND is_demo = 0 AND plan <> 'free'
          AND plan_expires_at IS NOT NULL AND plan_expires_at > ? AND plan_expires_at <= ?
          AND (plan_reminded_at IS NULL OR plan_reminded_at < ?)`).all(now, inThreeDays, threeDaysAgo);
      for (const u of soon) {
        const daysLeft = Math.max(1, Math.ceil((Date.parse(u.plan_expires_at) - Date.now()) / 86400_000));
        store.q('UPDATE users SET plan_reminded_at = ? WHERE id = ?').run(now, u.id);
        notify(
          u.id,
          'warning',
          `تذكير: اشتراكك ينتهي خلال ${daysLeft} ${daysLeft === 1 ? 'يوم' : 'أيام'}`,
          'جدّد اشتراكك من صفحة الفوترة لتفادي التحويل التلقائي إلى الباقة المجانية.',
          '#/pay'
        );
        if (u.email) {
          const payUrl = appUrlPath('/dashboard/billing');
          Promise.resolve(mailer.send({
            to: u.email,
            subject: `تذكير تجديد اشتراك OrderFlow — متبقي ${daysLeft} أيام`,
            type: 'plan_expiring_soon',
            url: payUrl,
            text: `مرحبًا ${u.store_name || ''}، يتبقى ${daysLeft} أيام على انتهاء باقتك الحالية (${u.plan}). جدّد اشتراكك من: ${payUrl}`
          })).catch(() => {});
        }
      }
    } catch (_) {}

    // 3) TASK 8: إخفاء بيانات المشترين (PII) للطلبات المكتملة/المرتجعة/الملغاة الأقدم من PII_RETENTION_DAYS
    try {
      const pSettings = getPlatformSettings();
      const retentionDays = Math.max(1, Number(pSettings.pii_retention_days || cfg.piiRetentionDays || 30) || 30);
      const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
      const anonLabel = cipher.encrypt('عميل محذوف البيانات');
      const ordersRes = store.q(`
        UPDATE orders
        SET customer = ?, phone = '', phone_hash = '', address = '', pii_purged_at = ?
        WHERE status IN (2, 3, 4)
          AND pii_purged_at IS NULL
          AND COALESCE(delivered_at, cancelled_at, created_at) <= ?
      `).run(anonLabel, now, cutoff);

      const customersRes = store.q(`
        UPDATE customers
        SET name = ?, phone = '', phone_hash = '', address = '', email = '', pii_purged_at = ?
        WHERE pii_purged_at IS NULL
          AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = customers.id)
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = customers.id AND o.pii_purged_at IS NULL)
      `).run(anonLabel, now);

      const ordersPurged = Number(ordersRes.changes || 0);
      const customersPurged = Number(customersRes.changes || 0);
      if (ordersPurged > 0 || customersPurged > 0) {
        logAudit(null, 'privacy.pii_purged', 'platform', null, {
          ordersPurged,
          customersPurged,
          retentionDays
        });
      }
    } catch (_) {}

    // 4) TASK 9: حذف سجلات pii_access_log الأقدم من سنة واحدة
    try {
      const oneYearAgo = new Date(Date.now() - 365 * 86400_000).toISOString();
      store.q('DELETE FROM pii_access_log WHERE created_at < ?').run(oneYearAgo);
    } catch (_) {}

    // 5) TASK 17: تنفيذ حذف الحسابات التي مر على طلب حذفها 14 يومًا مع الاحتفاظ بسجل مدفوعات مجهول الهوية لأغراض ضريبية
    try {
      const delCutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
      const doomed = store.q("SELECT id FROM users WHERE role = 'client' AND deletion_requested_at IS NOT NULL AND deletion_requested_at <= ?").all(delCutoff);
      for (const u of doomed) {
        store.tx(() => {
          const pays = store.q('SELECT * FROM plan_payments WHERE user_id = ?').all(u.id);
          for (const p of pays) {
            store.q(`INSERT INTO anonymized_payments (receipt_no, tx_ref, plan, cycle, amount, discount, currency, method, status, paid_at, created_at, anonymized_at)
              VALUES (?, ?, ?, ?, ?, ?, 'EGP', ?, ?, ?, ?, ?)`)
              .run(p.receipt_no || null, p.tx_ref, p.plan, p.cycle, p.amount, p.discount || 0, p.method, p.status, p.paid_at || null, p.created_at, now);
          }
          store.q('DELETE FROM users WHERE id = ?').run(u.id);
          logAudit(null, 'account.scheduled_delete_executed', 'user', u.id, { anonymizedPayments: pays.length });
        });
      }
    } catch (_) {}

    // 6) TASK 16: مطابقة مدفوعات كاشير المعلّقة لأكثر من 30 دقيقة
    try {
      if (typeof app.payments.reconcilePendingPayments === 'function') {
        Promise.resolve(app.payments.reconcilePendingPayments()).catch(() => {});
      }
    } catch (_) {}

    // 7) TASK 18C: تنبيه أمني إذا مرت 36 ساعة دون نسخة احتياطية ناجحة (لقواعد البيانات على القرص)
    try {
      if (cfg.dbFile && cfg.dbFile !== ':memory:') {
        const s = getPlatformSettings();
        const lastAt = s.last_backup_at ? Date.parse(s.last_backup_at) : 0;
        const staleMs = 36 * 3600_000;
        const overdue = lastAt ? (Date.now() - lastAt > staleMs) : (Date.now() - startedAtMs > staleMs);
        if (overdue) {
          const recentAlert = store.q(
            "SELECT id FROM security_events WHERE title LIKE '%النسخ الاحتياطي%' AND created_at > ?"
          ).get(new Date(Date.now() - 12 * 3600_000).toISOString());
          if (!recentAlert) {
            app.sendSecurityAlert({
              severity: 'high',
              title: 'تأخر النسخ الاحتياطي لقاعدة البيانات لأكثر من 36 ساعة',
              details: { lastBackupAt: s.last_backup_at || 'never' }
            }).catch(() => {});
          }
        }
      }
    } catch (_) {}
  };
  app.runPurge = purge;
  purge();
  const purgeTimer = setInterval(purge, 3600_000);
  purgeTimer.unref();

  // مزامنة خلفية مجدولة للربط النشط مع الأسواق (تمنع التداخل المتزامن)
  let autoSyncTimer = null;
  if (cfg.autoSyncIntervalMin > 0) {
    autoSyncTimer = setInterval(() => {
      app.connectors.syncAllActiveConnections().catch((e) => logger.error('auto_sync_error', { error: e?.message || String(e) }));
    }, cfg.autoSyncIntervalMin * 60_000);
    autoSyncTimer.unref();
  }

  // نسخ احتياطي يومي تلقائي لقاعدة البيانات عبر VACUUM INTO مع الاحتفاظ بآخر 7 نسخ
  let backupTimer = null;
  if (cfg.dbFile && cfg.dbFile !== ':memory:' && cfg.backupDir) {
    backupTimer = setInterval(() => {
      try { app.createBackup(); } catch (e) { logger.error('backup_error', { error: e?.message || String(e) }); }
    }, 24 * 3600_000);
    backupTimer.unref();
  }

  // معالجة طابور دفع المخزون الثنائي (sync_outbox) وتتبّع شحنات شركات الشحن دوريًا
  let outboxTimer = null;
  if (cfg.autoSyncIntervalMin > 0 && typeof app.connectors.processSyncOutbox === 'function') {
    outboxTimer = setInterval(() => {
      app.connectors.processSyncOutbox(20).catch((e) => logger.error('outbox_error', { error: e?.message || String(e) }));
    }, 60_000);
    outboxTimer.unref();
  }

  // معالجة طابور مزامنة المخزون اللحظي لمنع البيع الزائد كل 30 ثانية
  let inventorySyncTimer = null;
  if (cfg.dbFile && cfg.dbFile !== ':memory:' && typeof app.connectors.processInventorySyncQueue === 'function') {
    inventorySyncTimer = setInterval(() => {
      app.connectors.processInventorySyncQueue({ limit: 25 }).catch((e) => logger.error('inventory_sync_error', { error: e?.message || String(e) }));
    }, 30_000);
    inventorySyncTimer.unref();
  }

  let courierPollTimer = null;
  if (cfg.courierPollIntervalMin > 0 && typeof app.couriers.pollOpenShipments === 'function') {
    courierPollTimer = setInterval(() => {
      app.couriers.pollOpenShipments(50).catch((e) => logger.error('courier_poll_error', { error: e?.message || String(e) }));
    }, cfg.courierPollIntervalMin * 60_000);
    courierPollTimer.unref();
  }

  const allowedOriginsSet = new Set(
    cfg.allowedOrigins
      .map((u) => { try { return new URL(u).origin; } catch { return ''; } })
      .filter(Boolean)
  );
  const allowedHosts = new Set([cfg.appUrl, ...cfg.allowedOrigins].filter(Boolean).map((u) => { try { return new URL(u).host; } catch { return ''; } }).filter(Boolean));
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    const fHost = req.headers['x-forwarded-host'];
    const host = (cfg.trustProxy && fHost) || req.headers.host;
    try {
      const u = new URL(origin);
      if (u.host === host || allowedHosts.has(u.host) || allowedOriginsSet.has(u.origin)) return true;
      if (!cfg.enforcedProd && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
      return false;
    } catch { return false; }
  };

  const applyCors = (req, res) => {
    const origin = req.headers.origin;
    if (!origin) return false;
    let normalized = '';
    try { normalized = new URL(origin).origin; } catch { return false; }
    if (!allowedOriginsSet.has(normalized)) return false;
    res.setHeader('Access-Control-Allow-Origin', normalized);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Impersonate-Token, Idempotency-Key');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  };

  async function handleApi(req, res, url, reqId) {
    const corsMatched = applyCors(req, res);
    if (req.method === 'OPTIONS') {
      if (req.headers.origin && !corsMatched && !sameOrigin(req)) {
        throw new HttpError(403, 'النطاق غير مصرّح به (CORS)');
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = clientIp(req, cfg.trustProxy, cfg.trustProxyHops);
    if (!limiter.hit(`api:${ip}`, 600, 60_000)) throw new HttpError(429, 'طلبات كثيرة، انتظر قليلًا ثم حاول مجددًا');

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const { route, params, pathMatched } = router.match(method, url.pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'الطريقة غير مسموحة' : 'المسار غير موجود');

    if (method !== 'GET' && !route.webhook) {
      if (req.headers['x-requested-with'] !== 'omniarab' || !sameOrigin(req)) throw new HttpError(403, 'طلب غير مسموح');
    }

    const sess = session.inspect(req);
    const user = sess.user;

    const isOwnerRoute = route.owner || route.admin || url.pathname.startsWith('/api/owner') || url.pathname.startsWith('/api/admin');
    const isModRoute = route.moderator || url.pathname.startsWith('/api/moderator');

    // كشف الإبطال الفوري للجلسة (عند حذف أو إيقاف المشرف أو تغيير كلمة مروره)
    if (sess.revoked && route.auth) {
      session.clear(res);
      throw new HttpError(401, 'تم إنهاء جلستك بواسطة الإدارة، يرجى تسجيل الدخول مجددًا', { code: 'SESSION_REVOKED', reason: sess.reason });
    }

    // TASK 4: تقييد الجلسة إذا كانت مخصصة لإعداد المصادقة الثنائية الإلزامية (setup2fa: 1)
    if (user && user._setup2fa && !isAllowedDuring2faSetup(method, url.pathname)) {
      throw new HttpError(403, 'يجب تفعيل المصادقة الثنائية (2FA) أولاً قبل استخدام لوحة التحكم.', { code: '2FA_SETUP_REQUIRED' });
    }

    // حماية مسارات المالك والمشرفين: إرجاع 404 Not Found لغير المصرح لهم لإخفاء وجود اللوحات تمامًا
    if (isOwnerRoute) {
      requireOwner(user);
    } else if (isModRoute) {
      requireModerator(user);
      if (route.permission) requirePermission(user, route.permission);
    } else if (route.auth && !user) {
      throw new HttpError(401, 'سجّل الدخول للمتابعة', { code: 'AUTH' });
    }

    if (user && user._readOnly && method !== 'GET' && url.pathname !== '/api/auth/logout') {
      throw new HttpError(403, 'وضع المعاينة للقراءة فقط: لا يمكن إجراء تعديلات نيابة عن العميل', { code: 'READ_ONLY_IMPERSONATION' });
    }

    let body = {};
    let raw = Buffer.alloc(0);
    if (method !== 'GET') {
      raw = await readBody(req, route.maxBody || 1_000_000);
      if (raw.length) {
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'نوع المحتوى غير مدعوم');
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'صيغة JSON غير صالحة'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'صيغة الطلب غير صالحة');
        body = sanitizePayload(body);
      }
    }

    const out = await route.handler({ req, res, url, query: Object.fromEntries(url.searchParams), params, body, rawBody: raw, user, ip, sess, reqId });
    if (!res.writableEnded && !res.headersSent) sendJson(res, 200, out ?? { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    const reqStart = Date.now();
    const reqId = logger.requestId();
    res.setHeader('X-Request-Id', reqId);
    securityHeaders(res, cfg);
    let parsedPath = req.url || '/';
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); parsedPath = url.pathname; } catch { throw new HttpError(400, 'عنوان غير صالح'); }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, reqId);
        logger.debug('api_request', {
          reqId,
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          ms: Date.now() - reqStart
        });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'الطريقة غير مسموحة');

      // حماية الوصول المباشر من شريط العنوان لمسارات المالك والمشرفين (/owner, /moderator, /admin)
      const neededRole = requiredRoleForPath(url.pathname);
      if (neededRole) {
        const user = session.read(req);
        if (!canAccessPanel(user, neededRole)) {
          return sendText(res, 404, req.method === 'HEAD' ? '' : renderServer404Html(url.pathname), {
            'Content-Type': 'text/html; charset=utf-8'
          });
        }
      }

      if (!cfg.serveLegacySpa) {
        return sendJson(res, 404, { error: 'المسار غير موجود (واجهة Next.js تُقدَّم بشكل مستقل)' });
      }
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      logger.reportError(e, { reqId, method: req.method, path: parsedPath, source: 'http_500' });
      sendJson(res, 500, { error: 'حدث خطأ في الخادم، حاول مجددًا.', requestId: reqId });
    }
  });

  // حماية الخادم من هجمات Slowloris والاتصالات المعلّقة
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 64;

  const close = async () => {
    app.connectors.stop?.();
    clearInterval(purgeTimer);
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    if (backupTimer) clearInterval(backupTimer);
    if (outboxTimer) clearInterval(outboxTimer);
    if (inventorySyncTimer) clearInterval(inventorySyncTimer);
    if (courierPollTimer) clearInterval(courierPollTimer);
    limiter.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    store.close();
  };

  return {
    server,
    cfg,
    close,
    app,
    mailer,
    sms,
    logger,
    db: store.db,
    runPurge: app.runPurge,
    sendSecurityAlert: app.sendSecurityAlert,
    createBackup: app.createBackup
  };
}

module.exports = { createApp };
