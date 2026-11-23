'use strict';
// واجهة المالك الوحيد (/api/owner/*): محمية بالكامل بـ requireOwner (404 لغير المالك)، وتدير المشرفين (بحد أقصى 3) والعملاء وإعدادات المنصة وسجل المراقبة
const { hashPassword } = require('../auth');
const {
  ROLES,
  MAX_MODERATORS,
  MODERATOR_PERMISSION_META,
  normalizePermissions,
  assertModeratorLimit,
  assertActiveModeratorLimit,
  assertNotOwnerTarget
} = require('../rbac');
const { HttpError, bad, text, phone, email, password, money, integer, oneOf, latin, round2, toCsv, nowIso } = require('../util');
const { PLANS } = require('../domain');

const DAY_MS = 86400_000;

module.exports = (r, app) => {
  const { q, tx, cfg, cipher, session, mailer, notify, logAudit, model, getPlatformSettings, setPlatformSetting } = app;
  const dec = (v) => (cipher ? cipher.decrypt(v) : String(v || ''));

  const systemStatusOf = () => {
    const backups = app.listBackups ? app.listBackups() : [];
    const lastBackup = backups[0] || null;
    const plat = getPlatformSettings();
    const unackSecurityEvents = q('SELECT COUNT(*) n FROM security_events WHERE acknowledged_at IS NULL').get().n;
    return {
      production: Boolean(cfg.enforcedProd),
      mailConfigured: Boolean(mailer && mailer.configured),
      mailProvider: mailer ? mailer.activeProvider : 'memory',
      smsConfigured: Boolean(app.sms && app.sms.configured),
      paymentProvider: cfg.payments.provider || null,
      paymentMode: cfg.payments.provider === 'kashier' ? (cfg.payments.kashierMode || 'test') : (cfg.payments.provider || 'none'),
      piiRetentionDays: Math.max(1, Number(plat.pii_retention_days || cfg.piiRetentionDays || 30)),
      requireEmailVerification: plat.require_email_verification === '1',
      lastBackupAt: lastBackup ? lastBackup.createdAt : null,
      lastBackupFile: lastBackup ? lastBackup.file : null,
      lastBackupEncrypted: lastBackup ? Boolean(lastBackup.encrypted) : false,
      lastBackupUploadStatus: app.lastBackupUpload ? app.lastBackupUpload.status : (cfg.backupS3Bucket ? 'pending' : 'local_only'),
      unackSecurityEvents
    };
  };

  const clientRowOf = (u) => ({
    id: u.id,
    storeName: u.store_name,
    fullName: u.full_name || u.store_name,
    phone: u.phone,
    email: u.email || '',
    emailVerified: Boolean(u.email_verified_at),
    role: u.role || ROLES.CLIENT,
    status: u.status || 'pending',
    rejectReason: u.reject_reason || '',
    reviewedBy: u.reviewed_by || null,
    reviewedByName: u.reviewer_name || '',
    reviewedAt: u.reviewed_at || null,
    plan: u.plan,
    planName: (PLANS[u.plan] || PLANS.free).name,
    planCycle: u.plan_cycle || 'monthly',
    planExpiresAt: u.plan_expires_at || null,
    taxId: dec(u.tax_id),
    instaPayHandle: dec(u.instapay),
    isDemo: Boolean(u.is_demo),
    productsCount: u.products_count ?? q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(u.id).n,
    approvedProductsCount: u.approved_products_count ?? q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'approved'").get(u.id).n,
    ordersCount: u.orders_count ?? q('SELECT COUNT(*) n FROM orders WHERE user_id = ?').get(u.id).n,
    totalPaid: round2(u.total_paid ?? q("SELECT COALESCE(SUM(amount), 0) s FROM plan_payments WHERE user_id = ? AND status = 'paid'").get(u.id).s),
    createdAt: u.created_at,
    lastSyncAt: u.last_sync_at || null
  });

  const moderatorRowOf = (u) => ({
    id: u.id,
    fullName: u.full_name || u.store_name,
    email: u.email || '',
    phone: u.phone,
    role: ROLES.MODERATOR,
    status: u.status,
    totpEnabled: Boolean(u.totp_enabled),
    permissions: normalizePermissions(u.permissions),
    approvedCount: u.approved_count ?? q("SELECT COUNT(*) n FROM audit_log WHERE admin_id = ? AND action = 'client.approve'").get(u.id).n,
    rejectedCount: u.rejected_count ?? q("SELECT COUNT(*) n FROM audit_log WHERE admin_id = ? AND action = 'client.reject'").get(u.id).n,
    totalActions: u.total_actions ?? q('SELECT COUNT(*) n FROM audit_log WHERE admin_id = ?').get(u.id).n,
    createdAt: u.created_at
  });

  const findClientStrict = (id) => {
    const u = q("SELECT * FROM users WHERE id = ? AND role = 'client' AND is_demo = 0").get(Number(id) || 0);
    if (!u) throw new HttpError(404, 'حساب العميل غير موجود');
    assertNotOwnerTarget(u);
    return u;
  };

  const findModeratorStrict = (id) => {
    const u = q("SELECT * FROM users WHERE id = ? AND role = 'moderator'").get(Number(id) || 0);
    if (!u) throw new HttpError(404, 'حساب المشرف غير موجود');
    assertNotOwnerTarget(u);
    return u;
  };

  // 1. لوحة المالك الرئيسية والإحصاءات الشاملة
  r.get('/api/owner/dashboard', () => {
    const stats = q(`SELECT
        COALESCE(SUM(role = 'client' AND is_demo = 0), 0) totalClients,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND status = 'pending'), 0) pendingClients,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND status = 'active'), 0) activeClients,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND status = 'rejected'), 0) rejectedClients,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND status = 'suspended'), 0) suspendedClients,
        COALESCE(SUM(role = 'moderator'), 0) totalModerators,
        COALESCE(SUM(role = 'moderator' AND status = 'active'), 0) activeModerators,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND plan = 'free'), 0) freeCount,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND plan = 'pro'), 0) proCount,
        COALESCE(SUM(role = 'client' AND is_demo = 0 AND plan = 'business'), 0) businessCount
      FROM users`).get();

    const prodStats = q(`SELECT
        COUNT(*) totalProducts,
        COALESCE(SUM(approval_status = 'pending'), 0) pendingProducts,
        COALESCE(SUM(approval_status = 'approved'), 0) approvedProducts
      FROM products WHERE user_id IN (SELECT id FROM users WHERE is_demo = 0)`).get();

    const ordStats = q(`SELECT
        COUNT(*) totalOrders,
        COALESCE(SUM(approval_status = 'pending'), 0) pendingOrders,
        COALESCE(SUM(CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN total ELSE 0 END), 0) totalGmv
      FROM orders WHERE user_id IN (SELECT id FROM users WHERE is_demo = 0)`).get();

    const payStats = q(`SELECT
        COALESCE(SUM(status = 'paid'), 0) paidCount,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) totalRevenue
      FROM plan_payments WHERE user_id IN (SELECT id FROM users WHERE is_demo = 0)`).get();

    const ticketStats = q(`SELECT
        COUNT(*) totalTickets,
        COALESCE(SUM(status IN ('open', 'in_progress')), 0) openTickets
      FROM support_tickets`).get();

    const serviceStats = q(`SELECT
        COUNT(*) totalServices,
        COALESCE(SUM(status IN ('pending', 'scheduled', 'in_progress')), 0) pendingServices
      FROM service_requests`).get();

    const pendingQueue = q(`SELECT u.*, r.full_name AS reviewer_name
      FROM users u LEFT JOIN users r ON r.id = u.reviewed_by
      WHERE u.role = 'client' AND u.is_demo = 0 AND u.status = 'pending'
      ORDER BY u.id DESC LIMIT 10`).all().map(clientRowOf);

    const recentAudit = q(`SELECT a.*, u.store_name AS admin_name, u.phone AS admin_phone, u.email AS admin_email, u.role AS user_role
      FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id
      ORDER BY a.id DESC LIMIT 12`).all().map(model.auditOf);

    return {
      kpis: {
        totalClients: stats.totalClients,
        pendingClients: stats.pendingClients,
        activeClients: stats.activeClients,
        rejectedClients: stats.rejectedClients,
        suspendedClients: stats.suspendedClients,
        totalModerators: stats.totalModerators,
        activeModerators: stats.activeModerators,
        maxModerators: MAX_MODERATORS,
        pendingProducts: prodStats.pendingProducts,
        pendingOrders: ordStats.pendingOrders,
        totalProducts: prodStats.totalProducts,
        totalOrders: ordStats.totalOrders,
        totalGmv: round2(ordStats.totalGmv),
        totalRevenue: round2(payStats.totalRevenue),
        paidSubscriptions: payStats.paidCount,
        totalTickets: ticketStats.totalTickets,
        openTickets: ticketStats.openTickets,
        totalServices: serviceStats.totalServices,
        pendingServices: serviceStats.pendingServices
      },
      planBreakdown: {
        free: stats.freeCount,
        pro: stats.proCount,
        business: stats.businessCount
      },
      pendingQueue,
      recentAudit,
      platformSettings: getPlatformSettings(),
      systemStatus: systemStatusOf()
    };
  }, { owner: true });

  // 2. إدارة حسابات المشرفين (بحد أقصى 3 حسابات فقط)
  r.get('/api/owner/moderators', () => {
    const rows = q(`SELECT u.*,
        (SELECT COUNT(*) FROM audit_log a WHERE a.admin_id = u.id AND a.action = 'client.approve') AS approved_count,
        (SELECT COUNT(*) FROM audit_log a WHERE a.admin_id = u.id AND a.action = 'client.reject') AS rejected_count,
        (SELECT COUNT(*) FROM audit_log a WHERE a.admin_id = u.id) AS total_actions
      FROM users u
      WHERE u.role = 'moderator'
      ORDER BY u.id ASC`).all();
    const moderators = rows.map(moderatorRowOf);
    const activeCount = moderators.filter((m) => m.status === 'active').length;
    return {
      moderators,
      count: moderators.length,
      activeCount,
      max: MAX_MODERATORS,
      remainingSlots: Math.max(0, MAX_MODERATORS - moderators.length),
      permissionMeta: MODERATOR_PERMISSION_META
    };
  }, { owner: true });

  r.post('/api/owner/moderators', async ({ user, body, ip }) => {
    const existingCount = q("SELECT COUNT(*) n FROM users WHERE role = 'moderator'").get().n;
    assertModeratorLimit(existingCount, MAX_MODERATORS);

    const fullName = text(body.fullName || body.name, 'اسم المشرف', { min: 2, max: 80 });
    const mail = email(body.email);
    if (!mail) throw bad('البريد الإلكتروني للمشرف مطلوب');
    const ph = body.phone ? phone(body.phone) : `0109900${String(Date.now()).slice(-4)}`;
    const pw = password(body.password, ph);
    const perms = normalizePermissions(body.permissions);

    if (q('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل في حساب آخر');
    if (q('SELECT 1 FROM users WHERE phone = ?').get(ph)) throw new HttpError(409, 'رقم الموبايل مستخدم بالفعل في حساب آخر');

    const hash = await hashPassword(pw);
    const id = Number(q(`INSERT INTO users (phone, email, pass_hash, store_name, full_name, role, status, permissions, plan, created_at)
      VALUES (?, ?, ?, ?, ?, 'moderator', 'active', ?, 'business', ?)`)
      .run(ph, mail, hash, fullName, fullName, JSON.stringify(perms), nowIso()).lastInsertRowid);

    logAudit(user.id, 'moderator.create', 'moderator', id, { fullName, email: mail, permissions: perms }, ip);
    return { ok: true, moderator: moderatorRowOf(findModeratorStrict(id)) };
  }, { owner: true });

  r.put('/api/owner/moderators/:id', ({ user, params, body, ip }) => {
    const mod = findModeratorStrict(params.id);
    const fullName = body.fullName !== undefined || body.name !== undefined
      ? text(body.fullName ?? body.name, 'اسم المشرف', { min: 2, max: 80 })
      : (mod.full_name || mod.store_name);
    const mail = body.email !== undefined ? email(body.email) : mod.email;
    if (!mail) throw bad('البريد الإلكتروني للمشرف مطلوب');
    const ph = body.phone !== undefined ? phone(body.phone) : mod.phone;

    if (q('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(mail, mod.id)) {
      throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل في حساب آخر');
    }
    if (q('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(ph, mod.id)) {
      throw new HttpError(409, 'رقم الموبايل مستخدم بالفعل في حساب آخر');
    }

    const perms = body.permissions !== undefined
      ? normalizePermissions(body.permissions, normalizePermissions(mod.permissions))
      : normalizePermissions(mod.permissions);

    q('UPDATE users SET full_name = ?, store_name = ?, email = ?, phone = ?, permissions = ? WHERE id = ?')
      .run(fullName, fullName, mail, ph, JSON.stringify(perms), mod.id);

    logAudit(user.id, 'moderator.update', 'moderator', mod.id, { fullName, email: mail, phone: ph, permissions: perms }, ip);
    return { ok: true, moderator: moderatorRowOf(findModeratorStrict(mod.id)) };
  }, { owner: true });

  // تخصيص صلاحيات ومهام كل مشرف بشكل مستقل
  r.post('/api/owner/moderators/:id/permissions', ({ user, params, body, ip }) => {
    const mod = findModeratorStrict(params.id);
    const perms = normalizePermissions(body.permissions || body, normalizePermissions(mod.permissions));
    q('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), mod.id);
    logAudit(user.id, 'moderator.permissions', 'moderator', mod.id, { fullName: mod.full_name, email: mod.email, permissions: perms }, ip);
    return { ok: true, moderator: moderatorRowOf(findModeratorStrict(mod.id)) };
  }, { owner: true });

  // تغيير كلمة مرور المشرف + إبطال جلساته الحالية فورًا
  r.post('/api/owner/moderators/:id/password', async ({ user, params, body, ip }) => {
    const mod = findModeratorStrict(params.id);
    const nextPw = password(body.password || body.next, mod.phone);
    const hash = await hashPassword(nextPw);
    q('UPDATE users SET pass_hash = ?, token_ver = token_ver + 1 WHERE id = ?').run(hash, mod.id);
    logAudit(user.id, 'moderator.change_password', 'moderator', mod.id, { fullName: mod.full_name, email: mod.email }, ip);
    return { ok: true, message: 'تم تحديث كلمة مرور المشرف وإبطال جلساته السابقة فورًا' };
  }, { owner: true });

  // إيقاف مؤقت (مع الإبطال الفوري للجلسة) أو إعادة تفعيل المشرف
  r.post('/api/owner/moderators/:id/status', ({ user, params, body, ip }) => {
    const mod = findModeratorStrict(params.id);
    const nextStatus = oneOf(body.status, ['active', 'suspended'], 'حالة المشرف');
    if (nextStatus === 'active' && mod.status !== 'active') {
      const activeCount = q("SELECT COUNT(*) n FROM users WHERE role = 'moderator' AND status = 'active'").get().n;
      assertActiveModeratorLimit(activeCount, MAX_MODERATORS);
    }
    if (nextStatus === 'suspended') {
      q("UPDATE users SET status = 'suspended', token_ver = token_ver + 1 WHERE id = ?").run(mod.id);
      logAudit(user.id, 'moderator.suspend', 'moderator', mod.id, { fullName: mod.full_name, email: mod.email, reason: body.reason || '' }, ip);
    } else {
      q("UPDATE users SET status = 'active' WHERE id = ?").run(mod.id);
      logAudit(user.id, 'moderator.reactivate', 'moderator', mod.id, { fullName: mod.full_name, email: mod.email }, ip);
    }
    return { ok: true, moderator: moderatorRowOf(findModeratorStrict(mod.id)) };
  }, { owner: true });

  // حذف المشرف نهائيًا من النظام + الإبطال الفوري لجلسته (مع بقاء سجل المراقبة محفوظًا)
  r.delete('/api/owner/moderators/:id', ({ user, params, ip }) => {
    const mod = findModeratorStrict(params.id);
    q("DELETE FROM users WHERE id = ? AND role = 'moderator'").run(mod.id);
    logAudit(user.id, 'moderator.delete', 'moderator', mod.id, { fullName: mod.full_name, email: mod.email, phone: mod.phone }, ip);
    return { ok: true, deletedId: mod.id };
  }, { owner: true });

  // 3. إدارة العملاء (قبول / رفض / حظر / تفعيل / تغيير باقة / معاينة)
  r.get('/api/owner/clients', ({ query }) => {
    const where = ["u.role = 'client'", 'u.is_demo = 0'];
    const args = [];
    if (query.status && ['pending', 'active', 'rejected', 'suspended'].includes(query.status)) {
      where.push('u.status = ?');
      args.push(query.status);
    }
    if (query.plan && PLANS[query.plan]) {
      where.push('u.plan = ?');
      args.push(query.plan);
    }
    const search = String(query.q ?? '').trim().slice(0, 60);
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const taxHash = cipher ? cipher.blindIndex(latin(search)) : '';
      if (taxHash) {
        where.push(`(u.store_name LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\' OR COALESCE(u.email, '') LIKE ? ESCAPE '\\' OR u.tax_id_hash = ?)`);
        args.push(like, like, like, like, taxHash);
      } else {
        where.push(`(u.store_name LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\' OR COALESCE(u.email, '') LIKE ? ESCAPE '\\')`);
        args.push(like, like, like, like);
      }
    }

    const counts = q(`SELECT
        COUNT(*) allCount,
        COALESCE(SUM(status = 'pending'), 0) pending,
        COALESCE(SUM(status = 'active'), 0) active,
        COALESCE(SUM(status = 'rejected'), 0) rejected,
        COALESCE(SUM(status = 'suspended'), 0) suspended
      FROM users WHERE role = 'client' AND is_demo = 0`).get();

    const rows = q(`SELECT u.*, r.full_name AS reviewer_name,
        (SELECT COUNT(*) FROM products p WHERE p.user_id = u.id) AS products_count,
        (SELECT COUNT(*) FROM products p WHERE p.user_id = u.id AND p.approval_status = 'approved') AS approved_products_count,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders_count,
        (SELECT COALESCE(SUM(amount), 0) FROM plan_payments pp WHERE pp.user_id = u.id AND pp.status = 'paid') AS total_paid
      FROM users u
      LEFT JOIN users r ON r.id = u.reviewed_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN u.status = 'pending' THEN 0 ELSE 1 END, u.id DESC
      LIMIT 150`).all(...args);

    return { clients: rows.map(clientRowOf), counts, total: rows.length };
  }, { owner: true });

  r.get('/api/owner/clients/:id', ({ params }) => {
    const u = findClientStrict(params.id);
    const products = q('SELECT * FROM products WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id).map(model.productOf);
    const orders = q('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id).map(model.orderOf);
    const payments = model.paymentsOf(u.id);
    const auditLogs = q(`SELECT a.*, adm.store_name AS admin_name, adm.phone AS admin_phone, adm.email AS admin_email, adm.role AS user_role
      FROM audit_log a LEFT JOIN users adm ON adm.id = a.admin_id
      WHERE a.target_type = 'user' AND a.target_id = ?
      ORDER BY a.id DESC LIMIT 30`).all(u.id).map(model.auditOf);

    return {
      client: clientRowOf(u),
      settings: model.settingsOf(u),
      plan: model.planOf(u),
      counts: model.counts(u.id),
      products,
      orders,
      payments,
      auditLogs
    };
  }, { owner: true });

  r.post('/api/owner/clients/:id/approve', async ({ user, params, ip }) => {
    const u = findClientStrict(params.id);
    const now = nowIso();
    q("UPDATE users SET status = 'active', reject_reason = '', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(user.id, now, u.id);
    logAudit(user.id, 'client.approve', 'user', u.id, { storeName: u.store_name, email: u.email || '', phone: u.phone }, ip);
    notify(u.id, 'ok', 'تمت الموافقة على حسابك وتفعيله ✓', 'أهلًا بك في OrderFlow! يمكنك الآن تسجيل الدخول واستخدام جميع خدمات المنصة.', '#/dash');
    if (u.email && mailer) {
      await mailer.send({
        to: u.email,
        subject: 'تمت الموافقة على حسابك في OrderFlow ✓',
        type: 'account_approved',
        storeName: u.store_name,
        url: `${cfg.appUrl || 'http://localhost:3000'}/#/login`,
        text: `مرحبًا ${u.store_name}، تمت الموافقة على حسابك في OrderFlow ويمكنك الآن تسجيل الدخول.`
      });
    }
    return { ok: true, client: clientRowOf(findClientStrict(u.id)) };
  }, { owner: true });

  r.post('/api/owner/clients/:id/reject', async ({ user, params, body, ip }) => {
    const u = findClientStrict(params.id);
    const reason = text(body.reason || '', 'سبب الرفض', { max: 300, optional: true });
    const now = nowIso();
    q("UPDATE users SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, token_ver = token_ver + 1 WHERE id = ?")
      .run(reason, user.id, now, u.id);
    logAudit(user.id, 'client.reject', 'user', u.id, { storeName: u.store_name, email: u.email || '', phone: u.phone, reason }, ip);
    if (u.email && mailer) {
      await mailer.send({
        to: u.email,
        subject: 'تحديث بخصوص طلب تسجيل متجرك — OrderFlow',
        type: 'account_rejected',
        storeName: u.store_name,
        reason,
        text: `مرحبًا ${u.store_name}، نعتذر لعدم قبول طلب تسجيلك حاليًا.${reason ? ` السبب: ${reason}` : ''}`
      });
    }
    return { ok: true, client: clientRowOf(findClientStrict(u.id)) };
  }, { owner: true });

  r.post('/api/owner/clients/:id/status', ({ user, params, body, ip }) => {
    const u = findClientStrict(params.id);
    const st = oneOf(body.status, ['active', 'suspended', 'pending', 'rejected'], 'حالة الحساب');
    const reason = text(body.reason || '', 'السبب', { max: 300, optional: true });
    if (st === 'suspended' || st === 'rejected') {
      q('UPDATE users SET status = ?, reject_reason = ?, token_ver = token_ver + 1, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
        .run(st, reason, user.id, nowIso(), u.id);
    } else {
      q('UPDATE users SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
        .run(st, '', user.id, nowIso(), u.id);
    }
    const action = st === 'suspended' ? 'client.suspend' : st === 'rejected' ? 'client.reject' : 'client.reactivate';
    logAudit(user.id, action, 'user', u.id, { status: st, reason, storeName: u.store_name, email: u.email || '' }, ip);
    return { ok: true, client: clientRowOf(findClientStrict(u.id)) };
  }, { owner: true });

  r.post('/api/owner/clients/:id/plan', ({ user, params, body, ip }) => {
    const u = findClientStrict(params.id);
    const normalizedPlan = body.plan === 'ent' ? 'business' : body.plan;
    const targetPlan = PLANS[oneOf(normalizedPlan, Object.keys(PLANS), 'الباقة')];
    const cycle = body.cycle === 'yearly' ? 'yearly' : 'monthly';
    const expiresAt = targetPlan.id === 'free' ? null : new Date(Date.now() + (cycle === 'yearly' ? 365 : 30) * DAY_MS).toISOString();
    const prevPlan = u.plan;
    q('UPDATE users SET plan = ?, plan_cycle = ?, plan_expires_at = ? WHERE id = ?').run(targetPlan.id, cycle, expiresAt, u.id);
    logAudit(user.id, 'client.change_plan', 'user', u.id, { from: prevPlan, to: targetPlan.id, cycle, storeName: u.store_name }, ip);
    notify(u.id, 'ok', `تم تحديث باقة متجرك إلى «${targetPlan.name}»`, `تم تفعيل ${targetPlan.name} بواسطة مالك المنصة.`, '#/pay');
    const fresh = findClientStrict(u.id);
    return { ok: true, client: clientRowOf(fresh), plan: model.planOf(fresh) };
  }, { owner: true });

  r.post('/api/owner/clients/:id/impersonate', ({ user, params, ip }) => {
    const u = findClientStrict(params.id);
    const token = session.issueImpersonation(user, u);
    logAudit(user.id, 'client.impersonate', 'user', u.id, { storeName: u.store_name, phone: u.phone, readOnly: true }, ip);
    return {
      ok: true,
      token,
      impersonationToken: token,
      readOnly: true,
      client: clientRowOf(u),
      me: model.meOf({ ...u, _impersonatedBy: user.id, _readOnly: true })
    };
  }, { owner: true });

  // 4. إعدادات المنصة العامة والنسخ الاحتياطي (حصريًا للمالك)
  r.get('/api/owner/settings', () => ({
    settings: getPlatformSettings(),
    backups: app.listBackups ? app.listBackups() : [],
    systemStatus: systemStatusOf()
  }), { owner: true });

  r.put('/api/owner/settings', ({ user, body, ip }) => {
    const allowed = {
      platform_name: (v) => text(v, 'اسم المنصة', { min: 2, max: 60 }),
      platform_legal_name: (v) => text(v, 'الاسم القانوني للمنصة', { min: 2, max: 120 }),
      platform_tax_id: (v) => {
        const cleanTax = latin(text(v, 'الرقم الضريبي للمنصة', { max: 30, optional: true }));
        if (!/^[0-9\- ]*$/.test(cleanTax)) throw bad('الرقم الضريبي للمنصة: أرقام وشرطات فقط');
        return cleanTax;
      },
      support_email: (v) => email(v) || '',
      support_phone: (v) => text(v, 'هاتف الدعم', { max: 40, optional: true }),
      registration_open: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
      require_client_approval: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
      require_email_verification: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
      pii_retention_days: (v) => String(integer(v, 'مدة الاحتفاظ ببيانات العملاء (بالأيام)', { min: 7, max: 3650 })),
      maintenance_notice: (v) => text(v, 'إشعار الصيانة', { max: 240, optional: true })
    };
    const updated = {};
    for (const [key, validate] of Object.entries(allowed)) {
      if (body[key] !== undefined) {
        const val = validate(body[key]);
        setPlatformSetting(key, val);
        updated[key] = val;
      }
    }
    logAudit(user.id, 'platform.settings_update', 'platform', null, updated, ip);
    return { ok: true, settings: getPlatformSettings(), systemStatus: systemStatusOf() };
  }, { owner: true });

  // إرسال إيميل تجريبي للمالك للتحقق من إعدادات البريد الإلكتروني
  r.post('/api/owner/mail/test', async ({ user, body, ip }) => {
    const to = email(body?.to) || user.email || getPlatformSettings().support_email;
    if (!to) throw bad('أضف بريدًا إلكترونيًا لحساب المالك أو في إعدادات المنصة أولًا');
    const result = await mailer.send({
      to,
      subject: 'رسالة اختبار البريد الإلكتروني — OrderFlow',
      type: 'contact',
      text: `هذه رسالة اختبار للتأكد من عمل مزوّد البريد الإلكتروني (${mailer.activeProvider}) بنجاح في منصة OrderFlow.`
    });
    logAudit(user.id, 'platform.mail_test', 'mail', null, { to, provider: result.provider, delivered: result.delivered }, ip);
    return {
      ok: Boolean(result.delivered || result.provider === 'memory'),
      provider: result.provider,
      configured: mailer.configured,
      delivered: Boolean(result.delivered),
      error: result.error || null
    };
  }, { owner: true });

  // النسخ الاحتياطي لقاعدة البيانات (VACUUM INTO مشفّر بـ AES-256-GCM عند توفر المفتاح + رفع اختياري إلى S3)
  r.get('/api/owner/backups', () => ({
    backups: app.listBackups ? app.listBackups() : [],
    keepCount: app.cfg.backupKeepCount || 7,
    lastBackupUpload: app.lastBackupUpload || null
  }), { owner: true });

  r.post('/api/owner/backup', ({ user, ip }) => {
    const backup = app.createBackup();
    const backups = app.listBackups();
    logAudit(user.id, 'platform.backup_create', 'database', null, { file: backup.file, size: backup.size, encrypted: Boolean(backup.encrypted) }, ip);
    return { ok: true, backup, backups, systemStatus: systemStatusOf() };
  }, { owner: true });

  // 4b. سجل الوصول للبيانات الشخصية (PII Access Log — الامتثال لسياسة أمازون SP-API DPP والقانون ١٥١/٢٠٢٠)
  const buildPiiLogQuery = (query) => {
    const where = ['1 = 1'];
    const args = [];
    if (query.merchantId || query.ownerUserId) {
      where.push('p.owner_user_id = ?');
      args.push(Number(query.merchantId || query.ownerUserId) || 0);
    }
    if (query.actorId) {
      where.push('p.actor_id = ?');
      args.push(Number(query.actorId) || 0);
    }
    if (query.action) {
      where.push('p.action = ?');
      args.push(String(query.action));
    }
    if (query.from) {
      where.push('p.created_at >= ?');
      args.push(String(query.from));
    }
    if (query.to) {
      where.push('p.created_at <= ?');
      args.push(String(query.to));
    }
    return { sql: where.join(' AND '), args };
  };

  r.get('/api/owner/pii-log', ({ query }) => {
    const { sql, args } = buildPiiLogQuery(query);
    const limit = Math.min(500, Math.max(10, Number(query.limit) || 150));
    const rows = q(`SELECT p.*,
        act.store_name AS actor_name, act.role AS actor_role, act.email AS actor_email,
        own.store_name AS merchant_name
      FROM pii_access_log p
      LEFT JOIN users act ON act.id = p.actor_id
      LEFT JOIN users own ON own.id = p.owner_user_id
      WHERE ${sql}
      ORDER BY p.id DESC LIMIT ?`).all(...args, limit);
    const logs = rows.map((x) => ({
      id: x.id,
      actorId: x.actor_id,
      actorName: x.actor_name || '',
      actorRole: x.actor_role || '',
      actorEmail: x.actor_email || '',
      ownerUserId: x.owner_user_id,
      merchantName: x.merchant_name || '',
      action: x.action,
      targetType: x.target_type,
      targetId: x.target_id,
      count: x.count,
      ip: x.ip || '',
      createdAt: x.created_at
    }));
    return { logs, items: logs, total: logs.length };
  }, { owner: true });

  r.get('/api/owner/pii-log/export.csv', ({ query, res }) => {
    const { sql, args } = buildPiiLogQuery(query);
    const rows = q(`SELECT p.*,
        act.store_name AS actor_name, act.role AS actor_role,
        own.store_name AS merchant_name
      FROM pii_access_log p
      LEFT JOIN users act ON act.id = p.actor_id
      LEFT JOIN users own ON own.id = p.owner_user_id
      WHERE ${sql}
      ORDER BY p.id DESC LIMIT 5000`).all(...args);
    const csv = [['ID', 'التاريخ', 'المُنفّذ', 'دور المُنفّذ', 'التاجر المالك للبيانات', 'الإجراء', 'النوع', 'المعرّف', 'العدد', 'IP']];
    for (const x of rows) {
      csv.push([x.id, x.created_at, x.actor_name || x.actor_id, x.actor_role || '', x.merchant_name || x.owner_user_id, x.action, x.target_type, x.target_id ?? '', x.count, x.ip || '']);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orderflow-pii-access-log.csv"', 'Cache-Control': 'no-store' });
    res.end(toCsv(csv));
  }, { owner: true });

  // 4c. التنبيهات الأمنية (Security Events)
  r.get('/api/owner/security', ({ query }) => {
    const where = ['1 = 1'];
    const args = [];
    if (query.severity && ['low', 'medium', 'high', 'critical'].includes(query.severity)) {
      where.push('e.severity = ?');
      args.push(query.severity);
    }
    if (query.unacked === '1') {
      where.push('e.acknowledged_at IS NULL');
    }
    const rows = q(`SELECT e.*, u.full_name AS ack_by_name
      FROM security_events e
      LEFT JOIN users u ON u.id = e.acknowledged_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN e.acknowledged_at IS NULL THEN 0 ELSE 1 END, e.id DESC
      LIMIT 150`).all(...args);
    const events = rows.map((e) => {
      let details = {};
      try { details = JSON.parse(e.details || '{}'); } catch {}
      return {
        id: e.id,
        severity: e.severity,
        title: e.title,
        details,
        acknowledgedAt: e.acknowledged_at || null,
        acknowledgedBy: e.acknowledged_by || null,
        acknowledgedByName: e.ack_by_name || '',
        createdAt: e.created_at
      };
    });
    const unackCount = q('SELECT COUNT(*) n FROM security_events WHERE acknowledged_at IS NULL').get().n;
    return { events, unackCount };
  }, { owner: true });

  r.post('/api/owner/security/:id/ack', ({ user, params, ip }) => {
    const id = integer(params.id, 'معرّف التنبيه', { min: 1 });
    const row = q('SELECT * FROM security_events WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'التنبيه الأمني غير موجود');
    const now = nowIso();
    q('UPDATE security_events SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?').run(now, user.id, id);
    logAudit(user.id, 'security.event_ack', 'security_event', id, { title: row.title, severity: row.severity }, ip);
    return { ok: true, id, acknowledgedAt: now };
  }, { owner: true });

  // 5. سجل المراقبة الشامل (Audit Log) مع تصفية حسب المشرف أو الدور أو الإجراء
  r.get('/api/owner/audit', ({ query }) => {
    const where = ['1 = 1'];
    const args = [];
    if (query.action) {
      where.push('a.action = ?');
      args.push(String(query.action));
    }
    if (query.actorRole && ['owner', 'moderator'].includes(query.actorRole)) {
      where.push('a.actor_role = ?');
      args.push(query.actorRole);
    }
    if (query.actorId && Number(query.actorId) > 0) {
      where.push('a.admin_id = ?');
      args.push(Number(query.actorId));
    }
    const search = String(query.q ?? '').trim().slice(0, 60);
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(a.action LIKE ? ESCAPE '\\' OR a.details LIKE ? ESCAPE '\\' OR a.actor_name LIKE ? ESCAPE '\\' OR a.actor_email LIKE ? ESCAPE '\\')`);
      args.push(like, like, like, like);
    }
    const limit = Math.min(250, Math.max(10, Number(query.limit) || 120));
    const logs = q(`SELECT a.*, u.store_name AS admin_name, u.phone AS admin_phone, u.email AS admin_email, u.role AS user_role
      FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.id DESC LIMIT ?`).all(...args, limit).map(model.auditOf);

    const moderators = q("SELECT id, full_name, email, status FROM users WHERE role = 'moderator' ORDER BY id ASC").all();
    return { logs, items: logs, moderators };
  }, { owner: true });

  // 6. مسارات الاعتماد والمدفوعات والكوبونات تحت /api/owner/*
  r.get('/api/owner/approvals', ({ query }) => {
    const statusFilter = ['pending', 'approved', 'rejected', 'all'].includes(query.status) ? query.status : 'pending';
    const typeFilter = ['all', 'product', 'order'].includes(query.type) ? query.type : 'all';
    const whereSql = statusFilter === 'all' ? 'u.is_demo = 0' : 'u.is_demo = 0 AND x.approval_status = ?';
    const args = statusFilter === 'all' ? [] : [statusFilter];

    const products = (typeFilter === 'all' || typeFilter === 'product')
      ? q(`SELECT x.*, u.store_name, u.phone AS user_phone FROM products x JOIN users u ON u.id = x.user_id WHERE ${whereSql} ORDER BY x.id DESC LIMIT 100`).all(...args).map((p) => ({
        ...model.productOf(p), userId: p.user_id, storeName: p.store_name, storePhone: p.user_phone
      }))
      : [];
    const orders = (typeFilter === 'all' || typeFilter === 'order')
      ? q(`SELECT x.*, u.store_name, u.phone AS user_phone FROM orders x JOIN users u ON u.id = x.user_id WHERE ${whereSql} ORDER BY x.id DESC LIMIT 100`).all(...args).map((o) => ({
        ...model.orderOf(o), userId: o.user_id, storeName: o.store_name, storePhone: o.user_phone
      }))
      : [];
    return { products, orders };
  }, { owner: true });

  r.get('/api/owner/payments', ({ query }) => {
    const where = ['u.is_demo = 0'];
    const args = [];
    if (query.status && ['paid', 'pending', 'failed', 'cancelled', 'review'].includes(query.status)) {
      where.push('p.status = ?');
      args.push(query.status);
    }
    const search = String(query.q ?? '').trim().slice(0, 60);
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(p.tx_ref LIKE ? ESCAPE '\\' OR u.store_name LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    const payments = q(`SELECT p.*, u.store_name, u.phone AS user_phone
      FROM plan_payments p JOIN users u ON u.id = p.user_id
      WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 100`).all(...args).map(model.paymentOf);
    const summary = q(`SELECT
        COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) totalPaid,
        COALESCE(SUM(p.status = 'paid'), 0) countPaid,
        COALESCE(SUM(p.status = 'pending'), 0) countPending,
        COALESCE(SUM(p.status IN ('failed', 'cancelled', 'review')), 0) countFailed
      FROM plan_payments p JOIN users u ON u.id = p.user_id WHERE u.is_demo = 0`).get();
    return {
      payments,
      summary: {
        paidTotal: round2(summary.totalPaid),
        paidCount: summary.countPaid,
        pendingCount: summary.countPending,
        failedCount: summary.countFailed
      }
    };
  }, { owner: true });

  r.get('/api/owner/coupons', () => ({
    coupons: q('SELECT * FROM coupons ORDER BY id DESC').all().map(model.couponOf)
  }), { owner: true });

  r.post('/api/owner/coupons', ({ user, body, ip }) => {
    const code = latin(text(body.code, 'كود الكوبون', { min: 2, max: 30 })).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9_-]{2,30}$/.test(code)) throw bad('كود الكوبون يجب أن يتكون من حروف إنجليزية وأرقام فقط');
    const type = oneOf(body.type || 'pct', ['pct', 'fixed'], 'نوع الخصم');
    const value = money(body.value !== undefined ? body.value : body.pct, 'قيمة الخصم', { min: 1, max: type === 'pct' ? 100 : 100_000 });
    const desc = text(body.desc || '', 'وصف الكوبون', { max: 140, optional: true }) || (type === 'pct' ? `خصم ${value}٪` : `خصم ${value} ج.م`);
    const active = body.active === undefined ? 1 : (body.active ? 1 : 0);
    const maxUses = body.maxUses == null || body.maxUses === '' ? null : integer(body.maxUses, 'الحد الأقصى', { min: 1, max: 1_000_000 });
    let id;
    try {
      id = Number(q('INSERT INTO coupons (code, type, value, desc, once_per_user, active, max_uses, created_at) VALUES (?,?,?,?,0,?,?,?)')
        .run(code, type, value, desc, active, maxUses, nowIso()).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'كود الكوبون موجود بالفعل');
      throw e;
    }
    logAudit(user.id, 'coupon.create', 'coupon', id, { code, type, value }, ip);
    return { ok: true, coupon: model.couponOf(q('SELECT * FROM coupons WHERE id = ?').get(id)) };
  }, { owner: true });

  r.put('/api/owner/coupons/:id', ({ user, params, body, ip }) => {
    const cur = q('SELECT * FROM coupons WHERE id = ? OR code = ?').get(Number(params.id) || 0, String(params.id).toUpperCase());
    if (!cur) throw new HttpError(404, 'الكوبون غير موجود');
    const type = body.type !== undefined ? oneOf(body.type, ['pct', 'fixed'], 'نوع الخصم') : cur.type;
    const rawVal = body.value !== undefined ? body.value : body.pct;
    const value = rawVal !== undefined ? money(rawVal, 'قيمة الخصم', { min: 1, max: type === 'pct' ? 100 : 100_000 }) : cur.value;
    const desc = body.desc !== undefined ? text(body.desc, 'وصف الكوبون', { max: 140, optional: true }) : cur.desc;
    const active = body.active !== undefined ? (body.active ? 1 : 0) : cur.active;
    const maxUses = body.maxUses !== undefined ? (body.maxUses === '' || body.maxUses == null ? null : integer(body.maxUses, 'الحد الأقصى', { min: 1, max: 1_000_000 })) : cur.max_uses;
    q('UPDATE coupons SET type = ?, value = ?, desc = ?, active = ?, max_uses = ? WHERE id = ?')
      .run(type, value, desc, active, maxUses, cur.id);
    logAudit(user.id, 'coupon.update', 'coupon', cur.id, { code: cur.code, type, value, active: Boolean(active) }, ip);
    return { ok: true, coupon: model.couponOf(q('SELECT * FROM coupons WHERE id = ?').get(cur.id)) };
  }, { owner: true });

  r.delete('/api/owner/coupons/:id', ({ user, params, ip }) => {
    const cur = q('SELECT * FROM coupons WHERE id = ? OR code = ?').get(Number(params.id) || 0, String(params.id).toUpperCase());
    if (!cur) throw new HttpError(404, 'الكوبون غير موجود');
    q('DELETE FROM coupons WHERE id = ?').run(cur.id);
    logAudit(user.id, 'coupon.delete', 'coupon', cur.id, { code: cur.code }, ip);
    return { ok: true };
  }, { owner: true });

  // 7. إدارة تذاكر الدعم الفني ورسائل تواصل معنا (حصريًا للمالك)
  const ticketRowOf = (t) => ({
    id: t.id,
    userId: t.user_id || null,
    storeName: t.store_name || t.name,
    name: t.name,
    contact: t.contact,
    subject: t.subject,
    message: t.message,
    status: t.status || 'open',
    reply: t.reply || '',
    repliedBy: t.replied_by || null,
    repliedByName: t.replier_name || '',
    createdAt: t.created_at,
    updatedAt: t.updated_at || null
  });

  r.get('/api/owner/tickets', ({ query }) => {
    const where = ['1 = 1'];
    const args = [];
    if (query.status && ['open', 'in_progress', 'resolved', 'closed'].includes(query.status)) {
      where.push('t.status = ?');
      args.push(query.status);
    }
    const search = String(query.q ?? '').trim().slice(0, 60);
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(t.name LIKE ? ESCAPE '\\' OR t.contact LIKE ? ESCAPE '\\' OR t.subject LIKE ? ESCAPE '\\' OR t.message LIKE ? ESCAPE '\\')`);
      args.push(like, like, like, like);
    }
    const tickets = q(`SELECT t.*, u.store_name, rep.full_name AS replier_name
      FROM support_tickets t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN users rep ON rep.id = t.replied_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN t.status = 'open' THEN 0 WHEN t.status = 'in_progress' THEN 1 ELSE 2 END, t.id DESC
      LIMIT 150`).all(...args).map(ticketRowOf);
    const counts = q(`SELECT
        COUNT(*) allCount,
        COALESCE(SUM(status = 'open'), 0) open,
        COALESCE(SUM(status = 'in_progress'), 0) inProgress,
        COALESCE(SUM(status = 'resolved'), 0) resolved,
        COALESCE(SUM(status = 'closed'), 0) closed
      FROM support_tickets`).get();
    return { tickets, counts };
  }, { owner: true });

  r.post('/api/owner/tickets/:id/reply', ({ user, params, body, ip }) => {
    const id = integer(params.id, 'رقم التذكرة', { min: 1 });
    const ticket = q('SELECT * FROM support_tickets WHERE id = ?').get(id);
    if (!ticket) throw new HttpError(404, 'تذكرة الدعم غير موجودة');
    const reply = text(body.reply, 'نص الرد', { min: 2, max: 2000 });
    const status = body.status !== undefined
      ? oneOf(body.status, ['open', 'in_progress', 'resolved', 'closed'], 'حالة التذكرة')
      : 'resolved';
    const now = nowIso();
    q('UPDATE support_tickets SET reply = ?, replied_by = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(reply, user.id, status, now, ticket.id);
    logAudit(user.id, 'ticket.reply', 'ticket', ticket.id, { subject: ticket.subject, status, userId: ticket.user_id }, ip);
    if (ticket.user_id) {
      notify(
        ticket.user_id,
        status === 'resolved' || status === 'closed' ? 'ok' : 'info',
        `تم الرد على تذكرة الدعم #${ticket.id}`,
        reply.slice(0, 300),
        '#/help'
      );
    }
    const fresh = q(`SELECT t.*, u.store_name, rep.full_name AS replier_name
      FROM support_tickets t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN users rep ON rep.id = t.replied_by
      WHERE t.id = ?`).get(ticket.id);
    return { ok: true, ticket: ticketRowOf(fresh) };
  }, { owner: true });

  // 8. إدارة طلبات خدمات الخبراء والاستشارات (حصريًا للمالك)
  const serviceRowOf = (s) => ({
    id: s.id,
    userId: s.user_id || null,
    refCode: s.ref_code,
    serviceKey: s.service_key,
    serviceTitle: s.service_title,
    name: s.name,
    phone: s.phone,
    storeName: s.store_name || s.user_store_name || '',
    platforms: s.platforms || '',
    monthlyOrders: s.monthly_orders || '',
    notes: s.notes || '',
    adminNotes: s.admin_notes || '',
    status: s.status || 'pending',
    createdAt: s.created_at,
    updatedAt: s.updated_at || null
  });

  r.get('/api/owner/services', ({ query }) => {
    const where = ['1 = 1'];
    const args = [];
    if (query.status && ['pending', 'scheduled', 'in_progress', 'completed', 'cancelled'].includes(query.status)) {
      where.push('s.status = ?');
      args.push(query.status);
    }
    const search = String(query.q ?? '').trim().slice(0, 60);
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(s.ref_code LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\' OR s.store_name LIKE ? ESCAPE '\\' OR s.service_title LIKE ? ESCAPE '\\')`);
      args.push(like, like, like, like, like);
    }
    const requests = q(`SELECT s.*, u.store_name AS user_store_name
      FROM service_requests s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN s.status = 'pending' THEN 0 WHEN s.status IN ('scheduled', 'in_progress') THEN 1 ELSE 2 END, s.id DESC
      LIMIT 150`).all(...args).map(serviceRowOf);
    const counts = q(`SELECT
        COUNT(*) allCount,
        COALESCE(SUM(status = 'pending'), 0) pending,
        COALESCE(SUM(status = 'scheduled'), 0) scheduled,
        COALESCE(SUM(status = 'in_progress'), 0) inProgress,
        COALESCE(SUM(status = 'completed'), 0) completed,
        COALESCE(SUM(status = 'cancelled'), 0) cancelled
      FROM service_requests`).get();
    return { requests, services: requests, counts };
  }, { owner: true });

  r.post('/api/owner/services/:id/status', ({ user, params, body, ip }) => {
    const id = integer(params.id, 'رقم طلب الخدمة', { min: 1 });
    const reqRow = q('SELECT * FROM service_requests WHERE id = ?').get(id);
    if (!reqRow) throw new HttpError(404, 'طلب الخدمة غير موجود');
    const status = oneOf(body.status, ['pending', 'scheduled', 'in_progress', 'completed', 'cancelled'], 'حالة الطلب');
    const adminNotes = body.adminNotes !== undefined || body.admin_notes !== undefined
      ? text(body.adminNotes ?? body.admin_notes, 'ملاحظات الإدارة', { max: 1000, optional: true })
      : (reqRow.admin_notes || '');
    const now = nowIso();
    q('UPDATE service_requests SET status = ?, admin_notes = ?, updated_at = ? WHERE id = ?')
      .run(status, adminNotes, now, reqRow.id);
    logAudit(user.id, 'service_request.status', 'service_request', reqRow.id, {
      refCode: reqRow.ref_code,
      serviceTitle: reqRow.service_title,
      status,
      adminNotes,
      userId: reqRow.user_id
    }, ip);
    if (reqRow.user_id) {
      const statusLabels = {
        pending: 'قيد المراجعة',
        scheduled: 'تم جدولة الموعد',
        in_progress: 'قيد التنفيذ',
        completed: 'مكتمل ✓',
        cancelled: 'ملغى'
      };
      notify(
        reqRow.user_id,
        status === 'completed' ? 'ok' : (status === 'cancelled' ? 'warning' : 'info'),
        `تحديث طلب الخدمة (${reqRow.ref_code}): ${statusLabels[status] || status}`,
        adminNotes || `تم تحديث حالة طلب «${reqRow.service_title}» إلى ${statusLabels[status] || status}.`,
        '#/services'
      );
    }
    const fresh = q('SELECT s.*, u.store_name AS user_store_name FROM service_requests s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(reqRow.id);
    return { ok: true, request: serviceRowOf(fresh) };
  }, { owner: true });
};
