'use strict';
// بنية موصّلات شركات الشحن الحقيقية (Bosta API و Aramex API) بنفس أسلوب src/connectors/
// تدعم حفظ مفاتيح API مشفّرة بـ AES-256-GCM، اختبار الاتصال، إنشاء بوالص الشحن (AWB)، وتتبع حالة الشحنة تلقائيًا.

const { HttpError, bad, nowIso, parseJson } = require('../util');
const { COD } = require('../domain');
const { assertSafeExternalUrl, assertSafeExternalUrlWithDns, callJson, callWithRetry, maskSecret } = require('../connectors');

const COURIER_KEYS = ['bosta', 'aramex'];

const COURIER_SCHEMAS = Object.freeze({
  bosta: {
    key: 'bosta',
    name: 'بوسطة (Bosta API v2)',
    label: 'بوسطة',
    docsHint: 'احصل على مفتاح API من لوحة بوسطة للأعمال ← Settings ← Integrations ← API Key.',
    defaultBaseUrl: 'https://app.bosta.co/api/v2',
    sandboxBaseUrl: 'https://stg-app.bosta.co/api/v2',
    fields: [
      { name: 'apiKey', label: 'مفتاح API لبوسطة (API Key)', placeholder: 'أدخل Bosta API Key', required: true, secret: true },
      { name: 'businessLocationId', label: 'معرّف موقع الاستلام (Pickup Location ID — اختياري)', placeholder: 'اختياري', required: false, secret: false },
      { name: 'baseUrl', label: 'رابط Bosta API (اختياري)', placeholder: 'https://app.bosta.co/api/v2', defaultValue: 'https://app.bosta.co/api/v2', required: false, secret: false, isUrl: true }
    ]
  },
  aramex: {
    key: 'aramex',
    name: 'أرامكس (Aramex Shipping API)',
    label: 'أرامكس',
    docsHint: 'أدخل بيانات حساب أرامكس للأعمال (Account Number / Pin / Username / Password) لإصدار بوالص AWB وتتبع الشحنات.',
    defaultBaseUrl: 'https://ws.aramex.net/ShippingAPI.V2',
    sandboxBaseUrl: 'https://ws.sbx.aramex.net/ShippingAPI.V2',
    fields: [
      { name: 'accountNumber', label: 'رقم الحساب (Account Number)', placeholder: 'مثال: 20016', required: true, secret: false },
      { name: 'accountPin', label: 'الرمز السري للحساب (Account Pin)', placeholder: 'أدخل Account Pin', required: true, secret: true },
      { name: 'userName', label: 'اسم المستخدم (Username)', placeholder: 'shipping@store.eg', required: true, secret: false },
      { name: 'password', label: 'كلمة المرور (Password)', placeholder: 'أدخل Aramex API Password', required: true, secret: true },
      { name: 'accountEntity', label: 'كود الفرع (Entity)', placeholder: 'CAI', defaultValue: 'CAI', required: false, secret: false },
      { name: 'accountCountryCode', label: 'كود الدولة', placeholder: 'EG', defaultValue: 'EG', required: false, secret: false },
      { name: 'baseUrl', label: 'رابط Aramex API (اختياري)', placeholder: 'https://ws.aramex.net/ShippingAPI.V2', defaultValue: 'https://ws.aramex.net/ShippingAPI.V2', required: false, secret: false, isUrl: true }
    ]
  }
});

function maskCourierCredentials(courier, rawCreds = {}) {
  const schema = COURIER_SCHEMAS[courier];
  if (!schema) return {};
  const out = {};
  for (const f of schema.fields) {
    const val = String(rawCreds[f.name] ?? '').trim();
    out[f.name] = f.secret
      ? { configured: Boolean(val), masked: maskSecret(val) }
      : (val || f.defaultValue || '');
  }
  return out;
}

