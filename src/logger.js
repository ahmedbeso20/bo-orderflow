'use strict';
// وحدة السجلات المهيكلة (Structured JSON Logger) والتبليغ عن أخطاء 500 غير المتوقعة
const crypto = require('node:crypto');

const LEVEL_PRIORITY = { debug: 10, info: 20, warn: 30, error: 40 };
const ERROR_DEDUP_MS = 10 * 60_000; // حد أقصى بلاغ واحد لكل توقيع خطأ خلال 10 دقائق

function createLogger(cfg = {}) {
  const minLevel = LEVEL_PRIORITY[String(cfg.logLevel || process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
  const silent = Boolean(cfg.silentLogs || process.env.NODE_ENV === 'test');
  const errorWebhookUrl = String(cfg.errorWebhookUrl || '').trim();
  const fetchFn = cfg.fetch || globalThis.fetch;
  const recentErrors = new Map();

  function write(level, msg, fields = {}) {
    if (LEVEL_PRIORITY[level] < minLevel) return;
    if (silent && level !== 'error') return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: String(msg || ''),
      ...fields
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  function requestId() {
    return crypto.randomBytes(8).toString('hex');
  }

  function errorSignature(err, routePath = '') {
    const name = String(err?.name || 'Error');
    const firstFrame = String(err?.stack || '').split('\n')[1] || '';
    const message = String(err?.message || '').slice(0, 120);
    return crypto.createHash('sha256').update(`${name}|${message}|${firstFrame}|${routePath}`).digest('hex').slice(0, 16);
  }

  /** يبلغ عن أخطاء 500 أو الاستثناءات غير المعالجة دون تضمين أي جسم طلب (request body) */
  function reportError(err, { reqId = '', path = '', method = '', source = 'http_500' } = {}) {
    const sig = errorSignature(err, path);
    const payload = {
      source,
      signature: sig,
      requestId: reqId || '',
      method: method || '',
      path: path || '',
      message: String(err?.message || err || 'Unknown error').slice(0, 500),
      stack: String(err?.stack || '').split('\n').slice(0, 10).join('\n'),
      ts: new Date().toISOString()
    };

    write('error', payload.message, {
      source,
      signature: sig,
      requestId: reqId || undefined,
      method: method || undefined,
      path: path || undefined
    });

    if (!errorWebhookUrl || typeof fetchFn !== 'function') return Promise.resolve({ sent: false });

    const now = Date.now();
    const last = recentErrors.get(sig) || 0;
    if (now - last < ERROR_DEDUP_MS) return Promise.resolve({ sent: false, deduplicated: true });
    recentErrors.set(sig, now);
    if (recentErrors.size > 500) {
      for (const [k, t] of recentErrors) {
        if (now - t >= ERROR_DEDUP_MS) recentErrors.delete(k);
      }
    }

    return Promise.resolve(fetchFn(errorWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[OrderFlow ${source}] ${payload.message} (reqId: ${payload.requestId || 'n/a'})`,
        ...payload
      }),
      signal: AbortSignal.timeout(5000)
    })).then(() => ({ sent: true })).catch(() => ({ sent: false }));
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    requestId,
    reportError
  };
}

module.exports = { createLogger };
