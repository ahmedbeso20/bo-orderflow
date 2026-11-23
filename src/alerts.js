'use strict';
// نظام التنبيهات الأمنية والاستجابة للحوادث (TASK 10)
const { nowIso } = require('./util');

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

function normalizeSeverity(sev) {
  const s = String(sev || 'medium').toLowerCase();
  return SEVERITY_RANK[s] ? s : 'medium';
}

/**
 * يسجّل حدثًا أمنيًا في جدول security_events، ويرسل إشعارًا للمالك،
 * ويرسل بريدًا إلكترونيًا للمالك إذا كانت الخطورة high أو critical،
 * ويرسل Webhook اختياريًا عند ضبط ALERT_WEBHOOK_URL.
 */
async function sendSecurityAlert(app, { severity = 'medium', title = 'تنبيه أمني', details = {} } = {}) {
  const sev = normalizeSeverity(severity);
  const safeTitle = String(title || 'تنبيه أمني').slice(0, 240);
  const safeDetails = details && typeof details === 'object' ? details : { note: String(details || '') };
  const ts = nowIso();

  let eventId = null;
  try {
    const info = app.q(
      'INSERT INTO security_events (severity, title, details, created_at) VALUES (?, ?, ?, ?)'
    ).run(sev, safeTitle, JSON.stringify(safeDetails), ts);
    eventId = Number(info.lastInsertRowid);
  } catch (err) {
    console.error('[alerts] failed to insert security_event:', err?.message || err);
  }

  const owner = app.q("SELECT id, email, store_name, full_name FROM users WHERE role = 'owner' LIMIT 1").get();
  if (owner) {
    const notifType = SEVERITY_RANK[sev] >= 3 ? 'error' : 'warning';
    const summaryText = Object.entries(safeDetails)
      .slice(0, 6)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' · ');
    if (typeof app.notify === 'function') {
      app.notify(owner.id, notifType, `تنبيه أمني (${sev}): ${safeTitle}`, summaryText || 'راجع صفحة الأمان في لوحة المالك.', '#/owner/security');
    }

    if (SEVERITY_RANK[sev] >= SEVERITY_RANK.high && owner.email && app.mailer) {
      Promise.resolve(app.mailer.send({
        to: owner.email,
        subject: `[OrderFlow Security ${sev.toUpperCase()}] ${safeTitle}`,
        type: 'security_alert',
        severity: sev,
        alertTitle: safeTitle,
        details: safeDetails,
        url: `${app.cfg?.appUrl || 'http://localhost:3000'}/#/owner/security`,
        text: `تنبيه أمني (${sev}) على منصة OrderFlow:\n${safeTitle}\n${summaryText}\nراجع لوحة الأمان: ${app.cfg?.appUrl || 'http://localhost:3000'}/#/owner/security`
      })).catch(() => {});
    }
  }

  const webhookUrl = String(app.cfg?.alertWebhookUrl || '').trim();
  const fetchFn = app.cfg?.fetch || globalThis.fetch;
  if (webhookUrl && typeof fetchFn === 'function') {
    Promise.resolve(fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[OrderFlow Security | ${sev.toUpperCase()}] ${safeTitle}\n${JSON.stringify(safeDetails)}`,
        eventId,
        severity: sev,
        title: safeTitle,
        details: safeDetails,
        createdAt: ts
      }),
      signal: AbortSignal.timeout(5000)
    })).catch(() => {});
  }

  return { id: eventId, severity: sev, title: safeTitle, createdAt: ts };
}

/** يتتبع آخر 10 عناوين IP لكل مالك ويرفع تنبيهًا عند تسجيل الدخول من IP جديد */
function trackOwnerLoginIp(app, ownerUser, ip) {
  if (!ownerUser || ownerUser.role !== 'owner' || !ip) return { isNew: false };
  const cleanIp = String(ip).trim();
  const existing = app.q('SELECT id FROM owner_login_ips WHERE user_id = ? AND ip = ?').get(ownerUser.id, cleanIp);
  const countBefore = Number(app.q('SELECT COUNT(*) AS c FROM owner_login_ips WHERE user_id = ?').get(ownerUser.id)?.c || 0);
  const ts = nowIso();

  if (existing) {
    app.q('UPDATE owner_login_ips SET last_seen_at = ? WHERE id = ?').run(ts, existing.id);
    return { isNew: false };
  }

  app.q('INSERT INTO owner_login_ips (user_id, ip, last_seen_at) VALUES (?, ?, ?)').run(ownerUser.id, cleanIp, ts);
  // الاحتفاظ بآخر 10 عناوين IP فقط
  app.q(`DELETE FROM owner_login_ips WHERE user_id = ? AND id NOT IN (
    SELECT id FROM owner_login_ips WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 10
  )`).run(ownerUser.id, ownerUser.id);

  // أول تسجيل دخول على الإطلاق يسجّل الـ IP كخط أساس؛ أي IP جديد بعد ذلك يرفع تنبيهًا
  if (countBefore > 0) {
    sendSecurityAlert(app, {
      severity: 'high',
      title: 'تسجيل دخول لحساب المالك من عنوان IP جديد',
      details: { ownerId: ownerUser.id, email: ownerUser.email || '', ip: cleanIp }
    });
    return { isNew: true };
  }
  return { isNew: false };
}

module.exports = { sendSecurityAlert, trackOwnerLoginIp, SEVERITY_RANK };
