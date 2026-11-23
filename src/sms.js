'use strict';
// وحدة إرسال رسائل SMS لرموز التحقق (OTP): تدعم console للتطوير، وبوابة HTTP عامة لمصر، وTwilio REST عبر fetch فقط (TASK 15)

function formatEgyptE164(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('20') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('01') && digits.length === 11) return `+2${digits}`;
  return digits;
}

function createSms(cfg = {}) {
  const provider = String(cfg.smsProvider || '').trim().toLowerCase();
  const fetchFn = cfg.fetch || globalThis.fetch;
  const sentLog = []; // مفيد للاختبارات عند استخدام console

  const configured = Boolean(
    provider === 'console' ||
    (provider === 'http' && cfg.smsApiUrl) ||
    (provider === 'twilio' && cfg.twilioAccountSid && cfg.twilioAuthToken && cfg.twilioFrom)
  );

  async function send({ to, message }) {
    const dest = formatEgyptE164(to);
    const bodyText = String(message || '').trim();
    if (!dest || !bodyText) {
      return { delivered: false, provider: provider || 'none', error: 'رقم الهاتف أو نص الرسالة فارغ' };
    }

    if (provider === 'console') {
      if (cfg.enforcedProd) {
        return { delivered: false, provider: 'console', error: 'مزود console غير مسموح في بيئة الإنتاج' };
      }
      sentLog.push({ to: dest, message: bodyText, at: new Date().toISOString() });
      console.log(`[sms:console] to=${dest} msg=${bodyText}`);
      return { delivered: true, provider: 'console', to: dest };
    }

    if (provider === 'http' && cfg.smsApiUrl) {
      const tpl = String(cfg.smsBodyTemplate || '{"to":"{to}","message":"{message}","sender":"{sender}"}');
      const jsonSafe = (v) => JSON.stringify(String(v ?? '')).slice(1, -1);
      const rendered = tpl
        .replace(/\{to\}/g, jsonSafe(dest))
        .replace(/\{message\}/g, jsonSafe(bodyText))
        .replace(/\{sender\}/g, jsonSafe(cfg.smsSender || 'OrderFlow'));

      const headers = { 'Content-Type': 'application/json' };
      if (cfg.smsApiKey) {
        headers.Authorization = `Bearer ${cfg.smsApiKey}`;
        headers['X-API-Key'] = cfg.smsApiKey;
      }
      const res = await fetchFn(cfg.smsApiUrl, {
        method: 'POST',
        headers,
        body: rendered,
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) {
        return { delivered: false, provider: 'http', status: res.status, error: `فشل إرسال الرسالة من بوابة SMS (${res.status})` };
      }
      return { delivered: true, provider: 'http', to: dest };
    }

    if (provider === 'twilio' && cfg.twilioAccountSid && cfg.twilioAuthToken && cfg.twilioFrom) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.twilioAccountSid)}/Messages.json`;
      const auth = Buffer.from(`${cfg.twilioAccountSid}:${cfg.twilioAuthToken}`).toString('base64');
      const form = new URLSearchParams({
        To: dest,
        From: cfg.twilioFrom,
        Body: bodyText
      });
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000)
      });
      if (!res.ok) {
        return { delivered: false, provider: 'twilio', status: res.status, error: `فشل إرسال الرسالة عبر Twilio (${res.status})` };
      }
      return { delivered: true, provider: 'twilio', to: dest };
    }

    return { delivered: false, provider: provider || 'none', error: 'مزود رسائل SMS غير مضبوط' };
  }

  return {
    provider: provider || 'none',
    configured,
    sentLog,
    send
  };
}

module.exports = { createSms, formatEgyptE164 };
