'use strict';
// مولّد QR Code قياسي متوافق تمامًا مع ISO/IEC 18004 عبر مكتبة qrcode (Versions 1..40, optimal mask, ECC M)
const QRCode = require('qrcode');

function buildMatrix(text, { errorCorrectionLevel = 'M' } = {}) {
  const value = String(text || ' ');
  const qr = QRCode.create(value, { errorCorrectionLevel });
  const size = qr.modules.size;
  const mat = Array.from({ length: size }, (_, r) => {
    const row = new Int8Array(size);
    for (let c = 0; c < size; c++) {
      row[c] = qr.modules.get(r, c) ? 1 : 0;
    }
    return row;
  });
  return { size, mat, version: qr.version };
}

function generateQrSvg(
  text,
  {
    pixelSize = 220,
    margin = 4,
    darkColor = '#000000',
    lightColor = '#ffffff',
    errorCorrectionLevel = 'M'
  } = {}
) {
  const { size, mat } = buildMatrix(text, { errorCorrectionLevel });
  const total = size + margin * 2;
  let paths = '';
  for (let r = 0; r < size; r++) {
    let runStart = -1;
    for (let c = 0; c <= size; c++) {
      const dark = c < size && mat[r][c] === 1;
      if (dark && runStart === -1) {
        runStart = c;
      } else if (!dark && runStart !== -1) {
        paths += `M${runStart + margin},${r + margin}h${c - runStart}v1h-${c - runStart}z`;
        runStart = -1;
      }
    }
  }
  return `<svg width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="${total}" height="${total}" fill="${lightColor}"/><path d="${paths}" fill="${darkColor}"/></svg>`;
}

module.exports = { buildMatrix, generateQrSvg };
