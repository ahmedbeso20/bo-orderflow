'use strict';
// محرك حساب صافي الربح الدقيق بالقرش (FIFO Batch COGS + تسويات المنصات + قائمة الدخل P&L)
const { round2, nowIso } = require('./util');
const { MARKETS } = require('./domain');

const DAY_MS = 86400_000;

const DEFAULT_COMMISSION_PCT = { a: 12, n: 10, j: 11, t: 12, k: 10 };

const AMAZON_FEE_LABELS = {
  Commission: 'عمولة بيع أمازون',
  FBAPerUnitFulfillmentFee: 'رسوم تجهيز وشحن FBA',
  FBAWeightBasedFee: 'رسوم وزن FBA',
  FBAPerOrderFulfillmentFee: 'رسوم تجهيز طلب FBA',
  ShippingChargeback: 'خصم شحن أمازون',
  ShippingHB: 'رسوم شحن أمازون',
  FixedClosingFee: 'رسوم إغلاق ثابتة',
  VariableClosingFee: 'رسوم إغلاق متغيرة',
  RefundCommission: 'رسوم معالجة المرتجع',
  ReturnShippingFee: 'رسوم شحن المرتجع',
  GiftwrapChargeback: 'خصم تغليف هدايا',
  EasyShipWeightHandlingFee: 'رسوم EasyShip للوزن',
  StorageFee: 'رسوم تخزين أمازون',
  SponsoredProducts: 'إعلانات أمازون الممولة',
  ServiceFee: 'رسوم خدمات أمازون'
};

function mapAmazonFeeLabel(feeType) {
  const key = String(feeType || '').trim();
  if (!key) return 'رسوم منصة أمازون';
  if (AMAZON_FEE_LABELS[key]) return AMAZON_FEE_LABELS[key];
  if (/tax|vat/i.test(key)) return 'ضريبة القيمة المضافة على الرسوم';
  if (/commission/i.test(key)) return 'عمولة بيع أمازون';
  if (/fulfillment|fba|pick|pack/i.test(key)) return 'رسوم تجهيز وشحن FBA';
  if (/ship/i.test(key)) return 'رسوم شحن أمازون';
  if (/refund|return/i.test(key)) return 'رسوم معالجة المرتجع';
  if (/ad|sponsor/i.test(key)) return 'رسوم إعلانات أمازون';
  return `رسوم أمازون (${key})`;
}

/**
 * استهلاك دُفعات المخزون بنظام الوارد أولًا يُصرف أولًا (FIFO)
 * - يستهلك الكمية من أقدم دُفعات inventory_batches التي لديها qty_remaining > 0
 * - تكلفة الوحدة الواصلة = unit_cost + inbound_ship_per_unit + customs_other_per_unit
 * - للكمية المتبقية دون دُفعات، يعتمد على product.cost كبديل واضح
 * - يسجل التخصيص في order_item_batches إذا تم تمرير orderId لتمكين الاستعادة الدقيقة عند الإلغاء/المرتجع
 */
