#!/usr/bin/env node
'use strict';

/**
 * Decrypt an AES-256-GCM encrypted OrderFlow SQLite backup (.db.enc) to a usable .db file.
 * Usage:
 *   BACKUP_ENCRYPTION_KEY="..." node scripts/restore-backup.js <input.db.enc> [output.db]
 */

const fs = require('node:fs');
const path = require('node:path');
const { decryptBackupFile } = require('../src/db');

if (require.main === module) {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || (inputPath ? inputPath.replace(/\.enc$/i, '.restored.db') : '');
  const key = process.env.BACKUP_ENCRYPTION_KEY || process.env.DATA_ENCRYPTION_KEY || '';

  if (!inputPath) {
    console.error('Usage: BACKUP_ENCRYPTION_KEY="..." node scripts/restore-backup.js <backup.db.enc> [output.db]');
    process.exit(1);
  }
  if (!key) {
    console.error('Error: BACKUP_ENCRYPTION_KEY environment variable is required.');
    process.exit(1);
  }

  try {
    const resolvedIn = path.resolve(inputPath);
    const resolvedOut = path.resolve(outputPath);
    const res = decryptBackupFile(resolvedIn, resolvedOut, key);
    const bytes = fs.statSync(res).size;
    console.log(JSON.stringify({ ok: true, input: resolvedIn, output: res, bytes }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}
