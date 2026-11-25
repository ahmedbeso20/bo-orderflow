/* ==========================================================================
   OrderFlow Dedicated Auth Pages (Login & Register)
   Split-panel architectural design inspired by modern SaaS auth flows,
   crafted natively in OrderFlow's Royal Ocean × Turquoise × Deep Navy palette.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    root.OrderFlowAuth = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MARKETPLACE_MARKS = [
    { key: 'a', name: 'Amazon Egypt', src: '/assets/logos/amazon-icon.svg' },
    { key: 'n', name: 'Noon', src: '/assets/logos/noon-icon.svg' },
    { key: 'j', name: 'Jumia', src: '/assets/logos/jumia-icon.jpg' },
    { key: 't', name: 'Trendyol', src: '/assets/logos/trendyol-icon.jpg' },
    { key: 'k', name: 'Kenzz', src: '/assets/logos/kenzz-icon.png' }
  ];

  function renderAuthPage(mode, ctx) {
    const { ico, esc, ORDERFLOW_LOGO_SVG, authViewState = {} } = ctx;
    const isRegister = mode === 1;
    const step = authViewState.step || 'form'; // 'form' | '2fa' | 'pending'
    const showPass = Boolean(authViewState.showPass);
    const pendingMessage = authViewState.pendingMessage || '';
    const pendingStore = authViewState.pendingStore || '';
    const challengeToken = authViewState.challengeToken || '';
    const challengeMessage = authViewState.challengeMessage || '';
    const requiresLoginCaptcha = Boolean(authViewState.requiresLoginCaptcha);

    const switchTargetMode = isRegister ? 0 : 1;
    const showcaseTitle = isRegister ? 'لديك حساب بالفعل؟' : 'ليس لديك حساب؟';
    const showcaseSub = isRegister
      ? 'سجّل دخولك لمتابعة مخزونك الموحّد وطلباتك وتحصيلات COD لحظة بلحظة.'
      : 'ابدأ إدارة متاجرك على أمازون مصر ونون وجوميا وترينديول من شاشة واحدة.';
    const circleLabel = isRegister ? 'تسجيل الدخول' : 'إنشاء حساب';
    const circleIcon = isRegister ? ico('logIn', 24) : ico('userPlus', 24);

    let formBodyHtml = '';

    if (step === 'pending') {
      formBodyHtml = `
        <div class="auth-state-panel" role="status">
          <div class="auth-state-emblem is-pending" aria-hidden="true">${ico('clock', 28)}</div>
          <h1 class="auth-heading">تم استلام طلب تسجيل متجرك</h1>
          <p class="auth-sub" style="max-width:44ch;margin-inline:auto">
            ${pendingStore ? `<strong>${esc(pendingStore)}</strong> — ` : ''}${esc(pendingMessage || 'حسابك الآن قيد المراجعة من قِبل فريق الإدارة. فور التفعيل ستصلك رسالة تأكيد ويمكنك تسجيل الدخول مباشرة.')}
          </p>
          <div class="auth-state-actions">
            <button type="button" class="auth-submit-btn" data-a="auth-switch" data-m="0">
              ${ico('logIn', 18)}
              <span>الذهاب إلى تسجيل الدخول</span>
            </button>
            <a class="auth-demo-btn" href="#/">
              ${ico('arrowRight', 16)}
              <span>العودة إلى الصفحة الرئيسية</span>
            </a>
          </div>
        </div>
      `;
    } else if (step === '2fa') {
      formBodyHtml = `
        <div class="auth-form-head">
          <div class="auth-state-emblem is-shield" aria-hidden="true">${ico('shield', 24)}</div>
          <h1 class="auth-heading">المصادقة الثنائية (2FA)</h1>
          <p class="auth-sub">${esc(challengeMessage || 'أدخل الرمز المكوّن من ٦ أرقام من تطبيق المصادقة أو أحد أكواد الاسترداد الطارئة.')}</p>
        </div>
        <form class="auth-form" data-submit="login-2fa-submit" novalidate>
          <input type="hidden" id="l2fa-token" value="${esc(challengeToken)}">
          <div class="auth-field">
            <label for="l2fa-code">رمز التحقق أو كود الاسترداد</label>
            <div class="auth-input-wrap">
              <span class="auth-input-ico" aria-hidden="true">${ico('key', 17)}</span>
              <input
                id="l2fa-code"
                class="auth-input auth-input-otp"
                dir="ltr"
                autocomplete="one-time-code"
                maxlength="12"
                placeholder="123456  /  XXXX-XXXX"
                required
              >
            </div>
          </div>
          <p id="l2fa-err" class="auth-err" role="alert"></p>
          <button class="auth-submit-btn" type="submit">
            ${ico('checkCircle', 18)}
            <span>تأكيد الرمز والدخول</span>
          </button>
          <button type="button" class="auth-text-back" data-a="auth-back-login">
            ${ico('arrowRight', 15)}
            <span>العودة لتغيير بيانات الحساب</span>
          </button>
        </form>
      `;
    } else if (isRegister) {
      formBodyHtml = `
        <div class="auth-form-head">
          <h1 class="auth-heading">إنشاء حساب تاجر</h1>
          <p class="auth-sub">أدخل بيانات متجرك للبدء مجانًا — بدون بطاقة بنكية</p>
        </div>
        <form class="auth-form auth-form-register" data-submit="auth-submit" novalidate>
          <div class="auth-grid-2">
            <div class="auth-field">
              <label for="auth-store">اسم المتجر أو العلامة التجارية</label>
              <div class="auth-input-wrap">
                <span class="auth-input-ico" aria-hidden="true">${ico('store', 17)}</span>
                <input
                  id="auth-store"
                  class="auth-input"
                  maxlength="60"
                  autocomplete="organization"
                  placeholder="مثال: متجر النور للإلكترونيات"
                  required
                >
              </div>
            </div>
            <div class="auth-field">
              <label for="auth-fullname">الاسم الكامل</label>
              <div class="auth-input-wrap">
                <span class="auth-input-ico" aria-hidden="true">${ico('user', 17)}</span>
                <input
                  id="auth-fullname"
                  class="auth-input"
                  maxlength="80"
                  autocomplete="name"
                  placeholder="مثال: أحمد محمود"
                >
              </div>
            </div>
          </div>

          <div class="auth-grid-2">
            <div class="auth-field">
              <label for="auth-email">البريد الإلكتروني</label>
              <div class="auth-input-wrap">
                <span class="auth-input-ico" aria-hidden="true">${ico('mail', 17)}</span>
                <input
                  id="auth-email"
                  class="auth-input"
                  type="email"
                  dir="ltr"
                  autocomplete="email"
                  placeholder="owner@yourstore.com"
                  required
                >
              </div>
            </div>
            <div class="auth-field">
              <label for="auth-id">رقم الموبايل (واتساب)</label>
              <div class="auth-input-wrap">
                <span class="auth-input-ico" aria-hidden="true">${ico('smartphone', 17)}</span>
                <input
                  id="auth-id"
                  class="auth-input"
                  dir="ltr"
                  inputmode="tel"
                  autocomplete="tel"
                  placeholder="010xxxxxxxx"
                  required
                >
              </div>
            </div>
          </div>

          <div class="auth-field">
            <label for="auth-pass">كلمة المرور</label>
            <div class="auth-input-wrap has-trail">
              <span class="auth-input-ico" aria-hidden="true">${ico('lock', 17)}</span>
              <input
                id="auth-pass"
                class="auth-input"
                type="${showPass ? 'text' : 'password'}"
                dir="ltr"
                autocomplete="new-password"
                data-i="auth-pass-strength"
                placeholder="٨ أحرف على الأقل (حروف وأرقام)"
                required
              >
              <button
                type="button"
                class="auth-eye-btn"
                data-a="toggle-auth-pass"
                aria-label="${showPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}"
                aria-pressed="${showPass ? 'true' : 'false'}"
              >${ico(showPass ? 'eyeOff' : 'eye', 17)}</button>
            </div>
            <div class="auth-pw-meter" id="auth-pw-meter" data-level="empty" aria-live="polite">
              <div class="auth-pw-bars" aria-hidden="true">
                <i></i><i></i><i></i><i></i>
              </div>
              <div class="auth-pw-meta">
                <span class="auth-pw-label" id="auth-pw-label">اختر كلمة مرور من ٨ أحرف بحروف وأرقام</span>
                <span class="auth-pw-checks" id="auth-pw-checks">٨+ أحرف · حرف · رقم</span>
              </div>
            </div>
          </div>

          <label class="auth-terms-row" for="auth-terms">
            <input type="checkbox" id="auth-terms" class="auth-checkbox">
            <span>أوافق على <a href="#/terms" class="auth-inline-link">الشروط والأحكام</a> و<a href="#/privacy" class="auth-inline-link">سياسة الخصوصية</a> وفق القانون ١٥١/٢٠٢٠</span>
          </label>

          <div id="ts-register" class="auth-turnstile-slot"></div>
          <p id="auth-err" class="auth-err" role="alert"></p>

          <button class="auth-submit-btn" id="auth-submit-btn" type="submit">
            ${ico('userPlus', 18)}
            <span>إنشاء حساب المتجر</span>
          </button>

          <p class="auth-mobile-switch">
            لديك حساب بالفعل؟
            <button type="button" class="auth-inline-btn" data-a="auth-switch" data-m="0">سجّل الدخول</button>
          </p>
        </form>
      `;
    } else {
      formBodyHtml = `
        <div class="auth-form-head">
          <h1 class="auth-heading">تسجيل الدخول</h1>
          <p class="auth-sub">أدخل بياناتك للوصول إلى لوحة تحكم متاجرك</p>
        </div>
        <form class="auth-form" data-submit="auth-submit" novalidate>
          <div class="auth-field">
            <label for="auth-id">البريد الإلكتروني أو رقم الموبايل</label>
            <div class="auth-input-wrap">
              <span class="auth-input-ico" aria-hidden="true">${ico('mail', 17)}</span>
              <input
                id="auth-id"
                class="auth-input"
                dir="ltr"
                autocomplete="username"
                placeholder="owner@store.eg  /  010xxxxxxxx"
                required
              >
            </div>
          </div>

          <div class="auth-field">
            <div class="auth-label-row">
              <label for="auth-pass">كلمة المرور</label>
              <button type="button" class="auth-forgot-link" data-a="forgot-password">نسيت كلمة المرور؟</button>
            </div>
            <div class="auth-input-wrap has-trail">
              <span class="auth-input-ico" aria-hidden="true">${ico('lock', 17)}</span>
              <input
                id="auth-pass"
                class="auth-input"
                type="${showPass ? 'text' : 'password'}"
                dir="ltr"
                autocomplete="current-password"
                placeholder="••••••••"
                required
              >
              <button
                type="button"
                class="auth-eye-btn"
                data-a="toggle-auth-pass"
                aria-label="${showPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}"
                aria-pressed="${showPass ? 'true' : 'false'}"
              >${ico(showPass ? 'eyeOff' : 'eye', 17)}</button>
            </div>
          </div>

          ${requiresLoginCaptcha ? '<div id="ts-login" class="auth-turnstile-slot"></div>' : ''}
          <p id="auth-err" class="auth-err" role="alert"></p>

          <button class="auth-submit-btn" id="auth-submit-btn" type="submit">
            ${ico('logIn', 18)}
            <span>تسجيل الدخول</span>
          </button>

          <div class="auth-divider" aria-hidden="true"><span>أو</span></div>

          <button type="button" class="auth-demo-btn" data-a="demo">
            ${ico('zap', 16)}
            <span>جرّب لوحة تحكم تجريبية بدون تسجيل</span>
          </button>

          <p class="auth-mobile-switch">
            ليس لديك حساب؟
            <button type="button" class="auth-inline-btn" data-a="auth-switch" data-m="1">أنشئ حسابًا جديدًا</button>
          </p>
        </form>
      `;
    }

    return `
      <div class="auth-stage" data-auth-mode="${isRegister ? 'register' : 'login'}">
        <header class="auth-topbar">
          <a href="#/" class="auth-back-home">
            ${ico('arrowRight', 16)}
            <span>العودة للرئيسية</span>
          </a>
          <button
            type="button"
            class="auth-theme-btn"
            data-a="theme"
            title="تبديل المظهر"
            aria-label="تبديل المظهر"
          >
            <span class="theme-ico-moon">${ico('moon', 16)}<span class="auth-theme-label">الوضع الليلي</span></span>
            <span class="theme-ico-sun">${ico('sunMoon', 16)}<span class="auth-theme-label">الوضع النهاري</span></span>
          </button>
        </header>

        <main class="auth-center">
          <section class="auth-card ${isRegister ? 'is-register' : 'is-login'}" aria-label="${isRegister ? 'صفحة إنشاء حساب' : 'صفحة تسجيل الدخول'}">
            <div class="auth-form-pane">
              <div class="auth-brand-wrap">
                <a class="auth-brand-link" href="#/" aria-label="OrderFlow — الصفحة الرئيسية">
                  <span class="auth-brand-mark">${ORDERFLOW_LOGO_SVG}</span>
                  <span class="auth-brand-name">Order<span class="auth-brand-accent">Flow</span></span>
                </a>
              </div>
              ${formBodyHtml}
            </div>

            <aside class="auth-showcase" aria-label="${isRegister ? 'الانتقال إلى تسجيل الدخول' : 'الانتقال إلى إنشاء حساب'}">
              <span class="auth-arc auth-arc-top" aria-hidden="true"></span>
              <span class="auth-arc auth-arc-bottom" aria-hidden="true"></span>

              <div class="auth-showcase-inner">
                <span class="auth-showcase-kicker">منصة التجارة متعددة القنوات</span>
                <h2 class="auth-showcase-title">${showcaseTitle}</h2>
                <p class="auth-showcase-sub">${showcaseSub}</p>

                <button
                  type="button"
                  class="auth-circle-cta"
                  data-a="auth-switch"
                  data-m="${switchTargetMode}"
                  aria-label="${circleLabel}"
                >
                  <span class="auth-circle-ico" aria-hidden="true">${circleIcon}</span>
                  <span class="auth-circle-text">${circleLabel}</span>
                </button>
              </div>

              <div class="auth-showcase-foot">
                <div class="auth-mk-row" aria-label="المنصات المدعومة">
                  ${MARKETPLACE_MARKS.map((m) => `
                    <span class="auth-mk-tile" title="${m.name}">
                      <img src="${m.src}" alt="${m.name}" loading="lazy" referrerpolicy="no-referrer">
                    </span>
                  `).join('')}
                </div>
                <p class="auth-trust-line">تشفير AES-256 · مصادقة ثنائية 2FA · بالجنيه المصري</p>
              </div>
            </aside>
          </section>
        </main>

        <footer class="auth-page-foot">
          <a href="#/terms">الشروط والأحكام</a>
          <span aria-hidden="true">·</span>
          <a href="#/privacy">سياسة الخصوصية</a>
          <span aria-hidden="true">·</span>
          <a href="#/contact">تواصل معنا</a>
          <span aria-hidden="true">·</span>
          <span>© ٢٠٢٦ OrderFlow</span>
        </footer>
      </div>
    `;
  }

  return {
    renderAuthPage
  };
});
