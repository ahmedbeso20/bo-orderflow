'use strict';
const { DatabaseSync } = require('node:sqlite');

// كل عنصر = ترحيل (migration) يُنفَّذ مرة واحدة. أضف عناصر جديدة في النهاية فقط
const MIGRATIONS = [`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  pass_hash TEXT NOT NULL,
  token_ver INTEGER NOT NULL DEFAULT 1,
  store_name TEXT NOT NULL,
  tax_id TEXT NOT NULL DEFAULT '',
  instapay TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  is_demo INTEGER NOT NULL DEFAULT 0,
  integrations TEXT NOT NULL DEFAULT '{}',
  notifications TEXT NOT NULL DEFAULT '{"s":1,"o":1,"f":1,"w":0}',
  ai_cache TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  order_seq INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  cat TEXT NOT NULL DEFAULT 'عام',
  markets TEXT NOT NULL DEFAULT 'a',
  price REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, sku)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  no INTEGER NOT NULL,
  market TEXT NOT NULL,
  customer TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  gov TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  pay TEXT NOT NULL,
  courier TEXT NOT NULL,
  total REAL NOT NULL,
  cost_total REAL NOT NULL DEFAULT 0,
  ship_fee REAL NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (user_id, no)
);
CREATE INDEX orders_user_date ON orders(user_id, created_at);
CREATE INDEX orders_user_status ON orders(user_id, status);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL
);
CREATE INDEX order_items_order ON order_items(order_id);

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  courier TEXT NOT NULL,
  gross REAL NOT NULL,
  fees REAL NOT NULL,
  net REAL NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`, `
ALTER TABLE users ADD COLUMN plan_cycle TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE users ADD COLUMN plan_expires_at TEXT;
ALTER TABLE users ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN default_pay_method TEXT NOT NULL DEFAULT 'card';

CREATE TABLE plan_payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_ref TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  cycle TEXT NOT NULL DEFAULT 'monthly',
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  vat REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  coupon TEXT NOT NULL DEFAULT '',
  payer_info TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paid',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX plan_payments_user ON plan_payments(user_id, created_at);
`, `
-- بوابة دفع قابلة للتوصيل: مزوّد الدفع، مرجعه، مفتاح منع التكرار، وسجل أحداث الخطافات لمنع إعادة التشغيل
ALTER TABLE plan_payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'sandbox';
ALTER TABLE plan_payments ADD COLUMN provider_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE plan_payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP';
ALTER TABLE plan_payments ADD COLUMN idem_key TEXT;
ALTER TABLE plan_payments ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX plan_payments_idem ON plan_payments(user_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX plan_payments_provider_ref ON plan_payments(provider, provider_ref);
CREATE TABLE payment_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tx_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
`, `
-- الأدوار وحالة الحساب وتوثيق البريد الإلكتروني
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin'));
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- نظام اعتماد المنتجات والطلبات وصور المنتجات وإلغاء الطلبات والمرتجعات
ALTER TABLE products ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE products ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT '';

ALTER TABLE orders ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE orders ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cancelled_at TEXT;
ALTER TABLE orders ADD COLUMN return_reason TEXT NOT NULL DEFAULT '';

-- جدول الكوبونات الترويجية في قاعدة البيانات (بدلًا من الكوبونات الثابتة في الكود)
CREATE TABLE coupons (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('pct', 'fixed')),
  value REAL NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  once_per_user INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO coupons (code, type, value, desc, once_per_user, active, created_at) VALUES
  ('WELCOME20', 'pct', 20, 'خصم ترحيبي ٢٠٪ على اشتراكك', 1, 1, '2026-01-01T00:00:00.000Z'),
  ('EGYPT10', 'pct', 10, 'خصم خاص لتجار مصر ١٠٪', 0, 1, '2026-01-01T00:00:00.000Z'),
  ('OMNI50', 'fixed', 50, 'خصم نقدي فوري ٥٠ ج.م', 0, 1, '2026-01-01T00:00:00.000Z');

-- سجل المراجعة الإدارية (Audit Log) لكل إجراء يقوم به المدير
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_created ON audit_log(created_at DESC);

-- رموز لمرة واحدة ومحددة الصلاحية لاستعادة كلمة المرور وتأكيد البريد الإلكتروني
CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('reset_password', 'verify_email')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, type);

-- مركز الإشعارات
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

-- تذاكر الدعم الفني ورسائل تواصل معنا
CREATE TABLE support_tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
`, `
-- طلبات خدمات الخبراء وإدارة الحسابات وحجز الاستشارات المجانية
CREATE TABLE service_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ref_code TEXT NOT NULL UNIQUE,
  service_key TEXT NOT NULL,
  service_title TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  store_name TEXT NOT NULL DEFAULT '',
  platforms TEXT NOT NULL DEFAULT '',
  monthly_orders TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX service_requests_user ON service_requests(user_id, created_at DESC);
`, {
  disableForeignKeys: true,
  sql: `
-- ترقية جدول المستخدمين لنظام الصلاحيات الكامل (Owner / Moderator / Client) وحالة المراجعة (pending / active / rejected / suspended)
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  pass_hash TEXT NOT NULL,
  token_ver INTEGER NOT NULL DEFAULT 1,
  store_name TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  instapay TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  is_demo INTEGER NOT NULL DEFAULT 0,
  integrations TEXT NOT NULL DEFAULT '{}',
  notifications TEXT NOT NULL DEFAULT '{"s":1,"o":1,"f":1,"w":0}',
  ai_cache TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  order_seq INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL,
  plan_cycle TEXT NOT NULL DEFAULT 'monthly',
  plan_expires_at TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  default_pay_method TEXT NOT NULL DEFAULT 'card',
  role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('owner', 'moderator', 'client')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'suspended')),
  permissions TEXT NOT NULL DEFAULT '{}',
  reject_reason TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER REFERENCES users_new(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  email_verified_at TEXT
);

INSERT INTO users_new (
  id, phone, email, pass_hash, token_ver, store_name, full_name, tax_id, instapay, plan, is_demo,
  integrations, notifications, ai_cache, last_sync_at, order_seq, created_at,
  plan_cycle, plan_expires_at, auto_renew, default_pay_method, role, status, email_verified_at
)
SELECT
  id, phone, email, pass_hash, token_ver, store_name, store_name, tax_id, instapay, plan, is_demo,
  integrations, notifications, ai_cache, last_sync_at, order_seq, created_at,
  plan_cycle, plan_expires_at, auto_renew, default_pay_method,
  CASE WHEN role = 'admin' THEN 'owner' ELSE 'client' END,
  status,
  email_verified_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_single_owner ON users(role) WHERE role = 'owner';
CREATE INDEX users_role_status ON users(role, status);

-- ترقية سجل المراقبة (Audit Log) ليحفظ اسم ودور المنفذ حتى بعد حذف حساب المشرف
CREATE TABLE audit_log_new (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT 'owner',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT INTO audit_log_new (id, admin_id, actor_name, actor_email, actor_role, action, target_type, target_id, details, ip, created_at)
SELECT
  a.id,
  a.admin_id,
  COALESCE(u.store_name, ''),
  COALESCE(u.email, ''),
  COALESCE(u.role, 'owner'),
  a.action,
  a.target_type,
  a.target_id,
  a.details,
  a.ip,
  a.created_at
FROM audit_log a
LEFT JOIN users u ON u.id = a.admin_id;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
CREATE INDEX audit_log_created ON audit_log(created_at DESC);
CREATE INDEX audit_log_actor ON audit_log(admin_id, created_at DESC);

-- جدول إعدادات المنصة العامة (حصريًا للمالك)
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO platform_settings (key, value, updated_at) VALUES
  ('platform_name', 'OrderFlow', '2026-01-01T00:00:00.000Z'),
  ('support_email', 'support@orderflow.eg', '2026-01-01T00:00:00.000Z'),
  ('support_phone', '+20 100 000 0000', '2026-01-01T00:00:00.000Z'),
  ('registration_open', '1', '2026-01-01T00:00:00.000Z'),
  ('require_client_approval', '1', '2026-01-01T00:00:00.000Z'),
  ('maintenance_notice', '', '2026-01-01T00:00:00.000Z');
`
}, `
-- اتصالات API المشفرة لمنصات البيع الخمس (أمازون · نون · جوميا · ترينديول · كنز) وتتبع المزامنة الحقيقية
CREATE TABLE marketplace_connections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('a', 'n', 'j', 't', 'k')),
  enabled INTEGER NOT NULL DEFAULT 1,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  creds_enc TEXT NOT NULL DEFAULT '',
  endpoint_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'configured', 'connected', 'error')),
  last_tested_at TEXT,
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, platform)
);
CREATE INDEX marketplace_connections_user ON marketplace_connections(user_id);

ALTER TABLE orders ADD COLUMN external_ref TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX orders_user_market_extref ON orders(user_id, market, external_ref) WHERE external_ref <> '';
`, {
  sql: `
-- الترحيل 8: المصادقة الثنائية (2FA TOTP)، جدول العملاء الحقيقي (CRM)، ربط شركات الشحن (AWB)، وإعدادات الفوترة القانونية
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN plan_reminded_at TEXT;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  gov TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX customers_user_phone ON customers(user_id, phone) WHERE phone <> '';
CREATE INDEX customers_user_name ON customers(user_id, name);

ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX orders_customer_id ON orders(customer_id);
ALTER TABLE orders ADD COLUMN awb_number TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN tracking_url TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN courier_status TEXT NOT NULL DEFAULT '';

CREATE TABLE courier_connections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  courier TEXT NOT NULL CHECK (courier IN ('bosta', 'aramex')),
  enabled INTEGER NOT NULL DEFAULT 1,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  creds_enc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'configured', 'connected', 'error')),
  last_tested_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, courier)
);
CREATE INDEX courier_connections_user ON courier_connections(user_id);

INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('platform_legal_name', 'OrderFlow لتقنيات التجارة الإلكترونية', '2026-01-01T00:00:00.000Z'),
  ('platform_tax_id', '', '2026-01-01T00:00:00.000Z');
`,
  postMigrate(db) {
    // ترحيل بيانات الطلبات الحالية تلقائيًا لإنشاء سجلات العملاء في جدول customers وربطها عبر customer_id
    const existingOrders = db.prepare(
      'SELECT id, user_id, customer, phone, gov, address, created_at FROM orders WHERE customer_id IS NULL ORDER BY id ASC'
    ).all();
    const findByPhone = db.prepare('SELECT id, gov, address FROM customers WHERE user_id = ? AND phone = ?');
    const findByNameNoPhone = db.prepare("SELECT id, gov, address FROM customers WHERE user_id = ? AND name = ? AND phone = '' ORDER BY id ASC LIMIT 1");
    const insCustomer = db.prepare(
      'INSERT INTO customers (user_id, name, phone, email, gov, address, notes, tags, created_at, updated_at) VALUES (?, ?, ?, \'\', ?, ?, \'\', \'\', ?, ?)'
    );
    const updCustomer = db.prepare(
      'UPDATE customers SET gov = COALESCE(NULLIF(?, \'\'), gov), address = COALESCE(NULLIF(?, \'\'), address), updated_at = ? WHERE id = ?'
    );
    const linkOrder = db.prepare('UPDATE orders SET customer_id = ? WHERE id = ?');

    for (const o of existingOrders) {
      const ph = String(o.phone || '').trim();
      const name = String(o.customer || '').trim() || 'عميل';
      const gov = String(o.gov || '').trim();
      const address = String(o.address || '').trim();
      const ts = o.created_at || new Date().toISOString();
      let c = ph ? findByPhone.get(o.user_id, ph) : findByNameNoPhone.get(o.user_id, name);
      let cid;
      if (c) {
        cid = c.id;
        updCustomer.run(gov, address, ts, cid);
      } else {
        cid = Number(insCustomer.run(o.user_id, name, ph, gov, address, ts, ts).lastInsertRowid);
      }
      linkOrder.run(cid, o.id);
    }
  }
}, `
-- الترحيل 9: الفهرس الأعمى للرقم الضريبي (tax_id_hash) وأعمدة الرد والمتابعة لتذاكر الدعم وطلبات خدمات الخبراء
ALTER TABLE users ADD COLUMN tax_id_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX users_tax_id_hash ON users(tax_id_hash) WHERE tax_id_hash <> '';

ALTER TABLE support_tickets ADD COLUMN reply TEXT NOT NULL DEFAULT '';
ALTER TABLE support_tickets ADD COLUMN replied_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN updated_at TEXT;

ALTER TABLE service_requests ADD COLUMN admin_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN updated_at TEXT;
`, {
  sql: `
-- الترحيل 10: حماية 2FA والرموز الاحتياطية، حدود الطلبات الدائمة، تشفير بيانات المشترين والاحتفاظ بها وسجل الوصول، التنبيهات الأمنية، مصدر البيانات، سجلات المزامنة، OTP الهاتف، رقم الإيصال المتسلسل، وحقوق البيانات (قانون 151/2020)

-- TASK 4: حماية ضد إعادة استخدام رموز TOTP + رموز الاسترداد الاحتياطية
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
CREATE TABLE totp_recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX totp_recovery_codes_user ON totp_recovery_codes(user_id);

-- TASK 6: جدول حدود المحاولات الدائم في SQLite
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_reset ON rate_limits(reset_at);

-- TASK 7: الفهرس الأعمى لأرقام هواتف المشترين والعملاء (تشفير PII أثناء السكون)
ALTER TABLE orders ADD COLUMN phone_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX orders_user_phone_hash ON orders(user_id, phone_hash) WHERE phone_hash <> '';

ALTER TABLE customers ADD COLUMN phone_hash TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS customers_user_phone;
CREATE UNIQUE INDEX customers_user_phone_hash ON customers(user_id, phone_hash) WHERE phone_hash <> '';

-- TASK 8: الاحتفاظ ببيانات المشترين وحذفها تلقائيًا بعد المدة المحددة
ALTER TABLE orders ADD COLUMN delivered_at TEXT;
ALTER TABLE orders ADD COLUMN pii_purged_at TEXT;
ALTER TABLE customers ADD COLUMN pii_purged_at TEXT;
INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('pii_retention_days', '30', '2026-01-01T00:00:00.000Z');

-- TASK 9: سجل الوصول للبيانات الحساسة (Amazon DPP)
CREATE TABLE pii_access_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id INTEGER,
  count INTEGER NOT NULL DEFAULT 1,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX pii_access_log_created ON pii_access_log(created_at DESC);
CREATE INDEX pii_access_log_owner ON pii_access_log(owner_user_id, created_at DESC);

-- TASK 10: أحداث وتنبيهات الأمان + تتبع عناوين IP الأخيرة للمالك
CREATE TABLE security_events (
  id INTEGER PRIMARY KEY,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  acknowledged_at TEXT,
  acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX security_events_created ON security_events(created_at DESC);

CREATE TABLE owner_login_ips (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (user_id, ip)
);

-- TASK 11: التفرقة بين البيانات التجريبية واليدوية والمتصلة بالأسواق
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE products ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
CREATE INDEX orders_user_source ON orders(user_id, source);
CREATE INDEX products_user_source ON products(user_id, source);

-- TASK 12: سجل عمليات المزامنة لكل سوق ولكل مستخدم
CREATE TABLE connector_sync_runs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  orders_new INTEGER NOT NULL DEFAULT 0,
  orders_updated INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX connector_sync_runs_user ON connector_sync_runs(user_id, platform, started_at DESC);

-- TASK 15: توسيع auth_tokens لدعم phone_otp وعدد المحاولات + توثيق رقم الهاتف
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;

CREATE TABLE auth_tokens_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('reset_password', 'verify_email', 'phone_otp')),
  token_hash TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO auth_tokens_new (id, user_id, type, token_hash, target, attempts, expires_at, used_at, created_at)
SELECT id, user_id, type, token_hash, '', 0, expires_at, used_at, created_at FROM auth_tokens;
DROP TABLE auth_tokens;
ALTER TABLE auth_tokens_new RENAME TO auth_tokens;
CREATE INDEX auth_tokens_user_type ON auth_tokens(user_id, type);
CREATE INDEX auth_tokens_expires ON auth_tokens(expires_at);

-- TASK 16: رقم إيصال متسلسل على مستوى المنصة للمدفوعات
ALTER TABLE plan_payments ADD COLUMN receipt_no INTEGER;
CREATE UNIQUE INDEX plan_payments_receipt_no ON plan_payments(receipt_no) WHERE receipt_no IS NOT NULL;

-- TASK 17: حقوق المستخدم في بياناته (فترة سماح الحذف 14 يومًا، قبول الشروط، أرشيف مدفوعات مجهول الهوية)
ALTER TABLE users ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE users ADD COLUMN terms_version TEXT NOT NULL DEFAULT '';

CREATE TABLE anonymized_payments (
  id INTEGER PRIMARY KEY,
  receipt_no INTEGER,
  tx_ref TEXT NOT NULL,
  plan TEXT NOT NULL,
  cycle TEXT NOT NULL,
  amount REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EGP',
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  anonymized_at TEXT NOT NULL
);
`
}, {
  disableForeignKeys: true,
  sql: `
-- الترحيل 11: فصل سر 2FA المعلّق، حصة رفع الصور، طابور مزامنة المخزون الثنائي، دقة محاسبة المزامنة، ودعم شركة شحن Mylerz
ALTER TABLE users ADD COLUMN totp_pending_secret_enc TEXT NOT NULL DEFAULT '';

ALTER TABLE orders ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN fulfillment_channel TEXT NOT NULL DEFAULT '';

CREATE TABLE user_uploads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX user_uploads_user ON user_uploads(user_id);

CREATE TABLE sync_outbox (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('a', 'n', 'j', 't', 'k')),
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sync_outbox_pending ON sync_outbox(status, next_retry_at);
CREATE INDEX sync_outbox_user_sku ON sync_outbox(user_id, platform, sku);

CREATE TABLE courier_connections_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  courier TEXT NOT NULL CHECK (courier IN ('bosta', 'aramex', 'mylerz')),
  enabled INTEGER NOT NULL DEFAULT 1,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  creds_enc TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'configured', 'connected', 'error')),
  last_tested_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, courier)
);
INSERT INTO courier_connections_new (id, user_id, courier, enabled, environment, creds_enc, status, last_tested_at, last_error, created_at, updated_at)
SELECT id, user_id, courier, enabled, environment, creds_enc, status, last_tested_at, last_error, created_at, updated_at FROM courier_connections;
DROP TABLE courier_connections;
ALTER TABLE courier_connections_new RENAME TO courier_connections;
CREATE INDEX courier_connections_user ON courier_connections(user_id);
`
}];

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveSubkey } = require('./security');

