'use strict';
// مرسل بريد إلكتروني حقيقي بدون حزم خارجية:
// يدعم: (1) Resend HTTP API، (2) SMTP + STARTTLS/TLS المباشر عبر node:net/node:tls،
// (3) Webhook موقّع بـ HMAC-SHA256، مع الحفاظ على وضع الطرفية في التطوير والاختبارات.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

function sanitizeHeaderValue(v) {
  return String(v || '').replace(/[\r\n]+/g, ' ').trim();
}

function extractEmailAddress(addr) {
  const s = sanitizeHeaderValue(addr);
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  return m ? m[1] : s;
}

function encodeMimeHeader(str) {
  const clean = sanitizeHeaderValue(str);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function buildMimeMessage({ from, to, subject, text, html }) {
  const date = new Date().toUTCString();
  const msgId = `<${crypto.randomBytes(12).toString('hex')}@orderflow.eg>`;
  const headers = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0'
  ];

  const dotStuff = (s) => String(s || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');

  if (html) {
    const boundary = `of_${crypto.randomBytes(10).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim(),
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(html), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim(),
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }

  headers.push('Content-Type: text/plain; charset="utf-8"');
  headers.push('Content-Transfer-Encoding: base64');
  return [
    ...headers,
    '',
    dotStuff(Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim()),
    ''
  ].join('\r\n');
}

/** عميل SMTP قياسي يدعم TLS المباشر (465) و STARTTLS (587) و AUTH PLAIN/LOGIN */
async function sendViaSmtp(cfg, entry) {
  const host = String(cfg.smtpHost || '').trim();
  const port = Number(cfg.smtpPort || 587) || 587;
  const user = String(cfg.smtpUser || '').trim();
  const pass = String(cfg.smtpPass || '').trim();
  const useImplicitTls = Boolean(cfg.smtpSecure || port === 465);
  const useStartTls = cfg.smtpStartTls !== false && !useImplicitTls;
  const fromAddr = extractEmailAddress(cfg.mailFrom || user || 'noreply@orderflow.eg');
  const toAddr = extractEmailAddress(entry.to);
  const timeoutMs = Number(cfg.smtpTimeoutMs || 12_000);

  let socket = await new Promise((resolve, reject) => {
    const s = useImplicitTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: cfg.smtpRejectUnauthorized !== false })
      : net.connect({ host, port });
    s.setTimeout(timeoutMs, () => s.destroy(new Error('SMTP timeout')));
    s.once('error', reject);
    s.once(useImplicitTls ? 'secureConnect' : 'connect', () => {
      s.off('error', reject);
      resolve(s);
    });
  });

  let buffer = '';
  let waiter = null;

  const attachReaders = (sock) => {
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buffer += chunk;
      flushResponse();
    });
    sock.on('error', (err) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(err);
      }
    });
    sock.on('close', () => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(new Error('SMTP connection closed unexpectedly'));
      }
    });
  };

  const flushResponse = () => {
    if (!waiter) return;
    const lines = buffer.split('\r\n');
    // آخر عنصر قد يكون سطرًا غير مكتمل
    let consumed = 0;
    const collected = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      consumed += line.length + 2;
      collected.push(line);
      if (/^\d{3} /.test(line)) {
        buffer = buffer.slice(consumed);
        const code = Number(line.slice(0, 3));
        const w = waiter;
        waiter = null;
        w.resolve({ code, text: collected.join('\n') });
        return;
      }
    }
  };

  const readResp = () => new Promise((resolve, reject) => {
    waiter = { resolve, reject };
    flushResponse();
  });

  const cmd = async (line, expectCodes) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const resp = await readResp();
    if (expectCodes && !expectCodes.includes(resp.code)) {
      throw new Error(`SMTP ${resp.code}: ${resp.text.slice(0, 200)}`);
    }
    return resp;
  };

  try {
    attachReaders(socket);
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO orderflow.eg', [250]);

    if (useStartTls && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket = await new Promise((resolve, reject) => {
        const tlsSock = tls.connect({
          socket,
          servername: host,
          rejectUnauthorized: cfg.smtpRejectUnauthorized !== false
        });
        tlsSock.setTimeout(timeoutMs, () => tlsSock.destroy(new Error('SMTP TLS timeout')));
        tlsSock.once('error', reject);
        tlsSock.once('secureConnect', () => {
          tlsSock.off('error', reject);
          resolve(tlsSock);
        });
      });
      attachReaders(socket);
      ehlo = await cmd('EHLO orderflow.eg', [250]);
    }

    if (user && pass) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
        const authB64 = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
        await cmd(`AUTH PLAIN ${authB64}`, [235]);
      } else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user, 'utf8').toString('base64'), [334]);
        await cmd(Buffer.from(pass, 'utf8').toString('base64'), [235]);
      }
    }

    await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await cmd(`RCPT TO:<${toAddr}>`, [250, 251]);
    await cmd('DATA', [354]);
    const mime = buildMimeMessage({
      from: cfg.mailFrom || fromAddr,
      to: entry.to,
      subject: entry.subject,
      text: entry.text,
      html: entry.html
    });
    const dataResp = await cmd(`${mime}\r\n.`, [250]);
    await cmd('QUIT', [221]).catch(() => {});
    return { providerId: dataResp.text.slice(0, 120) };
  } finally {
    try { socket.end(); socket.destroy(); } catch (_) {}
  }
}

function createMailer(cfg = {}) {
  const sent = [];

  const pushSent = (entry) => {
    sent.push(entry);
    if (sent.length > 200) sent.shift();
    return entry;
  };

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

    // 1. ناقل مخصص للاختبارات
    if (typeof cfg.mailTransport === 'function') {
      entry.provider = 'custom';
      await cfg.mailTransport(entry);
      entry.delivered = true;
      return pushSent(entry);
    }

    const fetchFn = cfg.fetch || globalThis.fetch;
    const apiKey = String(cfg.mailApiKey || '').trim();
    const from = String(cfg.mailFrom || '').trim();
    const apiUrl = String(cfg.mailApiUrl || 'https://api.resend.com/emails').trim();
    const smtpHost = String(cfg.smtpHost || '').trim();
    const webhookUrl = String(cfg.mailWebhookUrl || '').trim();
    const webhookSecret = String(cfg.mailWebhookSecret || '').trim();

    // 2. Resend HTTP API
    if (apiKey && from && entry.to.includes('@') && typeof fetchFn === 'function') {
      entry.provider = 'resend';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const payload = { from, to: [entry.to], subject: entry.subject, text: entry.text };
        if (entry.html) payload.html = entry.html;
        const res = await fetchFn(apiUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
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
      return pushSent(entry);
    }

    // 3. SMTP + STARTTLS المباشر بدون حزم خارجية
    if (smtpHost && entry.to.includes('@')) {
      entry.provider = 'smtp';
      try {
        const res = await sendViaSmtp(cfg, entry);
        entry.delivered = true;
        entry.providerId = res.providerId || 'smtp-ok';
      } catch (err) {
        entry.error = String(err?.message || 'فشل الإرسال عبر SMTP').slice(0, 240);
        console.error(`[mailer] فشل SMTP إلى ${entry.to}: ${entry.error}`);
      }
      return pushSent(entry);
    }

    // 4. Webhook موقّع بـ HMAC-SHA256
    if (webhookUrl && typeof fetchFn === 'function') {
      entry.provider = 'webhook';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const bodyStr = JSON.stringify({
          to: entry.to,
          from: from || 'noreply@orderflow.eg',
          subject: entry.subject,
          text: entry.text,
          html: entry.html,
          type: entry.type,
          url: entry.url,
          sentAt: entry.sentAt
        });
        const headers = { 'content-type': 'application/json' };
        if (webhookSecret) {
          const sig = crypto.createHmac('sha256', webhookSecret).update(bodyStr, 'utf8').digest('hex');
          headers['x-orderflow-signature'] = `sha256=${sig}`;
        }
        const res = await fetchFn(webhookUrl, {
          method: 'POST',
          headers,
          body: bodyStr,
          redirect: 'error',
          signal: controller.signal
        });
        entry.status = Number(res.status || 0);
        if (res.ok) {
          entry.delivered = true;
          entry.providerId = `wh-${Date.now()}`;
        } else {
          entry.error = `Webhook HTTP ${res.status}`;
          console.error(`[mailer] فشل Webhook إلى ${entry.to}: ${entry.error}`);
        }
      } catch (err) {
        entry.error = String(err?.message || 'فشل إرسال Webhook').slice(0, 240);
        console.error(`[mailer] خطأ Webhook: ${entry.error}`);
      } finally {
        clearTimeout(timer);
      }
      return pushSent(entry);
    }

    // 5. وضع الطرفية أثناء التطوير
    if (!cfg.production) {
      entry.delivered = true;
      console.log(`[mailer] To: ${entry.to} | Subject: ${entry.subject}${entry.token ? ` | Token: ${entry.token}` : ''}${entry.url ? ` | URL: ${entry.url}` : ''}`);
    } else {
      console.warn(`[mailer] تحذير: لم يُضبط Resend أو SMTP أو Mail Webhook في الإنتاج — تعذّر إرسال البريد إلى ${entry.to}`);
    }
    return pushSent(entry);
  }

  return {
    send,
    sent,
    last: () => sent.at(-1) || null,
    clear: () => { sent.length = 0; }
  };
}

module.exports = { createMailer, sendViaSmtp, buildMimeMessage };
