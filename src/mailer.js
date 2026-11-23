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

function escHtml(v) {
  return String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrapBrandedRtlHtml({ heading, badge = 'OrderFlow', accent = '#0C5CA4', bodyHtml, ctaUrl = '', ctaLabel = '', footerNote = '' }) {
  const safeCta = ctaUrl && /^https?:\/\//i.test(ctaUrl)
    ? `<tr><td style="padding:18px 28px 8px;text-align:center"><a href="${escHtml(ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:10px">${escHtml(ctaLabel || 'فتح OrderFlow')}</a></td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#F3F5FB;font-family:Cairo,Tahoma,Arial,sans-serif;color:#082038;direction:rtl;text-align:right">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;margin:0 auto;background:#FFFFFF;border:1px solid #DCE5F2;border-radius:14px;overflow:hidden">
    <tr>
      <td style="background:${accent};padding:20px 28px;color:#FFFFFF">
        <div style="font-size:20px;font-weight:800;letter-spacing:0.2px">OrderFlow</div>
        <div style="font-size:12px;opacity:0.9;margin-top:2px">${escHtml(badge)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 28px 10px">
        <h1 style="margin:0 0 12px;font-size:19px;line-height:1.5;color:#082038">${escHtml(heading)}</h1>
        <div style="font-size:14.5px;line-height:1.85;color:#273B53">${bodyHtml}</div>
      </td>
    </tr>
    ${safeCta}
    <tr>
      <td style="padding:20px 28px 24px;border-top:1px solid #E8EEF7;font-size:12px;line-height:1.7;color:#5C7089">
        ${footerNote ? `<div style="margin-bottom:6px">${escHtml(footerNote)}</div>` : ''}
        <div>OrderFlow — منصة إدارة متاجر أمازون ونون وجوميا في مصر</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderEmailTemplate(type, opts = {}) {
  const url = String(opts.url || '');
  const textBody = String(opts.text || '').trim();
  const paragraphs = (s) => escHtml(s).replace(/\n/g, '<br>');

  switch (type) {
    case 'verify_email':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'تأكيد بريدك الإلكتروني على OrderFlow',
          badge: 'توثيق الحساب',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'اضغط الزر التالي لتأكيد بريدك الإلكتروني وتفعيل جميع مزايا الربط مع الأسواق والدفع.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'تأكيد البريد الإلكتروني',
          footerNote: 'إذا لم تقم بإنشاء هذا الحساب يمكنك تجاهل هذه الرسالة بأمان.'
        }),
        text: textBody || `تأكيد بريدك الإلكتروني على OrderFlow: ${url}`
      };
    case 'reset_password':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'استعادة كلمة مرور حسابك',
          badge: 'أمان الحساب',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك. الرابط صالح لمدة 30 دقيقة فقط.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'إعادة تعيين كلمة المرور',
          footerNote: 'إذا لم تطلب تغيير كلمة المرور، ننصح بتجاهل الرسالة وتفعيل المصادقة الثنائية (2FA).'
        }),
        text: textBody || `رابط إعادة تعيين كلمة المرور (صالح لمدة 30 دقيقة): ${url}`
      };
    case 'plan_expired':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'انتهى اشتراكك وتم التحويل للباقة المجانية',
          badge: 'الاشتراكات والفوترة',
          accent: '#B45309',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'انتهت صلاحية باقتك المدفوعة وتم تحويل الحساب تلقائيًا للباقة المجانية.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'تجديد الاشتراك الآن'
        }),
        text: textBody || `انتهى اشتراكك على OrderFlow. يمكنك التجديد عبر: ${url}`
      };
    case 'plan_expiring_soon':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'تذكير بقرب انتهاء اشتراكك',
          badge: 'الاشتراكات والفوترة',
          accent: '#0C5CA4',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'قارب اشتراكك الحالي على الانتهاء. جدّده الآن لضمان استمرار المزامنة بدون انقطاع.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'تجديد الاشتراك'
        }),
        text: textBody || `تذكير بقرب انتهاء اشتراكك على OrderFlow: ${url}`
      };
    case 'contact':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'رسالة تواصل جديدة من الموقع',
          badge: 'الدعم والمبيعات',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'وصلت رسالة جديدة من نموذج التواصل.')}</p>`
        }),
        text: textBody || 'وصلت رسالة تواصل جديدة.'
      };
    case 'security_alert':
      return {
        html: wrapBrandedRtlHtml({
          heading: opts.alertTitle || opts.subject || 'تنبيه أمني عاجل',
          badge: `تنبيه أمني (${String(opts.severity || 'high').toUpperCase()})`,
          accent: '#B91C1C',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'تم رصد حدث أمني يتطلب مراجعتك الفورية في لوحة المالك.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'فتح لوحة الأمان'
        }),
        text: textBody || `تنبيه أمني على OrderFlow: ${url}`
      };
    case 'account_approved':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'تم قبول وتفعيل حسابك بنجاح 🎉',
          badge: 'تفعيل الحساب',
          accent: '#0F766E',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'تهانينا! تمت مراجعة حسابك وتفعيله بنجاح. يمكنك الآن تسجيل الدخول وربط متاجرك على أمازون ونون وجوميا.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'تسجيل الدخول للوحة التحكم'
        }),
        text: textBody || `تم تفعيل حسابك على OrderFlow بنجاح. ادخل من هنا: ${url}`
      };
    case 'account_rejected':
      return {
        html: wrapBrandedRtlHtml({
          heading: 'تحديث بخصوص طلب إنشاء حسابك',
          badge: 'مراجعة الحساب',
          accent: '#991B1B',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody || 'نعتذر، لم يتم قبول طلب تفعيل حسابك حاليًا. يمكنك التواصل مع فريق الدعم لمزيد من التفاصيل.')}</p>`,
          ctaUrl: url,
          ctaLabel: 'التواصل مع الدعم'
        }),
        text: textBody || 'نعتذر، لم يتم قبول طلب تفعيل حسابك حاليًا.'
      };
    default:
      return {
        html: wrapBrandedRtlHtml({
          heading: opts.subject || 'إشعار من OrderFlow',
          bodyHtml: `<p style="margin:0 0 12px">${paragraphs(textBody)}</p>`,
          ctaUrl: url,
          ctaLabel: url ? 'فتح الرابط' : ''
        }),
        text: textBody
      };
  }
}

function createMailer(cfg = {}) {
  const sent = [];

  const activeProvider = typeof cfg.mailTransport === 'function'
    ? 'custom'
    : (String(cfg.mailApiKey || '').trim() && String(cfg.mailFrom || '').trim())
      ? 'resend'
      : String(cfg.smtpHost || '').trim()
        ? 'smtp'
        : String(cfg.mailWebhookUrl || '').trim()
          ? 'webhook'
          : 'none';
  const configured = activeProvider !== 'none';

  const pushSent = (entry) => {
    sent.push(entry);
    if (sent.length > 200) sent.shift();
    return entry;
  };

  async function send({ to, subject, text, html, token, url, type, severity, alertTitle, details }) {
    const rendered = !html ? renderEmailTemplate(type || 'general', { subject, text, url, severity, alertTitle, details }) : null;
    const entry = {
      to: String(to || '').trim(),
      subject: String(subject || ''),
      text: String(text || rendered?.text || ''),
      html: html ? String(html) : (rendered ? rendered.html : null),
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
    configured,
    activeProvider,
    last: () => sent.at(-1) || null,
    clear: () => { sent.length = 0; }
  };
}

module.exports = { createMailer, sendViaSmtp, buildMimeMessage, renderEmailTemplate };
