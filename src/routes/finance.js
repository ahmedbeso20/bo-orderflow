'use strict';
const crypto = require('node:crypto');
const { HttpError, bad, text, money, integer, oneOf, round2, toCsv, nowIso } = require('../util');
const { MARKETS, COURIERS, COURIER_BY_KEY, COD, PAY_BUCKET, FEE_RATE_SQL } = require('../domain');
const { buildFullPnlReport, computeOrderFinancials, restoreFifoBatches } = require('../profit-engine');

const DAY = 86400000;
// الإيراد/العمولات/صافي الربح لكل طلب غير ملغي وغير مرفوض مع تفضيل الرسوم الفعلية المسوّاة (settled) عند توفرها
const REV = "CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN total ELSE 0 END";
const FEES = `CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN CASE WHEN COALESCE(fees_source, 'estimated') != 'estimated' AND actual_market_fees IS NOT NULL THEN actual_market_fees + COALESCE(other_platform_fees, 0) + COALESCE(ad_fee_alloc, 0) ELSE total * ${FEE_RATE_SQL} END ELSE 0 END`;
const NET = `CASE WHEN status NOT IN (3, 4) AND approval_status != 'rejected' THEN total - (CASE WHEN COALESCE(fees_source, 'estimated') != 'estimated' AND actual_market_fees IS NOT NULL THEN actual_market_fees + COALESCE(other_platform_fees, 0) + COALESCE(ad_fee_alloc, 0) ELSE total * ${FEE_RATE_SQL} END) - cost_total - COALESCE(packaging_total, 0) - ship_fee WHEN status = 3 AND approval_status != 'rejected' THEN -(ship_fee + (CASE WHEN COALESCE(return_ship_fee, 0) > 0 THEN return_ship_fee ELSE ship_fee * 0.8 END) + COALESCE(actual_market_fees, 0) + COALESCE(packaging_total, 0)) ELSE 0 END`;


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
    const missingCogsCount = Number(q('SELECT COUNT(*) n FROM products WHERE user_id = ? AND (cost <= 0 OR COALESCE(cost_is_estimated, 0) = 1)').get(user.id)?.n || 0);

    return {
      range, market: market || 'all', source: sourceFilter, hasActiveConnection, missingCogsCount,
      kpis: {
        gross: round2(cur.gross), net: round2(cur.net), fees: round2(cur.fees), orders: cur.orders,
        delivered: Number(cur.delivered || 0),
        returned: Number(cur.returned || 0),
        avgOrder: cur.orders ? round2(cur.gross / cur.orders) : 0,
        unpricedCostCount,
        missingCogsCount,
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
          try { restoreFifoBatches(q, { userId: order.user_id, orderId: order.id }); } catch (_) {}
        }
      } else if (mapped === 1 && order.status === 0) {
        q('UPDATE orders SET courier_status = ?, status = 1 WHERE id = ?').run(statusText || 'in_transit', order.id);
      } else if (statusText) {
        q('UPDATE orders SET courier_status = ? WHERE id = ?').run(statusText, order.id);
      }
    });

    if (connectors && restoredIds.length) {
      for (const pid of restoredIds) {
        const prod = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(pid, order.user_id);
        if (prod) {
          if (typeof connectors.enqueueStockPush === 'function') {
            try { connectors.enqueueStockPush(order.user_id, prod); } catch (_) {}
          }
          if (typeof connectors.enqueueStockSyncForProduct === 'function') {
            try { connectors.enqueueStockSyncForProduct(order.user_id, pid, { reason: 'courier_rto_return' }); } catch (_) {}
          }
        }
      }
    }

    logAudit(order.user_id, 'courier.webhook_update', 'order', order.id, { courier: courierKey, awbNumber: awb, statusText, mapped }, ip);
    return { ok: true, matched: true, orderId: order.id, awbNumber: awb, status: mapped ?? order.status };
  }, { auth: false, webhook: true });

  // ── محرك الربحية الحقيقية (Sellerboard-Grade P&L)، دُفعات FIFO، المصاريف التشغيلية، وتسويات CSV ──
  function parseSettlementCsv(csvText) {
    const src = String(csvText || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field.trim()); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(field.trim());
        if (row.some((c) => c !== '')) rows.push(row);
        row = []; field = '';
      } else {
        field += ch;
      }
    }
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
    return rows;
  }

  r.get('/api/finance/pnl', ({ user, query }) => {
    const market = MARKETS[query.market] ? query.market : 'all';
    const from = query.from && /^\d{4}-\d{2}-\d{2}/.test(String(query.from)) ? String(query.from).slice(0, 24) : null;
    const to = query.to && /^\d{4}-\d{2}-\d{2}/.test(String(query.to)) ? String(query.to).slice(0, 24) : null;
    return buildFullPnlReport(q, { userId: user.id, from, to, market });
  });

  r.get('/api/finance/pnl/export.csv', ({ user, query, res }) => {
    const market = MARKETS[query.market] ? query.market : 'all';
    const report = buildFullPnlReport(q, { userId: user.id, from: query.from || null, to: query.to || null, market });
    const rows = [
      ['الفترة', 'عدد الطلبات', 'إجمالي المبيعات (ج.م)', 'المرتجعات (ج.م)', 'عمولات المنصات (ج.م)', 'الشحن والتجهيز (ج.م)', 'خسارة شحن المرتجعات (ج.م)', 'تكلفة البضاعة FIFO (ج.م)', 'التغليف (ج.م)', 'الإعلانات (ج.م)', 'ضريبة ١٤٪ (ج.م)', 'مصاريف تشغيلية (ج.م)', 'صافي الربح (ج.م)', 'الهامش %', 'ROI %']
    ];
    for (const p of Object.values(report.periods || {})) {
      rows.push([
        p.label, p.orderCount, p.grossSales, p.refundsAndRtoValue, p.marketplaceCommissions,
        p.shippingAndFulfillmentFees, p.rtoShippingLoss, p.cogsFifo, p.packagingCost,
        p.adSpend, p.vat, p.operatingExpenses, p.netProfit, p.netMarginPct, p.roiPct
      ]);
    }
    rows.push([]);
    rows.push(['المنتج', 'SKU', 'الوحدات المباعة', 'المرتجعة', 'نسبة المرتجع %', 'الإيرادات (ج.م)', 'الرسوم والشحن (ج.م)', 'تكلفة FIFO (ج.م)', 'صافي الربح (ج.م)', 'الهامش %', 'ROI %', 'الحالة']);
    for (const pr of report.products || []) {
      rows.push([
        pr.name, pr.sku, pr.unitsSold, pr.unitsReturned, pr.returnRatePct,
        pr.revenue, pr.fees, pr.cogs, pr.netProfit, pr.marginPct, pr.roiPct,
        pr.isLosing ? 'خاسر' : (pr.costMissing ? 'تكلفة غير مؤكدة' : 'رابح')
      ]);
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="orderflow-pnl.csv"',
      'Cache-Control': 'no-store'
    });
    res.end(toCsv(rows));
  });

  r.post('/api/finance/settlements/import', ({ user, body }) => {
    let rawRows = [];
    if (typeof body.csv === 'string' && body.csv.trim()) {
      const parsed = parseSettlementCsv(body.csv);
      if (parsed.length < 2) throw bad('ملف التسوية CSV يجب أن يحتوي على صف عناوين وصف بيانات واحد على الأقل');
      const headerAliases = {
        externalRef: ['externalref', 'external_ref', 'order_id', 'orderid', 'ref', 'رقم الطلب الخارجي', 'مرجع الطلب'],
        market: ['market', 'platform', 'channel', 'السوق', 'المنصة'],
        commission: ['commission', 'referral_fee', 'عمولة', 'العمولة'],
        shippingFee: ['shippingfee', 'shipping_fee', 'fulfillment', 'شحن', 'الشحن'],
        returnPenalty: ['returnpenalty', 'return_penalty', 'rto_fee', 'return_ship_fee', 'غرامة المرتجع', 'شحن المرتجع'],
        adFee: ['adfee', 'ad_fee', 'ppc', 'ads', 'إعلانات', 'الاعلانات'],
        otherFees: ['otherfees', 'other_fees', 'closing_fee', 'رسوم أخرى'],
        vat: ['vat', 'tax', 'ضريبة', 'الضريبة']
      };
      const hdrs = parsed[0].map((h) => {
        const norm = String(h || '').trim().toLowerCase();
        for (const [key, aliases] of Object.entries(headerAliases)) {
          if (aliases.includes(norm)) return key;
        }
        return null;
      });
      if (!hdrs.includes('externalRef')) {
        throw bad('يجب أن يحتوي ملف CSV على عمود externalRef أو order_id لمطابقة الطلبات');
      }
      for (let i = 1; i < parsed.length; i++) {
        const obj = {};
        hdrs.forEach((k, idx) => { if (k) obj[k] = parsed[i][idx] ?? ''; });
        rawRows.push(obj);
      }
    } else if (Array.isArray(body.rows)) {
      rawRows = body.rows;
    } else {
      throw bad('أرسل محتوى CSV في حقل csv أو مصفوفة صفوف في حقل rows');
    }

    if (!rawRows.length) throw bad('لا توجد صفوف تسوية للاستيراد');
    if (rawRows.length > 2000) throw bad('الحد الأقصى لاستيراد التسويات في الدفعة الواحدة ٢٠٠٠ صف');

    const now = nowIso();
    let matchedOrders = 0;
    let feeLinesInserted = 0;
    const unmatchedRefs = [];

    const parseMoneyCell = (v) => {
      const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? Math.abs(round2(n)) : 0;
    };

    tx(() => {
      for (const row of rawRows) {
        const extRef = String(row.externalRef || row.external_ref || row.orderId || '').trim();
        if (!extRef) continue;
        const mktRaw = String(row.market || '').trim().toLowerCase();
        const mkt = MARKETS[mktRaw]
          ? mktRaw
          : /noon|نون/.test(mktRaw) ? 'n'
            : /jumia|جوميا/.test(mktRaw) ? 'j'
              : /amazon|أمازون|امازون/.test(mktRaw) ? 'a'
                : /trendyol|ترينديول/.test(mktRaw) ? 't'
                  : /kenzz|كنز/.test(mktRaw) ? 'k' : '';

        let order = mkt
          ? q('SELECT * FROM orders WHERE user_id = ? AND external_ref = ? AND market = ?').get(user.id, extRef, mkt)
          : q('SELECT * FROM orders WHERE user_id = ? AND external_ref = ?').get(user.id, extRef);
        if (!order && /^#?\d+$/.test(extRef)) {
          order = q('SELECT * FROM orders WHERE user_id = ? AND no = ?').get(user.id, Number(extRef.replace('#', '')));
        }
        if (!order) {
          unmatchedRefs.push(extRef);
          continue;
        }

        const commission = parseMoneyCell(row.commission);
        const shippingFee = parseMoneyCell(row.shippingFee ?? row.shipping_fee);
        const returnPenalty = parseMoneyCell(row.returnPenalty ?? row.return_penalty);
        const adFee = parseMoneyCell(row.adFee ?? row.ad_fee);
        const otherFees = parseMoneyCell(row.otherFees ?? row.other_fees);
        const vat = parseMoneyCell(row.vat);

        q('DELETE FROM order_fee_lines WHERE user_id = ? AND order_id = ?').run(user.id, order.id);
        const lines = [
          { code: 'Commission', label: 'عمولة المنصة (تسوية CSV)', amount: commission, vat: vat },
          { code: 'ShippingFee', label: 'رسوم الشحن والتجهيز (CSV)', amount: shippingFee, vat: 0 },
          { code: 'ReturnPenalty', label: 'غرامة وشحن المرتجع (CSV)', amount: returnPenalty, vat: 0 },
          { code: 'AdFee', label: 'رسوم الإعلانات الممولة (CSV)', amount: adFee, vat: 0 },
          { code: 'OtherFees', label: 'رسوم منصة إضافية (CSV)', amount: otherFees, vat: 0 }
        ].filter((l) => l.amount > 0 || l.vat > 0);
        if (!lines.length && vat > 0) {
          lines.push({ code: 'VAT', label: 'ضريبة القيمة المضافة ١٤٪ (CSV)', amount: 0, vat });
        }

        for (const l of lines) {
          q(`INSERT INTO order_fee_lines (user_id, order_id, external_ref, market, fee_code, fee_label, amount, vat_amount, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(user.id, order.id, extRef, order.market, l.code, l.label, l.amount, l.vat, now);
          feeLinesInserted++;
        }

        q(`UPDATE orders
           SET actual_market_fees = ?,
               other_platform_fees = ?,
               ad_fee_alloc = ?,
               return_ship_fee = CASE WHEN ? > 0 THEN ? ELSE return_ship_fee END,
               fees_source = 'csv_settled',
               financial_settled_at = ?
           WHERE id = ? AND user_id = ?`).run(
          round2(commission),
          round2(shippingFee + otherFees),
          round2(adFee),
          round2(returnPenalty),
          round2(returnPenalty),
          now,
          order.id,
          user.id
        );
        matchedOrders++;
      }
    });

    return {
      ok: true,
      matchedOrders,
      feeLinesInserted,
      unmatchedCount: unmatchedRefs.length,
      unmatchedRefs: unmatchedRefs.slice(0, 50)
    };
  });

  /** إدارة دُفعات المخزون (FIFO Batches) لكل منتج */
  r.get('/api/products/:id/batches', ({ user, params }) => {
    const p = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    const batches = q('SELECT * FROM inventory_batches WHERE user_id = ? AND product_id = ? ORDER BY purchased_at ASC, id ASC').all(user.id, p.id);
    return {
      product: model.productOf(p),
      batches: batches.map((b) => ({
        id: b.id,
        productId: b.product_id,
        batchCode: b.batch_code || '',
        qtyInitial: Number(b.qty_initial || 0),
        qtyRemaining: Number(b.qty_remaining || 0),
        unitCost: Number(b.unit_cost || 0),
        inboundShipPerUnit: Number(b.inbound_ship_per_unit || 0),
        customsOtherPerUnit: Number(b.customs_other_per_unit || 0),
        landedUnitCost: round2(Number(b.unit_cost || 0) + Number(b.inbound_ship_per_unit || 0) + Number(b.customs_other_per_unit || 0)),
        purchasedAt: b.purchased_at,
        notes: b.notes || ''
      }))
    };
  });

  r.post('/api/products/:id/batches', ({ user, params, body }) => {
    const p = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    const qty = integer(body.qty ?? body.qtyInitial, 'كمية الدُفعة', { min: 1, max: 1_000_000 });
    const unitCost = money(body.unitCost ?? body.unit_cost, 'تكلفة الوحدة', { min: 0, max: 10_000_000 });
    const inboundShip = money(body.inboundShipPerUnit ?? body.inbound_ship_per_unit ?? 0, 'شحن التوريد للوحدة', { min: 0, max: 1_000_000 });
    const customsOther = money(body.customsOtherPerUnit ?? body.customs_other_per_unit ?? 0, 'جمارك/مصاريف للوحدة', { min: 0, max: 1_000_000 });
    const batchCode = text(body.batchCode || body.batch_code || `B-${Date.now().toString(36).toUpperCase()}`, 'كود الدُفعة', { max: 40, optional: true });
    const notes = text(body.notes || '', 'ملاحظات', { max: 300, optional: true });
    const purchasedAt = body.purchasedAt && /^\d{4}-\d{2}-\d{2}/.test(String(body.purchasedAt))
      ? new Date(String(body.purchasedAt)).toISOString()
      : nowIso();
    const addToStock = body.addToStock !== false;
    const landed = round2(unitCost + inboundShip + customsOther);
    const now = nowIso();

    const batchId = tx(() => {
      const id = Number(q(`INSERT INTO inventory_batches
        (user_id, product_id, batch_code, qty_initial, qty_remaining, unit_cost, inbound_ship_per_unit, customs_other_per_unit, purchased_at, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, p.id, batchCode, qty, qty, unitCost, inboundShip, customsOther, purchasedAt, notes, now).lastInsertRowid);

      const newStock = addToStock ? Number(p.stock || 0) + qty : Number(p.stock || 0);
      const shouldUpdateCost = Number(p.cost || 0) <= 0 || Number(p.cost_is_estimated || 0) === 1;
      q('UPDATE products SET stock = ?, cost = ?, cost_is_estimated = 0, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(newStock, shouldUpdateCost ? landed : p.cost, now, p.id, user.id);
      return id;
    });

    const updatedProd = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(p.id, user.id);
    if (addToStock && connectors) {
      if (typeof connectors.enqueueStockPush === 'function') {
        try { connectors.enqueueStockPush(user.id, updatedProd); } catch (_) {}
      }
      if (typeof connectors.enqueueStockSyncForProduct === 'function') {
        try { connectors.enqueueStockSyncForProduct(user.id, p.id, { reason: 'fifo_batch_added' }); } catch (_) {}
      }
    }

    const row = q('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    return {
      ok: true,
      batch: {
        id: row.id,
        productId: row.product_id,
        batchCode: row.batch_code,
        qtyInitial: row.qty_initial,
        qtyRemaining: row.qty_remaining,
        unitCost: row.unit_cost,
        inboundShipPerUnit: row.inbound_ship_per_unit,
        customsOtherPerUnit: row.customs_other_per_unit,
        landedUnitCost: landed,
        purchasedAt: row.purchased_at,
        notes: row.notes
      },
      product: model.productOf(updatedProd)
    };
  });

  r.delete('/api/batches/:id', ({ user, params }) => {
    const b = q('SELECT * FROM inventory_batches WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!b) throw new HttpError(404, 'الدُفعة غير موجودة');
    q('DELETE FROM inventory_batches WHERE id = ? AND user_id = ?').run(b.id, user.id);
    return { ok: true, deletedId: b.id };
  });

  /** المصاريف التشغيلية وإعلانات المتجر (Operating Expenses) */
  r.get('/api/finance/expenses', ({ user }) => {
    const rows = q('SELECT * FROM merchant_expenses WHERE user_id = ? ORDER BY expense_date DESC, id DESC LIMIT 500').all(user.id);
    return {
      expenses: rows.map((e) => ({
        id: e.id,
        title: e.title,
        category: e.category,
        market: e.market || 'all',
        amount: Number(e.amount || 0),
        recurrence: e.recurrence || 'once',
        expenseDate: e.expense_date,
        notes: e.notes || '',
        createdAt: e.created_at
      }))
    };
  });

  r.post('/api/finance/expenses', ({ user, body }) => {
    const title = text(body.title, 'عنوان المصروف', { min: 2, max: 120 });
    const category = oneOf(body.category || 'other', ['ads', 'rent', 'salaries', 'packaging_bulk', 'software', 'photography', 'other'], 'التصنيف');
    const market = body.market && body.market !== 'all' ? oneOf(body.market, Object.keys(MARKETS), 'السوق') : 'all';
    const amount = money(body.amount, 'المبلغ', { min: 0.01, max: 100_000_000 });
    const recurrence = oneOf(body.recurrence || 'once', ['once', 'monthly'], 'التكرار');
    const expenseDate = body.expenseDate && /^\d{4}-\d{2}-\d{2}/.test(String(body.expenseDate))
      ? String(body.expenseDate).slice(0, 10)
      : nowIso().slice(0, 10);
    const notes = text(body.notes || '', 'ملاحظات', { max: 300, optional: true });
    const now = nowIso();
    const id = Number(q(`INSERT INTO merchant_expenses (user_id, title, category, market, amount, recurrence, expense_date, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, title, category, market, amount, recurrence, expenseDate, notes, now).lastInsertRowid);
    const row = q('SELECT * FROM merchant_expenses WHERE id = ?').get(id);
    return {
      ok: true,
      expense: {
        id: row.id,
        title: row.title,
        category: row.category,
        market: row.market,
        amount: Number(row.amount || 0),
        recurrence: row.recurrence,
        expenseDate: row.expense_date,
        notes: row.notes || '',
        createdAt: row.created_at
      }
    };
  });

  r.delete('/api/finance/expenses/:id', ({ user, params }) => {
    const row = q('SELECT id FROM merchant_expenses WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!row) throw new HttpError(404, 'المصروف غير موجود');
    q('DELETE FROM merchant_expenses WHERE id = ? AND user_id = ?').run(row.id, user.id);
    return { ok: true, deletedId: row.id };
  });

  /** قواعد عمولات المنصات حسب الفئة */
  r.get('/api/finance/fee-rules', ({ user }) => {
    const rows = q('SELECT * FROM market_fee_rules WHERE user_id = ? ORDER BY market, cat').all(user.id);
    return {
      rules: rows.map((row) => ({
        id: row.id,
        market: row.market,
        cat: row.cat,
        commissionPct: Number(row.commission_pct || 0),
        fulfillmentFee: Number(row.fulfillment_fee || 0),
        closingFee: Number(row.closing_fee || 0),
        rtoShipMultiplier: Number(row.rto_ship_multiplier || 1.8),
        updatedAt: row.updated_at
      }))
    };
  });

  r.put('/api/finance/fee-rules', ({ user, body }) => {
    const market = oneOf(body.market, Object.keys(MARKETS), 'السوق');
    const rawCat = String(body.cat || 'all').trim();
    const cat = text(rawCat === '*' || !rawCat ? 'all' : rawCat, 'الفئة', { min: 1, max: 40 });
    const commissionPct = money(body.commissionPct ?? body.commission_pct ?? 10, 'نسبة العمولة', { min: 0, max: 60 });
    const fulfillmentFee = money(body.fulfillmentFee ?? body.fulfillment_fee ?? 0, 'رسوم التجهيز', { min: 0, max: 10000 });
    const closingFee = money(body.closingFee ?? body.closing_fee ?? 0, 'رسوم الإغلاق', { min: 0, max: 10000 });
    const rtoMult = Math.max(0, Math.min(5, Number(body.rtoShipMultiplier ?? body.rto_ship_multiplier ?? 1.8) || 1.8));
    const now = nowIso();
    q(`INSERT INTO market_fee_rules (user_id, market, cat, commission_pct, fulfillment_fee, closing_fee, rto_ship_multiplier, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, market, cat) DO UPDATE SET
         commission_pct = excluded.commission_pct,
         fulfillment_fee = excluded.fulfillment_fee,
         closing_fee = excluded.closing_fee,
         rto_ship_multiplier = excluded.rto_ship_multiplier,
         updated_at = excluded.updated_at`)
      .run(user.id, market, cat, commissionPct, fulfillmentFee, closingFee, rtoMult, now);
    const rows = q('SELECT * FROM market_fee_rules WHERE user_id = ? ORDER BY market, cat').all(user.id);
    return {
      ok: true,
      rules: rows.map((row) => ({
        id: row.id,
        market: row.market,
        cat: row.cat,
        commissionPct: Number(row.commission_pct || 0),
        fulfillmentFee: Number(row.fulfillment_fee || 0),
        closingFee: Number(row.closing_fee || 0),
        rtoShipMultiplier: Number(row.rto_ship_multiplier || 1.8),
        updatedAt: row.updated_at
      }))
    };
  });

  /** تفصيل الرسوم والأرباح لطلب محدد (Order Fee Drilldown) */
  r.get('/api/orders/:id/fees', ({ user, params }) => {
    const order = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(params.id) || 0, user.id);
    if (!order) throw new HttpError(404, 'الطلب غير موجود');
    const lines = q('SELECT * FROM order_fee_lines WHERE user_id = ? AND order_id = ? ORDER BY id ASC').all(user.id, order.id);
    const rules = q('SELECT * FROM market_fee_rules WHERE user_id = ?').all(user.id);
    const feeRulesMap = new Map(rules.map((row) => [`${row.market}:${row.cat || 'all'}`, row]));
    const feeLinesByOrder = new Map([[order.id, lines]]);
    const financials = computeOrderFinancials(order, feeRulesMap, feeLinesByOrder);
    const batches = q(`SELECT oib.*, ib.batch_code, ib.purchased_at
      FROM order_item_batches oib
      LEFT JOIN inventory_batches ib ON ib.id = oib.batch_id
      WHERE oib.order_id = ?`).all(order.id);
    return {
      order: model.orderOf(order),
      financials,
      lines: lines.map((l) => ({
        id: l.id,
        feeCode: l.fee_code,
        feeLabel: l.fee_label,
        amount: Number(l.amount || 0),
        vatAmount: Number(l.vat_amount || 0),
        createdAt: l.created_at
      })),
      batches: batches.map((b) => ({
        batchId: b.batch_id,
        batchCode: b.batch_code || `#${b.batch_id}`,
        productId: b.product_id,
        qty: Number(b.qty || 0),
        unitLandedCost: Number(b.unit_landed_cost || 0),
        purchasedAt: b.purchased_at
      }))
    };
  });
};
