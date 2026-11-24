'use strict';
// Cloudflare Turnstile server-side CAPTCHA verification (zero external dependencies)
const { HttpError } = require('./util');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifies a Cloudflare Turnstile response token against Cloudflare's siteverify endpoint.
 * When TURNSTILE_SECRET_KEY is not configured, verification is skipped (returns { verified: true, skipped: true }).
 * When TURNSTILE_SECRET_KEY is configured, missing or invalid tokens fail closed with HTTP 400.
 */
async function verifyTurnstileToken(token, remoteIp, cfg = {}) {
  const secret = String(cfg.turnstileSecretKey || '').trim();
  if (!secret) {
    return { verified: true, skipped: true };
  }

  const responseToken = String(token || '').trim();
  if (!responseToken) {
    throw new HttpError(400, 'يرجى إتمام التحقق الأمني (CAPTCHA) للمتابعة.', { code: 'CAPTCHA_REQUIRED' });
  }

  const fetchFn = cfg.fetch || globalThis.fetch;
  const form = new URLSearchParams({
    secret,
    response: responseToken
  });
  if (remoteIp) form.set('remoteip', String(remoteIp));

  let res;
  try {
    res = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw new HttpError(502, 'تعذر التحقق الأمني (CAPTCHA) حاليًا، يرجى المحاولة مرة أخرى.', { code: 'CAPTCHA_UNAVAILABLE' });
  }

  if (!res || !res.ok) {
    throw new HttpError(502, 'تعذر التحقق الأمني (CAPTCHA) حاليًا، يرجى المحاولة مرة أخرى.', { code: 'CAPTCHA_UNAVAILABLE' });
  }

  const data = await res.json().catch(() => null);
  if (!data || data.success !== true) {
    throw new HttpError(400, 'فشل التحقق الأمني (CAPTCHA)؛ يرجى إعادة المحاولة.', {
      code: 'CAPTCHA_FAILED',
      errors: Array.isArray(data?.['error-codes']) ? data['error-codes'] : []
    });
  }

  return { verified: true, skipped: false, hostname: data.hostname || '' };
}

module.exports = { verifyTurnstileToken, SITEVERIFY_URL };