function consumeFifoCost(q, { userId, productId, qty, orderId = null, fallbackUnitCost = null, packagingPerUnit = null }) {
  const needQty = Math.max(0, Math.floor(Number(qty) || 0));
  if (!needQty || !productId) {
    return { totalCost: 0, unitCostAvg: 0, packagingTotal: 0, allocations: [], usedFallback: false, costMissing: true };
  }

  const prod = q('SELECT id, cost, packaging_cost FROM products WHERE id = ? AND user_id = ?').get(productId, userId);
  const baseUnitCost = fallbackUnitCost != null ? Math.max(0, Number(fallbackUnitCost) || 0) : Math.max(0, Number(prod?.cost || 0));
  const pkgUnit = packagingPerUnit != null ? Math.max(0, Number(packagingPerUnit) || 0) : Math.max(0, Number(prod?.packaging_cost || 0));

  const batches = q(`SELECT id, qty_remaining, unit_cost, inbound_ship_per_unit, customs_other_per_unit
    FROM inventory_batches
    WHERE user_id = ? AND product_id = ? AND qty_remaining > 0
    ORDER BY purchased_at ASC, id ASC`).all(userId, productId);

  let remaining = needQty;
  let totalCost = 0;
  const allocations = [];

  for (const b of batches) {
    if (remaining <= 0) break;
    const avail = Math.max(0, Number(b.qty_remaining || 0));
    if (!avail) continue;
    const take = Math.min(avail, remaining);
    const landed = round2(Number(b.unit_cost || 0) + Number(b.inbound_ship_per_unit || 0) + Number(b.customs_other_per_unit || 0));
    q('UPDATE inventory_batches SET qty_remaining = qty_remaining - ? WHERE id = ? AND user_id = ?')
      .run(take, b.id, userId);
    if (orderId) {
      q('INSERT INTO order_item_batches (order_id, product_id, batch_id, qty, unit_landed_cost) VALUES (?, ?, ?, ?, ?)')
        .run(orderId, productId, b.id, take, landed);
    }
    allocations.push({ batchId: b.id, qty: take, unitLandedCost: landed });
    totalCost += take * landed;
    remaining -= take;
  }

  let usedFallback = false;
  if (remaining > 0) {
    usedFallback = true;
    totalCost += remaining * baseUnitCost;
  }

  const roundedTotal = round2(totalCost);
  const unitCostAvg = needQty > 0 ? round2(roundedTotal / needQty) : 0;
  const packagingTotal = round2(needQty * pkgUnit);
  const costMissing = usedFallback && baseUnitCost <= 0 && allocations.length === 0;

  return {
    totalCost: roundedTotal,
    unitCostAvg,
    packagingTotal,
    allocations,
    usedFallback,
    costMissing
  };
}

/**
 * استعادة دُفعات المخزون FIFO عند إلغاء طلب أو استرجاعه سليمًا
 */
function restoreFifoBatches(q, { userId, orderId }) {
  if (!orderId) return 0;
  const rows = q('SELECT id, batch_id, qty FROM order_item_batches WHERE order_id = ?').all(orderId);
  let restoredUnits = 0;
  for (const row of rows) {
    q(`UPDATE inventory_batches
       SET qty_remaining = MIN(qty_initial, qty_remaining + ?)
       WHERE id = ? AND user_id = ?`)
      .run(row.qty, row.batch_id, userId);
    restoredUnits += Number(row.qty || 0);
  }
  if (rows.length) {
    q('DELETE FROM order_item_batches WHERE order_id = ?').run(orderId);
  }
  return restoredUnits;
}

/**
 * تحليل استجابة Amazon SP-API Finances (/finances/v0/financialEvents)
 * يستخرج ShipmentEventList و RefundEventList و ServiceFeeEventList بدقة بالقرش.
 */
