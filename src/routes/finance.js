'use strict';
const crypto = require('node:crypto');
const { HttpError, round2, nowIso } = require('../util');
const { MARKETS, COURIERS, COURIER_BY_KEY, COD, PAY_BUCKET, FEE_RATE_SQL } = require('../domain');

const DAY = 86400000;
// الإيراد/العمولات/صافي الربح لكل طلب غير ملغي وغير مرفوض. المرتجع: لا إيراد وخسارة شحن ذهابًا وإيابًا (×١٫٨ كما في الحاسبة)
const REV = "CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN total ELSE 0 END";
const FEES = `CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN total * ${FEE_RATE_SQL} ELSE 0 END`;
const NET = `CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN total - total * ${FEE_RATE_SQL} - cost_total - ship_fee WHEN status = 3 AND approval_status != 'rejected' THEN -ship_fee * 1.8 ELSE 0 END`;


module.exports = (r, { q, tx, cfg, model, cipher, connectors, couriers, limiter, logAudit }) => {
  const iso = (t) => new Date(t).toISOString();
  const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null);
  const ipaOf = (u) => (cipher ? cipher.decrypt(u.instapay) : String(u.instapay || ''));

  const { codBalances } = model;

  r.get('/api/dashboard', ({ user, query }) => {
    const range = [7, 30, 90].includes(+query.range) ? +query.range : 30;
    const market = MARKETS[query.market] ? query.market : null;
    const sourceFilter = query.source === 'connected' ? 'connected' : 'all';
    const mk = (market ? ' AND market = ?' : '') + (sourceFilter === 'connected' ? " AND source IN ('amazon','noon','jumia','trendyol','kenzz')" : '');
    const now = Date.now();
    const win = (from, to) => q(`SELECT COALESCE(SUM(${REV}), 0) gross, COALESCE(SUM(${FEES}), 0) fees, COALESCE(SUM(${NET}), 0) net,
        COUNT(*) orders, COALESCE(SUM(status = 2), 0) delivered, COALESCE(SUM(status = 3), 0) returned
      FROM orders WHERE user_id = ? AND created_at >= ? AND created_at < ?${mk}`).get(...[user.id, iso(from), iso(to), ...(market ? [market] : [])]);

    const cur = win(now - range * DAY, now + 60_000);
    const prev = win(now - 2 * range * DAY, now - range * DAY);
    const finished = cur.delivered + cur.returned;

    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1);
    const byMonth = new Map(q(`SELECT substr(created_at, 1, 7) ym, COALESCE(SUM(${REV}), 0) revenue, COALESCE(SUM(${NET}), 0) profit
      FROM orders WHERE user_id = ? AND created_at >= ?${mk} GROUP BY ym`).all(...[user.id, iso(start), ...(market ? [market] : [])]).map((x) => [x.ym, x]));
    const months = Array.from({ length: 12 }, (_, i) => {
      const ym = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7);
      const x = byMonth.get(ym);
      return { ym, revenue: round2(x?.revenue), profit: round2(x?.profit) };
    });

    const since = iso(now - range * DAY);
    const srcOnly = sourceFilter === 'connected' ? " AND source IN ('amazon','noon','jumia','trendyol','kenzz')" : '';
    const mRows = q(`SELECT market, COUNT(*) orders, COALESCE(SUM(${REV}), 0) amount FROM orders WHERE user_id = ? AND created_at >= ?${srcOnly} GROUP BY market`).all(user.id, since);
    const mTotal = mRows.reduce((s, x) => s + x.amount, 0);
    const marketShare = Object.fromEntries(Object.keys(MARKETS).map((k) => {
      const row = mRows.find((x) => x.market === k);
      const amount = round2(row?.amount);
      const orders = Number(row?.orders || 0);
      return [k, { amount, orders, pct: mTotal ? Math.round((amount / mTotal) * 1000) / 10 : 0 }];
    }));
    const marketShareList = Object.keys(MARKETS).map((k) => ({
      key: k,
      name: MARKETS[k].name,
      amount: marketShare[k].amount,
      orders: marketShare[k].orders,
      pct: marketShare[k].pct
    }));

    const payShare = { cod: 0, wallet: 0, card: 0 };
    const pRows = q(`SELECT pay, COUNT(*) n FROM orders WHERE user_id = ? AND created_at >= ?${srcOnly} GROUP BY pay`).all(user.id, since);
    const pTotal = pRows.reduce((s, x) => s + x.n, 0);
    for (const x of pRows) payShare[PAY_BUCKET[x.pay] || 'card'] += x.n;
    for (const k of Object.keys(payShare)) payShare[k] = pTotal ? Math.round((payShare[k] / pTotal) * 1000) / 10 : 0;

    const recent = q(`SELECT * FROM orders WHERE user_id = ?${mk} ORDER BY created_at DESC, id DESC LIMIT 5`).all(...[user.id, ...(market ? [market] : [])]).map(model.orderOf);
    const conns = connectors ? connectors.listForUser(user.id) : [];
    const hasActiveConnection = conns.some((c) => c.configured && c.enabled);
    const unpricedCostCount = Number(q('SELECT COUNT(*) n FROM products WHERE user_id = ? AND cost <= 0').get(user.id)?.n || 0);

    return {
      range, market: market || 'all', source: sourceFilter, hasActiveConnection,
      kpis: {
        gross: round2(cur.gross), net: round2(cur.net), fees: round2(cur.fees), orders: cur.orders,
        delivered: Number(cur.delivered || 0),
        returned: Number(cur.returned || 0),
        avgOrder: cur.orders ? round2(cur.gross / cur.orders) : 0,
        unpricedCostCount,
        margin: cur.gross ? Math.round((cur.net / cur.gross) * 1000) / 10 : 0,
        deliveryRate: finished ? Math.round((cur.delivered / finished) * 1000) / 10 : 0,
        grossDelta: pct(cur.gross, prev.gross), netDelta: pct(cur.net, prev.net),
        codReady: codBalances(user.id).totals.net
      },
      months, marketShare, marketShareList, payShare, recent
    };
  });

  r.get('/api/cod', ({ user }) => ({
    ...codBalances(user.id),
    instaPayHandle: ipaOf(user),
    accountingMode: 'manual',
    accountingNotice: 'تنبيه محاسبي: تسوية تحصيلات الدفع عند الاستلام (COD) هنا هي تسجيل محاسبي داخلي لمتابعة الأرصدة المسحوبة ولا تُجري تحويلًا بنكيًا تلقائيًا — يتم التحويل الفعلي عبر شركة الشحن أو تطبيق إنستاباي.',
    courierSchemas: couriers ? couriers.COURIER_SCHEMAS : {},
    courierConnections: couriers ? couriers.listForUser(user.id) : []
  }));

  r.post('/api/cod/:courier/payout', ({ user, params }) => {
    const label = COURIER_BY_KEY[params.courier];
    if (!label) throw new HttpError(404, 'شركة الشحن غير معروفة');
    const handle = ipaOf(user);
    if (!handle) throw new HttpError(409, 'أضف عنوان InstaPay لاستلام التحصيلات من صفحة الإعدادات أولًا');
    const out = tx(() => {
      const c = codBalances(user.id).couriers.find((x) => x.key === params.courier);
      if (c.collected <= 0 || c.net <= 0) throw new HttpError(409, 'لا يوجد رصيد قابل للسحب لدى هذه الشركة حاليًا');
      const now = nowIso();
      q("UPDATE orders SET settled_at = ? WHERE user_id = ? AND pay = ? AND courier = ? AND status = 2 AND settled_at IS NULL").run(now, user.id, COD, label);
      q('INSERT INTO payouts (user_id,courier,gross,fees,net,handle,created_at) VALUES (?,?,?,?,?,?,?)').run(user.id, label, c.collected, c.fees, c.net, cipher ? cipher.encrypt(handle) : handle, now);
      return c;
    });
    return {
      net: out.net,
      handle,
      accountingMode: 'manual',
      ...codBalances(user.id),
      instaPayHandle: handle
    };
  });

  // ── ربط شركات الشحن الحقيقية (بوسطة Bosta API / أرامكس Aramex API) ──
  const noDemoCourier = (u) => {
    if (u.is_demo) throw new HttpError(403, 'ربط مفاتيح API لشركات الشحن متاح للحسابات المسجّلة فقط');
  };

  r.get('/api/couriers/connections', ({ user }) => ({
    schemas: couriers.COURIER_SCHEMAS,
    connections: couriers.listForUser(user.id)
  }));

  r.put('/api/couriers/connections/:courier', async ({ user, params, body, ip }) => {
    noDemoCourier(user);
    if (!limiter.hit(`courier-save:${user.id}`, 25, 600_000)) throw new HttpError(429, 'طلبات كثيرة، انتظر قليلًا');
    const connection = couriers.saveConnection(user.id, params.courier, {
      credentials: body?.credentials || {},
      environment: body?.environment || 'production',
      enabled: body?.enabled !== false
    });
    logAudit(user.id, 'courier.credentials_saved', 'courier', null, { courier: params.courier, environment: connection.environment }, ip);
    let testResult = null;
    if (body?.testNow) testResult = await couriers.testConnection(user.id, params.courier);
    return {
      ok: true,
      connection: testResult ? testResult.connection : connection,
      testResult,
      connections: couriers.listForUser(user.id)
    };
  });

  r.post('/api/couriers/connections/:courier/test', async ({ user, params, ip }) => {
    noDemoCourier(user);
    if (!limiter.hit(`courier-test:${user.id}`, 20, 600_000)) throw new HttpError(429, 'محاولات كثيرة لاختبار الاتصال');
    const result = await couriers.testConnection(user.id, params.courier);
    logAudit(user.id, 'courier.connection_tested', 'courier', null, { courier: params.courier, ok: result.ok }, ip);
    return { ...result, connections: couriers.listForUser(user.id) };
  });

  r.delete('/api/couriers/connections/:courier', ({ user, params, ip }) => {
    noDemoCourier(user);
    couriers.deleteConnection(user.id, params.courier);
    logAudit(user.id, 'courier.credentials_deleted', 'courier', null, { courier: params.courier }, ip);
    return { ok: true, connections: couriers.listForUser(user.id) };
  });

  r.post('/api/orders/:id/awb/create', async ({ user, params, body, ip }) => {
    noDemoCourier(user);
    if (!limiter.hit(`awb-create:${user.id}`, 30, 600_000)) throw new HttpError(429, 'طلبات إنشاء بوالص كثيرة، انتظر قليلًا');
    const rawOrder = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!rawOrder) throw new HttpError(404, 'الطلب غير موجود');
    const order = {
      ...rawOrder,
      customer: model.dec(rawOrder.customer),
      phone: model.dec(rawOrder.phone),
      address: model.dec(rawOrder.address)
    };
    const out = await couriers.createAwb(user, order, body?.courier);
    const fresh = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order.id, user.id);
    logAudit(user.id, 'courier.awb_created', 'order', order.id, { courier: body?.courier || order.courier, awbNumber: out.awbNumber }, ip);
    return { ok: true, ...out, order: model.orderOf(fresh) };
  });

  r.post('/api/orders/:id/awb/track', async ({ user, params, body }) => {
    noDemoCourier(user);
    if (!limiter.hit(`awb-track:${user.id}`, 60, 600_000)) throw new HttpError(429, 'طلبات تتبع كثيرة، انتظر قليلًا');
    const order = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!order) throw new HttpError(404, 'الطلب غير موجود');
    const out = await couriers.trackShipment(user, order, body?.courier);
    const fresh = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order.id, user.id);
    return { ok: true, ...out, order: model.orderOf(fresh) };
  });

  // ── Webhook استقبال تحديثات شركات الشحن (Bosta / Aramex / Mylerz) ──
  r.post('/api/webhooks/couriers/:courier', ({ req, params, body, rawBody, ip }) => {
    const courierKey = String(params.courier || '').toLowerCase();
    if (!COURIER_BY_KEY[courierKey]) throw new HttpError(404, 'شركة الشحن غير معروفة');
    const secret = String(cfg?.courierWebhookSecret || '').trim();
    if (!secret) throw new HttpError(503, 'لم يتم ضبط COURIER_WEBHOOK_SECRET على الخادم');

    const sigHeader = String(req.headers['x-courier-signature'] || req.headers['x-webhook-signature'] || '').trim();
    const tokenHeader = String(req.headers['x-webhook-secret'] || '').trim();
    const expectedHmac = crypto.createHmac('sha256', secret).update(rawBody || Buffer.from('')).digest('hex');

    const eqSafe = (a, b) => {
      const ba = Buffer.from(String(a || ''), 'utf8');
      const bb = Buffer.from(String(b || ''), 'utf8');
      return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
    };
    const sigOk = sigHeader ? eqSafe(sigHeader.replace(/^sha256=/i, '').toLowerCase(), expectedHmac) : false;
    const tokOk = tokenHeader ? eqSafe(tokenHeader, secret) : false;
    if (!sigOk && !tokOk) {
      throw new HttpError(401, 'توقيع Webhook شركة الشحن غير صالح', { code: 'INVALID_WEBHOOK_SIGNATURE' });
    }

    const awb = String(body?.trackingNumber || body?.awbNumber || body?.barcode || body?.shipmentNumber || '').trim();
    if (!awb) throw new HttpError(400, 'رقم البوليصة (trackingNumber / awbNumber) مطلوب');
    const statusText = String(body?.state?.value || body?.state || body?.status || body?.UpdateDescription || '').trim().slice(0, 120);
    const mapped = /deliver/i.test(statusText) ? 2 : /return|rto|reject|terminat|cancel/i.test(statusText) ? 3 : /picked|transit|out for|dispatch|ship/i.test(statusText) ? 1 : null;

    const order = q('SELECT * FROM orders WHERE awb_number = ? ORDER BY id DESC LIMIT 1').get(awb);
    if (!order) return { ok: true, matched: false, awbNumber: awb };

    const restoredIds = [];
    tx(() => {
      if (mapped === 2 && order.status !== 2 && order.status !== 3 && order.status !== 4) {
        q('UPDATE orders SET courier_status = ?, status = 2, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?')
          .run(statusText || 'delivered', nowIso(), order.id);
      } else if (mapped === 3 && order.status !== 3 && order.status !== 4) {
        q('UPDATE orders SET courier_status = ?, status = 3, return_reason = COALESCE(NULLIF(return_reason, \'\'), ?) WHERE id = ?')
          .run(statusText || 'returned', statusText || 'مرتجع عبر شركة الشحن', order.id);
        if (order.approval_status !== 'rejected') {
          for (const it of q('SELECT * FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(order.id)) {
            q('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? AND user_id = ?').run(it.qty, nowIso(), it.product_id, order.user_id);
            restoredIds.push(it.product_id);
          }
        }
      } else if (mapped === 1 && order.status === 0) {
        q('UPDATE orders SET courier_status = ?, status = 1 WHERE id = ?').run(statusText || 'in_transit', order.id);
      } else if (statusText) {
        q('UPDATE orders SET courier_status = ? WHERE id = ?').run(statusText, order.id);
      }
    });

    if (connectors && typeof connectors.enqueueStockPush === 'function' && restoredIds.length) {
      for (const pid of restoredIds) {
        const prod = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(pid, order.user_id);
        if (prod) {
          try { connectors.enqueueStockPush(order.user_id, prod); } catch (_) {}
        }
      }
    }

    logAudit(order.user_id, 'courier.webhook_update', 'order', order.id, { courier: courierKey, awbNumber: awb, statusText, mapped }, ip);
    return { ok: true, matched: true, orderId: order.id, awbNumber: awb, status: mapped ?? order.status };
  }, { auth: false, webhook: true });
};
