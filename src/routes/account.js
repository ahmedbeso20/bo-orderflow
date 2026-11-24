'use strict';
const zlib = require('node:zlib');
const {
  verifyPassword, hashPassword, generateTotpSecret, verifyTotpCode,
  buildTotpUri, generateRecoveryCodes, normalizeRecoveryCode
} = require('../auth');
const { getLoginRedirect } = require('../rbac');
const { HttpError, bad, text, phone, email, password, oneOf, latin, nowIso, parseJson } = require('../util');
const { PLANS, INTEGRATION_KEYS, sanitizeIntegrations, NOTIFICATION_KEYS } = require('../domain');
const { generateQrSvg } = require('../qr');
const { seedDemo } = require('../seed');

const MARKET_KEYS = ['a', 'n', 'j', 't', 'k'];
const DAY_MS = 86400_000;

/** CRC32 table and zero-dependency ZIP archive writer (deflate via node:zlib) */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = ((((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate())) & 0xFFFF;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, compressed);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

module.exports = (r, app) => {
  const { q, tx, cfg, limiter, cipher, session, mailer, notify, logAudit, logPiiAccess, model, connectors, getPlatformSettings, sms } = app;
  const reload = (id) => q('SELECT * FROM users WHERE id = ?').get(id);
  const noDemo = (u) => { if (u.is_demo) throw new HttpError(403, 'هذا الإجراء غير متاح في الحساب التجريبي'); };

  /** كل ما تحتاجه الواجهة عند الفتح في طلب واحد */
  r.get('/api/bootstrap', ({ user }) => {
    const plat = getPlatformSettings();
    const conns = connectors.listForUser(user.id);
    const hasSeedData = Boolean(
      q("SELECT 1 FROM orders WHERE user_id = ? AND source = 'seed' LIMIT 1").get(user.id)
      || q("SELECT 1 FROM products WHERE user_id = ? AND source = 'seed' LIMIT 1").get(user.id)
    );
    return {
      me: model.meOf(user),
      settings: model.settingsOf(user),
      ...model.meta(user),
      products: model.productsOf(user.id),
      ai: parseJson(user.ai_cache, {}),
      payments: model.paymentsOf(user.id),
      marketplaceSchemas: connectors.PLATFORM_SCHEMAS,
      marketplaceConnections: conns,
      hasActiveConnection: conns.some((c) => c.configured && c.enabled),
      hasSeedData,
      piiRetentionDays: Math.max(1, Number(plat.pii_retention_days || cfg.piiRetentionDays || 30)),
      requireEmailVerification: plat.require_email_verification === '1',
      smsEnabled: Boolean(sms && sms.configured)
    };
  });

  async function verifyCurrentTotpWithReplay(cur, rawCode, { allowRecovery = false } = {}) {
    const code = String(rawCode || '').trim();
    if (!code) return { ok: false };
    const secret = cipher.decrypt(cur.totp_secret_enc);
    const step = verifyTotpCode(secret, code);
    if (step) {
      if (step <= Number(cur.totp_last_step || 0)) {
        throw new HttpError(401, 'تم استخدام رمز المصادقة الثنائية هذا بالفعل؛ انتظر الرمز التالي.', { code: 'REPLAY_2FA' });
      }
      q('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, cur.id);
      return { ok: true, step, usedRecovery: false };
    }
    if (allowRecovery) {
      const normRec = normalizeRecoveryCode(code);
      if (normRec.length >= 8) {
        const recs = q('SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL').all(cur.id);
        for (const rec of recs) {
          if (await verifyPassword(normRec, rec.code_hash)) {
            q('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?').run(nowIso(), rec.id);
            return { ok: true, step: 0, usedRecovery: true };
          }
        }
      }
    }
    return { ok: false };
  }

  async function requireSensitiveReauth(user, body, actionLabel = 'تعديل بيانات الحساب الحساسة') {
    const cur = reload(user.id);
    const curPass = String(body.currentPassword ?? body.password ?? '');
    if (!curPass || !(await verifyPassword(curPass, cur.pass_hash))) {
      throw new HttpError(403, `أدخل كلمة المرور الحالية لتأكيد ${actionLabel}`, { code: 'REAUTH_REQUIRED' });
    }
    if (cur.totp_enabled === 1 && cur.totp_secret_enc) {
      const check = await verifyCurrentTotpWithReplay(cur, body.totpCode || body.code || body.otp, { allowRecovery: false });
      if (!check.ok) {
        throw new HttpError(401, `أدخل رمز المصادقة الثنائية الصحيح لتأكيد ${actionLabel}`, { code: '2FA_REQUIRED' });
      }
    }
  }

  r.put('/api/settings', async ({ user, body }) => {
    const f = {};
    if (body.storeName !== undefined) f.store_name = text(body.storeName, 'اسم المتجر', { min: 2, max: 60 });
    if (body.taxId !== undefined) {
      const cleanTax = latin(text(body.taxId, 'الرقم الضريبي', { max: 20, optional: true }));
      if (!/^[0-9\- ]*$/.test(cleanTax)) throw bad('الرقم الضريبي: أرقام وشرطات فقط');
      f.tax_id = cleanTax ? cipher.encrypt(cleanTax) : '';
      f.tax_id_hash = cleanTax ? cipher.blindIndex(cleanTax) : '';
    }
    if (body.instaPayHandle !== undefined) {
      const cleanIpa = text(body.instaPayHandle, 'عنوان InstaPay', { max: 60, optional: true });
      f.instapay = cleanIpa ? cipher.encrypt(cleanIpa) : '';
    }
    let changingContact = false;
    if (!user.is_demo) { // الموبايل والبريد هما بيانات الدخول، فلا تُعدَّل في الحساب التجريبي
      if (body.storePhone !== undefined) {
        f.phone = phone(body.storePhone);
        if (f.phone !== user.phone) {
          f.phone_verified_at = null;
          changingContact = true;
        }
      }
      if (body.storeEmail !== undefined) {
        f.email = email(body.storeEmail);
        if ((f.email || null) !== (user.email || null)) {
          f.email_verified_at = null;
          changingContact = true;
        }
      }
    }
    if (changingContact) {
      await requireSensitiveReauth(user, body, 'تعديل البريد الإلكتروني أو رقم الموبايل');
    }
    if (f.phone && q('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(f.phone, user.id)) throw new HttpError(409, 'رقم الموبايل مستخدم في حساب آخر');
    if (f.email && q('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(f.email, user.id)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
    const keys = Object.keys(f); // أسماء الأعمدة ثابتة أعلاه فقط
    if (keys.length) q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), user.id);
    const fresh = reload(user.id);
    return { settings: model.settingsOf(fresh), me: model.meOf(fresh) };
  });

  // إرسال رمز تأكيد البريد الإلكتروني
  r.post('/api/account/verify-email/send', async ({ user, body }) => {
    noDemo(user);
    if (!limiter.hit(`vmail:${user.id}`, 5, 600_000)) throw new HttpError(429, 'طلبات كثيرة، انتظر قليلًا');
    let targetEmail = user.email;
    if (body && body.email) {
      targetEmail = email(body.email);
      if (targetEmail !== (user.email || null)) {
        await requireSensitiveReauth(user, body, 'تغيير البريد الإلكتروني');
        if (targetEmail && q('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(targetEmail, user.id)) {
          throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
        }
        q('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?').run(targetEmail, user.id);
      }
    }
    if (!targetEmail) throw bad('أضف بريدك الإلكتروني أولًا في إعدادات المتجر');
    const { token } = app.issueOneTimeToken(user.id, 'verify_email', 24 * 3600_000, targetEmail);
    await mailer.send({
      to: targetEmail,
      subject: 'تأكيد البريد الإلكتروني — OrderFlow',
      type: 'verify_email',
      token,
      url: app.appUrlPath(`/verify-email?token=${token}`),
      text: `رمز تأكيد بريدك الإلكتروني في OrderFlow هو: ${token}`
    });
    return { ok: true, email: targetEmail, ...(!cfg.enforcedProd ? { devToken: token } : {}) };
  });

  // تأكيد البريد الإلكتروني لحساب مسجّل الدخول
  r.post('/api/account/verify-email/confirm', ({ user, body }) => {
    noDemo(user);
    const row = app.consumeOneTimeToken(body.token, 'verify_email', (tokenRow) => {
      if (tokenRow.user_id !== user.id) throw bad('الرمز غير مخصص لهذا الحساب');
      const cur = reload(user.id);
      if (!tokenRow.target || !cur.email || cur.email.toLowerCase() !== tokenRow.target.toLowerCase()) {
        throw bad('الرمز لم يعد مطابقًا لبريدك الإلكتروني الحالي');
      }
    });
    const now = nowIso();
    q('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, row.user_id);
    const fresh = reload(user.id);
    return { ok: true, me: model.meOf(fresh), settings: model.settingsOf(fresh) };
  });

  // توثيق رقم الموبايل عبر SMS OTP
  r.post('/api/account/verify-phone/send', async ({ user }) => {
    noDemo(user);
    if (!user.phone) throw bad('أضف رقم موبايلك أولًا في إعدادات المتجر');
    const out = await app.issuePhoneOtp(user.id, user.phone, 'رمز تأكيد رقم موبايلك في OrderFlow');
    return { ok: true, phone: user.phone, expiresAt: out.expiresAt, ...(!cfg.enforcedProd ? { devOtp: out.code } : {}) };
  });

  r.post('/api/account/verify-phone/confirm', ({ user, body }) => {
    noDemo(user);
    app.verifyPhoneOtp(user.phone, body.code || body.otp, user.id);
    const now = nowIso();
    q('UPDATE users SET phone_verified_at = ? WHERE id = ?').run(now, user.id);
    notify(user.id, 'ok', 'تم توثيق رقم موبايلك بنجاح ✓', 'يمكنك الآن استخدام رقم الموبايل لاستعادة كلمة المرور والتنبيهات الهامة.', '#/set');
    const fresh = reload(user.id);
    return { ok: true, me: model.meOf(fresh), settings: model.settingsOf(fresh) };
  });

  // المصادقة الثنائية (2FA - TOTP) لحسابات المالك والمشرفين والتجار
  r.get('/api/account/2fa/status', ({ user }) => {
    const remainingRecovery = q('SELECT COUNT(*) n FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(user.id).n;
    return {
      enabled: Boolean(user.totp_enabled),
      mandatory: user.role === 'owner' || user.role === 'moderator',
      recommended: user.role === 'owner' || user.role === 'moderator',
      remainingRecoveryCodes: remainingRecovery
    };
  });

  r.post('/api/account/2fa/setup', async ({ user, body }) => {
    noDemo(user);
    const cur = reload(user.id);
    if (cur.totp_enabled === 1) {
      if (!limiter.hit(`2fa-setup:${user.id}`, 6, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
      const pwOk = Boolean(body.password && (await verifyPassword(String(body.password), cur.pass_hash)));
      if (!pwOk) {
        throw new HttpError(403, 'المصادقة الثنائية مفعّلة بالفعل. أدخل كلمة المرور الحالية ورمز المصادقة الثنائية الحالي لإعادة الإعداد.', { code: '2FA_ALREADY_ENABLED' });
      }
      const totpRes = await verifyCurrentTotpWithReplay(cur, body.totpCode || body.code || body.otp, { allowRecovery: false });
      if (!totpRes.ok) {
        throw new HttpError(403, 'المصادقة الثنائية مفعّلة بالفعل. أدخل رمز المصادقة الثنائية الحالي الصحيح لإعادة الإعداد.', { code: '2FA_ALREADY_ENABLED' });
      }
    }
    const secret = generateTotpSecret();
    // نخزّن السر الجديد في عمود معلّق فقط دون تعطيل 2FA الحالي أو المساس بـ totp_secret_enc
    q('UPDATE users SET totp_pending_secret_enc = ? WHERE id = ?').run(cipher.encrypt(secret), user.id);
    const otpauthUri = buildTotpUri({
      secret,
      accountName: cur.email || cur.phone || `user-${cur.id}`,
      issuer: 'OrderFlow'
    });
    return {
      ok: true,
      secret,
      otpauthUri,
      qrSvg: generateQrSvg(otpauthUri, {
        pixelSize: 220,
        margin: 4,
        darkColor: '#000000',
        lightColor: '#ffffff',
        errorCorrectionLevel: 'M'
      })
    };
  });

  r.post('/api/account/2fa/enable', async ({ user, body, res, ip }) => {
    noDemo(user);
    const cur = reload(user.id);
    if (!cur.totp_pending_secret_enc) throw bad('ابدأ إعداد المصادقة الثنائية أولًا للحصول على المفتاح');
    const secret = cipher.decrypt(cur.totp_pending_secret_enc);
    const code = String(body.code || body.totpCode || body.otp || '').trim();
    const step = verifyTotpCode(secret, code);
    if (!step) {
      throw bad('رمز التحقق غير صحيح. تأكد من إدخال الرمز المكوّن من ٦ أرقام من تطبيق المصادقة.');
    }
    if (cur.totp_enabled === 0 && step <= Number(cur.totp_last_step || 0)) {
      throw bad('تم استخدام هذا الرمز بالفعل، انتظر الرمز التالي.');
    }

    // توليد ١٠ أكواد استرداد ذات استخدام واحد وتخزين هاش scrypt فقط
    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = await Promise.all(recoveryCodes.map((c) => hashPassword(normalizeRecoveryCode(c))));
    const now = nowIso();
    tx(() => {
      q("UPDATE users SET totp_secret_enc = totp_pending_secret_enc, totp_pending_secret_enc = '', totp_enabled = 1, totp_last_step = ? WHERE id = ?").run(step, user.id);
      q('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(user.id);
      const ins = q('INSERT INTO totp_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)');
      for (const h of hashes) ins.run(user.id, h, now);
    });

    logAudit(user.id, 'security.2fa_enabled', 'user', user.id, { role: user.role }, ip);
    const fresh = reload(user.id);
    // ترقية الجلسة المقيدة إلى جلسة كاملة بعد تفعيل 2FA
    session.issue(res, fresh);
    if (fresh.role === 'owner' && app.trackOwnerLoginIp) {
      await app.trackOwnerLoginIp(fresh, ip);
    }
    return {
      ok: true,
      totpEnabled: true,
      recoveryCodes,
      me: model.meOf(fresh),
      settings: model.settingsOf(fresh),
      redirectTo: getLoginRedirect(fresh)
    };
  });

  r.post('/api/account/2fa/disable', async ({ user, body, ip }) => {
    noDemo(user);
    if (user.role === 'owner' || user.role === 'moderator') {
      throw new HttpError(403, 'المصادقة الثنائية إلزامية لحسابات المالك والمشرفين ولا يمكن تعطيلها.', { code: '2FA_MANDATORY_FOR_STAFF' });
    }
    if (!limiter.hit(`2fa-dis:${user.id}`, 6, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    if (!(await verifyPassword(String(body.password ?? ''), user.pass_hash))) {
      throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة');
    }
    const cur = reload(user.id);
    if (cur.totp_enabled && cur.totp_secret_enc) {
      const check = await verifyCurrentTotpWithReplay(cur, body.code || body.totpCode || body.otp, { allowRecovery: false });
      if (!check.ok) {
        throw new HttpError(401, 'أدخل رمز المصادقة الثنائية الصحيح لتعطيل الحماية');
      }
    }
    tx(() => {
      q("UPDATE users SET totp_enabled = 0, totp_secret_enc = '', totp_pending_secret_enc = '', totp_last_step = 0 WHERE id = ?").run(user.id);
      q('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(user.id);
    });
    logAudit(user.id, 'security.2fa_disabled', 'user', user.id, { role: user.role }, ip);
    const fresh = reload(user.id);
    return { ok: true, totpEnabled: false, me: model.meOf(fresh), settings: model.settingsOf(fresh) };
  });

  // حذف البيانات التجريبية فقط (source = 'seed') دون المساس بالبيانات اليدوية أو المتصلة بالأسواق
  r.delete('/api/account/seed-data', ({ user, ip }) => {
    const out = tx(() => {
      const delOrders = q("DELETE FROM orders WHERE user_id = ? AND source = 'seed'").run(user.id).changes;
      const delProducts = q("DELETE FROM products WHERE user_id = ? AND source = 'seed'").run(user.id).changes;
      const delCustomers = q(`DELETE FROM customers WHERE user_id = ? AND id NOT IN (
        SELECT DISTINCT customer_id FROM orders WHERE user_id = ? AND customer_id IS NOT NULL
      )`).run(user.id, user.id).changes;
      return { deletedOrders: delOrders, deletedProducts: delProducts, deletedCustomers: delCustomers };
    });
    logAudit(user.id, 'account.seed_data_deleted', 'user', user.id, out, ip);
    return { ok: true, ...out, ...model.meta(reload(user.id)) };
  });

  // تصدير جميع بيانات التاجر في ملف ZIP (قانون حماية البيانات الشخصية ١٥١ لسنة ٢٠٢٠)
  r.get('/api/account/export', ({ user, res, ip }) => {
    noDemo(user);
    if (!limiter.hit(`export-data:${user.id}`, 2, 86400_000)) {
      throw new HttpError(429, 'يمكنك تصدير نسخة كاملة من بياناتك مرتين كحد أقصى يوميًا.', { code: 'RATE_LIMITED' });
    }
    const profile = {
      ...model.meOf(user),
      settings: model.settingsOf(user),
      exportedAt: nowIso()
    };
    const products = model.productsOf(user.id);
    const orders = q('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(user.id).map(model.orderOf);
    const customers = q('SELECT * FROM customers WHERE user_id = ? ORDER BY id DESC').all(user.id).map(model.customerOf);
    const payments = model.paymentsOf(user.id);
    const notifications = q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC').all(user.id).map(model.notificationOf);

    const zipBuf = buildZip([
      { name: 'profile.json', content: JSON.stringify(profile, null, 2) },
      { name: 'products.json', content: JSON.stringify(products, null, 2) },
      { name: 'orders.json', content: JSON.stringify(orders, null, 2) },
      { name: 'customers.json', content: JSON.stringify(customers, null, 2) },
      { name: 'payments.json', content: JSON.stringify(payments, null, 2) },
      { name: 'notifications.json', content: JSON.stringify(notifications, null, 2) }
    ]);

    logAudit(user.id, 'account.data_export', 'user', user.id, { orders: orders.length, customers: customers.length, products: products.length }, ip);
    if (logPiiAccess) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: 'account_export_zip',
        targetType: 'account',
        targetId: user.id,
        count: orders.length + customers.length,
        ip
      });
    }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="orderflow-export-${user.id}.zip"`,
      'Content-Length': zipBuf.length,
      'Cache-Control': 'no-store'
    });
    res.end(zipBuf);
  });

  // طلب حذف الحساب مع مهلة سماح ١٤ يومًا قبل الحذف النهائي وأرشفة الفواتير الضريبية مجهولة الهوية
  r.post('/api/account/delete', async ({ user, body, ip }) => {
    noDemo(user);
    if (user.role === 'owner') {
      throw new HttpError(403, 'لا يمكن حذف حساب مالك المنصة لحماية استمرارية النظام.', { code: 'OWNER_PROTECTED' });
    }
    if (!limiter.hit(`delreq:${user.id}`, 5, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    if (!(await verifyPassword(String(body.password ?? ''), user.pass_hash))) {
      throw new HttpError(403, 'كلمة المرور غير صحيحة');
    }
    const cur = reload(user.id);
    if (cur.totp_enabled && cur.totp_secret_enc) {
      const check = await verifyCurrentTotpWithReplay(cur, body.code || body.totpCode || body.otp, { allowRecovery: true });
      if (!check.ok) {
        throw new HttpError(401, 'أدخل رمز المصادقة الثنائية الصحيح لتأكيد طلب حذف الحساب', { code: '2FA_REQUIRED' });
      }
    }
    const now = nowIso();
    const scheduled = new Date(Date.now() + 14 * DAY_MS).toISOString();
    q('UPDATE users SET deletion_requested_at = ? WHERE id = ?').run(now, user.id);
    logAudit(user.id, 'account.deletion_requested', 'user', user.id, { scheduledDeletionAt: scheduled }, ip);
    notify(user.id, 'warning', 'تم جدولة حذف الحساب بعد ١٤ يومًا', 'يمكنك إلغاء طلب حذف الحساب في أي وقت خلال ١٤ يومًا من صفحة الإعدادات.', '#/set');
    const fresh = reload(user.id);
    return {
      ok: true,
      deletionRequestedAt: now,
      scheduledDeletionAt: scheduled,
      me: model.meOf(fresh)
    };
  });

  r.post('/api/account/delete/cancel', ({ user, ip }) => {
    noDemo(user);
    q('UPDATE users SET deletion_requested_at = NULL WHERE id = ?').run(user.id);
    logAudit(user.id, 'account.deletion_cancelled', 'user', user.id, {}, ip);
    const fresh = reload(user.id);
    return { ok: true, me: model.meOf(fresh) };
  });

  r.put('/api/settings/integrations', ({ user, body }) => {
    const key = oneOf(body.key, INTEGRATION_KEYS, 'الربط');
    const on = body.on ? 1 : 0;
    const cur = sanitizeIntegrations(parseJson(user.integrations, {}));
    const plan = model.planOf(user);
    if (on && MARKET_KEYS.includes(key) && MARKET_KEYS.filter((k) => k !== key && cur[k]).length >= plan.markets) {
      throw new HttpError(402, `${plan.name} تتيح ربط ${plan.markets} أسواق فقط. رقّ باقتك لربط المزيد.`, { code: 'PLAN_LIMIT' });
    }
    cur[key] = on;
    q('UPDATE users SET integrations = ? WHERE id = ?').run(JSON.stringify(cur), user.id);
    return { integrations: cur };
  });

  r.put('/api/settings/notifications', ({ user, body }) => {
    const key = oneOf(body.key, NOTIFICATION_KEYS, 'التنبيه');
    const cur = parseJson(user.notifications, {});
    cur[key] = body.on ? 1 : 0;
    q('UPDATE users SET notifications = ? WHERE id = ?').run(JSON.stringify(cur), user.id);
    return { notifications: cur };
  });

  // نقطة الربط مع المنصات: تسحب البيانات الحقيقية لكل منصة مربوطة بـ API وتزامن العناصر المعتمدة
  r.post('/api/sync', async ({ user }) => {
    const markets = MARKET_KEYS.filter((k) => parseJson(user.integrations, {})[k]);
    if (!markets.length) throw new HttpError(409, 'فعّل ربط سوق واحد على الأقل من صفحة التكاملات أولًا');
    const now = nowIso();
    const names = { a: 'أمازون مصر', n: 'نون مصر', j: 'جوميا', t: 'ترينديول', k: 'كنز مصر' };

    const liveResults = [];
    for (const m of markets) {
      const res = await connectors.syncPlatform(user.id, m);
      if (res && res.live) liveResults.push(res);
    }

    q('UPDATE users SET last_sync_at = ? WHERE id = ?').run(now, user.id);
    const prodCount = q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'approved'").get(user.id).n;
    const totalStock = q("SELECT COALESCE(SUM(stock), 0) n FROM products WHERE user_id = ? AND approval_status = 'approved'").get(user.id).n;
    const pendingApprovalProducts = q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'pending'").get(user.id).n;
    const lowStock = q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'approved' AND stock <= 5").get(user.id).n;
    const pendingOrders = q("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND approval_status = 'approved' AND status = 0").get(user.id).n;
    const liveByKey = new Map(liveResults.map((x) => [x.platform, x]));
    const marketDetails = markets.map((m) => {
      const live = liveByKey.get(m);
      if (live) {
        return {
          key: m,
          name: names[m] || m,
          mode: 'live_api',
          ok: live.ok,
          status: live.ok ? `مزامنة API حية (+${live.importedProducts} منتج، +${live.importedOrders} طلب)` : `خطأ API: ${live.error}`,
          syncedAt: now
        };
      }
      return { key: m, name: names[m] || m, mode: 'local', ok: true, status: 'متصل ومزامَن محليًا', syncedAt: now };
    });
    const importedTotal = liveResults.reduce((s, r) => s + (r.importedProducts || 0) + (r.importedOrders || 0), 0);
    return {
      lastSyncAt: now,
      markets,
      products: prodCount,
      stock: totalStock,
      totalStock,
      orders: pendingOrders,
      pendingApprovalProducts,
      lowStock,
      pendingOrders,
      marketDetails,
      liveResults,
      connections: connectors.listForUser(user.id),
      message: liveResults.length
        ? `تمت المزامنة الحية عبر ${liveResults.length} منصة API (${importedTotal} عنصر جديد) — إجمالي ${prodCount} منتجًا و${pendingOrders} طلبًا.`
        : `تمت مزامنة ${prodCount} منتجًا معتمدًا (${totalStock} قطعة) و${pendingOrders} طلبًا معتمدًا بنجاح عبر ${markets.length} منصات.`
    };
  });

  // مركز الإشعارات
  r.get('/api/notifications', ({ user }) => {
    const list = q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id).map(model.notificationOf);
    const unreadCount = q('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n;
    return { notifications: list, unreadCount, counts: model.counts(user.id) };
  });

  r.post('/api/notifications/read-all', ({ user }) => {
    q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), user.id);
    return { ok: true, unreadCount: 0, counts: model.counts(user.id) };
  });

  r.post('/api/notifications/:id/read', ({ user, params }) => {
    q('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(nowIso(), Number(params.id) || 0, user.id);
    return { ok: true, counts: model.counts(user.id) };
  });

  r.delete('/api/notifications/:id', ({ user, params }) => {
    q('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(Number(params.id) || 0, user.id);
    return { ok: true, counts: model.counts(user.id) };
  });

  // مركز المساعدة وتذاكر الدعم الفني
  r.get('/api/support/tickets', ({ user }) => {
    const tickets = q('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(user.id);
    return { tickets };
  });

  r.post('/api/support/tickets', async ({ user, body }) => {
    const subject = text(body.subject, 'موضوع التذكرة', { min: 3, max: 140 });
    const message = text(body.message, 'تفاصيل المشكلة أو الاستفسار', { min: 5, max: 2000 });
    const now = nowIso();
    const info = q('INSERT INTO support_tickets (user_id, name, contact, subject, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, user.store_name, user.email || user.phone, subject, message, 'open', now);
    notify(user.id, 'info', `تم استلام تذكرة الدعم #${info.lastInsertRowid}`, `الموضوع: ${subject} — سيقوم فريق دعم OrderFlow بالرد عليك قريبًا.`, '#/help');
    await mailer.send({
      to: getPlatformSettings().support_email || 'support@orderflow.eg',
      subject: `[تذكرة دعم #${info.lastInsertRowid}] ${subject} — ${user.store_name}`,
      type: 'contact',
      text: `المتجر: ${user.store_name} (${user.email || user.phone})\nالموضوع: ${subject}\n\n${message}`
    });
    return { ok: true, ticket: q('SELECT * FROM support_tickets WHERE id = ?').get(info.lastInsertRowid) };
  });

  function checkPlanDowngradeLimits(user, target) {
    const used = model.planOf(user).used;
    if (target.products != null && used > target.products) {
      throw new HttpError(409, `لديك ${used} منتجًا والحد في ${target.name} هو ${target.products}. احذف الزائد أولًا.`);
    }
    const active = MARKET_KEYS.filter((k) => parseJson(user.integrations, {})[k]).length;
    if (active > target.markets) {
      throw new HttpError(409, `${target.name} تتيح ${target.markets} أسواق فقط. افصل سوقًا من صفحة التكاملات أولًا.`);
    }
  }

  // تغيير الباقة المباشر (محفوظ للتوافق مع الاختبارات والترقية السريعة)
  r.post('/api/plan', ({ user, body }) => {
    noDemo(user);
    if (!cfg.allowPlanSelfService) throw new HttpError(402, 'الدفع الإلكتروني غير مُفعّل بعد، تواصل معنا لتفعيل الباقة.', { code: 'PAYMENT_REQUIRED' });
    const target = PLANS[oneOf(body.plan, Object.keys(PLANS), 'الباقة')];
    const cycle = body.cycle === 'yearly' ? 'yearly' : 'monthly';
    checkPlanDowngradeLimits(user, target);
    const expiresAt = target.id === 'free' ? null : new Date(Date.now() + (cycle === 'yearly' ? 365 : 30) * DAY_MS).toISOString();
    q('UPDATE users SET plan = ?, plan_cycle = ?, plan_expires_at = ? WHERE id = ?').run(target.id, cycle, expiresAt, user.id);
    return { plan: model.planOf(reload(user.id)) };
  });

  app.checkPlanDowngradeLimits = checkPlanDowngradeLimits;

  r.post('/api/demo/reset', ({ user }) => {
    if (!user.is_demo) throw new HttpError(403, 'متاح للحساب التجريبي فقط');
    seedDemo(app, user.id);
    return { ok: true };
  });

  r.post('/api/account/password', async ({ user, body, res, ip }) => {
    noDemo(user);
    if (!limiter.hit(`pw:${user.id}`, 5, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    const cur = reload(user.id);
    if (!(await verifyPassword(String(body.current ?? ''), cur.pass_hash))) throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة');
    if (cur.totp_enabled === 1 && cur.totp_secret_enc) {
      const check = await verifyCurrentTotpWithReplay(cur, body.totpCode || body.code || body.otp, { allowRecovery: false });
      if (!check.ok) {
        throw new HttpError(401, 'أدخل رمز المصادقة الثنائية الصحيح لتأكيد تغيير كلمة المرور', { code: '2FA_REQUIRED' });
      }
    }
    const hash = await hashPassword(password(body.next, cur.phone));
    q('UPDATE users SET pass_hash = ?, token_ver = token_ver + 1 WHERE id = ?').run(hash, user.id);
    logAudit(user.id, 'security.password_change', 'user', user.id, { role: user.role }, ip);
    session.issue(res, reload(user.id)); // تنتهي الجلسات الأخرى ونُبقي هذه
    return { ok: true };
  });

  r.delete('/api/account', async ({ user, body, res, ip }) => {
    if (user.role === 'owner') {
      throw new HttpError(403, 'لا يمكن حذف حساب مالك المنصة من قاعدة البيانات لحماية استمرارية النظام.', { code: 'OWNER_PROTECTED' });
    }
    if (!user.is_demo) {
      if (!limiter.hit(`pw:${user.id}`, 5, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
      const cur = reload(user.id);
      if (!(await verifyPassword(String(body.password ?? ''), cur.pass_hash))) throw new HttpError(403, 'كلمة المرور غير صحيحة');
      if (cur.totp_enabled && cur.totp_secret_enc) {
        const check = await verifyCurrentTotpWithReplay(cur, body.code || body.totpCode || body.otp, { allowRecovery: true });
        if (!check.ok) {
          throw new HttpError(401, 'أدخل رمز المصادقة الثنائية الصحيح لتأكيد حذف الحساب', { code: '2FA_REQUIRED' });
        }
      }
      const now = nowIso();
      const archivedCount = tx(() => {
        const pays = q('SELECT * FROM plan_payments WHERE user_id = ?').all(user.id);
        for (const p of pays) {
          q(`INSERT INTO anonymized_payments (receipt_no, tx_ref, plan, cycle, amount, discount, currency, method, status, paid_at, created_at, anonymized_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(p.receipt_no || null, p.tx_ref, p.plan, p.cycle, p.amount, p.discount || 0, p.currency || 'EGP', p.method, p.status, p.updated_at || p.created_at, p.created_at, now);
        }
        logAudit(user.id, 'security.account_delete', 'user', user.id, {
          storeName: user.store_name,
          email: user.email || '',
          anonymizedPayments: pays.length
        }, ip);
        q('DELETE FROM users WHERE id = ?').run(user.id);
        return pays.length;
      });
      session.clear(res);
      return { ok: true, anonymizedPayments: archivedCount };
    }
    q('DELETE FROM users WHERE id = ?').run(user.id); // تُحذف بيانات الحساب التجريبي تلقائيًا
    session.clear(res);
    return { ok: true };
  });
};
