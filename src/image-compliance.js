'use strict';
// محرك فحص مطابقة صور المنتجات لمعايير أمازون مصر ونون وترينديول (Pixel-Level Compliance Auditor)
// يعمل في Node.js (الاختبارات والخادم) ويدعم التصدير الصافي بدون تبعيات خارجية.

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * فحص مطابقة صورة منتج على مستوى البكسلات (RGBA Uint8Array / Uint8ClampedArray)
 * @param {object} params
 * @param {number} params.width عرض الصورة بالبكسل
 * @param {number} params.height ارتفاع الصورة بالبكسل
 * @param {Uint8Array|Uint8ClampedArray|number[]} params.rgbaPixels مصفوفة RGBA بطول width * height * 4
 * @param {'amazon'|'noon'|'trendyol'|'jumia'} [params.marketplace='amazon'] المنصة المستهدفة
 */
function evaluateImageCompliance({ width, height, rgbaPixels, marketplace = 'amazon' }) {
  const w = Math.max(0, Math.floor(Number(width) || 0));
  const h = Math.max(0, Math.floor(Number(height) || 0));
  const mkt = ['amazon', 'noon', 'trendyol', 'jumia'].includes(String(marketplace || '').toLowerCase())
    ? String(marketplace).toLowerCase()
    : 'amazon';

  if (!w || !h || !rgbaPixels || rgbaPixels.length < w * h * 4) {
    return {
      score: 0,
      passed: false,
      marketplace: mkt,
      metrics: { width: w, height: h, aspectRatio: 0, borderWhitePct: 0, borderHex: '#000000', fillRatio: 0, areaCoverage: 0 },
      checks: [{
        code: 'INVALID_IMAGE',
        passed: false,
        severity: 'error',
        titleAr: 'بيانات الصورة غير صالحة أو فارغة',
        fixHintAr: 'ارفع صورة بصيغة PNG أو JPG أو WEBP واضحة ثم أعد الفحص.'
      }]
    };
  }

  const checks = [];
  let score = 100;

  // 1) فحص الدقة (Resolution)
  const minSide = Math.min(w, h);
  const maxSide = Math.max(w, h);
  let resPassed = minSide >= 1000;
  let resSeverity = minSide >= 1600 ? 'ok' : (minSide >= 1000 ? 'ok' : (minSide < 500 ? 'error' : 'error'));
  let resTitle = minSide >= 1600
    ? `دقة ممتازة (${w}×${h} بكسل — تدعم التكبير Zoom)`
    : (minSide >= 1000
      ? `دقة مقبولة (${w}×${h} بكسل — يُفضّل ١٦٠٠×١٦٠٠ لتفعيل Zoom)`
      : (minSide < 500
        ? `دقة منخفضة جدًا (${w}×${h} بكسل — سترفضها المنصة فورًا)`
        : `دقة أقل من الحد الأدنى المطلوب (${w}×${h} بكسل — المطلوب ١٠٠٠ بكسل على الأقل)`));
  if (minSide < 500) score -= 35;
  else if (minSide < 1000) score -= 25;
  else if (minSide < 1600) score -= 4;

  checks.push({
    code: 'RESOLUTION',
    passed: resPassed,
    severity: resSeverity,
    titleAr: resTitle,
    fixHintAr: resPassed
      ? 'الدقة مطابقة لمتطلبات العرض.'
      : 'استخدم زر «إصلاح تلقائي فوري» لرفع المقاس إلى ١٦٠٠×١٦٠٠ بكسل (أو ١٢٨٠×١٦٠٠ لنون).'
  });

  // 2) فحص نسبة الأبعاد (Aspect Ratio)
  const aspectRatio = Number((w / h).toFixed(4));
  let aspectPassed = false;
  let aspectTitle = '';
  let aspectHint = '';
  if (mkt === 'amazon' || mkt === 'jumia') {
    aspectPassed = Math.abs(aspectRatio - 1) <= 0.02;
    aspectTitle = aspectPassed
      ? 'نسبة الأبعاد مربعة 1:1 مطابقة تمامًا لشروط أمازون'
      : `نسبة الأبعاد (${w}:${h}) غير مربعة 1:1 المطلوبة لأمازون`;
    aspectHint = aspectPassed
      ? 'النسبة مربعة مثالية.'
      : 'أمازون مصر تشترط نسبة 1:1 (مثال ١٦٠٠×١٦٠٠) للصورة الرئيسية.';
  } else {
    // Noon & Trendyol: accept 1:1 (±2%) OR 4:5 (0.8 ±3%) OR 730x1000 (0.73 ±3%)
    const isSquare = Math.abs(aspectRatio - 1) <= 0.02;
    const isFourFive = Math.abs(aspectRatio - 0.8) <= 0.03;
    const isNoonPortrait = Math.abs(aspectRatio - 0.73) <= 0.03;
    aspectPassed = isSquare || isFourFive || isNoonPortrait;
    aspectTitle = aspectPassed
      ? `نسبة الأبعاد (${isSquare ? '1:1' : isFourFive ? '4:5' : '730×1000'}) مطابقة لشروط ${mkt === 'noon' ? 'نون' : 'ترينديول'}`
      : `نسبة الأبعاد (${w}×${h}) غير مطابقة لنون (تقبل 1:1 أو 4:5 أو 730×1000)`;
    aspectHint = aspectPassed
      ? 'النسبة معتمدة للمنصة.'
      : 'اضبط المقاس على 1:1 أو 4:5 (١٢٨٠×١٦٠٠) لعدم اقتصاص المنتج في بطاقات العرض.';
  }
  if (!aspectPassed) score -= 20;
  checks.push({
    code: 'ASPECT_RATIO',
    passed: aspectPassed,
    severity: aspectPassed ? 'ok' : 'error',
    titleAr: aspectTitle,
    fixHintAr: aspectHint
  });

  // 3) فحص نقاء الخلفية البيضاء (#FFFFFF) في الحلقة الخارجية (4% من كل جانب والزوايا)
  const marginX = Math.max(1, Math.round(w * 0.04));
  const marginY = Math.max(1, Math.round(h * 0.04));
  const stepX = Math.max(1, Math.floor(w / 240));
  const stepY = Math.max(1, Math.floor(h / 240));

  let borderTotal = 0;
  let borderPureWhite = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < h; y += stepY) {
    const inYBorder = y < marginY || y >= h - marginY;
    for (let x = 0; x < w; x += stepX) {
      const inXBorder = x < marginX || x >= w - marginX;
      if (!inYBorder && !inXBorder) continue;
      const idx = (y * w + x) * 4;
      const a = rgbaPixels[idx + 3];
      // البكسل الشفاف يُعتبر خلفية غير مملوءة بالأبيض النقي إذا لم يُدمج على #FFFFFF
      const r = a < 250 ? Math.round((rgbaPixels[idx] * a + 255 * (255 - a)) / 255) : rgbaPixels[idx];
      const g = a < 250 ? Math.round((rgbaPixels[idx + 1] * a + 255 * (255 - a)) / 255) : rgbaPixels[idx + 1];
      const b = a < 250 ? Math.round((rgbaPixels[idx + 2] * a + 255 * (255 - a)) / 255) : rgbaPixels[idx + 2];
      borderTotal++;
      sumR += r;
      sumG += g;
      sumB += b;
      if (r >= 253 && g >= 253 && b >= 253 && a >= 250) {
        borderPureWhite++;
      }
    }
  }

  const borderWhitePct = borderTotal > 0 ? Math.round((borderPureWhite / borderTotal) * 1000) / 10 : 0;
  const avgR = borderTotal > 0 ? sumR / borderTotal : 0;
  const avgG = borderTotal > 0 ? sumG / borderTotal : 0;
  const avgB = borderTotal > 0 ? sumB / borderTotal : 0;
  const borderHex = rgbToHex(avgR, avgG, avgB);
  const bgPassed = borderWhitePct >= 92 && avgR >= 252 && avgG >= 252 && avgB >= 252;

  if (!bgPassed) {
    score -= borderWhitePct < 50 ? 35 : 25;
  }
  checks.push({
    code: 'PURE_WHITE_BG',
    passed: bgPassed,
    severity: bgPassed ? 'ok' : 'error',
    titleAr: bgPassed
      ? `خلفية بيضاء نقية مطابقة (${borderHex} — نقاء الحواف ${borderWhitePct}٪)`
      : `الخلفية ليست بيضاء نقية #FFFFFF (اللون المكتشف بالحواف ${borderHex} — نقاء ${borderWhitePct}٪ فقط)`,
    fixHintAr: bgPassed
      ? 'الخلفية مطابقة لسياسة أمازون ونون.'
      : 'اضغط «إصلاح تلقائي فوري» لتنظيف الخلفية الرمادية أو الملونة إلى أبيض نقي #FFFFFF دون مسح تفاصيل المنتج.'
  });

  // 4) فحص نسبة امتلاء المنتج داخل الإطار (قاعدة 85% في أمازون ونون)
  const scanStepX = Math.max(1, Math.floor(w / 320));
  const scanStepY = Math.max(1, Math.floor(h / 320));
  let minX = w, maxX = -1, minY = h, maxY = -1;
  let fgSamples = 0;
  let totalSamples = 0;

  // نحدد لون الخلفية المرجعي لحساب حدود المنتج حتى لو كانت الخلفية رمادية فاتحة مثل #EFEFEF
  const bgRefR = borderTotal > 0 ? avgR : 255;
  const bgRefG = borderTotal > 0 ? avgG : 255;
  const bgRefB = borderTotal > 0 ? avgB : 255;
  const isBgBright = bgRefR >= 220 && bgRefG >= 220 && bgRefB >= 220;

  for (let y = 0; y < h; y += scanStepY) {
    for (let x = 0; x < w; x += scanStepX) {
      totalSamples++;
      const idx = (y * w + x) * 4;
      const r = rgbaPixels[idx];
      const g = rgbaPixels[idx + 1];
      const b = rgbaPixels[idx + 2];
      const a = rgbaPixels[idx + 3];
      if (a < 20) continue;

      const isPureWhite = r >= 248 && g >= 248 && b >= 248;
      const distFromBg = Math.abs(r - bgRefR) + Math.abs(g - bgRefG) + Math.abs(b - bgRefB);
      const isForeground = isBgBright ? (!isPureWhite && distFromBg > 24) : (distFromBg > 36);

      if (isForeground) {
        fgSamples++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  let bboxW = 0;
  let bboxH = 0;
  if (maxX >= minX && maxY >= minY) {
    bboxW = Math.min(w, maxX - minX + scanStepX);
    bboxH = Math.min(h, maxY - minY + scanStepY);
  }
  const fillRatio = Number(Math.max(bboxW / w, bboxH / h).toFixed(3));
  const areaCoverage = totalSamples > 0 ? Number((fgSamples / totalSamples).toFixed(3)) : 0;
  const fillPct = Math.round(fillRatio * 100);

  const fillPassed = fillRatio >= 0.75 && fillRatio <= 0.92;
  let fillSeverity = 'ok';
  let fillTitle = `نسبة امتلاء المنتج ممتازة (${fillPct}٪ — النطاق المثالي ٧٥٪ إلى ٩٢٪)`;
  let fillHint = 'تموضع المنتج وحجمه مثاليان للظهور في نتائج البحث.';

  if (fillRatio < 0.75) {
    fillSeverity = fillRatio < 0.55 ? 'error' : 'warning';
    fillTitle = `المنتج صغير داخل الإطار (${fillPct}٪ فقط — أمازون ونون تطلبان نحو ٨٥٪)`;
    fillHint = 'استخدم «إصلاح تلقائي فوري» لقص الهوامش الزائدة وتكبير المنتج وتوسيطه تلقائيًا ليملأ ٨٥٪ من الإطار.';
    score -= fillRatio < 0.55 ? 20 : 12;
  } else if (fillRatio > 0.95) {
    fillSeverity = 'warning';
    fillTitle = `المنتج قريب جدًا من الحواف (${fillPct}٪ — قد يُقتص جزء منه)`;
    fillHint = 'أضف هامشًا أبيضًا متوازنًا (نحو ٧٫٥٪ من كل جانب) لتصل النسبة إلى ٨٥٪.';
    score -= 10;
  }

  checks.push({
    code: 'FRAME_FILL_RATIO',
    passed: fillPassed,
    severity: fillSeverity,
    titleAr: fillTitle,
    fixHintAr: fillHint
  });

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const hasCriticalError = checks.some((c) => !c.passed && c.severity === 'error');
  const passed = !hasCriticalError && finalScore >= 85 && bgPassed && resPassed && aspectPassed && fillPassed;

  return {
    score: finalScore,
    passed,
    marketplace: mkt,
    metrics: {
      width: w,
      height: h,
      minSide,
      maxSide,
      aspectRatio,
      borderWhitePct,
      borderHex,
      fillRatio,
      areaCoverage
    },
    checks
  };
}

module.exports = {
  evaluateImageCompliance,
  rgbToHex
};
