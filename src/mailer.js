'use strict';
// مرسل بريد إلكتروني فعلي عبر HTTP API (مثل Resend) عند ضبط MAIL_API_KEY و MAIL_FROM،
// مع الإبقاء على وضع الطباعة في الطرفية أثناء التطوير والاختبارات وحفظ السجل للاختبارات.

function createMailer(cfg = {}) {
  const sent = [];

  async function send({ to, subject, text, html, token, url, type }) {
    const entry = {
      to: String(to || '').trim(),
      subject: String(subject || ''),
      text: String(text || ''),
      html: html ? String(html) : null,
      token: token || null,
      url: url || null,
      type: type || 'general',
      provider: 'console',
      delivered: false,
      providerId: null,
      error: null,
      sentAt: new Date().toISOString()
    };

    if (typeof cfg.mailTransport === 'function') {
      entry.provider = 'custom';
      await cfg.mailTransport(entry);
      entry.delivered = true;
      sent.push(entry);
      if (sent.length > 200) sent.shift();
      return entry;
    }

    const apiKey = String(cfg.mailApiKey || '').trim();
    const from = String(cfg.mailFrom || '').trim();
    const apiUrl = String(cfg.mailApiUrl || 'https://api.resend.com/emails').trim();
    const fetchFn = cfg.fetch || globalThis.fetch;

    if (apiKey && from && entry.to.includes('@') && typeof fetchFn === 'function') {
      entry.provider = 'resend';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const payload = {
          from,
          to: [entry.to],
          subject: entry.subject,
          text: entry.text
        };
        if (entry.html) payload.html = entry.html;
        const res = await fetchFn(apiUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        const raw = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        entry.status = Number(res.status || 0);
        if (res.ok) {
          entry.delivered = true;
          entry.providerId = data.id || null;
        } else {
          entry.error = String(data.message || data.error || `HTTP ${res.status}`).slice(0, 240);
          console.error(`[mailer] فشل إرسال البريد إلى ${entry.to}: ${entry.error}`);
        }
      } catch (err) {
        entry.error = String(err?.message || 'خطأ في الاتصال بخدمة البريد').slice(0, 240);
        console.error(`[mailer] تعذّر الاتصال بـ Mail API: ${entry.error}`);
      } finally {
        clearTimeout(timer);
      }
      sent.push(entry);
      if (sent.length > 200) sent.shift();
      return entry;
    }

    if (!cfg.production) {
      entry.delivered = true;
      console.log(`[mailer] To: ${entry.to} | Subject: ${entry.subject}${entry.token ? ` | Token: ${entry.token}` : ''}${entry.url ? ` | URL: ${entry.url}` : ''}`);
    } else {
      console.warn(`[mailer] تحذير: لم يُضبط MAIL_API_KEY أو MAIL_FROM في الإنتاج — تعذّر إرسال البريد إلى ${entry.to}`);
    }
    sent.push(entry);
    if (sent.length > 200) sent.shift();
    return entry;
  }

  return {
    send,
    sent,
    last: () => sent.at(-1) || null,
    clear: () => { sent.length = 0; }
  };
}

module.exports = { createMailer };
