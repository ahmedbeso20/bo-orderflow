'use strict';
const crypto = require('node:crypto');
const {
  hashPassword, verifyPassword, verifyTotpCode,
  normalizeRecoveryCode
} = require('../auth');
const { checkLoginStatus, getLoginRedirect } = require('../rbac');
const { HttpError, bad, text, phone, email, password, clean, latin, nowIso } = require('../util');
const { verifyTurnstileToken } = require('../turnstile');
const { deriveSubkey } = require('../security');
const { seedDemo } = require('../seed');

const BAD_LOGIN = 'بيانات الدخول غير صحيحة';
const TERMS_VERSION = '2026-11';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = (r, app) => {
  const { q, tx, cfg, limiter, cipher, session, mailer, notify, logAudit, model, getPlatformSettings, sms } = app;
  const dummyHash = hashPassword(crypto.randomBytes(12).toString('hex'));
  const otpKey = deriveSubkey(cfg.secret, 'phone-otp-hmac-v1', 32);

  const issueOneTimeToken = (userId, type, ttlMs, target = '') => {
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = sha256(rawToken);
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();
    q('INSERT INTO auth_tokens (user_id, type, token_hash, target, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(userId, type, tokenHash, target, expiresAt, new Date(now).toISOString());
    return { token: rawToken, expiresAt };
  };

  const consumeOneTimeToken = (rawToken, type, validateFn = null) => {
    const tokenStr = clean(rawToken);
    if (!tokenStr) throw bad('الرمز غير صالح أو منتهي الصلاحية');
    const row = q('SELECT * FROM auth_tokens WHERE token_hash = ? AND type = ?').get(sha256(tokenStr), type);
    if (!row || row.used_at || row.expires_at <= nowIso()) {
      throw bad('الرمز غير صالح أو منتهي الصلاحية');
    }
    if (typeof validateFn === 'function') validateFn(row);
    q('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
    return row;
  };

  const issuePhoneOtp = async (userId, phoneNum, purposeText = 'رمز التحقق الخاص بك في OrderFlow') => {
    if (!sms || !sms.configured) {
      throw new HttpError(503, 'خدمة الرسائل النصية (SMS) غير مفعّلة حاليًا.');
    }
    if (!limiter.hit(`otp-cool:${phoneNum}`, 1, 60_000)) {
      throw new HttpError(429, 'انتظر ٦٠ ثانية قبل طلب رمز تحقق جديد.', { code: 'OTP_COOLDOWN' });
    }
    if (!limiter.hit(`otp-day:${phoneNum}`, 5, 86400_000)) {
      throw new HttpError(429, 'تجاوزت الحد اليومي لرسائل التحقق (٥ رسائل يوميًا).', { code: 'OTP_DAILY_LIMIT' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const hmacHex = crypto.createHmac('sha256', otpKey).update(`${userId}:${phoneNum}:${nonce}:${code}`, 'utf8').digest('hex');
    const tokenHash = `${nonce}:${hmacHex}`;
    const now = Date.now();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    // إبطال الرموز السابقة غير المستخدمة لنفس الرقم
    q("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND type = 'phone_otp' AND target = ? AND used_at IS NULL")
      .run(new Date(now).toISOString(), userId, phoneNum);
    const ins = q("INSERT INTO auth_tokens (user_id, type, token_hash, target, attempts, expires_at, created_at) VALUES (?, 'phone_otp', ?, ?, 0, ?, ?)")
      .run(userId, tokenHash, phoneNum, expiresAt, new Date(now).toISOString());

    const msgText = `${purposeText}: ${code} (صالح لمدة ١٠ دقائق)`;
    const sent = await sms.send({
      to: phoneNum,
      code,
      message: msgText
    });
    if (!sent || !sent.delivered) {
      q('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(nowIso(), Number(ins.lastInsertRowid));
      limiter.reset(`otp-cool:${phoneNum}`);
      throw new HttpError(502, sent?.error || 'تعذر إرسال رسالة التحقق SMS حاليًا');
    }
    return { code, expiresAt };
  };

  const verifyPhoneOtp = (phoneNum, rawCode, expectedUserId = null) => {
    const codeStr = latin(clean(rawCode)).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(codeStr)) throw new HttpError(401, 'رمز التحقق يجب أن يتكون من ٦ أرقام');
    const row = expectedUserId
      ? q("SELECT * FROM auth_tokens WHERE user_id = ? AND type = 'phone_otp' AND target = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1").get(expectedUserId, phoneNum)
      : q("SELECT * FROM auth_tokens WHERE type = 'phone_otp' AND target = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1").get(phoneNum);
    if (!row || row.expires_at <= nowIso()) {
      throw new HttpError(401, 'رمز التحقق غير صالح أو منتهي الصلاحية');
    }
    if ((row.attempts || 0) >= 5) {
      throw new HttpError(429, 'تم إيقاف الرمز بعد ٥ محاولات خاطئة؛ اطلب رمزًا جديدًا.', { code: 'OTP_LOCKED' });
    }
    const stored = String(row.token_hash || '');
    const parts = stored.split(':');
    let matched = false;
    if (parts.length === 2 && parts[0] && parts[1]) {
      const [nonce, expectedHex] = parts;
      const actualHex = crypto.createHmac('sha256', otpKey).update(`${row.user_id}:${phoneNum}:${nonce}:${codeStr}`, 'utf8').digest('hex');
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const actualBuf = Buffer.from(actualHex, 'hex');
      matched = expectedBuf.length === actualBuf.length && expectedBuf.length > 0 && crypto.timingSafeEqual(expectedBuf, actualBuf);
    } else {
      // توافق مؤقت مع أي رموز صادرة قبل الترقية
      const expectedBuf = Buffer.from(stored, 'hex');
      const actualBuf = Buffer.from(sha256(`${cfg.secret}:${codeStr}`), 'hex');
      matched = expectedBuf.length === actualBuf.length && expectedBuf.length > 0 && crypto.timingSafeEqual(expectedBuf, actualBuf);
    }
    if (!matched) {
      const nextAttempts = (row.attempts || 0) + 1;
      q('UPDATE auth_tokens SET attempts = ? WHERE id = ?').run(nextAttempts, row.id);
      if (nextAttempts >= 5) {
        q('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
        throw new HttpError(429, 'تم إيقاف الرمز بعد ٥ محاولات خاطئة؛ اطلب رمزًا جديدًا.', { code: 'OTP_LOCKED' });
      }
      throw new HttpError(401, 'رمز التحقق غير صحيح');
    }
    q('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
    return row;
  };

  async function verify2faOrRecovery(u, rawInput, ip) {
    // حد أقصى ٥ محاولات فاشلة لكل مستخدم خلال ١٥ دقيقة — المحاولة السادسة تُرجع 429 وتطلق تنبيهًا أمنيًا
    if (!limiter.hit(`2fa-user:${u.id}`, 5, 900_000)) {
      try { logAudit(u.id, 'security.2fa_locked', 'auth', u.id, { role: u.role }, ip); } catch (_) {}
      if (app.sendSecurityAlert) {
        await app.sendSecurityAlert({
          severity: 'high',
          title: 'قفل المصادقة الثنائية بسبب محاولات متكررة',
          details: { userId: u.id, role: u.role, ip }
        });
      }
      throw new HttpError(429, 'تم إيقاف التحقق الثنائي مؤقتًا بعد ٥ محاولات فاشلة. انتظر ١٥ دقيقة ثم حاول مجددًا.', { code: 'RATE_LIMITED' });
    }

    const secret = cipher.decrypt(u.totp_secret_enc);
    const step = verifyTotpCode(secret, rawInput);
    if (step) {
      const lastStep = Number(u.totp_last_step || 0);
      if (step <= lastStep) {
        try { logAudit(u.id, 'security.2fa_replay', 'auth', u.id, { role: u.role }, ip); } catch (_) {}
        throw new HttpError(401, 'تم استخدام رمز المصادقة الثنائية هذا بالفعل؛ انتظر الرمز التالي.', { code: 'REPLAY_2FA' });
      }
      q('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
      limiter.reset(`2fa-user:${u.id}`);
      return { ok: true, usedRecovery: false };
    }

    // التحقق من أكواد الاسترداد ذات الاستخدام الواحد
    const normalizedRecovery = normalizeRecoveryCode(rawInput);
    if (normalizedRecovery.length >= 8) {
      const recoveryRows = q('SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL').all(u.id);
      for (const rec of recoveryRows) {
        if (await verifyPassword(normalizedRecovery, rec.code_hash)) {
          q('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?').run(nowIso(), rec.id);
          limiter.reset(`2fa-user:${u.id}`);
          try { logAudit(u.id, 'security.2fa_recovery_used', 'auth', u.id, { role: u.role }, ip); } catch (_) {}
          return { ok: true, usedRecovery: true };
        }
      }
    }

    try { logAudit(u.id, 'security.2fa_failed', 'auth', u.id, { role: u.role }, ip); } catch (_) {}
    throw new HttpError(401, 'رمز المصادقة الثنائية أو كود الاسترداد غير صحيح أو منتهي الصلاحية', { code: 'INVALID_2FA' });
  }

  app.issueOneTimeToken = issueOneTimeToken;
  app.consumeOneTimeToken = consumeOneTimeToken;
  app.issuePhoneOtp = issuePhoneOtp;
  app.verifyPhoneOtp = verifyPhoneOtp;

  // إعدادات المصادقة العامة للواجهة
  r.get('/api/auth/config', () => {
    const plat = getPlatformSettings();
    return {
      smsEnabled: Boolean(sms && sms.configured),
      requireEmailVerification: plat.require_email_verification === '1',
      piiRetentionDays: Math.max(1, Number(plat.pii_retention_days || cfg.piiRetentionDays || 30)),
      termsVersion: TERMS_VERSION,
      turnstileEnabled: Boolean(cfg.turnstileSecretKey && cfg.turnstileSiteKey),
      turnstileSiteKey: cfg.turnstileSiteKey || ''
    };
  }, { auth: false });

  // فحص صامت لحالة الجلسة عبر كوكي HttpOnly بدون أخطاء 401 في الصفحات العامة
  r.get('/api/auth/session', ({ req }) => {
    const uid = session.read(req);
    return { authenticated: Boolean(uid), setup2faRequired: Boolean(uid && uid._setup2fa) };
  }, { auth: false });

  // تسجيل حساب عميل جديد — يُحفظ تلقائيًا بحالة قيد المراجعة (pending) ولا يُمنح جلسة دخول حتى تتم الموافقة
  r.post('/api/auth/register', async ({ body, res, ip }) => {
    if (!limiter.hit(`reg:${ip}`, 15, 3600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا');
    await verifyTurnstileToken(body.turnstileToken || body.captchaToken || body['cf-turnstile-response'], ip, cfg);
    const platSettings = getPlatformSettings();
    if (platSettings.registration_open === '0') {
      throw new HttpError(403, 'التسجيل الجديد متوقف مؤقتًا من قِبل إدارة المنصة.');
    }
    if (body.termsAccepted !== true) {
      throw bad('يجب الموافقة على الشروط وسياسة الخصوصية لإتمام التسجيل');
    }

    const store = text(body.store, 'اسم المتجر', { min: 2, max: 60 });
    const fullName = body.fullName ? text(body.fullName, 'الاسم الكامل', { min: 2, max: 80 }) : store;
    const ph = phone(body.phone);
    const mail = email(body.email);
    const pw = password(body.password, ph);

    if (platSettings.require_email_verification === '1' && !mail) {
      throw bad('البريد الإلكتروني مطلوب لإتمام التسجيل وتأكيد الحساب');
    }

    if (q('SELECT 1 FROM users WHERE phone = ?').get(ph)) throw new HttpError(409, 'رقم الموبايل مسجّل بالفعل، جرّب تسجيل الدخول');
    if (mail && q('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'البريد الإلكتروني مسجّل بالفعل');

    const requireApproval = platSettings.require_client_approval !== '0';
    const initialStatus = requireApproval ? 'pending' : 'active';
    const hash = await hashPassword(pw);
    const now = nowIso();
    let id;
    try {
      id = Number(q(`INSERT INTO users (phone, email, pass_hash, store_name, full_name, role, status, terms_accepted_at, terms_version, created_at)
        VALUES (?, ?, ?, ?, ?, 'client', ?, ?, ?, ?)`)
        .run(ph, mail, hash, store, fullName, initialStatus, now, TERMS_VERSION, now).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'الحساب مسجّل بالفعل');
      throw e;
    }

    if (mail) {
      const { token } = issueOneTimeToken(id, 'verify_email', 24 * 3600_000, mail);
      await mailer.send({
        to: mail,
        subject: 'تأكيد البريد الإلكتروني — OrderFlow',
        type: 'verify_email',
        token,
        url: app.appUrlPath(`/verify-email?token=${token}`),
        text: `رمز تأكيد بريدك الإلكتروني في OrderFlow هو: ${token}`
      });
    }

    const user = q('SELECT * FROM users WHERE id = ?').get(id);

    if (initialStatus === 'pending') {
      notify(id, 'info', 'طلب تسجيلك قيد المراجعة', 'شكرًا لتسجيلك في OrderFlow. سيقوم فريق الإشراف بمراجعة حسابك وتفعيله قريبًا.', '#/');
      return {
        ok: true,
        pending: true,
        status: 'pending',
        message: 'تم إنشاء حسابك بنجاح، وهو الآن قيد المراجعة من قِبل الإدارة. ستتمكن من تسجيل الدخول فور تفعيل الحساب.',
        account: { id: user.id, storeName: user.store_name, email: user.email || '', phone: user.phone, status: 'pending' }
      };
    }

    notify(id, 'info', 'مرحبًا بك في OrderFlow!', 'ابدأ بإضافة منتجاتك الأولى وسيتم مراجعتها واعتمادها للمزامنة مع الأسواق.', '#/prod');
    session.issue(res, user);
    return { ok: true, pending: false, status: 'active', me: model.meOf(user), redirectTo: getLoginRedirect(user) };
  }, { auth: false });

  // تسجيل الدخول الموحّد لجميع الأدوار (Owner / Moderator / Client) مع توجيه تلقائي وحماية من التخمين
  r.post('/api/auth/login', async ({ body, res, ip }) => {
    const raw = clean(body.id || body.email || body.phone);
    const pw = String(body.password ?? '');
    if (!raw || !pw) throw bad('أدخل البريد الإلكتروني أو رقم الموبايل وكلمة المرور');
    const byMail = raw.includes('@');
    let ident;
    try { ident = byMail ? raw.toLowerCase() : phone(raw); } catch { throw new HttpError(401, BAD_LOGIN); }

    // حماية مزدوجة: حد صارم لكل (IP + حساب) لمنع قفل الحساب بهجوم DoS + سقف أوسع للحساب
    if (
      !limiter.hit(`login-ip:${ip}`, 25, 600_000) ||
      !limiter.hit(`login-ip-id:${ip}:${ident}`, 5, 900_000) ||
      !limiter.hit(`login-id:${ident}`, 20, 900_000)
    ) {
      try { logAudit(null, 'security.login_rate_limited', 'auth', null, { ident: String(ident).slice(0, 60) }, ip); } catch (_) {}
      throw new HttpError(429, 'تم تجاوز الحد الأقصى لمحاولات تسجيل الدخول الفاشلة. انتظر ١٥ دقيقة ثم حاول مجددًا.', { code: 'RATE_LIMITED' });
    }

    // التحقق عبر Cloudflare Turnstile عند تمرير التوكن أو بعد فشل محاولتين لنفس (IP + حساب)
    const loginCaptchaTok = body.turnstileToken || body.captchaToken || body['cf-turnstile-response'];
    const failRow = q('SELECT n, reset_at FROM rate_limits WHERE key = ?').get(`login-fail:${ip}:${ident}`);
    const priorFails = (failRow && Number(failRow.reset_at) > Date.now()) ? Number(failRow.n || 0) : 0;
    if (cfg.turnstileSecretKey && (loginCaptchaTok || priorFails >= 2)) {
      if (!loginCaptchaTok) {
        throw new HttpError(400, 'يرجى إكمال التحقق الأمني (CAPTCHA) للمتابعة.', { code: 'CAPTCHA_REQUIRED', requiresCaptcha: true });
      }
      try {
        await verifyTurnstileToken(loginCaptchaTok, ip, cfg);
      } catch (err) {
        if (err instanceof HttpError) {
          throw new HttpError(err.status, err.message, { ...err.extra, requiresCaptcha: true });
        }
        throw err;
      }
    }

    const u = q(`SELECT * FROM users WHERE ${byMail ? 'email' : 'phone'} = ? AND is_demo = 0`).get(ident);
    const ok = await verifyPassword(pw, u ? u.pass_hash : await dummyHash);
    if (!u || !ok) {
      limiter.hit(`login-fail:${ip}:${ident}`, 100, 900_000);
      // تنبيه أمني عند تجاوز ٢٠ محاولة فاشلة لحساب أو ١٠٠ من نفس الـ IP خلال ساعة
      if (!limiter.hit(`alert-fail-id:${ident}`, 20, 3600_000) && limiter.hit(`alert-sent-id:${ident}`, 1, 3600_000)) {
        if (app.sendSecurityAlert) {
          await app.sendSecurityAlert({
            severity: 'high',
            title: 'محاولات دخول فاشلة متكررة على حساب',
            details: { ident: String(ident).slice(0, 60), ip }
          });
        }
      }
      if (!limiter.hit(`alert-fail-ip:${ip}`, 100, 3600_000) && limiter.hit(`alert-sent-ip:${ip}`, 1, 3600_000)) {
        if (app.sendSecurityAlert) {
          await app.sendSecurityAlert({
            severity: 'high',
            title: 'نشاط تسجيل دخول مشبوه من عنوان IP',
            details: { ip }
          });
        }
      }
      const nextFails = priorFails + 1;
      throw new HttpError(401, BAD_LOGIN, (cfg.turnstileSecretKey && nextFails >= 2) ? { requiresCaptcha: true } : {});
    }

    const statusCheck = checkLoginStatus(u);
    if (!statusCheck.allowed) {
      throw new HttpError(statusCheck.status, statusCheck.message, {
        code: statusCheck.code,
        ...(statusCheck.reason ? { reason: statusCheck.reason } : {})
      });
    }

    // المصادقة الثنائية إلزامية للمالك والمشرفين: إذا لم تكن مفعّلة نُصدر جلسة إعداد مقيدة
    if ((u.role === 'owner' || u.role === 'moderator') && u.totp_enabled !== 1) {
      limiter.reset(`login-ip-id:${ip}:${ident}`);
      limiter.reset(`login-fail:${ip}:${ident}`);
      limiter.reset(`login-id:${ident}`);
      session.issue(res, u, { setup2fa: true });
      return {
        ok: true,
        setup2faRequired: true,
        me: model.meOf({ ...u, _setup2fa: true }),
        redirectTo: '#/setup-2fa',
        message: 'المصادقة الثنائية (2FA) إلزامية لحسابك. يرجى تفعيلها الآن قبل متابعة العمل.'
      };
    }

    // فحص المصادقة الثنائية (2FA - TOTP) إن كانت مفعّلة على الحساب
    if (u.totp_enabled === 1 && u.totp_secret_enc) {
      const otpInput = clean(body.totpCode || body.otp || body.code || '');
      if (!otpInput) {
        const challengeToken = session.issue2faChallenge(u);
        return {
          ok: false,
          requires2fa: true,
          challengeToken,
          role: u.role,
          message: 'أدخل رمز المصادقة الثنائية (٦ أرقام) أو أحد أكواد الاسترداد لإتمام تسجيل الدخول.'
        };
      }
      await verify2faOrRecovery(u, otpInput, ip);
    }

    limiter.reset(`login-ip-id:${ip}:${ident}`);
    limiter.reset(`login-fail:${ip}:${ident}`);
    limiter.reset(`login-id:${ident}`);
    session.issue(res, u);
    if (u.role === 'owner' && app.trackOwnerLoginIp) {
      await app.trackOwnerLoginIp(u, ip);
    }
    return { ok: true, me: model.meOf(u), redirectTo: getLoginRedirect(u) };
  }, { auth: false });

  // استكمال تسجيل الدخول عبر رمز المصادقة الثنائية (TOTP 2FA أو كود استرداد)
  r.post('/api/auth/login/2fa', async ({ body, res, ip }) => {
    if (!limiter.hit(`login-2fa:${ip}`, 20, 600_000)) {
      throw new HttpError(429, 'محاولات كثيرة للتحقق الثنائي، انتظر قليلًا ثم حاول مجددًا', { code: 'RATE_LIMITED' });
    }
    const challengeToken = clean(body.challengeToken);
    const code = clean(body.code || body.totpCode || body.otp || '');
    if (!challengeToken || !code) throw bad('أدخل رمز المصادقة الثنائية لإتمام تسجيل الدخول');

    const u = session.verify2faChallenge(challengeToken);
    if (!u) {
      throw new HttpError(401, 'انتهت صلاحية جلسة التحقق الثنائي، سجّل الدخول مجددًا', { code: 'EXPIRED_2FA_CHALLENGE' });
    }
    const statusCheck = checkLoginStatus(u);
    if (!statusCheck.allowed) {
      throw new HttpError(statusCheck.status, statusCheck.message, { code: statusCheck.code });
    }
    if (!u.totp_enabled || !u.totp_secret_enc) {
      throw new HttpError(400, 'المصادقة الثنائية غير مفعّلة لهذا الحساب');
    }
    await verify2faOrRecovery(u, code, ip);

    session.issue(res, u);
    if (u.role === 'owner' && app.trackOwnerLoginIp) {
      await app.trackOwnerLoginIp(u, ip);
    }
    return { ok: true, me: model.meOf(u), redirectTo: getLoginRedirect(u) };
  }, { auth: false });

  // فحص فوري لصلاحية الجلسة — يكتشف الإبطال الفوري لحظة إيقاف أو حذف المشرف
  r.get('/api/auth/session-check', ({ user }) => ({
    ok: true,
    me: model.meOf(user),
    redirectTo: user._setup2fa ? '#/setup-2fa' : getLoginRedirect(user)
  }));

  // طلب رمز استعادة كلمة المرور (عبر البريد الإلكتروني أو SMS OTP للحسابات بدون بريد)
  r.post('/api/auth/forgot-password', async ({ body, ip }) => {
    if (!limiter.hit(`forgot-ip:${ip}`, 15, 600_000)) throw new HttpError(429, 'طلبات كثيرة، حاول بعد قليل');
    await verifyTurnstileToken(body.turnstileToken || body.captchaToken || body['cf-turnstile-response'], ip, cfg);
    const raw = clean(body.id || body.email || body.phone);
    if (!raw) throw bad('أدخل رقم الموبايل أو البريد الإلكتروني المسجّل');
    const byMail = raw.includes('@');
    let ident = null;
    try { ident = byMail ? email(raw) : phone(raw); } catch { ident = null; }
    let devToken = undefined;
    let devOtp = undefined;
    let method = byMail ? 'email' : 'sms';

    if (body.viaSms && (!sms || !sms.configured)) {
      throw new HttpError(400, 'خدمة استعادة كلمة المرور عبر SMS غير مفعّلة حاليًا؛ يرجى استخدام البريد الإلكتروني.');
    }

    if (ident) {
      const u = q(`SELECT * FROM users WHERE ${byMail ? 'email' : 'phone'} = ? AND is_demo = 0`).get(ident);
      // نمنع استعادة كلمة المرور العامة لحسابات المالك والمشرفين (دون كشف وجود الحساب)
      if (u && u.status === 'active' && u.role === 'client') {
        const useSms = Boolean(body.viaSms) || (!byMail && !u.email);
        if (useSms && u.phone && sms && sms.configured) {
          const out = await issuePhoneOtp(u.id, u.phone, 'رمز استعادة كلمة مرورك في OrderFlow');
          method = 'sms';
          if (!cfg.enforcedProd) devOtp = out.code;
        } else if (u.email) {
          const { token } = issueOneTimeToken(u.id, 'reset_password', 30 * 60_000, u.email);
          await mailer.send({
            to: u.email,
            subject: 'إعادة تعيين كلمة المرور — OrderFlow',
            type: 'reset_password',
            token,
            url: app.appUrlPath(`/reset-password?token=${token}`),
            text: `رمز إعادة تعيين كلمة المرور لحسابك في OrderFlow (صالح لمدة ٣٠ دقيقة): ${token}`
          });
          method = 'email';
          if (!cfg.enforcedProd) devToken = token;
        } else if (u.phone && sms && sms.configured) {
          const out = await issuePhoneOtp(u.id, u.phone, 'رمز استعادة كلمة مرورك في OrderFlow');
          method = 'sms';
          if (!cfg.enforcedProd) devOtp = out.code;
        }
      }
    }
    return {
      ok: true,
      method,
      message: method === 'sms'
        ? 'إذا كان رقم الموبايل مسجّلًا ونشطًا لدينا، فقد أرسلنا رمز تحقق مكوّن من ٦ أرقام عبر SMS.'
        : 'إذا كان الحساب مسجّلًا ونشطًا لدينا، فقد أرسلنا رمز ورابط إعادة تعيين كلمة المرور.',
      ...(devToken ? { devToken } : {}),
      ...(devOtp ? { devOtp } : {})
    };
  }, { auth: false });

  // استعادة كلمة المرور عبر رمز البريد الإلكتروني
  r.post('/api/auth/reset-password', async ({ body, res, ip }) => {
    if (!limiter.hit(`reset-ip:${ip}`, 15, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    const tokenRow = consumeOneTimeToken(body.token, 'reset_password');
    const u = q('SELECT * FROM users WHERE id = ?').get(tokenRow.user_id);
    if (!u || u.status !== 'active' || u.role !== 'client') throw new HttpError(403, 'الحساب غير متاح');
    const nextPw = password(body.password, u.phone);
    const hash = await hashPassword(nextPw);
    q('UPDATE users SET pass_hash = ?, token_ver = token_ver + 1 WHERE id = ?').run(hash, u.id);
    const fresh = q('SELECT * FROM users WHERE id = ?').get(u.id);
    logAudit(u.id, 'security.password_reset', 'user', u.id, { method: 'email', totpEnabled: Boolean(fresh.totp_enabled) }, ip);
    if (fresh.totp_enabled === 1) {
      session.clear(res);
      const challengeToken = session.issue2faChallenge(fresh);
      return {
        ok: true,
        passwordReset: true,
        requiresLogin: true,
        requires2fa: true,
        challengeToken,
        message: 'تم تحديث كلمة المرور بنجاح. سجّل الدخول الآن بكلمة المرور الجديدة ورمز المصادقة الثنائية.'
      };
    }
    session.issue(res, fresh);
    return { ok: true, me: model.meOf(fresh), redirectTo: getLoginRedirect(fresh) };
  }, { auth: false });

  // استعادة كلمة المرور عبر رمز SMS OTP
  r.post('/api/auth/reset-password/otp', async ({ body, res, ip }) => {
    if (!limiter.hit(`reset-otp-ip:${ip}`, 15, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    const ph = phone(body.phone);
    const otpRow = verifyPhoneOtp(ph, body.code || body.otp);
    const u = q('SELECT * FROM users WHERE id = ? AND is_demo = 0').get(otpRow.user_id);
    if (!u || u.status !== 'active' || u.role !== 'client') throw new HttpError(403, 'الحساب غير متاح');
    const nextPw = password(body.password, u.phone);
    const hash = await hashPassword(nextPw);
    const now = nowIso();
    q('UPDATE users SET pass_hash = ?, token_ver = token_ver + 1, phone_verified_at = COALESCE(phone_verified_at, ?) WHERE id = ?')
      .run(hash, now, u.id);
    const fresh = q('SELECT * FROM users WHERE id = ?').get(u.id);
    logAudit(u.id, 'security.password_reset', 'user', u.id, { method: 'sms_otp', totpEnabled: Boolean(fresh.totp_enabled) }, ip);
    if (fresh.totp_enabled === 1) {
      session.clear(res);
      const challengeToken = session.issue2faChallenge(fresh);
      return {
        ok: true,
        passwordReset: true,
        requiresLogin: true,
        requires2fa: true,
        challengeToken,
        message: 'تم تحديث كلمة المرور بنجاح. سجّل الدخول الآن بكلمة المرور الجديدة ورمز المصادقة الثنائية.'
      };
    }
    session.issue(res, fresh);
    return { ok: true, me: model.meOf(fresh), redirectTo: getLoginRedirect(fresh) };
  }, { auth: false });

  r.post('/api/auth/verify-email', ({ body }) => {
    const tokenRow = consumeOneTimeToken(body.token, 'verify_email', (row) => {
      const u = q('SELECT id, email FROM users WHERE id = ?').get(row.user_id);
      if (!row.target || !u || !u.email || u.email.toLowerCase() !== row.target.toLowerCase()) {
        throw bad('الرمز لم يعد مطابقًا لبريدك الإلكتروني الحالي');
      }
    });
    const now = nowIso();
    q('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, tokenRow.user_id);
    notify(tokenRow.user_id, 'ok', 'تم توثيق بريدك الإلكتروني بنجاح ✓', 'شكراً لتأكيد بريدك الإلكتروني الرسمي على منصة OrderFlow.', '#/set');
    return { ok: true, verified: true, emailVerifiedAt: now };
  }, { auth: false });

  // إعادة إرسال رابط توثيق البريد الإلكتروني (٣ مرات في الساعة كحد أقصى)
  r.post('/api/auth/resend-verification', async ({ user }) => {
    if (user.is_demo) throw new HttpError(403, 'هذا الإجراء غير متاح في الحساب التجريبي');
    if (!user.email) throw bad('أضف بريدك الإلكتروني أولًا في إعدادات المتجر');
    if (user.email_verified_at) return { ok: true, alreadyVerified: true };
    if (!limiter.hit(`verify-resend:${user.id}`, 3, 3600_000)) {
      throw new HttpError(429, 'تجاوزت الحد المسموح لإعادة الإرسال (٣ مرات في الساعة). انتظر قليلًا.', { code: 'RATE_LIMITED' });
    }
    const { token } = issueOneTimeToken(user.id, 'verify_email', 24 * 3600_000, user.email);
    await mailer.send({
      to: user.email,
      subject: 'تأكيد البريد الإلكتروني — OrderFlow',
      type: 'verify_email',
      token,
      url: app.appUrlPath(`/verify-email?token=${token}`),
      text: `رمز تأكيد بريدك الإلكتروني في OrderFlow هو: ${token}`
    });
    return { ok: true, email: user.email, ...(!cfg.enforcedProd ? { devToken: token } : {}) };
  });

  r.post('/api/contact', async ({ body, user, ip }) => {
    if (!limiter.hit(`contact:${ip}`, 10, 600_000)) throw new HttpError(429, 'طلبات كثيرة، حاول بعد قليل');
    await verifyTurnstileToken(body.turnstileToken || body.captchaToken || body['cf-turnstile-response'], ip, cfg);
    const name = text(body.name, 'الاسم', { min: 2, max: 80 });
    const contact = text(body.contact || body.email || body.phone, 'وسيلة التواصل', { min: 4, max: 120 });
    const subject = text(body.subject || 'استفسار عام', 'الموضوع', { min: 2, max: 140 });
    const message = text(body.message, 'الرسالة', { min: 5, max: 2000 });
    const info = q('INSERT INTO support_tickets (user_id, name, contact, subject, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user ? user.id : null, name, contact, subject, message, 'open', nowIso());
    await mailer.send({
      to: getPlatformSettings().support_email || 'support@orderflow.eg',
      subject: `[تواصل معنا] ${subject} — ${name}`,
      type: 'contact',
      text: `من: ${name} (${contact})\n${message}`
    });
    return { ok: true, ticketId: Number(info.lastInsertRowid) };
  }, { auth: false });

  // حساب تجريبي مؤقت ببيانات جاهزة (يُحذف بعد ٢٤ ساعة)
  r.post('/api/auth/demo', async ({ body, res, ip }) => {
    if (!limiter.hit(`demo:${ip}`, 15, 3600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا', { code: 'RATE_LIMITED' });
    await verifyTurnstileToken(body.turnstileToken || body.captchaToken || body['cf-turnstile-response'], ip, cfg);
    const demoCount = q('SELECT COUNT(*) n FROM users WHERE is_demo = 1').get().n;
    if (demoCount >= cfg.maxDemos) {
      try {
        q('DELETE FROM users WHERE is_demo = 1 AND id IN (SELECT id FROM users WHERE is_demo = 1 ORDER BY created_at ASC LIMIT 10)').run();
      } catch (_) {}
    }
    const id = tx(() => {
      const tag = crypto.randomBytes(6).toString('hex');
      const info = q(`INSERT INTO users (phone,pass_hash,store_name,full_name,role,status,plan,is_demo,integrations,tax_id,tax_id_hash,instapay,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`demo-${tag}`, '!', 'متجر النور للإلكترونيات', 'متجر النور للإلكترونيات', 'client', 'active', 'pro', 1,
        JSON.stringify({ a: 1, n: 1, j: 1, bs: 1, ar: 1, my: 0 }), cipher.encrypt('412-890-115'), cipher.blindIndex('412-890-115'), cipher.encrypt('elnoor.store@instapay'), nowIso());
      seedDemo(app, Number(info.lastInsertRowid));
      return info.lastInsertRowid;
    });
    const user = q('SELECT * FROM users WHERE id = ?').get(id);
    session.issue(res, user);
    return { ok: true, me: model.meOf(user), redirectTo: '#/dash' };
  }, { auth: false });

  r.post('/api/auth/logout', ({ res, user }) => {
    // إبطال الجلسة على مستوى الخادم فورًا لمنع إعادة استخدام الكوكي المسروق بعد تسجيل الخروج
    if (user && !user._readOnly && !user.is_demo) {
      q('UPDATE users SET token_ver = token_ver + 1 WHERE id = ?').run(user.id);
    }
    session.clear(res);
    return { ok: true };
  }, { auth: false });

  r.post('/api/auth/logout-all', ({ res, user, ip }) => {
    if (!user._readOnly) {
      q('UPDATE users SET token_ver = token_ver + 1 WHERE id = ?').run(user.id);
      logAudit(user.id, 'security.logout_all', 'user', user.id, { role: user.role }, ip);
    }
    session.clear(res);
    return { ok: true };
  });

  r.get('/api/auth/me', ({ user }) => ({
    ok: true,
    authenticated: true,
    setup2faRequired: Boolean(user._setup2fa),
    me: model.meOf(user),
    redirectTo: user._setup2fa ? '#/setup-2fa' : getLoginRedirect(user)
  }));
};