function parseAmazonFinancialEvents(payload) {
  const events = payload?.payload?.FinancialEvents || payload?.FinancialEvents || payload || {};
  const byOrder = new Map(); // externalRef -> { feeLines: [], serviceFeeLines: [], isRefund: boolean }
  const serviceFees = [];

  const ensureOrder = (ref) => {
    const k = String(ref || '').trim();
    if (!k) return null;
    if (!byOrder.has(k)) byOrder.set(k, { externalRef: k, feeLines: [], hasRefund: false, postedDate: null });
    return byOrder.get(k);
  };

  const extractMoney = (obj) => {
    if (!obj) return 0;
    const raw = obj.CurrencyAmount ?? obj.Amount ?? obj.amount ?? 0;
    return Number.isFinite(Number(raw)) ? Number(raw) : 0;
  };

  const processEventList = (list, isRefund = false) => {
    for (const ev of Array.isArray(list) ? list : []) {
      const ref = ev.AmazonOrderId || ev.SellerOrderId || '';
      const bucket = ensureOrder(ref);
      if (!bucket) continue;
      if (isRefund) bucket.hasRefund = true;
      if (ev.PostedDate && !bucket.postedDate) bucket.postedDate = ev.PostedDate;

      const items = ev.ShipmentItemList || ev.ShipmentItemAdjustmentList || ev.OrderItemList || [];
      for (const item of Array.isArray(items) ? items : []) {
        const feeList = item.ItemFeeList || item.ItemFeeAdjustmentList || [];
        for (const fee of Array.isArray(feeList) ? feeList : []) {
          const code = String(fee.FeeType || 'Fee').trim();
          const rawAmt = extractMoney(fee.FeeAmount);
          // في Amazon Finances الرسوم تأتي سالبة (خصم على البائع)؛ نخزن التكلفة كموجب للخصم وسالب للاسترداد
          const costAmount = round2(-rawAmt);
          if (Math.abs(costAmount) < 0.001) continue;
          const isVat = /tax|vat/i.test(code);
          bucket.feeLines.push({
            feeCode: code,
            feeLabel: mapAmazonFeeLabel(code),
            amount: isVat ? 0 : costAmount,
            vatAmount: isVat ? costAmount : 0,
            category: /ad|sponsor/i.test(code) ? 'ad' : /return|refund/i.test(code) ? 'return' : /ship/i.test(code) ? 'shipping' : 'market'
          });
        }

        const chargeList = item.ItemChargeList || item.ItemChargeAdjustmentList || [];
        for (const ch of Array.isArray(chargeList) ? chargeList : []) {
          const code = String(ch.ChargeType || '').trim();
          if (/tax|vat/i.test(code) && /fee|commission/i.test(code)) {
            const rawAmt = extractMoney(ch.ChargeAmount);
            const vatAmt = round2(-rawAmt);
            if (Math.abs(vatAmt) >= 0.001) {
              bucket.feeLines.push({
                feeCode: code,
                feeLabel: mapAmazonFeeLabel(code),
                amount: 0,
                vatAmount: vatAmt,
                category: 'vat'
              });
            }
          }
        }

        const promoList = item.PromotionList || item.PromotionAdjustmentList || [];
        for (const pr of Array.isArray(promoList) ? promoList : []) {
          const rawAmt = extractMoney(pr.PromotionAmount);
          const costAmount = round2(-rawAmt);
          if (Math.abs(costAmount) < 0.001) continue;
          bucket.feeLines.push({
            feeCode: String(pr.PromotionType || 'Promotion'),
            feeLabel: 'خصم ترويجي / كوبون أمازون',
            amount: costAmount,
            vatAmount: 0,
            category: 'other'
          });
        }
      }

      const orderFees = ev.OrderFeeList || ev.OrderFeeAdjustmentList || [];
      for (const fee of Array.isArray(orderFees) ? orderFees : []) {
        const code = String(fee.FeeType || 'OrderFee').trim();
        const costAmount = round2(-extractMoney(fee.FeeAmount));
        if (Math.abs(costAmount) < 0.001) continue;
        bucket.feeLines.push({
          feeCode: code,
          feeLabel: mapAmazonFeeLabel(code),
          amount: costAmount,
          vatAmount: 0,
          category: 'market'
        });
      }
    }
  };

  processEventList(events.ShipmentEventList, false);
  processEventList(events.RefundEventList, true);

  for (const sf of Array.isArray(events.ServiceFeeEventList) ? events.ServiceFeeEventList : []) {
    const ref = String(sf.AmazonOrderId || '').trim();
    const list = Array.isArray(sf.FeeList) ? sf.FeeList : [];
    for (const fee of list) {
      const code = String(fee.FeeType || sf.FeeReason || 'ServiceFee').trim();
      const costAmount = round2(-extractMoney(fee.FeeAmount));
      if (Math.abs(costAmount) < 0.001) continue;
      const line = {
        feeCode: code,
        feeLabel: mapAmazonFeeLabel(code),
        amount: costAmount,
        vatAmount: 0,
        category: /ad|sponsor/i.test(code) ? 'ad' : 'other'
      };
      if (ref) {
        const b = ensureOrder(ref);
        if (b) b.feeLines.push(line);
      } else {
        serviceFees.push({ ...line, externalRef: '' });
      }
    }
  }

  return {
    orders: [...byOrder.values()],
    serviceFees,
    nextToken: payload?.payload?.NextToken || payload?.NextToken || null
  };
}