function validateAndMergeCourierCredentials(courier, inputCreds = {}, existingCreds = {}) {
  const schema = COURIER_SCHEMAS[courier];
  if (!schema) throw bad('شركة شحن غير مدعومة');
  if (!inputCreds || typeof inputCreds !== 'object' || Array.isArray(inputCreds)) {
    throw bad('بيانات ربط شركة الشحن غير صالحة');
  }
  const merged = {};
  for (const f of schema.fields) {
    let val = inputCreds[f.name] !== undefined && inputCreds[f.name] !== null ? String(inputCreds[f.name]).trim() : '';
    if (!val && f.secret && existingCreds[f.name]) val = String(existingCreds[f.name]).trim();
    if (!val && f.defaultValue) val = f.defaultValue;
    if (val.length > 2000) throw bad(`${f.label}: القيمة طويلة جدًا`);
    if (f.isUrl && val) val = assertSafeExternalUrl(val, f.label);
    if (f.required && !val) throw bad(`حقل "${f.label}" مطلوب لإتمام الربط مع ${schema.name}`);
    merged[f.name] = val;
  }
  return merged;
}

const ADAPTERS = {
  /**
   * 1. Bosta Egypt — Bosta Delivery API v2
   * Docs: https://docs.bosta.co/
   * Auth: Authorization header containing Bosta API Key
   */
  bosta: {
    base(creds, env) {
      return assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? COURIER_SCHEMAS.bosta.sandboxBaseUrl : COURIER_SCHEMAS.bosta.defaultBaseUrl),
        'رابط Bosta API'
      );
    },
    headers(creds) {
      return { authorization: creds.apiKey, 'content-type': 'application/json', accept: 'application/json' };
    },
    async test(creds, env, fetchFn) {
      const res = await callWithRetry(() => callJson(fetchFn, `${this.base(creds, env)}/pickup-locations`, { headers: this.headers(creds) }));
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new HttpError(400, 'مفتاح Bosta API غير صحيح أو غير مخوّل (HTTP ' + res.status + ')');
        throw new HttpError(400, `فشل الاتصال بـ Bosta API (HTTP ${res.status})`);
      }
      return { ok: true, message: 'تم التحقق من اتصال Bosta API بنجاح.' };
    },
    async createAwb(creds, env, order, store, fetchFn) {
      const parts = String(order.customer || 'عميل').trim().split(/\s+/);
      const firstName = parts[0] || 'عميل';
      const lastName = parts.slice(1).join(' ') || '.';
      const payload = {
        type: 10,
        specs: { packageType: 'Parcel', size: 'MEDIUM', packageDetails: { itemsCount: 1, description: String(order.items || `طلب #${order.no}`).slice(0, 120) } },
        notes: `OrderFlow #${order.no}`,
        cod: order.pay === COD ? Number(order.total || 0) : 0,
        dropOffAddress: {
          city: order.gov || 'Cairo',
          firstLine: order.address || order.gov || 'العنوان غير محدد'
        },
        receiver: { firstName, lastName, phone: order.phone || '01000000000' },
        businessReference: `OF-${order.no}`,
        ...(creds.businessLocationId ? { pickupAddress: { businessLocationId: creds.businessLocationId } } : {})
      };
      const res = await callJson(fetchFn, `${this.base(creds, env)}/deliveries`, {
        method: 'POST',
        headers: this.headers(creds),
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new HttpError(400, `فشل إنشاء بوليصة بوسطة: ${res.data?.message || `HTTP ${res.status}`}`);
      const awbNumber = String(res.data?.trackingNumber || res.data?.data?.trackingNumber || res.data?._id || '').trim();
      if (!awbNumber) throw new HttpError(502, 'لم تُرجع بوابة بوسطة رقم بوليصة (trackingNumber)');
      return {
        awbNumber,
        trackingUrl: `https://bosta.co/tracking-shipment/?track_num=${encodeURIComponent(awbNumber)}`,
        courierStatus: String(res.data?.state?.value || res.data?.state || 'created'),
        raw: res.data
      };
    },
    async track(creds, env, awbNumber, fetchFn) {
      const res = await callJson(fetchFn, `${this.base(creds, env)}/deliveries/business/${encodeURIComponent(awbNumber)}`, {
        headers: this.headers(creds)
      });
      if (!res.ok) throw new HttpError(400, `فشل تتبع شحنة بوسطة: ${res.data?.message || `HTTP ${res.status}`}`);
      const statusText = String(res.data?.state?.value || res.data?.CurrentStatus?.state || res.data?.state || 'in_transit');
      const mappedOrderStatus = /deliver/i.test(statusText) ? 2 : /return|cancel|terminat/i.test(statusText) ? 3 : /picked|transit|out for/i.test(statusText) ? 1 : null;
      return { awbNumber, courierStatus: statusText, mappedOrderStatus, raw: res.data };
    }
  },

  /**
   * 2. Aramex — Shipping & Tracking JSON API v2
   * Docs: https://www.aramex.com/developers/
   * Auth: ClientInfo JSON body (AccountNumber, AccountPin, UserName, Password, Entity, CountryCode)
   */
  aramex: {
    base(creds, env) {
      return assertSafeExternalUrl(
        creds.baseUrl || (env === 'sandbox' ? COURIER_SCHEMAS.aramex.sandboxBaseUrl : COURIER_SCHEMAS.aramex.defaultBaseUrl),
        'رابط Aramex API'
      );
    },
    clientInfo(creds) {
      return {
        UserName: creds.userName,
        Password: creds.password,
        Version: 'v1.0',
        AccountNumber: creds.accountNumber,
        AccountPin: creds.accountPin,
        AccountEntity: creds.accountEntity || 'CAI',
        AccountCountryCode: creds.accountCountryCode || 'EG'
      };
    },
    async test(creds, env, fetchFn) {
      const res = await callWithRetry(() => callJson(fetchFn, `${this.base(creds, env)}/Tracking/Service_1_0.svc/json/TrackShipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ClientInfo: this.clientInfo(creds), Shipments: ['0000000000'] })
      }));
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new HttpError(400, 'بيانات حساب أرامكس غير صحيحة أو غير مخوّلة (HTTP ' + res.status + ')');
        throw new HttpError(400, `فشل الاتصال بـ Aramex API (HTTP ${res.status})`);
      }
      if (res.data?.HasErrors && Array.isArray(res.data?.Notifications)) {
        const authErr = res.data.Notifications.find((n) => /auth|credential|account|pin|password/i.test(String(n.Message || n.Code || '')));
        if (authErr) throw new HttpError(400, `بيانات حساب أرامكس غير صحيحة: ${authErr.Message || authErr.Code}`);
      }
      return { ok: true, message: `تم التحقق من اتصال Aramex API (#${creds.accountNumber}) بنجاح.` };
    },
    async createAwb(creds, env, order, store, fetchFn) {
      const payload = {
        ClientInfo: this.clientInfo(creds),
        LabelInfo: { ReportID: 9201, ReportType: 'URL' },
        Shipments: [{
          Reference1: `OF-${order.no}`,
          Shipper: {
            AccountNumber: creds.accountNumber,
            PartyAddress: { Line1: store.store_name || 'OrderFlow Store', City: 'Cairo', CountryCode: creds.accountCountryCode || 'EG' },
            Contact: { PersonName: store.store_name || 'Merchant', CompanyName: store.store_name || 'Merchant', PhoneNumber1: store.phone || '01000000000' }
          },
          Consignee: {
            PartyAddress: { Line1: order.address || order.gov || 'Egypt', City: order.gov || 'Cairo', CountryCode: creds.accountCountryCode || 'EG' },
            Contact: { PersonName: order.customer || 'Customer', CompanyName: order.customer || 'Customer', PhoneNumber1: order.phone || '01000000000' }
          },
          Details: {
            NumberOfPieces: 1,
            ActualWeight: { Unit: 'KG', Value: 1 },
            ProductGroup: 'DOM',
            ProductType: 'ONP',
            PaymentType: 'P',
            CashOnDeliveryAmount: order.pay === COD ? { CurrencyCode: 'EGP', Value: Number(order.total || 0) } : null,
            DescriptionOfGoods: String(order.items || `Order #${order.no}`).slice(0, 120)
          }
        }]
      };
      const res = await callJson(fetchFn, `${this.base(creds, env)}/Shipping/Service_1_0.svc/json/CreateShipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok || res.data?.HasErrors) {
        const msg = res.data?.Notifications?.[0]?.Message || res.data?.Shipments?.[0]?.Notifications?.[0]?.Message || `HTTP ${res.status}`;
        throw new HttpError(400, `فشل إنشاء بوليصة أرامكس: ${msg}`);
      }
      const ship = res.data?.Shipments?.[0] || {};
      const awbNumber = String(ship.ID || res.data?.ID || '').trim();
      if (!awbNumber) throw new HttpError(502, 'لم تُرجع بوابة أرامكس رقم بوليصة (AWB ID)');
      return {
        awbNumber,
        trackingUrl: ship.ShipmentLabel?.LabelURL || `https://www.aramex.com/track/results?ShipmentNumber=${encodeURIComponent(awbNumber)}`,
        courierStatus: 'created',
        raw: res.data
      };
    },
    async track(creds, env, awbNumber, fetchFn) {
      const res = await callJson(fetchFn, `${this.base(creds, env)}/Tracking/Service_1_0.svc/json/TrackShipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ClientInfo: this.clientInfo(creds), Shipments: [awbNumber], GetLastTrackingUpdateOnly: true })
      });
      if (!res.ok) throw new HttpError(400, `فشل تتبع شحنة أرامكس (HTTP ${res.status})`);
      const tr = res.data?.TrackingResults?.[0]?.Value?.[0] || {};
      const statusText = String(tr.UpdateDescription || tr.UpdateCode || 'in_transit');
      const mappedOrderStatus = /deliver/i.test(statusText) ? 2 : /return|cancel/i.test(statusText) ? 3 : /transit|picked|dispatched/i.test(statusText) ? 1 : null;
      return { awbNumber, courierStatus: statusText, mappedOrderStatus, raw: res.data };
    }
  }
};

function createCouriers(app) {
  const { q, cfg, cipher } = app;
  const guardedFetch = cfg.dnsLookup
    ? async (url, init = {}) => {
      await assertSafeExternalUrlWithDns(url, 'رابط شركة الشحن', { lookupFn: cfg.dnsLookup });
      return cfg.fetch(url, init);
    }
    : cfg.fetch;

  function decryptCreds(row) {
    if (!row || !row.creds_enc) return {};
    try { return parseJson(cipher.decrypt(row.creds_enc), {}); } catch { return {}; }
  }

  function formatRow(courier, row) {
    const schema = COURIER_SCHEMAS[courier];
    if (!row) {
      return {
        courier, name: schema.name, label: schema.label, configured: false, enabled: false,
        environment: 'production', status: 'disconnected', credentials: maskCourierCredentials(courier, {}),
        lastTestedAt: null, lastError: ''
      };
    }
    const raw = decryptCreds(row);
    const hasReq = schema.fields.filter((f) => f.required).every((f) => Boolean(raw[f.name]));
    return {
      courier, name: schema.name, label: schema.label, configured: hasReq, enabled: Boolean(row.enabled),
      environment: row.environment || 'production', status: row.status || (hasReq ? 'configured' : 'disconnected'),
      credentials: maskCourierCredentials(courier, raw),
      lastTestedAt: row.last_tested_at || null, lastError: row.last_error || ''
    };
  }

  const getRow = (userId, courier) => {
    if (!COURIER_KEYS.includes(courier)) throw bad('شركة شحن غير مدعومة');
    return q('SELECT * FROM courier_connections WHERE user_id = ? AND courier = ?').get(userId, courier);
  };

  const listForUser = (userId) => {
    const rows = q('SELECT * FROM courier_connections WHERE user_id = ?').all(userId);
    const map = new Map(rows.map((r) => [r.courier, r]));
    return COURIER_KEYS.map((k) => formatRow(k, map.get(k)));
  };

  function saveConnection(userId, courier, { credentials, environment = 'production', enabled = true }) {
    if (!COURIER_KEYS.includes(courier)) throw bad('شركة شحن غير مدعومة');
    const env = environment === 'sandbox' ? 'sandbox' : 'production';
    const existing = getRow(userId, courier);
    const merged = validateAndMergeCourierCredentials(courier, credentials, decryptCreds(existing));
    const enc = cipher.encrypt(JSON.stringify(merged));
    const now = nowIso();
    if (existing) {
      q("UPDATE courier_connections SET enabled = ?, environment = ?, creds_enc = ?, status = 'configured', last_error = '', updated_at = ? WHERE user_id = ? AND courier = ?")
        .run(enabled ? 1 : 0, env, enc, now, userId, courier);
    } else {
      q("INSERT INTO courier_connections (user_id, courier, enabled, environment, creds_enc, status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'configured', '', ?, ?)")
        .run(userId, courier, enabled ? 1 : 0, env, enc, now, now);
    }
    return formatRow(courier, getRow(userId, courier));
  }

  function deleteConnection(userId, courier) {
    if (!COURIER_KEYS.includes(courier)) throw bad('شركة شحن غير مدعومة');
    q('DELETE FROM courier_connections WHERE user_id = ? AND courier = ?').run(userId, courier);
    return formatRow(courier, null);
  }

  async function testConnection(userId, courier) {
    const row = getRow(userId, courier);
    if (!row || !row.creds_enc) throw bad(`أضف بيانات API الخاصة بشركة ${COURIER_SCHEMAS[courier]?.label || courier} أولًا.`);
    const creds = decryptCreds(row);
    const now = nowIso();
    try {
      const res = await ADAPTERS[courier].test(creds, row.environment || 'production', guardedFetch);
      q("UPDATE courier_connections SET status = 'connected', last_tested_at = ?, last_error = '', updated_at = ? WHERE user_id = ? AND courier = ?")
        .run(now, now, userId, courier);
      return { ok: true, message: res.message, connection: formatRow(courier, getRow(userId, courier)) };
    } catch (err) {
      const msg = String(err?.message || 'فشل الاتصال بشركة الشحن').slice(0, 300);
      q("UPDATE courier_connections SET status = 'error', last_tested_at = ?, last_error = ?, updated_at = ? WHERE user_id = ? AND courier = ?")
        .run(now, msg, now, userId, courier);
      return { ok: false, message: msg, connection: formatRow(courier, getRow(userId, courier)) };
    }
  }

  async function createAwb(user, order, courierKey) {
    const key = courierKey || (order.courier === 'أرامكس' ? 'aramex' : 'bosta');
    const row = getRow(user.id, key);
    if (!row || !row.creds_enc) {
      throw bad(`اربط مفاتيح API لشركة ${COURIER_SCHEMAS[key]?.label || key} أولًا من شاشة الشحن لإصدار بوليصة حقيقية.`);
    }
    const creds = decryptCreds(row);
    const res = await ADAPTERS[key].createAwb(creds, row.environment || 'production', order, user, guardedFetch);
    q('UPDATE orders SET awb_number = ?, tracking_url = ?, courier_status = ?, status = CASE WHEN status = 0 THEN 1 ELSE status END WHERE id = ? AND user_id = ?')
      .run(res.awbNumber, res.trackingUrl || '', res.courierStatus || 'created', order.id, user.id);
    return res;
  }

  async function trackShipment(user, order, courierKey) {
    if (!order.awb_number) throw bad('لا يوجد رقم بوليصة (AWB) مسجّل لهذا الطلب بعد.');
    const key = courierKey || (order.courier === 'أرامكس' ? 'aramex' : 'bosta');
    const row = getRow(user.id, key);
    if (!row || !row.creds_enc) throw bad(`اربط مفاتيح API لشركة ${COURIER_SCHEMAS[key]?.label || key} أولًا لتتبع الشحنة.`);
    const creds = decryptCreds(row);
    const res = await ADAPTERS[key].track(creds, row.environment || 'production', order.awb_number, guardedFetch);
    if (res.mappedOrderStatus !== null && order.status === 1 && (res.mappedOrderStatus === 2 || res.mappedOrderStatus === 3)) {
      if (res.mappedOrderStatus === 2) {
        q('UPDATE orders SET courier_status = ?, status = 2, delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND user_id = ?')
          .run(res.courierStatus, nowIso(), order.id, user.id);
      } else {
        q('UPDATE orders SET courier_status = ?, status = ? WHERE id = ? AND user_id = ?').run(res.courierStatus, res.mappedOrderStatus, order.id, user.id);
      }
    } else {
      q('UPDATE orders SET courier_status = ? WHERE id = ? AND user_id = ?').run(res.courierStatus, order.id, user.id);
    }
    return res;
  }

  return {
    COURIER_KEYS,
    COURIER_SCHEMAS,
    listForUser,
    saveConnection,
    deleteConnection,
    testConnection,
    createAwb,
    trackShipment
  };
}

module.exports = {
  COURIER_KEYS,
  COURIER_SCHEMAS,
  maskCourierCredentials,
  validateAndMergeCourierCredentials,
  createCouriers
};
