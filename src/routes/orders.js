'use strict';
const { HttpError, bad, text, integer, phone, email, oneOf, latin, round2, toCsv, nowIso } = require('../util');
const { MARKETS, COURIERS, PAYMENTS, STATUS_NEXT } = require('../domain');
const { invoicePage, awbPage } = require('../pages');
const { sendText } = require('../http');

const STATUS_LABEL = ['قيد التجهيز', 'تم الشحن', 'تم التسليم', 'مرتجع', 'ملغي'];

module.exports = (r, app) => {
  const { q, tx, model, cipher, limiter, logPiiAccess, sendSecurityAlert } = app;

  const find = (uid, id) => {
    const o = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(id) || 0, uid);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    return o;
  };
  const productsByIds = (uid, ids) => ids.map((id) => q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(id, uid)).filter(Boolean).map(model.productOf);

  const restoreOrderStock = (orderId, uid) => {
    const restored = [];
    for (const it of q('SELECT * FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(orderId)) {
      q('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? AND user_id = ?').run(it.qty, nowIso(), it.product_id, uid);
      restored.push(it.product_id);
    }
    return restored;
  };

  const trackBulkExport = (user, ip, target) => {
    if (!limiter || !sendSecurityAlert) return;
    if (!limiter.hit(`bulk-exp:${user.id}`, 3, 600_000)) {
      sendSecurityAlert({
        severity: 'high',
        title: 'تصدير بيانات متكرر بشكل غير معتاد',
        details: { userId: user.id, storeName: user.store_name, target, ip }
      }).catch(() => {});
    }
  };

  r.get('/api/orders', ({ user, query, ip }) => {
    const where = ['user_id = ?'];
    const args = [user.id];
    const status = Number(query.status);
    if (Number.isInteger(status) && status >= 0 && status <= 4) { where.push('status = ?'); args.push(status); }
    if (query.approval && ['pending', 'approved', 'rejected'].includes(query.approval)) {
      where.push('approval_status = ?');
      args.push(query.approval);
    }
    if (query.source === 'connected') {
      where.push("source IN ('amazon','noon','jumia','trendyol','kenzz')");
    }
    const perPage = Math.min(100, Math.max(5, Number(query.limit) || 25));
    const search = String(query.q ?? '').trim().slice(0, 60);

    let items, total, pages, page;
    if (search) {
      // Because buyer names/phones are encrypted at rest with random IVs (AES-256-GCM),
      // substring search decrypts up to 5000 merchant orders in memory before filtering.
      const needle = search.toLowerCase();
      const needleLatin = latin(search).toLowerCase();
      const noSearch = Number(latin(search));
      const all = q(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 5000`)
        .all(...args)
        .map(model.orderOf)
        .filter((o) => {
          if (Number.isInteger(noSearch) && o.no === noSearch) return true;
          const hay = `${o.customer} ${o.phone} ${o.gov} ${o.courier} ${o.items}`.toLowerCase();
          return hay.includes(needle) || hay.includes(needleLatin);
        });
      total = all.length;
      pages = Math.max(1, Math.ceil(total / perPage));
      page = Math.min(pages, Math.max(1, Number(query.page) || 1));
      items = all.slice((page - 1) * perPage, page * perPage);
    } else {
      total = q(`SELECT COUNT(*) n FROM orders WHERE ${where.join(' AND ')}`).get(...args).n;
      pages = Math.max(1, Math.ceil(total / perPage));
      page = Math.min(pages, Math.max(1, Number(query.page) || 1));
      items = q(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...args, perPage, (page - 1) * perPage).map(model.orderOf);
    }

    if (logPiiAccess && items.length > 0) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: user._impersonatedBy ? 'impersonate_view_orders' : 'orders_list',
        targetType: 'order',
        count: items.length,
        ip
      });
    }

    return { items, total, page, pages, perPage, counts: model.counts(user.id) };
  });

  r.post('/api/orders', ({ user, body }) => {
    const market = oneOf(body.market, Object.keys(MARKETS), 'السوق');
    const customer = text(body.customer, 'اسم العميل', { min: 2, max: 60 });
    const ph = phone(body.phone, { optional: true });
    const gov = text(body.gov, 'المحافظة', { min: 2, max: 40 });
    const address = text(body.address, 'العنوان', { max: 200, optional: true });
    const pay = oneOf(body.pay, PAYMENTS, 'طريقة الدفع');
    const courier = oneOf(body.courier, Object.keys(COURIERS), 'شركة الشحن');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) throw bad('أضف منتجًا واحدًا على الأقل (حتى ٢٠ منتجًا)');
    const wanted = new Map();
    for (const it of body.items) {
      const pid = integer(it?.productId, 'المنتج', { min: 1, max: 2 ** 31 });
      wanted.set(pid, (wanted.get(pid) || 0) + integer(it?.qty, 'الكمية', { min: 1, max: 999 }));
    }

    const order = tx(() => { // خصم المخزون وتسجيل الطلب معًا: إما ينجح الاثنان أو لا شيء
      const now = nowIso();
      const lines = [];
      let total = 0, cost = 0;
      for (const [pid, qty] of wanted) {
        const p = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(pid, user.id);
        if (!p) throw bad('أحد المنتجات غير موجود');
        if (p.approval_status === 'rejected') throw new HttpError(409, `المنتج "${p.name}" مرفوض ولا يمكن الطلب منه`);
        if (!p.markets.includes(market)) throw bad(`"${p.name}" غير منشور على ${MARKETS[market].name}`);
        if (!q('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?').run(qty, now, p.id, qty).changes) {
          throw new HttpError(409, `المخزون غير كافٍ لـ "${p.name}" (المتاح ${p.stock} قطعة)`);
        }
        total += p.price * qty; cost += p.cost * qty;
        lines.push({ p, qty });
      }
      const no = q('UPDATE users SET order_seq = order_seq + 1 WHERE id = ? RETURNING order_seq').get(user.id).order_seq;
      const itemsText = lines.map(({ p, qty }) => `${p.name}${qty > 1 ? ` (${qty} قطع)` : ''}`).join(' + ').slice(0, 500);
      const approvalStatus = user.role === 'owner' ? 'approved' : 'pending';
      const customerId = model.upsertCustomerForOrder({ userId: user.id, name: customer, phone: ph, gov, address, now });
      const id = q(`INSERT INTO orders (user_id,no,market,customer,customer_id,phone,phone_hash,gov,address,pay,courier,total,cost_total,ship_fee,status,items,approval_status,reject_reason,source,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,'manual',?)`).run(
        user.id, no, market,
        model.enc(customer), customerId, model.enc(ph), model.phoneHash(ph),
        gov, model.enc(address), pay, courier,
        Math.round(total * 100) / 100, Math.round(cost * 100) / 100, COURIERS[courier].fee, itemsText, approvalStatus, '', now
      ).lastInsertRowid;
      for (const { p, qty } of lines) q('INSERT INTO order_items (order_id,product_id,name,qty,price,cost) VALUES (?,?,?,?,?,?)').run(id, p.id, p.name, qty, p.price, p.cost);
      return q('SELECT * FROM orders WHERE id = ?').get(id);
    });
    const ids = [...wanted.keys()];
    return { order: model.orderOf(order), products: productsByIds(user.id, ids), counts: model.counts(user.id) };
  });

  r.post('/api/orders/:id/status', ({ user, params, body }) => {
    const next = integer(body.status, 'الحالة', { min: 1, max: 4 });
    const reason = body.reason ? text(body.reason, 'السبب', { max: 200, optional: true }) : '';
    const changed = tx(() => {
      const o = find(user.id, params.id);
      if (!(STATUS_NEXT[o.status] || []).includes(next)) throw new HttpError(409, `لا يمكن نقل الطلب من "${STATUS_LABEL[o.status]}" إلى "${STATUS_LABEL[next]}"`);
      if (next === 4) {
        q('UPDATE orders SET status = 4, cancel_reason = ?, cancelled_at = ? WHERE id = ?').run(reason || 'إلغاء الطلب قبل الشحن', nowIso(), o.id);
      } else if (next === 3) {
        q('UPDATE orders SET status = 3, return_reason = COALESCE(NULLIF(?, \'\'), return_reason) WHERE id = ?').run(reason, o.id);
      } else if (next === 2) {
        q('UPDATE orders SET status = 2, delivered_at = ? WHERE id = ?').run(nowIso(), o.id);
      } else {
        q('UPDATE orders SET status = ? WHERE id = ?').run(next, o.id);
      }
      let restored = [];
      if ((next === 3 || next === 4) && o.approval_status !== 'rejected') {
        restored = restoreOrderStock(o.id, user.id);
      }
      return { id: o.id, restored };
    });
    return { order: model.orderOf(find(user.id, changed.id)), products: productsByIds(user.id, changed.restored), counts: model.counts(user.id) };
  });

  // إلغاء الطلب قبل الشحن واستعادة المخزون
  r.post('/api/orders/:id/cancel', ({ user, params, body }) => {
    const reason = text(body.reason || 'إلغاء بناءً على طلب العميل', 'سبب الإلغاء', { min: 2, max: 200 });
    const changed = tx(() => {
      const o = find(user.id, params.id);
      if (o.status !== 0) throw new HttpError(409, `لا يمكن إلغاء الطلب في مرحلة "${STATUS_LABEL[o.status]}"؛ يُسمح بالإلغاء للطلبات قيد التجهيز فقط.`);
      q('UPDATE orders SET status = 4, cancel_reason = ?, cancelled_at = ? WHERE id = ?').run(reason, nowIso(), o.id);
      const restored = o.approval_status !== 'rejected' ? restoreOrderStock(o.id, user.id) : [];
      return { id: o.id, restored };
    });
    return { order: model.orderOf(find(user.id, changed.id)), products: productsByIds(user.id, changed.restored), counts: model.counts(user.id) };
  });

  // صفحة المرتجعات وتحليلات RTO
  r.get('/api/returns', ({ user, query }) => {
    const search = String(query.q ?? '').trim().slice(0, 60).toLowerCase();
    let returns = q('SELECT * FROM orders WHERE user_id = ? AND status = 3 ORDER BY created_at DESC, id DESC LIMIT 500')
      .all(user.id).map(model.orderOf);
    if (search) {
      // Decrypt-then-filter in memory because buyer names/phones are encrypted at rest
      returns = returns.filter((o) => `${o.customer} ${o.phone} ${o.gov} ${o.courier} ${o.items}`.toLowerCase().includes(search));
    }
    returns = returns.slice(0, 100);
    const stats = q(`SELECT
        COALESCE(SUM(status = 3), 0) totalReturns,
        COALESCE(SUM(status = 2), 0) totalDelivered,
        COALESCE(SUM(CASE WHEN status = 3 THEN total ELSE 0 END), 0) returnsValue,
        COALESCE(SUM(CASE WHEN status = 3 THEN ship_fee * 1.8 ELSE 0 END), 0) shipLoss
      FROM orders WHERE user_id = ?`).get(user.id);
    const finished = stats.totalReturns + stats.totalDelivered;
    const returnRate = finished ? Math.round((stats.totalReturns / finished) * 1000) / 10 : 0;
    const byCourier = q('SELECT courier, COUNT(*) n, COALESCE(SUM(ship_fee * 1.8), 0) loss FROM orders WHERE user_id = ? AND status = 3 GROUP BY courier').all(user.id);
    return {
      returns,
      summary: {
        count: stats.totalReturns,
        totalReturns: stats.totalReturns,
        returnRate,
        totalAmount: round2(stats.returnsValue),
        returnsValue: round2(stats.returnsValue),
        shipLoss: round2(stats.shipLoss)
      },
      byCourier
    };
  });

  r.post('/api/returns/:id/reason', ({ user, params, body }) => {
    const o = find(user.id, params.id);
    const reason = text(body.reason, 'سبب المرتجع', { min: 2, max: 200 });
    q('UPDATE orders SET return_reason = ? WHERE id = ?').run(reason, o.id);
    return { order: model.orderOf(find(user.id, o.id)) };
  });

  // صفحة العملاء (CRM حقيقي مربوط بجدول customers + إحصائيات orders)
  const findCustomer = (uid, id) => {
    const c = q('SELECT * FROM customers WHERE id = ? AND user_id = ?').get(Number(id) || 0, uid);
    if (!c) throw new HttpError(404, 'العميل غير موجود');
    return c;
  };

  const customerWithStats = (uid, cid) => {
    const row = q(`SELECT
        c.*,
        COUNT(o.id) AS ordersCount,
        COALESCE(SUM(CASE WHEN o.status = 2 THEN 1 ELSE 0 END), 0) AS deliveredCount,
        COALESCE(SUM(CASE WHEN o.status = 3 THEN 1 ELSE 0 END), 0) AS returnedCount,
        COALESCE(SUM(CASE WHEN o.status = 4 THEN 1 ELSE 0 END), 0) AS cancelledCount,
        COALESCE(SUM(CASE WHEN o.id IS NOT NULL AND o.status NOT IN (3, 4) THEN o.total ELSE 0 END), 0) AS totalSpent,
        MAX(o.created_at) AS lastOrderAt,
        GROUP_CONCAT(DISTINCT o.market) AS markets
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id AND o.user_id = c.user_id
      WHERE c.user_id = ? AND c.id = ?
      GROUP BY c.id`).get(uid, cid);
    return row ? model.customerOf(row) : null;
  };

  r.get('/api/customers', ({ user, query, ip }) => {
    // Customer names/phones/addresses are encrypted at rest; decrypt merchant's CRM rows in memory for filtering
    const rows = q(`SELECT
        c.*,
        COUNT(o.id) AS ordersCount,
        COALESCE(SUM(CASE WHEN o.status = 2 THEN 1 ELSE 0 END), 0) AS deliveredCount,
        COALESCE(SUM(CASE WHEN o.status = 3 THEN 1 ELSE 0 END), 0) AS returnedCount,
        COALESCE(SUM(CASE WHEN o.status = 4 THEN 1 ELSE 0 END), 0) AS cancelledCount,
        COALESCE(SUM(CASE WHEN o.id IS NOT NULL AND o.status NOT IN (3, 4) THEN o.total ELSE 0 END), 0) AS totalSpent,
        MAX(o.created_at) AS lastOrderAt,
        GROUP_CONCAT(DISTINCT o.market) AS markets
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id AND o.user_id = c.user_id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY totalSpent DESC, ordersCount DESC, c.id DESC LIMIT 5000`).all(user.id).map(model.customerOf);

    const search = String(query.q ?? '').trim().toLowerCase();
    const seg = String(query.segment ?? 'all');
    const filtered = rows.filter((c) => {
      if (search && !(`${c.name} ${c.phone} ${c.email} ${c.gov} ${c.notes} ${c.tags}`).toLowerCase().includes(search)) return false;
      if (seg === 'vip' && c.totalSpent < 1500 && c.ordersCount < 3) return false;
      if (seg === 'repeat' && c.ordersCount < 2) return false;
      if (seg === 'rto' && c.returnedCount < 1) return false;
      return true;
    });

    const outCustomers = filtered.slice(0, 150);
    if (logPiiAccess && outCustomers.length > 0) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: user._impersonatedBy ? 'impersonate_view_customers' : 'customers_crm_view',
        targetType: 'customer',
        count: outCustomers.length,
        ip
      });
    }

    return {
      customers: outCustomers,
      total: filtered.length,
      summary: {
        totalCustomers: rows.length,
        repeatCustomers: rows.filter((c) => c.ordersCount >= 2).length,
        vipCustomers: rows.filter((c) => c.totalSpent >= 1500 || c.ordersCount >= 3).length,
        avgLtv: rows.length ? round2(rows.reduce((s, c) => s + c.totalSpent, 0) / rows.length) : 0
      }
    };
  });

  r.post('/api/customers', ({ user, body }) => {
    const name = text(body.name, 'اسم العميل', { min: 2, max: 80 });
    const ph = phone(body.phone, { optional: true });
    const mail = email(body.email) || '';
    const gov = text(body.gov, 'المحافظة', { max: 40, optional: true });
    const address = text(body.address, 'العنوان', { max: 240, optional: true });
    const notes = text(body.notes, 'الملاحظات', { max: 1000, optional: true });
    const tags = text(body.tags, 'الوسوم', { max: 200, optional: true });
    const now = nowIso();
    let id;
    try {
      id = Number(q(`INSERT INTO customers (user_id, name, phone, phone_hash, email, gov, address, notes, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, model.enc(name), model.enc(ph), model.phoneHash(ph), mail, gov, model.enc(address), notes, tags, now, now).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'يوجد عميل مسجّل بنفس رقم الموبايل بالفعل');
      throw e;
    }
    return { ok: true, customer: customerWithStats(user.id, id) };
  });

  r.put('/api/customers/:id', ({ user, params, body }) => {
    const cur = findCustomer(user.id, params.id);
    const patch = {};
    if (body.name !== undefined) patch.name = model.enc(text(body.name, 'اسم العميل', { min: 2, max: 80 }));
    if (body.phone !== undefined) {
      const ph = phone(body.phone, { optional: true });
      patch.phone = model.enc(ph);
      patch.phone_hash = model.phoneHash(ph);
    }
    if (body.email !== undefined) patch.email = email(body.email) || '';
    if (body.gov !== undefined) patch.gov = text(body.gov, 'المحافظة', { max: 40, optional: true });
    if (body.address !== undefined) patch.address = model.enc(text(body.address, 'العنوان', { max: 240, optional: true }));
    if (body.notes !== undefined) patch.notes = text(body.notes, 'الملاحظات', { max: 1000, optional: true });
    if (body.tags !== undefined) patch.tags = text(body.tags, 'الوسوم', { max: 200, optional: true });
    const keys = Object.keys(patch);
    if (!keys.length) throw bad('لا توجد تغييرات للحفظ');
    try {
      q(`UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(...keys.map((k) => patch[k]), nowIso(), cur.id, user.id);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'يوجد عميل آخر مسجّل بنفس رقم الموبايل بالفعل');
      throw e;
    }
    return { ok: true, customer: customerWithStats(user.id, cur.id) };
  });

  r.delete('/api/customers/:id', ({ user, params }) => {
    const cur = findCustomer(user.id, params.id);
    q('DELETE FROM customers WHERE id = ? AND user_id = ?').run(cur.id, user.id);
    return { ok: true, deletedId: cur.id };
  });

  r.get('/api/customers/export.csv', ({ user, res, ip }) => {
    trackBulkExport(user, ip, 'customers.csv');
    const rows = [['الاسم', 'الموبايل', 'البريد الإلكتروني', 'المحافظة', 'العنوان', 'الوسوم', 'الملاحظات']];
    const list = q('SELECT * FROM customers WHERE user_id = ? ORDER BY id DESC').all(user.id).map(model.customerOf);
    for (const c of list) {
      rows.push([c.name, c.phone, c.email, c.gov, c.address, c.tags, c.notes]);
    }
    if (logPiiAccess) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: 'customers_export_csv',
        targetType: 'customer',
        count: list.length,
        ip
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orderflow-customers.csv"', 'Cache-Control': 'no-store' });
    res.end(toCsv(rows));
  });

  r.get('/api/orders/export.csv', ({ user, res, ip }) => {
    trackBulkExport(user, ip, 'orders.csv');
    const rows = [['رقم الطلب', 'التاريخ', 'السوق', 'العميل', 'الموبايل', 'المحافظة', 'الدفع', 'الشحن', 'الإجمالي', 'الحالة', 'حالة الاعتماد', 'المصدر', 'المنتجات']];
    const list = q('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(user.id).map(model.orderOf);
    for (const o of list) {
      rows.push([o.no, String(o.createdAt || '').slice(0, 10), MARKETS[o.market]?.name, o.customer, o.phone, o.gov, o.pay, o.courier, o.total, STATUS_LABEL[o.status], o.approvalStatus, o.source, o.items]);
    }
    if (logPiiAccess) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: 'orders_export_csv',
        targetType: 'order',
        count: list.length,
        ip
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="omniarab-orders.csv"', 'Cache-Control': 'no-store' });
    res.end(toCsv(rows));
  });

  r.get('/api/orders/awb', ({ user, res, ip }) => {
    const rawList = q('SELECT * FROM orders WHERE user_id = ? AND status = 0 ORDER BY created_at LIMIT 200').all(user.id);
    const list = rawList.map((o) => ({
      ...o,
      customer: model.dec(o.customer),
      phone: model.dec(o.phone),
      address: model.dec(o.address)
    }));
    if (logPiiAccess) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: 'orders_awb_print',
        targetType: 'order',
        count: list.length,
        ip
      });
    }
    sendText(res, 200, awbPage(list, user), { 'Content-Type': 'text/html; charset=utf-8' });
  });

  r.get('/api/orders/:id/invoice', ({ user, params, res, ip }) => {
    const raw = find(user.id, params.id);
    const o = {
      ...raw,
      customer: model.dec(raw.customer),
      phone: model.dec(raw.phone),
      address: model.dec(raw.address)
    };
    const items = q('SELECT name, qty, price FROM order_items WHERE order_id = ?').all(o.id);
    const store = cipher ? { ...user, tax_id: cipher.decrypt(user.tax_id) } : user;
    if (logPiiAccess) {
      logPiiAccess({
        actorId: user._impersonatedBy || user.id,
        ownerUserId: user.id,
        action: 'order_invoice_print',
        targetType: 'order',
        targetId: o.id,
        count: 1,
        ip
      });
    }
    sendText(res, 200, invoicePage(o, items, store), { 'Content-Type': 'text/html; charset=utf-8' });
  });
};
