'use strict';
const { HttpError, oneOf, parseJson } = require('../util');
const { PLANS, sanitizeIntegrations } = require('../domain');
const { PLATFORM_KEYS, PLATFORM_SCHEMAS } = require('../connectors');

module.exports = (r, app) => {
  const { q, connectors, limiter, logAudit } = app;
  const noDemo = (u) => {
    if (u.is_demo) throw new HttpError(403, 'حفظ مفاتيح API الحقيقية متاح للحسابات المسجّلة فقط (أنشئ حسابًا مجانيًا أولًا).');
  };

  /** قائمة المنصات الخمس مع مخطط الحقول وحالة الاتصال وسجل آخر ١٠ مزامنات (دون كشف أي أسرار) */
  r.get('/api/integrations/connections', ({ user }) => ({
    schemas: PLATFORM_SCHEMAS,
    connections: connectors.listForUser(user.id),
    syncRuns: connectors.listSyncRuns ? connectors.listSyncRuns(user.id, 10) : [],
    integrations: sanitizeIntegrations(parseJson(user.integrations, {}))
  }));

  r.get('/api/integrations/sync-runs', ({ user, query }) => ({
    runs: connectors.listSyncRuns ? connectors.listSyncRuns(user.id, Number(query.limit) || 10) : []
  }));

  /** حفظ أو تحديث مفاتيح API لمنصة محددة (تُشفّر بـ AES-256-GCM في قاعدة البيانات) */
  r.put('/api/integrations/connections/:platform', async ({ user, params, body, ip }) => {
    noDemo(user);
    if (app.getPlatformSettings().require_email_verification === '1' && !user.email_verified_at) {
      throw new HttpError(403, 'يرجى تأكيد بريدك الإلكتروني أولًا قبل ربط متاجر الأسواق.', { code: 'EMAIL_VERIFICATION_REQUIRED' });
    }
    const platform = oneOf(params.platform, PLATFORM_KEYS, 'المنصة');
    if (!limiter.hit(`conn-save:${user.id}`, 30, 600_000)) {
      throw new HttpError(429, 'طلبات كثيرة لتحديث بيانات الربط، انتظر قليلًا');
    }

    const curInts = sanitizeIntegrations(parseJson(user.integrations, {}));
    const plan = app.model.planOf(user);
    const enableMarket = body?.enabled !== false;
    if (enableMarket) {
      const otherActive = PLATFORM_KEYS.filter((k) => k !== platform && curInts[k]).length;
      if (otherActive >= plan.markets) {
        throw new HttpError(402, `${plan.name} تتيح ربط ${plan.markets} أسواق فقط. رقّ باقتك لربط المزيد.`, { code: 'PLAN_LIMIT' });
      }
    }

    const connection = connectors.saveConnection(user.id, platform, {
      credentials: body?.credentials || {},
      environment: body?.environment || 'production',
      enabled: enableMarket
    });

    curInts[platform] = enableMarket ? 1 : 0;
    q('UPDATE users SET integrations = ? WHERE id = ?').run(JSON.stringify(curInts), user.id);

    logAudit(user.id, 'integration.credentials_saved', 'marketplace', null, {
      platform,
      environment: connection.environment,
      enabled: enableMarket
    }, ip);

    let testResult = null;
    if (body?.testNow) {
      testResult = await connectors.testConnection(user.id, platform);
    }

    let syncResult = null;
    if (body?.syncNow && enableMarket && (!body?.testNow || testResult?.ok)) {
      syncResult = await connectors.syncPlatform(user.id, platform);
      if (syncResult?.ok) {
        q('UPDATE users SET last_sync_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
        logAudit(user.id, 'integration.live_sync', 'marketplace', null, {
          platform,
          importedProducts: syncResult.importedProducts,
          updatedProducts: syncResult.updatedProducts,
          importedOrders: syncResult.importedOrders
        }, ip);
      }
    }

    const connections = connectors.listForUser(user.id);
    const updatedConn = connections.find((c) => c.platform === platform) || (testResult ? testResult.connection : connection);

    return {
      ok: true,
      connection: updatedConn,
      testResult,
      syncResult,
      integrations: curInts,
      connections,
      syncRuns: connectors.listSyncRuns ? connectors.listSyncRuns(user.id, 10) : []
    };
  });

  /** اختبار الاتصال الحقيقي بسيرفر المنصة باستخدام المفاتيح المشفرة */
  r.post('/api/integrations/connections/:platform/test', async ({ user, params, ip }) => {
    noDemo(user);
    const platform = oneOf(params.platform, PLATFORM_KEYS, 'المنصة');
    if (!limiter.hit(`conn-test:${user.id}`, 20, 600_000)) {
      throw new HttpError(429, 'محاولات كثيرة لاختبار الاتصال، انتظر قليلًا');
    }
    const result = await connectors.testConnection(user.id, platform);
    logAudit(user.id, 'integration.connection_tested', 'marketplace', null, {
      platform,
      ok: result.ok
    }, ip);
    return {
      ...result,
      connections: connectors.listForUser(user.id)
    };
  });

  /** سحب ومزامنة المنتجات والطلبات الحقيقية من المنصة مباشرةً */
  r.post('/api/integrations/connections/:platform/sync', async ({ user, params, ip }) => {
    noDemo(user);
    const platform = oneOf(params.platform, PLATFORM_KEYS, 'المنصة');
    if (!limiter.hit(`conn-sync:${user.id}`, 15, 600_000)) {
      throw new HttpError(429, 'طلبات مزامنة كثيرة، انتظر قليلًا');
    }
    const result = await connectors.syncPlatform(user.id, platform);
    if (!result.live) {
      throw new HttpError(400, result.reason || 'أضف مفتاح API لهذه المنصة أولًا لبدء سحب البيانات.');
    }
    if (!result.ok) {
      throw new HttpError(502, result.error || 'تعذّر سحب البيانات من المنصة');
    }
    q('UPDATE users SET last_sync_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    logAudit(user.id, 'integration.live_sync', 'marketplace', null, {
      platform,
      importedProducts: result.importedProducts,
      updatedProducts: result.updatedProducts,
      importedOrders: result.importedOrders
    }, ip);
    return {
      ...result,
      connections: connectors.listForUser(user.id),
      syncRuns: connectors.listSyncRuns ? connectors.listSyncRuns(user.id, 10) : [],
      message: `تم سحب البيانات من ${result.name}: +${result.importedProducts} منتج جديد، ${result.updatedProducts} محدّث، +${result.importedOrders} طلب جديد.`
    };
  });

  /** حذف مفاتيح API المشفرة وفصل المنصة بالكامل */
  r.delete('/api/integrations/connections/:platform', ({ user, params, ip }) => {
    noDemo(user);
    const platform = oneOf(params.platform, PLATFORM_KEYS, 'المنصة');
    connectors.deleteConnection(user.id, platform);
    const curInts = sanitizeIntegrations(parseJson(user.integrations, {}));
    curInts[platform] = 0;
    q('UPDATE users SET integrations = ? WHERE id = ?').run(JSON.stringify(curInts), user.id);
    logAudit(user.id, 'integration.credentials_deleted', 'marketplace', null, { platform }, ip);
    return {
      ok: true,
      integrations: curInts,
      connections: connectors.listForUser(user.id)
    };
  });

  /** عرض حالة طابور دفع المخزون الثنائي (sync_outbox) ومعالجته يدويًا */
  r.get('/api/integrations/outbox', ({ user, query }) => ({
    items: connectors.listOutbox ? connectors.listOutbox(user.id, Number(query.limit) || 20) : []
  }));

  r.post('/api/integrations/outbox/process', async ({ user }) => {
    noDemo(user);
    const out = connectors.processSyncOutbox ? await connectors.processSyncOutbox(20) : { processed: 0, succeeded: 0, failed: 0 };
    return { ok: true, ...out, items: connectors.listOutbox ? connectors.listOutbox(user.id, 20) : [] };
  });

  /** ربط Amazon SP-API بضغطة واحدة عبر LWA OAuth (يستخدم Cookie موقّعة HttpOnly للتحقق من state) */
  const crypto = require('node:crypto');
  const { parseCookies } = require('../http');
  const signState = (payload) => {
    const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', app.cfg.secret).update(raw).digest('base64url');
    return `${raw}.${sig}`;
  };
  const verifyState = (cookieVal) => {
    if (!cookieVal || !cookieVal.includes('.')) return null;
    const [raw, sig] = cookieVal.split('.');
    const expected = crypto.createHmac('sha256', app.cfg.secret).update(raw).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (!obj || Date.now() > Number(obj.exp || 0)) return null;
      return obj;
    } catch { return null; }
  };

  r.get('/api/integrations/amazon/oauth/start', ({ user, res }) => {
    noDemo(user);
    const appId = app.cfg.amazonAppId;
    if (!appId || !app.cfg.amazonClientId || !app.cfg.amazonClientSecret) {
      throw new HttpError(503, 'لم يتم تفعيل ربط Amazon OAuth الموحّد على الخادم بعد (أضف AMAZON_SP_APP_ID و AMAZON_LWA_CLIENT_ID/SECRET). يمكنك إدخال المفاتيح يدويًا.');
    }
    const nonce = crypto.randomBytes(24).toString('base64url');
    const signed = signState({ nonce, userId: user.id, exp: Date.now() + 600_000 });
    const secure = app.cfg.enforcedProd ? '; Secure' : '';
    res.setHeader('Set-Cookie', `of_amz_state=${signed}; Path=/api/integrations/amazon/oauth; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    const base = (app.cfg.appUrl || 'http://localhost:3000').replace(/\/+$/, '');
    const redirectUri = `${base}/api/integrations/amazon/oauth/callback`;
    const authUrl = `https://sellercentral.amazon.eg/apps/authorize/consent?application_id=${encodeURIComponent(appId)}&state=${encodeURIComponent(nonce)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return { ok: true, authUrl };
  });

  r.get('/api/integrations/amazon/oauth/callback', async ({ req, res, query, ip }) => {
    const cookies = parseCookies(req.headers.cookie);
    const stateObj = verifyState(cookies.of_amz_state);
    const secure = app.cfg.enforcedProd ? '; Secure' : '';
    res.setHeader('Set-Cookie', `of_amz_state=; Path=/api/integrations/amazon/oauth; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);

    const code = String(query.spapi_oauth_code || '').trim();
    const state = String(query.state || '').trim();
    const sellerId = String(query.selling_partner_id || '').trim();
    if (!stateObj || !state || stateObj.nonce !== state) {
      throw new HttpError(400, 'رمز التحقق (OAuth State) غير صالح أو منتهي الصلاحية');
    }
    if (!code || !sellerId) {
      throw new HttpError(400, 'بيانات التفويض من أمازون غير مكتملة');
    }
    const base = (app.cfg.appUrl || 'http://localhost:3000').replace(/\/+$/, '');
    const redirectUri = `${base}/api/integrations/amazon/oauth/callback`;
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: app.cfg.amazonClientId,
      client_secret: app.cfg.amazonClientSecret
    });
    const tokRes = await app.cfg.fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const tokJson = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokJson.refresh_token) {
      throw new HttpError(502, `تعذّر استبدال رمز تفويض أمازون: ${tokJson.error_description || tokRes.status}`);
    }

    connectors.saveConnection(stateObj.userId, 'a', {
      credentials: {
        sellerId,
        marketplaceId: 'ARBP9OOSHTCHU',
        clientId: app.cfg.amazonClientId,
        clientSecret: app.cfg.amazonClientSecret,
        refreshToken: tokJson.refresh_token
      },
      environment: 'production',
      enabled: true
    });
    const uRow = q('SELECT integrations FROM users WHERE id = ?').get(stateObj.userId);
    const curInts = sanitizeIntegrations(parseJson(uRow?.integrations, {}));
    curInts.a = 1;
    q('UPDATE users SET integrations = ? WHERE id = ?').run(JSON.stringify(curInts), stateObj.userId);
    logAudit(stateObj.userId, 'integration.amazon_oauth_connected', 'marketplace', null, { sellerId }, ip);

    const targetUrl = `${app.appUrlPath('/dashboard/integrations')}?amazon=connected`;
    res.writeHead(302, { Location: targetUrl, 'Cache-Control': 'no-store' });
    res.end();
  }, { auth: false });
};
