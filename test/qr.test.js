'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const { buildMatrix, generateQrSvg } = require('../src/qr');
const { buildTotpUri, generateTotpSecret } = require('../src/auth');

test('buildMatrix matches ISO/IEC 18004 standard qrcode module-for-module for owner TOTP URI', () => {
  const secret = generateTotpSecret();
  const uri = buildTotpUri({ secret, accountName: 'owner@orderflow.eg', issuer: 'OrderFlow' });
  const actual = buildMatrix(uri);
  const expected = QRCode.create(uri, { errorCorrectionLevel: 'M' });

  assert.equal(actual.size, expected.modules.size);
  assert.equal(actual.version, expected.version);
  for (let r = 0; r < actual.size; r++) {
    for (let c = 0; c < actual.size; c++) {
      assert.equal(
        actual.mat[r][c],
        expected.modules.get(r, c) ? 1 : 0,
        `mismatch at (${r}, ${c})`
      );
    }
  }
});

test('generateQrSvg produces crisp black-on-white SVG with quiet zone and valid finder patterns', () => {
  const uri = buildTotpUri({
    secret: 'CZX7UXKQ44WL57UNSBWLFLWV7BAZ6ZNW',
    accountName: 'owner@orderflow.eg',
    issuer: 'OrderFlow'
  });
  const svg = generateQrSvg(uri);
  assert.match(svg, /^<svg width="220" height="220" viewBox="0 0 \d+ \d+"[\s\S]+<\/svg>$/);
  assert.ok(svg.includes('fill="#ffffff"'));
  assert.ok(svg.includes('fill="#000000"'));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));

  // Verify 7x7 finder patterns exist in top-left, top-right, and bottom-left corners
  const { size, mat } = buildMatrix(uri);
  const assertFinder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const expectedDark = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) ? 1 : 0;
        assert.equal(mat[r0 + r][c0 + c], expectedDark, `finder mismatch at (${r0 + r}, ${c0 + c})`);
      }
    }
  };
  assertFinder(0, 0);
  assertFinder(0, size - 7);
  assertFinder(size - 7, 0);
});

test('buildMatrix handles long otpauth URIs (>160 bytes) without truncation', () => {
  const longEmail = 'very.long.owner.merchant.account.address.2026@orderflow-enterprise.example.eg';
  const uri = buildTotpUri({
    secret: 'CZX7UXKQ44WL57UNSBWLFLWV7BAZ6ZNW',
    accountName: longEmail,
    issuer: 'OrderFlow Egypt Platform'
  });
  assert.ok(Buffer.from(uri, 'utf8').length > 160);
  const m = buildMatrix(uri);
  assert.ok(m.version >= 7);
  assert.equal(m.size, m.version * 4 + 17);
});