const BACKUP_MAGIC = Buffer.from('OFBK0001', 'ascii'); // 8 bytes

function enforceDbFilePermissions(file) {
  if (!file || file === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
    } catch (_) { /* تجاهل على أنظمة الملفات التي لا تدعم chmod */ }
  }
}

function initDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON; PRAGMA temp_store = MEMORY;');
  enforceDbFilePermissions(file);

  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < MIGRATIONS.length; v++) {
    const mig = MIGRATIONS[v];
    const sql = typeof mig === 'string' ? mig : mig.sql;
    const toggleFk = typeof mig === 'object' && mig.disableForeignKeys;
    const postMigrate = typeof mig === 'object' && typeof mig.postMigrate === 'function' ? mig.postMigrate : null;
    if (toggleFk) db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      if (postMigrate) postMigrate(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (toggleFk) db.exec('PRAGMA foreign_keys = ON;');
      throw e;
    }
    if (toggleFk) db.exec('PRAGMA foreign_keys = ON;');
  }
  return db;
}

const BACKUP_RE = /^orderflow-backup-\d{8}-\d{6}-\d{3}\.db(\.enc)?$/;

function listBackups(backupDir) {
  if (!backupDir || !fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((f) => BACKUP_RE.test(f))
    .map((filename) => {
      const full = path.join(backupDir, filename);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      return st && st.isFile()
        ? { filename, file: full, size: st.size, encrypted: filename.endsWith('.enc'), createdAt: st.mtime.toISOString() }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

function deriveBackupKey(keyMaterial) {
  if (!keyMaterial || String(keyMaterial).length < 16) {
    throw new Error('مفتاح تشفير النسخ الاحتياطي (BACKUP_ENCRYPTION_KEY) يجب أن يكون 16 حرفًا على الأقل');
  }
  return deriveSubkey(String(keyMaterial), 'db-backup-aes256gcm-v1', 32);
}

/** تشفير ملف النسخة الاحتياطية بـ AES-256-GCM بنظام الدفعات: [8-byte magic][12-byte iv][ciphertext][16-byte tag] */
function encryptBackupFile(srcPath, destPath, keyMaterial) {
  const key = deriveBackupKey(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const inFd = fs.openSync(srcPath, 'r');
  const outFd = fs.openSync(destPath, 'w', 0o600);
  try {
    fs.writeSync(outFd, BACKUP_MAGIC);
    fs.writeSync(outFd, iv);
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(inFd, buf, 0, buf.length, null)) > 0) {
      const encChunk = cipher.update(buf.subarray(0, bytesRead));
      if (encChunk.length) fs.writeSync(outFd, encChunk);
    }
    const finalChunk = cipher.final();
    if (finalChunk.length) fs.writeSync(outFd, finalChunk);
    fs.writeSync(outFd, cipher.getAuthTag());
  } catch (err) {
    try { fs.closeSync(outFd); } catch (_) {}
    try { fs.unlinkSync(destPath); } catch (_) {}
    throw err;
  } finally {
    try { fs.closeSync(inFd); } catch (_) {}
    try { fs.closeSync(outFd); } catch (_) {}
  }
  try { fs.chmodSync(destPath, 0o600); } catch (_) {}
  return destPath;
}

/** فك تشفير ملف نسخة احتياطية .db.enc والتحقق من AuthTag قبل الاعتماد */
function decryptBackupFile(encPath, outPath, keyMaterial) {
  const key = deriveBackupKey(keyMaterial);
  const stat = fs.statSync(encPath);
  const headerLen = BACKUP_MAGIC.length + 12;
  const tagLen = 16;
  if (stat.size < headerLen + tagLen) {
    throw new Error('ملف النسخة الاحتياطية المشفر تالف أو قصير جدًا');
  }
  const inFd = fs.openSync(encPath, 'r');
  const tmpOut = `${outPath}.tmp.${process.pid}`;
  const outFd = fs.openSync(tmpOut, 'w', 0o600);
  try {
    const header = Buffer.alloc(headerLen);
    fs.readSync(inFd, header, 0, headerLen, 0);
    if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
      throw new Error('صيغة ملف النسخة الاحتياطية غير معروفة');
    }
    const iv = header.subarray(BACKUP_MAGIC.length);
    const tag = Buffer.alloc(tagLen);
    fs.readSync(inFd, tag, 0, tagLen, stat.size - tagLen);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    let pos = headerLen;
    const end = stat.size - tagLen;
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (pos < end) {
      const toRead = Math.min(buf.length, end - pos);
      const n = fs.readSync(inFd, buf, 0, toRead, pos);
      if (n <= 0) break;
      pos += n;
      const plain = decipher.update(buf.subarray(0, n));
      if (plain.length) fs.writeSync(outFd, plain);
    }
    const finalPlain = decipher.final();
    if (finalPlain.length) fs.writeSync(outFd, finalPlain);
    fs.closeSync(outFd);
    fs.renameSync(tmpOut, outPath);
    try { fs.chmodSync(outPath, 0o600); } catch (_) {}
    return outPath;
  } catch (err) {
    try { fs.closeSync(outFd); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
    throw err;
  } finally {
    try { fs.closeSync(inFd); } catch (_) {}
  }
}

/** رفع نسخة احتياطية إلى تخزين متوافق مع S3 (Cloudflare R2 / AWS S3 / Backblaze B2) باستخدام AWS SigV4 بـ node:crypto */
async function uploadBackupToS3(filePath, cfg) {
  if (!cfg.backupS3Endpoint || !cfg.backupS3Bucket || !cfg.backupS3AccessKey || !cfg.backupS3Secret) {
    return { uploaded: false, skipped: true, reason: 'not_configured' };
  }
  const fetchFn = cfg.fetch || globalThis.fetch;
  const endpoint = String(cfg.backupS3Endpoint).replace(/\/+$/, '');
  const bucket = encodeURIComponent(cfg.backupS3Bucket);
  const objectKey = `backups/${path.basename(filePath)}`;
  const urlStr = `${endpoint}/${bucket}/${objectKey}`;
  const u = new URL(urlStr);
  const body = fs.readFileSync(filePath);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = cfg.backupS3Region || 'auto';
  const service = 's3';

  const canonicalUri = u.pathname;
  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kDate = hmac(`AWS4${cfg.backupS3Secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.backupS3AccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetchFn(urlStr, {
    method: 'PUT',
    headers: {
      Host: u.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authorization,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length)
    },
    body
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`فشل رفع النسخة الاحتياطية إلى S3 (${res.status}): ${errText.slice(0, 160)}`);
  }
  return { uploaded: true, key: objectKey, status: res.status };
}

/** اختبار اتصال S3 / Cloudflare R2 / B2 عبر طلب HEAD موقّع بـ AWS SigV4 */
async function testS3Connection(cfg = {}) {
  if (!cfg.backupS3Endpoint || !cfg.backupS3Bucket || !cfg.backupS3AccessKey || !cfg.backupS3Secret) {
    return { ok: false, configured: false, error: 'إعدادات تخزين S3/R2 غير مكتملة (BACKUP_S3_ENDPOINT / BUCKET / ACCESS_KEY / SECRET).' };
  }
  const fetchFn = cfg.fetch || globalThis.fetch;
  const endpoint = String(cfg.backupS3Endpoint).replace(/\/+$/, '');
  const bucket = encodeURIComponent(cfg.backupS3Bucket);
  const urlStr = `${endpoint}/${bucket}`;
  const u = new URL(urlStr);
  const payloadHash = crypto.createHash('sha256').update('').digest('hex');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = cfg.backupS3Region || 'auto';
  const service = 's3';

  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['HEAD', u.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kDate = hmac(`AWS4${cfg.backupS3Secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.backupS3AccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const res = await fetchFn(urlStr, {
      method: 'HEAD',
      headers: {
        Host: u.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        Authorization: authorization
      },
      signal: AbortSignal.timeout(8000)
    });
    if (res && (res.ok || res.status === 200)) {
      return { ok: true, configured: true, status: res.status, bucket: cfg.backupS3Bucket, endpoint };
    }
    return { ok: false, configured: true, status: res?.status || 0, error: `رفض خادم S3 الاتصال (HTTP ${res?.status || 'ERR'})` };
  } catch (err) {
    return { ok: false, configured: true, error: `تعذر الوصول إلى خادم S3: ${err?.message || 'خطأ شبكة'}` };
  }
}

/**
 * إنشاء نسخة احتياطية آمنة ومتسقة باستخدام SQLite VACUUM INTO
 * مع التشفير التلقائي AES-256-GCM عند ضبط encryptionKey وحذف النسخة غير المشفرة والاحتفاظ بآخر keepCount نسخ فقط
 */
function backupDatabase(db, backupDir, keepCount = 7, opts = {}) {
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${pad(now.getUTCMilliseconds(), 3)}`;
  let filename = `orderflow-backup-${stamp}.db`;
  let dest = path.join(dir, filename);
  let seq = 1;
  while (fs.existsSync(dest) || fs.existsSync(`${dest}.enc`)) {
    const ms = pad((now.getUTCMilliseconds() + seq++) % 1000, 3);
    filename = `orderflow-backup-${stamp.slice(0, -3)}${ms}.db`;
    dest = path.join(dir, filename);
  }
  if (!dest.startsWith(dir + path.sep)) throw new Error('مسار النسخ الاحتياطي غير صالح');

  // VACUUM INTO لا يقبل معلمات في بعض إصدارات SQLite؛ المسار مُولّد داخليًا بالكامل ونحميه بـ escape علامات الاقتباس
  const escapedDest = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedDest}'`);
  try { fs.chmodSync(dest, 0o600); } catch (_) {}

  let finalFilename = filename;
  let finalDest = dest;
  let encrypted = false;
  if (opts.encryptionKey) {
    finalFilename = `${filename}.enc`;
    finalDest = `${dest}.enc`;
    encryptBackupFile(dest, finalDest, opts.encryptionKey);
    try { fs.unlinkSync(dest); } catch (_) {}
    encrypted = true;
  }

  const all = listBackups(dir);
  const keep = Math.max(1, Number(keepCount) || 7);
  const pruned = [];
  for (const old of all.slice(keep)) {
    try {
      fs.unlinkSync(old.file);
      pruned.push(old.filename);
    } catch (_) {}
  }

  const st = fs.statSync(finalDest);
  return {
    filename: finalFilename,
    file: finalDest,
    size: st.size,
    encrypted,
    createdAt: now.toISOString(),
    kept: Math.min(all.length, keep),
    pruned
  };
}

function openDb(file) {
  let db;
  try {
    db = initDb(file);
  } catch (e) {
    if (file === ':memory:') throw e;
    const msg = String(e?.message || '');
    const isCorrupt = /not a database|malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg);
    if (!isCorrupt) throw e;
    // في حالة تلف الملف فقط: نعزله بنسخة احتياطية بدلاً من مسح البيانات صامتًا
    try { db?.close(); } catch (_) {}
    const stamp = Date.now();
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, `${file}${suffix}.corrupt.${stamp}`);
      } catch (_) {}
    }
    console.error(`[db] تم عزل ملف قاعدة بيانات تالف إلى ${file}.corrupt.${stamp} وإعادة التهيئة.`);
    db = initDb(file);
  }

  const cache = new Map();
  /** عبارة SQL مُجهَّزة ومخزّنة مؤقتًا */
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = db.prepare(sql))); return s; };

  let depth = 0;
  /** ينفّذ fn داخل معاملة ذرّية (كلها أو لا شيء) */
  const tx = (fn) => {
    if (depth) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { depth = 0; }
  };

  return { db, q, tx, close: () => db.close() };
}

module.exports = { openDb, backupDatabase, listBackups, encryptBackupFile, decryptBackupFile, uploadBackupToS3, testS3Connection };