/**
 * استرجاع قاعدة الرسوم المناسبة لطلب محدد (حسب التاجر والسوق والفئة)
 */
function resolveFeeRule(feeRulesMap, market, cat = 'all') {
  const m = String(market || 'a');
  const exact = feeRulesMap.get(`${m}:${cat}`);
  if (exact) return exact;
  const fallback = feeRulesMap.get(`${m}:all`);
  if (fallback) return fallback;
  return {
    market: m,
    cat: 'all',
    commission_pct: DEFAULT_COMMISSION_PCT[m] ?? 12,
    fulfillment_fee: 0,
    closing_fee: 0,
    rto_ship_multiplier: 1.8
  };
}

/**
 * حساب تفصيلي للربح الصافي على مستوى الطلب الواحد بدقة بالقرش
 */
function computeOrderFinancials(o, feeRulesMap = new Map(), feeLinesByOrder = new Map()) {
  const status = Number(o.status || 0);
  const rejected = o.approval_status === 'rejected';
  if (status === 4 || rejected) {
    return {
      grossSales: 0,
      refundsAndRtoValue: 0,
      marketplaceCommissions: 0,
      shippingAndFulfillmentFees: 0,
      rtoShippingLoss: 0,
      cogsFifo: 0,
      packagingCost: 0,
      adSpend: 0,
      otherFees: 0,
      vat: 0,
      netProfit: 0,
      isSettled: o.fees_source && o.fees_source !== 'estimated'
    };
  }

  const rule = resolveFeeRule(feeRulesMap, o.market, 'all');
  const total = round2(Number(o.total || 0));
  const shipFee = round2(Number(o.ship_fee || 0));
  const cogs = round2(Number(o.cost_total || 0));
  const packaging = round2(Number(o.packaging_total || 0));
  const isSettled = Boolean(o.fees_source && o.fees_source !== 'estimated' && o.actual_market_fees != null);
  const orderLines = feeLinesByOrder.get(o.id) || [];

  if (status === 3) {
    // طلب مرتجع (RTO): لا إيراد، وخسارة شحن ذهاب + عودة + أي غرامة مرتجع فعلية من التسوية
    const rtoMult = Number(rule.rto_ship_multiplier || 1.8);
    const returnBackFee = Number(o.return_ship_fee || 0) > 0
      ? round2(Number(o.return_ship_fee))
      : round2(shipFee * Math.max(0, rtoMult - 1));
    const rtoShipLoss = round2(shipFee + returnBackFee);
    const actualFees = isSettled ? round2(Number(o.actual_market_fees || 0)) : 0;
    const adSpend = round2(Number(o.ad_fee_alloc || 0));
    const otherFees = round2(Number(o.other_platform_fees || 0));
    const vat = round2(orderLines.reduce((s, l) => s + Number(l.vat_amount || 0), 0));
    const netProfit = round2(-(rtoShipLoss + actualFees + adSpend + otherFees + vat + packaging));
    return {
      grossSales: 0,
      refundsAndRtoValue: total,
      marketplaceCommissions: actualFees,
      shippingAndFulfillmentFees: 0,
      rtoShippingLoss: rtoShipLoss,
      cogsFifo: 0,
      packagingCost: packaging,
      adSpend,
      otherFees,
      vat,
      netProfit,
      isSettled
    };
  }

  // طلب نشط / مشحون / مسلّم
  let marketplaceCommissions = 0;
  let shippingAndFulfillmentFees = shipFee;
  let adSpend = round2(Number(o.ad_fee_alloc || 0));
  let otherFees = round2(Number(o.other_platform_fees || 0));
  let vat = 0;

  if (isSettled) {
    marketplaceCommissions = round2(Number(o.actual_market_fees || 0));
    vat = round2(orderLines.reduce((s, l) => s + Number(l.vat_amount || 0), 0));
    // إذا تضمنت بنود التسوية رسوم شحن/تجهيز ضمن actual_market_fees فلن نحسبها مرتين، و shipFee هنا هو شحن التاجر
  } else {
    const commPct = Number(rule.commission_pct ?? DEFAULT_COMMISSION_PCT[o.market] ?? 12);
    const baseComm = round2(total * (commPct / 100));
    const fulfillmentExtra = round2(Number(rule.fulfillment_fee || 0) + Number(rule.closing_fee || 0));
    // ضريبة القيمة المضافة ١٤٪ على عمولة المنصة والرسوم (متوافقة مع حاسبة الأرباح و FEE_RATE_SQL)
    marketplaceCommissions = baseComm;
    vat = round2((baseComm + fulfillmentExtra) * 0.14);
    shippingAndFulfillmentFees = round2(shipFee + fulfillmentExtra);
  }

  const totalDeductions = marketplaceCommissions + shippingAndFulfillmentFees + cogs + packaging + adSpend + otherFees + vat;
  const netProfit = round2(total - totalDeductions);

  return {
    grossSales: total,
    refundsAndRtoValue: 0,
    marketplaceCommissions,
    shippingAndFulfillmentFees,
    rtoShippingLoss: 0,
    cogsFifo: cogs,
    packagingCost: packaging,
    adSpend,
    otherFees,
    vat,
    netProfit,
    isSettled
  };
}

