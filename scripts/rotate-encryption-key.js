#!/usr/bin/env node
'use strict';

/**
 * Atomic DATA_ENCRYPTION_KEY rotation script for OrderFlow SQLite database.
 * Uses src/security.js (HKDF-SHA256 + AES-256-GCM + blindIndex HMAC-SHA256)
 * so rotated ciphertexts and blind indexes match runtime behavior 100%.
 *
 * Usage:
 *   OLD_KEY="..." NEW_KEY="..." DB_PATH="data/omniarab.db" node scripts/rotate-encryption-key.js
 * Programmatic import:
 *   const { rotateEncryptionKey } = require('./scripts/rotate-encryption-key');
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFieldCipher, deriveSubkey } = require('../src/security');
const { normalizePhoneForIndex } = require('../src/model');

function rotateEncryptionKey({ dbPath, oldKey, newKey }) {
  if (!oldKey || !newKey) throw new Error('OLD_KEY and NEW_KEY are required');
  if (String(oldKey) === String(newKey)) throw new Error('OLD_KEY and NEW_KEY must be different');
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`Database file not found: ${resolved}`);

  const oldCipher = createFieldCipher(deriveSubkey(String(oldKey), 'db-field-aes256gcm-v1', 32));
  const newCipher = createFieldCipher(deriveSubkey(String(newKey), 'db-field-aes256gcm-v1', 32));
  const dec = (v) => (v ? oldCipher.decrypt(v, { strict: true }) : '');
  const enc = (v) => (v ? newCipher.encrypt(v) : '');

  const db = new DatabaseSync(resolved);
  const stats = { users: 0, orders: 0, customers: 0, payouts: 0, marketplaces: 0, couriers: 0 };

  try {
    db.exec('BEGIN IMMEDIATE');

    // 1. users (tax_id, tax_id_hash, instapay, totp_secret_enc, totp_pending_secret_enc)
    const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    const hasPendingTotp = userCols.has('totp_pending_secret_enc');
    const users = db.prepare(
      hasPendingTotp
        ? 'SELECT id, tax_id, instapay, totp_secret_enc, totp_pending_secret_enc FROM users'
        : 'SELECT id, tax_id, instapay, totp_secret_enc FROM users'
    ).all();
    const updUser = db.prepare(
      hasPendingTotp
        ? 'UPDATE users SET tax_id = ?, tax_id_hash = ?, instapay = ?, totp_secret_enc = ?, totp_pending_secret_enc = ? WHERE id = ?'
        : 'UPDATE users SET tax_id = ?, tax_id_hash = ?, instapay = ?, totp_secret_enc = ? WHERE id = ?'
    );
    for (const u of users) {
      const taxPlain = dec(u.tax_id);
      const ipaPlain = dec(u.instapay);
      const totpPlain = dec(u.totp_secret_enc);
      if (hasPendingTotp) {
        const pendingTotpPlain = dec(u.totp_pending_secret_enc);
        updUser.run(
          enc(taxPlain),
          taxPlain ? newCipher.blindIndex(taxPlain) : '',
          enc(ipaPlain),
          enc(totpPlain),
          enc(pendingTotpPlain),
          u.id
        );
      } else {
        updUser.run(
          enc(taxPlain),
          taxPlain ? newCipher.blindIndex(taxPlain) : '',
          enc(ipaPlain),
          enc(totpPlain),
          u.id
        );
      }
      stats.users++;
    }

    // 2. orders (customer, phone, phone_hash, address)
    const orders = db.prepare('SELECT id, customer, phone, address FROM orders').all();
    const updOrder = db.prepare('UPDATE orders SET customer = ?, phone = ?, phone_hash = ?, address = ? WHERE id = ?');
    for (const o of orders) {
      const custPlain = dec(o.customer);
      const phonePlain = dec(o.phone);
      const addrPlain = dec(o.address);
      const normPhone = normalizePhoneForIndex(phonePlain);
      updOrder.run(
        enc(custPlain),
        enc(phonePlain),
        normPhone ? newCipher.blindIndex(normPhone) : '',
        enc(addrPlain),
        o.id
      );
      stats.orders++;
    }

    // 3. customers (name, phone, phone_hash, email, address)
    const customers = db.prepare('SELECT id, name, phone, email, address FROM customers').all();
    const updCust = db.prepare('UPDATE customers SET name = ?, phone = ?, phone_hash = ?, email = ?, address = ? WHERE id = ?');
    for (const c of customers) {
      const namePlain = dec(c.name);
      const phonePlain = dec(c.phone);
      const emailPlain = dec(c.email);
      const addrPlain = dec(c.address);
      const normPhone = normalizePhoneForIndex(phonePlain);
      updCust.run(
        enc(namePlain),
        enc(phonePlain),
        normPhone ? newCipher.blindIndex(normPhone) : '',
        emailPlain ? enc(emailPlain) : '',
        enc(addrPlain),
        c.id
      );
      stats.customers++;
    }

    // 4. payouts (handle)
    const payouts = db.prepare('SELECT id, handle FROM payouts').all();
    const updPayout = db.prepare('UPDATE payouts SET handle = ? WHERE id = ?');
    for (const p of payouts) {
      const plain = dec(p.handle);
      updPayout.run(enc(plain), p.id);
      stats.payouts++;
    }

    // 5. marketplace_connections (creds_enc)
    const mps = db.prepare('SELECT id, creds_enc FROM marketplace_connections').all();
    const updMp = db.prepare('UPDATE marketplace_connections SET creds_enc = ? WHERE id = ?');
    for (const m of mps) {
      const plain = dec(m.creds_enc);
      updMp.run(enc(plain), m.id);
      stats.marketplaces++;
    }

    // 6. courier_connections (creds_enc)
    const couriers = db.prepare('SELECT id, creds_enc FROM courier_connections').all();
    const updCour = db.prepare('UPDATE courier_connections SET creds_enc = ? WHERE id = ?');
    for (const c of couriers) {
      const plain = dec(c.creds_enc);
      updCour.run(enc(plain), c.id);
      stats.couriers++;
    }

    db.exec('COMMIT');
    return stats;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const oldKey = process.env.OLD_KEY || '';
  const newKey = process.env.NEW_KEY || '';
  const dbPath = process.env.DB_FILE || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'omniarab.db');
  try {
    const stats = rotateEncryptionKey({ dbPath, oldKey, newKey });
    console.log(JSON.stringify({ ok: true, rotated: stats }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

module.exports = { rotateEncryptionKey };
