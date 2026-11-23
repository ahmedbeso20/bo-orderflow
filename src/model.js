'use strict';
// تحويل صفوف قاعدة البيانات إلى كائنات JSON يرسلها الخادم للواجهة
const { PLANS, GATEWAY_METHODS, COURIERS, COD, sanitizeIntegrations } = require('./domain');
const { parseJson, round2, nowIso } = require('./util');

function createModel(q, cipher = null, opts = {}) {
  const onPlanExpired = typeof opts.onPlanExpired === 'function' ? opts.onPlanExpired : null;
  const dec = (v) => (cipher ? cipher.decrypt(v) : String(v || ''));

  /** يتحقق من انتهاء صلاحية الباقة المدفوعة ويُخفض الحساب تلقائيًا إلى المجانية */
  function enforcePlanExpiry(u) {
    if (!u || !u.id || u.is_demo) return u;
    if (u.plan && u.plan !== 'free' && u.plan_expires_at && u.plan_expires_at <= nowIso()) {
      const prevPlan = u.plan;
      const expiredAt = u.plan_expires_at;
      const res = q("UPDATE users SET plan = 'free', plan_cycle = 'monthly', plan_expires_at = NULL, plan_reminded_at = NULL WHERE id = ? AND plan <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?")
        .run(u.id, nowIso());
      u.plan = 'free';
      u.plan_cycle = 'monthly';
      u.plan_expires_at = null;
      if (res.changes > 0 && onPlanExpired) {
        try { onPlanExpired({ ...u, prevPlan, expiredAt }); } catch (_) {}
      }
    }
    return u;
  }

  /**
   * ينشئ أو يحدّث سجل العميل في جدول customers للطلب الجديد:
   * المطابقة برقم الهاتف أولًا، ثم بالاسم (فقط عند غياب رقم الهاتف لمنع دمج عميلين مختلفين بنفس الاسم وبهاتفين مختلفين)
   */
  function upsertCustomerForOrder({ userId, name, phone = '', gov = '', address = '', now = nowIso() }) {
    const cleanPhone = String(phone || '').trim();
    const cleanName = String(name || '').trim() || 'عميل';
    const cleanGov = String(gov || '').trim();
    const cleanAddr = String(address || '').trim();

    let existing = null;
    if (cleanPhone) {
      existing = q('SELECT * FROM customers WHERE user_id = ? AND phone = ?').get(userId, cleanPhone);
    } else {
      existing = q("SELECT * FROM customers WHERE user_id = ? AND name = ? AND phone = '' ORDER BY id ASC LIMIT 1").get(userId, cleanName)
        || q('SELECT * FROM customers WHERE user_id = ? AND name = ? ORDER BY id DESC LIMIT 1').get(userId, cleanName);
    }

    if (existing) {
      q(`UPDATE customers
         SET name = COALESCE(NULLIF(?, ''), name),
             gov = COALESCE(NULLIF(?, ''), gov),
             address = COALESCE(NULLIF(?, ''), address),
             updated_at = ?
         WHERE id = ?`)
        .run(cleanName, cleanGov, cleanAddr, now, existing.id);
      return existing.id;
    }

    const info = q(`INSERT INTO customers (user_id, name, phone, email, gov, address, notes, tags, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, '', '', ?, ?)`)
      .run(userId, cleanName, cleanPhone, cleanGov, cleanAddr, now, now);
    return Number(info.lastInsertRowid);
  }

  const productOf = (p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    cat: p.cat,
    markets: p.markets,
    price: p.price,
    cost: p.cost,
    stock: p.stock,
    effectiveStock: p.approval_status === 'approved' ? p.stock : 0,
    image: p.image || '',
    approvalStatus: p.approval_status || 'pending',
    rejectReason: p.reject_reason || '',
    createdAt: p.created_at,
    updatedAt: p.updated_at
  });
  const orderOf = (o) => ({
    id: o.id,
    no: o.no,
    market: o.market,
    customerId: o.customer_id || null,
    customer: o.customer,
    phone: o.phone,
    gov: o.gov,
    address: o.address,
    pay: o.pay,
    courier: o.courier,
    total: o.total,
    shipFee: o.ship_fee,
    status: o.status,
    items: o.items,
    createdAt: o.created_at,
    settled: !!o.settled_at,
    approvalStatus: o.approval_status || 'pending',
    rejectReason: o.reject_reason || '',
    cancelReason: o.cancel_reason || '',
    cancelledAt: o.cancelled_at || null,
    returnReason: o.return_reason || '',
    awbNumber: o.awb_number || '',
    trackingUrl: o.tracking_url || '',
    courierStatus: o.courier_status || ''
  });
  const customerOf = (c) => ({
    id: c.id,
    name: c.name,
    customer: c.name,
    phone: c.phone || '',
    email: c.email || '',
    gov: c.gov || '',
    address: c.address || '',
    notes: c.notes || '',
    tags: c.tags || '',
    ordersCount: Number(c.ordersCount ?? 0),
    totalOrders: Number(c.ordersCount ?? 0),
    deliveredCount: Number(c.deliveredCount ?? 0),
    returnedCount: Number(c.returnedCount ?? 0),
    cancelledCount: Number(c.cancelledCount ?? 0),
    returnedOrders: Number(c.returnedCount ?? 0) + Number(c.cancelledCount ?? 0),
    totalSpent: round2(c.totalSpent ?? 0),
    lastOrderAt: c.lastOrderAt || null,
    markets: typeof c.markets === 'string' ? c.markets.split(',').filter(Boolean) : (Array.isArray(c.markets) ? c.markets : []),
    createdAt: c.created_at,
    updatedAt: c.updated_at
  });
  const meOf = (u) => {
    enforcePlanExpiry(u);
    const { normalizePermissions, ROLES } = require('./rbac');
    return {
      id: u.id,
      storeName: u.store_name,
      fullName: u.full_name || u.store_name,
      phone: u.is_demo ? '' : u.phone,
      email: u.email || '',
      emailVerified: Boolean(u.email_verified_at),
      emailVerifiedAt: u.email_verified_at || null,
      totpEnabled: Boolean(u.totp_enabled),
      role: u.role || ROLES.CLIENT,
      status: u.status || 'pending',
      permissions: u.role === ROLES.MODERATOR ? normalizePermissions(u.permissions) : null,
      rejectReason: u.reject_reason || '',
      reviewedAt: u.reviewed_at || null,
      plan: u.plan,
      isDemo: !!u.is_demo,
      impersonatedBy: u._impersonatedBy || null,
      readOnly: Boolean(u._readOnly),
      createdAt: u.created_at
    };
  };
  const settingsOf = (u) => ({
    storeName: u.store_name,
    storeEmail: u.is_demo ? 'sales@elnoor-eg.com' : u.email || '',
    emailVerified: Boolean(u.email_verified_at),
    totpEnabled: Boolean(u.totp_enabled),
    storePhone: u.is_demo ? '01012345678' : u.phone,
    taxId: dec(u.tax_id),
    instaPayHandle: dec(u.instapay),
    integrations: sanitizeIntegrations(parseJson(u.integrations, {})),
    notifications: parseJson(u.notifications, {}),
    lastSyncAt: u.last_sync_at
  });
  // العناصر المعتمدة فقط تُحتسب ضمن المخزون النشط وتنبيهاته والمزامنة
  const counts = (uid) => ({
    lowStock: q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'approved' AND stock <= 5").get(uid).n,
    approvedStock: q("SELECT COALESCE(SUM(stock), 0) n FROM products WHERE user_id = ? AND approval_status = 'approved'").get(uid).n,
    approvedProducts: q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'approved'").get(uid).n,
    pendingOrders: q("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND status = 0 AND approval_status != 'rejected'").get(uid).n,
    unreadNotifications: q('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(uid).n
  });
  const planOf = (u) => {
    enforcePlanExpiry(u);
    const p = PLANS[u.plan] || PLANS.free;
    const day = new Date().toISOString().slice(0, 10);
    const aiUsedRow = q('SELECT n FROM ai_usage WHERE user_id = ? AND day = ?').get(u.id, day);
    return {
      id: p.id,
      name: p.name,
      limit: p.products,
      markets: p.markets,
      aiLimit: p.ai,
      aiUsed: aiUsedRow ? aiUsedRow.n : 0,
      priceMonthly: p.priceMonthly,
      priceYearly: p.priceYearly,
      cycle: u.plan_cycle || 'monthly',
      expiresAt: u.plan_expires_at || null,
      autoRenew: u.auto_renew === undefined ? false : Boolean(u.auto_renew),
      autoRenewSupported: false,
      defaultPayMethod: u.default_pay_method || 'card',
      used: q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(u.id).n,
      approvedUsed: q("SELECT COUNT(*) n FROM products WHERE user_id = ? AND approval_status = 'approved'").get(u.id).n
    };
  };
  const paymentOf = (row) => ({
    id: row.id,
    userId: row.user_id,
    storeName: row.store_name || undefined,
    phone: row.user_phone || undefined,
    txRef: row.tx_ref,
    plan: row.plan,
    planName: (PLANS[row.plan] || PLANS.pro).name,
    cycle: row.cycle,
    method: row.method,
    methodName: (GATEWAY_METHODS[row.method] || GATEWAY_METHODS.card).name,
    methodShort: (GATEWAY_METHODS[row.method] || GATEWAY_METHODS.card).short,
    amount: row.amount,
    vat: row.vat,
    discount: row.discount,
    coupon: row.coupon,
    payerInfo: row.payer_info,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdAt: row.created_at
  });
  const couponOf = (c) => ({
    id: c.id,
    code: c.code,
    type: c.type,
    value: c.value,
    pct: c.value,
    maxDiscount: c.type === 'fixed' ? c.value : 1000,
    desc: c.desc,
    oncePerUser: Boolean(c.once_per_user),
    active: Boolean(c.active),
    maxUses: c.max_uses == null ? null : c.max_uses,
    usedCount: c.used_count || 0,
    expiresAt: c.expires_at || null,
    createdAt: c.created_at
  });
  const notificationOf = (n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    read: Boolean(n.read_at),
    readAt: n.read_at || null,
    createdAt: n.created_at
  });
  const auditOf = (a) => ({
    id: a.id,
    adminId: a.admin_id,
    actorId: a.admin_id,
    adminName: a.actor_name || a.admin_name || 'إدارة النظام',
    actorName: a.actor_name || a.admin_name || 'إدارة النظام',
    actorEmail: a.actor_email || a.admin_email || '',
    adminPhone: a.admin_phone || '',
    actorRole: a.actor_role || a.user_role || 'owner',
    action: a.action,
    targetType: a.target_type,
    targetId: a.target_id,
    details: parseJson(a.details, {}),
    ip: a.ip,
    createdAt: a.created_at
  });
  const paymentsOf = (uid) => q('SELECT * FROM plan_payments WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid).map(paymentOf);
  const meta = (u) => ({ counts: counts(u.id), plan: planOf(u) });
  const productsOf = (uid) => q('SELECT * FROM products WHERE user_id = ? ORDER BY id DESC').all(uid).map(productOf);

  /** أرصدة الدفع عند الاستلام لكل شركة شحن: محصّل (تم التسليم ولم يُسوَّ) / قيد التوصيل / رسوم */
  function codBalances(uid) {
    const rows = q(`SELECT courier,
        COALESCE(SUM(CASE WHEN status = 2 AND settled_at IS NULL THEN total END), 0) collected,
        COALESCE(SUM(CASE WHEN status = 2 AND settled_at IS NULL THEN ship_fee END), 0) fees,
        COALESCE(SUM(CASE WHEN status = 1 THEN total END), 0) pending
      FROM orders WHERE user_id = ? AND pay = ? AND approval_status != 'rejected' GROUP BY courier`).all(uid, COD);
    const couriers = Object.entries(COURIERS).map(([label, c]) => {
      const x = rows.find((row) => row.courier === label) || { collected: 0, fees: 0, pending: 0 };
      return { key: c.key, label, cycle: c.cycle, collected: round2(x.collected), pending: round2(x.pending), fees: round2(x.fees), net: round2(Math.max(0, x.collected - x.fees)) };
    });
    const sum = (k) => round2(couriers.reduce((s, c) => s + c[k], 0));
    return { couriers, totals: { collected: sum('collected'), pending: sum('pending'), fees: sum('fees'), net: sum('net') } };
  }

  return {
    enforcePlanExpiry, upsertCustomerForOrder,
    productOf, orderOf, customerOf, meOf, settingsOf, counts, planOf,
    paymentOf, paymentsOf, couponOf, notificationOf, auditOf,
    meta, productsOf, codBalances
  };
}

module.exports = { createModel };