/**
 * حساب المصاريف التشغيلية (Operating Expenses) للفترة الزمنية [fromMs, toMs)
 * - المصاريف لمرة واحدة (once): تُحتسب بالكامل إذا وقع expense_date داخل الفترة
 * - المصاريف الشهرية المتكررة (monthly): تُقسّم تناسبيًا حسب عدد أيام الفترة / 30 يومًا (pro-rated بدقة)
 */
function computeOperatingExpenses(expenses, { fromMs, toMs, market = 'all' }) {
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const toDateExclusive = new Date(toMs).toISOString().slice(0, 10);
  // حساب عدد الأيام الدقيق للفترة (بحد أدنى يوم واحد)
  const windowDays = Math.max(1, (toMs - fromMs) / DAY_MS);

  let total = 0;
  let adExpenses = 0;
  const breakdown = [];

  for (const exp of expenses) {
    if (market && market !== 'all' && exp.market && exp.market !== 'all' && exp.market !== market) {
      continue;
    }
    const amt = Number(exp.amount || 0);
    if (amt <= 0) continue;

    let allocated = 0;
    if (exp.recurrence === 'monthly') {
      // يبدأ احتساب المصروف الشهري من تاريخ بدايته (expense_date) إن كان محدداً وموافقاً للفترة أو قبلها
      const expStartMs = Date.parse(`${String(exp.expense_date || '').slice(0, 10)}T00:00:00.000Z`);
      if (Number.isFinite(expStartMs) && expStartMs >= toMs) {
        continue;
      }
      const effectiveStart = Number.isFinite(expStartMs) ? Math.max(fromMs, expStartMs) : fromMs;
      const activeDays = Math.max(0, (toMs - effectiveStart) / DAY_MS);
      if (activeDays <= 0) continue;
      allocated = round2(amt * (activeDays / 30));
    } else {
      const d = String(exp.expense_date || '').slice(0, 10);
      if (d >= fromDate && d < toDateExclusive) {
        allocated = round2(amt);
      } else if (windowDays <= 1.05 && d === fromDate) {
        allocated = round2(amt);
      }
    }

    if (allocated > 0) {
      if (String(exp.category || '').toLowerCase() === 'ads') {
        adExpenses = round2(adExpenses + allocated);
      } else {
        total = round2(total + allocated);
      }
      breakdown.push({
        id: exp.id,
        title: exp.title,
        category: exp.category,
        recurrence: exp.recurrence,
        allocated
      });
    }
  }

  return { operatingExpenses: round2(total), adExpenses: round2(adExpenses), breakdown };
}

/**
 * حساب قائمة الدخل الشاملة (P&L Waterfall) لفترة زمنية محددة
 */
function computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, { fromMs, toMs, market = 'all', label = '' }) {
  let grossSales = 0;
  let refundsAndRtoValue = 0;
  let marketplaceCommissions = 0;
  let shippingAndFulfillmentFees = 0;
  let rtoShippingLoss = 0;
  let cogsFifo = 0;
  let packagingCost = 0;
  let adSpend = 0;
  let otherFees = 0;
  let vat = 0;
  let orderCount = 0;
  let returnedCount = 0;
  let settledCount = 0;

  for (const o of orders) {
    const ts = Date.parse(o.created_at);
    if (!Number.isFinite(ts) || ts < fromMs || ts >= toMs) continue;
    if (market && market !== 'all' && o.market !== market) continue;
    if (o.status === 4 || o.approval_status === 'rejected') continue;

    const f = computeOrderFinancials(o, feeRulesMap, feeLinesByOrder);
    orderCount++;
    if (o.status === 3) returnedCount++;
    if (f.isSettled) settledCount++;

    grossSales += f.grossSales;
    refundsAndRtoValue += f.refundsAndRtoValue;
    marketplaceCommissions += f.marketplaceCommissions;
    shippingAndFulfillmentFees += f.shippingAndFulfillmentFees;
    rtoShippingLoss += f.rtoShippingLoss;
    cogsFifo += f.cogsFifo;
    packagingCost += f.packagingCost;
    adSpend += f.adSpend;
    otherFees += f.otherFees;
    vat += f.vat;
  }

  const expCalc = computeOperatingExpenses(expenses, { fromMs, toMs, market });
  adSpend = round2(adSpend + expCalc.adExpenses);
  const operatingExpenses = expCalc.operatingExpenses;

  grossSales = round2(grossSales);
  refundsAndRtoValue = round2(refundsAndRtoValue);
  marketplaceCommissions = round2(marketplaceCommissions);
  shippingAndFulfillmentFees = round2(shippingAndFulfillmentFees);
  rtoShippingLoss = round2(rtoShippingLoss);
  cogsFifo = round2(cogsFifo);
  packagingCost = round2(packagingCost);
  otherFees = round2(otherFees);
  vat = round2(vat);

  const netProfit = round2(
    grossSales
    - marketplaceCommissions
    - shippingAndFulfillmentFees
    - rtoShippingLoss
    - cogsFifo
    - packagingCost
    - adSpend
    - otherFees
    - vat
    - operatingExpenses
  );

  const netMarginPct = grossSales > 0 ? Math.round((netProfit / grossSales) * 1000) / 10 : 0;
  const totalCapital = cogsFifo + packagingCost + adSpend + operatingExpenses;
  const roiPct = totalCapital > 0 ? Math.round((netProfit / totalCapital) * 1000) / 10 : 0;
  const settledOrdersPct = orderCount > 0 ? Math.round((settledCount / orderCount) * 1000) / 10 : 0;

  return {
    label,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    orderCount,
    returnedCount,
    settledCount,
    settledOrdersPct,
    grossSales,
    refundsAndRtoValue,
    marketplaceCommissions,
    shippingAndFulfillmentFees,
    rtoShippingLoss,
    cogsFifo,
    packagingCost,
    adSpend,
    otherFees,
    vat,
    operatingExpenses,
    netProfit,
    netMarginPct,
    roiPct
  };
}

/**
 * حساب لوحة ربحية المتجر الكاملة (Sellerboard-Grade P&L) لفترات متعددة وجدول ربحية المنتجات
 */
function buildFullPnlReport(q, { userId, from = null, to = null, market = 'all', nowMs = Date.now() }) {
  const mkt = market && MARKETS[market] ? market : 'all';
  const rulesRows = q('SELECT * FROM market_fee_rules WHERE user_id = ?').all(userId);
  const feeRulesMap = new Map(rulesRows.map((r) => [`${r.market}:${r.cat || 'all'}`, r]));

  const expenses = q('SELECT * FROM merchant_expenses WHERE user_id = ? ORDER BY expense_date DESC, id DESC').all(userId);

  // نافذة مرجعية تغطي 120 يومًا على الأقل أو النطاق المطلوب
  const nowDate = new Date(nowMs);
  const startOfToday = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const startOfYesterday = startOfToday - DAY_MS;
  const endOfToday = startOfToday + DAY_MS;
  const startOfLast7d = endOfToday - 7 * DAY_MS;
  const startOfThisMonth = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
  const startOfLastMonth = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1);

  let customFromMs = null;
  let customToMs = null;
  if (from) {
    const parsedFrom = Date.parse(String(from).length === 10 ? `${from}T00:00:00.000Z` : from);
    if (Number.isFinite(parsedFrom)) customFromMs = parsedFrom;
  }
  if (to) {
    const rawTo = String(to);
    const parsedTo = rawTo.length === 10 ? Date.parse(`${rawTo}T00:00:00.000Z`) + DAY_MS : Date.parse(rawTo);
    if (Number.isFinite(parsedTo)) customToMs = parsedTo;
  }

  const earliestMs = Math.min(startOfLastMonth, startOfLast7d, customFromMs ?? startOfLastMonth);
  const orders = q(`SELECT * FROM orders
    WHERE user_id = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC`)
    .all(userId, new Date(earliestMs - DAY_MS).toISOString());

  const feeLinesRows = q('SELECT * FROM order_fee_lines WHERE user_id = ?').all(userId);
  const feeLinesByOrder = new Map();
  for (const fl of feeLinesRows) {
    if (!fl.order_id) continue;
    if (!feeLinesByOrder.has(fl.order_id)) feeLinesByOrder.set(fl.order_id, []);
    feeLinesByOrder.get(fl.order_id).push(fl);
  }

  const periods = {
    today: computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, { fromMs: startOfToday, toMs: endOfToday, market: mkt, label: 'اليوم' }),
    yesterday: computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, { fromMs: startOfYesterday, toMs: startOfToday, market: mkt, label: 'أمس' }),
    last7d: computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, { fromMs: startOfLast7d, toMs: endOfToday, market: mkt, label: 'آخر ٧ أيام' }),
    thisMonth: computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, { fromMs: startOfThisMonth, toMs: endOfToday, market: mkt, label: 'هذا الشهر' }),
    lastMonth: computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, { fromMs: startOfLastMonth, toMs: startOfThisMonth, market: mkt, label: 'الشهر الماضي' })
  };

  const activeFromMs = customFromMs ?? startOfThisMonth;
  const activeToMs = customToMs ?? endOfToday;
  const selected = computeWindowPnl(orders, feeRulesMap, feeLinesByOrder, expenses, {
    fromMs: activeFromMs,
    toMs: activeToMs,
    market: mkt,
    label: customFromMs ? 'الفترة المحددة' : 'هذا الشهر'
  });

  // جدول ربحية المنتجات خلال الفترة المختارة (activeFromMs .. activeToMs)
  const prodRows = q('SELECT id, sku, name, cat, price, cost, packaging_cost, cost_is_estimated, stock FROM products WHERE user_id = ?').all(userId);
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  const perProd = new Map();

  const activeOrders = orders.filter((o) => {
    const ts = Date.parse(o.created_at);
    return Number.isFinite(ts) && ts >= activeFromMs && ts < activeToMs && (mkt === 'all' || o.market === mkt) && o.status !== 4 && o.approval_status !== 'rejected';
  });

  const orderItemsStmt = q('SELECT product_id, name, qty, price, cost FROM order_items WHERE order_id = ?');
  const recentOrderSummaries = [];

  for (const o of activeOrders) {
    const fin = computeOrderFinancials(o, feeRulesMap, feeLinesByOrder);
    if (recentOrderSummaries.length < 40) {
      recentOrderSummaries.push({
        id: o.id,
        no: o.no,
        externalRef: o.external_ref || '',
        market: o.market,
        status: o.status,
        total: o.total,
        feesSource: o.fees_source || 'estimated',
        financialSettledAt: o.financial_settled_at || null,
        cogsFifo: fin.cogsFifo,
        feesTotal: round2(fin.marketplaceCommissions + fin.shippingAndFulfillmentFees + fin.rtoShippingLoss + fin.vat + fin.adSpend + fin.otherFees),
        packagingCost: fin.packagingCost,
        netProfit: fin.netProfit,
        createdAt: o.created_at
      });
    }

    const items = orderItemsStmt.all(o.id);
    if (!items.length) continue;
    const totalLineVal = items.reduce((s, it) => s + Math.max(0, Number(it.price || 0) * Number(it.qty || 1)), 0) || 1;
    const orderFeesTotal = fin.marketplaceCommissions + fin.shippingAndFulfillmentFees + fin.rtoShippingLoss + fin.vat + fin.adSpend + fin.otherFees + fin.packagingCost;

    for (const it of items) {
      const pid = it.product_id || `name:${it.name}`;
      const prod = it.product_id ? prodMap.get(it.product_id) : null;
      if (!perProd.has(pid)) {
        perProd.set(pid, {
          productId: it.product_id || null,
          sku: prod?.sku || '—',
          name: prod?.name || it.name,
          cat: prod?.cat || 'عام',
          costMissing: prod ? (Number(prod.cost || 0) <= 0 || Boolean(prod.cost_is_estimated)) : (Number(it.cost || 0) <= 0),
          unitsSold: 0,
          unitsReturned: 0,
          revenue: 0,
          fees: 0,
          cogs: 0,
          netProfit: 0
        });
      }
      const agg = perProd.get(pid);
      const qty = Math.max(1, Number(it.qty || 1));
      const lineRev = round2(Number(it.price || 0) * qty);
      const weight = lineRev / totalLineVal;
      const allocFees = round2(orderFeesTotal * weight);
      const lineCogs = round2(Number(it.cost || 0) * qty);

      if (o.status === 3) {
        agg.unitsReturned += qty;
        agg.fees = round2(agg.fees + allocFees);
        agg.netProfit = round2(agg.netProfit - allocFees);
      } else {
        agg.unitsSold += qty;
        agg.revenue = round2(agg.revenue + lineRev);
        agg.fees = round2(agg.fees + allocFees);
        agg.cogs = round2(agg.cogs + lineCogs);
        agg.netProfit = round2(agg.netProfit + (lineRev - allocFees - lineCogs));
      }
    }
  }

  const productProfitability = [...perProd.values()].map((p) => {
    const totalUnits = p.unitsSold + p.unitsReturned;
    const returnRatePct = totalUnits > 0 ? Math.round((p.unitsReturned / totalUnits) * 1000) / 10 : 0;
    const marginPct = p.revenue > 0 ? Math.round((p.netProfit / p.revenue) * 1000) / 10 : (p.netProfit < 0 ? -100 : 0);
    const roiPct = p.cogs > 0 ? Math.round((p.netProfit / p.cogs) * 1000) / 10 : 0;
    return {
      ...p,
      returnRatePct,
      marginPct,
      roiPct,
      isLosing: p.netProfit < 0
    };
  }).sort((a, b) => {
    if (a.isLosing !== b.isLosing) return a.isLosing ? -1 : 1;
    return b.netProfit - a.netProfit;
  });

  const missingCogsCount = Number(
    q('SELECT COUNT(*) n FROM products WHERE user_id = ? AND (cost <= 0 OR cost_is_estimated = 1)').get(userId)?.n || 0
  );

  return {
    market: mkt,
    missingCogsCount,
    periods,
    selected,
    products: productProfitability,
    orders: recentOrderSummaries,
    feeRules: rulesRows,
    generatedAt: nowIso()
  };
}

module.exports = {
  AMAZON_FEE_LABELS,
  DEFAULT_COMMISSION_PCT,
  mapAmazonFeeLabel,
  consumeFifoCost,
  restoreFifoBatches,
  parseAmazonFinancialEvents,
  resolveFeeRule,
  computeOrderFinancials,
  computeOperatingExpenses,
  computeWindowPnl,
  buildFullPnlReport
};
