/* ==========================================================================
   OrderFlow Growth Suite — Solutions Showcase, Onboarding Engine,
   Managed Expert Services, Seller Academy Guides & Canvas Photo Studio
   UMD-compatible so both browser and Node unit tests (node:test) can import it.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    root.OrderFlowGrowth = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 1. الأيقونات والشعارات الرسمية المعتمدة للمنصات كما تظهر في مواقعها وتطبيقاتها الرسمية (أمازون · نون · جوميا · ترينديول · كنز)
   */
  const PLATFORM_LOGO_ASSETS = {
    a: {
      full: '/assets/logos/amazon.svg',
      icon: '/assets/logos/amazon-icon.svg',
      alt: 'Amazon Egypt',
      stageBg: '#FFFFFF',
      tileBg: '#FFFFFF',
      bleed: false
    },
    n: {
      full: '/assets/logos/noon.svg',
      icon: '/assets/logos/noon-icon.svg',
      alt: 'Noon',
      stageBg: '#FCE819',
      tileBg: '#FCE819',
      bleed: true
    },
    j: {
      full: '/assets/logos/jumia-wordmark.png',
      icon: '/assets/logos/jumia-icon.jpg',
      alt: 'Jumia',
      stageBg: '#FFFFFF',
      tileBg: '#F68B1E',
      bleed: true
    },
    t: {
      full: '/assets/logos/trendyol.svg',
      icon: '/assets/logos/trendyol-icon.jpg',
      alt: 'Trendyol',
      stageBg: '#FFFFFF',
      tileBg: '#F27A1A',
      bleed: true
    },
    k: {
      full: '/assets/logos/kenzz.svg',
      icon: '/assets/logos/kenzz-icon.png',
      alt: 'Kenzz',
      stageBg: '#FFFFFF',
      tileBg: '#FFFFFF',
      bleed: false
    }
  };

  function renderPlatformLogo(key, variant = 'icon') {
    const asset = PLATFORM_LOGO_ASSETS[key];
    if (!asset) return '';
    const mode = variant === 'full' ? 'full' : 'icon';
    const src = mode === 'full' ? asset.full : asset.icon;
    const bleedCls = mode === 'icon' && asset.bleed ? ' platform-logo-img--bleed' : '';
    return `<img class="platform-logo-img platform-logo-img--${mode} platform-logo-img--${key}${bleedCls}" src="${src}" alt="${asset.alt}" loading="eager" decoding="async">`;
  }

  const PARTNER_CERTIFICATIONS = [
    { key: 'a', code: 'Amazon SPN', name: 'Amazon Egypt', badge: 'إدارة المبيعات', accent: '#131921', textColor: '#ffffff', short: 'A', stageBg: PLATFORM_LOGO_ASSETS.a.stageBg, tileBg: PLATFORM_LOGO_ASSETS.a.tileBg, bleed: PLATFORM_LOGO_ASSETS.a.bleed, logoSrc: PLATFORM_LOGO_ASSETS.a.full, iconSrc: PLATFORM_LOGO_ASSETS.a.icon },
    { key: 'n', code: 'Noon FBPI', name: 'Noon', badge: 'إدارة المبيعات', accent: '#FCE819', textColor: '#1E1E24', short: 'N', stageBg: PLATFORM_LOGO_ASSETS.n.stageBg, tileBg: PLATFORM_LOGO_ASSETS.n.tileBg, bleed: PLATFORM_LOGO_ASSETS.n.bleed, logoSrc: PLATFORM_LOGO_ASSETS.n.full, iconSrc: PLATFORM_LOGO_ASSETS.n.icon },
    { key: 'j', code: 'Jumia AMP', name: 'Jumia', badge: 'إدارة المبيعات', accent: '#F68B1E', textColor: '#ffffff', short: 'J', stageBg: PLATFORM_LOGO_ASSETS.j.stageBg, tileBg: PLATFORM_LOGO_ASSETS.j.tileBg, bleed: PLATFORM_LOGO_ASSETS.j.bleed, logoSrc: PLATFORM_LOGO_ASSETS.j.full, iconSrc: PLATFORM_LOGO_ASSETS.j.icon },
    { key: 't', code: 'Trendyol API', name: 'Trendyol', badge: 'إدارة المبيعات', accent: '#F27A1A', textColor: '#ffffff', short: 'T', stageBg: PLATFORM_LOGO_ASSETS.t.stageBg, tileBg: PLATFORM_LOGO_ASSETS.t.tileBg, bleed: PLATFORM_LOGO_ASSETS.t.bleed, logoSrc: PLATFORM_LOGO_ASSETS.t.full, iconSrc: PLATFORM_LOGO_ASSETS.t.icon },
    { key: 'k', code: 'Kenzz Egypt', name: 'Kenzz', badge: 'إدارة المبيعات', accent: '#6A00D5', textColor: '#ffffff', short: 'K', stageBg: PLATFORM_LOGO_ASSETS.k.stageBg, tileBg: PLATFORM_LOGO_ASSETS.k.tileBg, bleed: PLATFORM_LOGO_ASSETS.k.bleed, logoSrc: PLATFORM_LOGO_ASSETS.k.full, iconSrc: PLATFORM_LOGO_ASSETS.k.icon }
  ];

  /**
   * 2. تبويبات "حلولنا الذكية" التفاعلية على الصفحة الرئيسية (منصة + ذكاء اصطناعي + خدمات الخبراء)
   */
  const SOLUTIONS_TABS = [
    {
      id: 'ai',
      label: 'الذكاء الاصطناعي',
      icon: 'ai',
      headline: 'أدوات ذكاء اصطناعي تجهّز منتجاتك في ثوانٍ',
      lead: 'اكتب وصف المنتج، جهّز صوره، واحسب صافي ربحك بسهولة بدون مجهود.',
      ctaText: 'جرّب الاستوديو الآن',
      ctaAction: 'demo',
      items: [
        { icon: 'ai', name: 'كتابة الوصف و A+', desc: 'عناوين ووصف جاهز لأمازون ونون وجوميا بضغطة زر.' },
        { icon: 'camera', name: 'استوديو الصور', desc: 'صور بخلفية بيضاء نقية مطابقة لشروط المنصات.' },
        { icon: 'calc', name: 'حاسبة الأرباح', desc: 'اعرف صافي ربح القطعة قبل ما تنشرها.' },
        { icon: 'brain', name: 'مستشار النمو', desc: 'اقتراحات سريعة لزيادة مبيعاتك وإعادة التوريد.' }
      ]
    },
    {
      id: 'ops',
      label: 'إدارة العمليات',
      icon: 'layers',
      headline: 'مخزونك وطلباتك وتحصيلاتك في شاشة واحدة',
      lead: 'تابع كل متاجرك وشركات الشحن من مكان واحد بدل التنقل بين ٥ لوحات.',
      ctaText: 'شاهد لوحة التحكم',
      ctaAction: 'demo',
      items: [
        { icon: 'sync', name: 'مخزون متزامن لحظيًا', desc: 'أي مبيعة تُخصم فورًا من باقي المنصات لمنع الإلغاء.' },
        { icon: 'ord', name: 'الطلبات والبوالص', desc: 'اطبع بوالص بوسطة وأرامكس وأكّد الطلب بواتساب.' },
        { icon: 'returns', name: 'متابعة المرتجعات', desc: 'قلّل رفض الاستلام وأعد المخزون السليم تلقائيًا.' },
        { icon: 'customers', name: 'سجل العملاء', desc: 'اعرف عملاءك وأكثر المحافظات طلبًا لمنتجاتك.' }
      ]
    },
    {
      id: 'experts',
      label: 'خدمات الخبراء',
      icon: 'briefcase',
      headline: 'فريق متخصص يساعدك في تأسيس ونمو متجرك',
      lead: 'نفتح حساباتك، نجهّز صفحات منتجاتك، وندير إعلاناتك خطوة بخطوة.',
      ctaText: 'احجز استشارة مجانية',
      ctaAction: 'open-consult',
      items: [
        { icon: 'award', name: 'فتح وتوثيق الحسابات', desc: 'تفعيل حسابك على أمازون ونون وجوميا بدون تعقيد.' },
        { icon: 'layers', name: 'تجهيز الكتالوج و A+', desc: 'تصميم صفحات بيعية وصور احترافية ترفع المبيعات.' },
        { icon: 'briefcase', name: 'إدارة كاملة للحساب', desc: 'مدير حساب يتابع الطلبات والمخزون يوميًا عنك.' },
        { icon: 'shield', name: 'حماية صحة الحساب', desc: 'حل تنبيهات المنصات والحفاظ على تقييم متجرك.' }
      ]
    }
  ];

  /**
   * 3. كتالوج خدمات الخبراء وإدارة الحسابات (لصفحة #/services والصفحة الرئيسية)
   */
  const EXPERT_SERVICES_UI = [
    {
      key: 'account_setup',
      icon: 'award',
      badge: 'تأسيس سريع',
      title: 'فتح وتوثيق حسابات البائعين',
      desc: 'إعداد كامل لحساباتك على أمازون مصر (SPN) ونون وجوميا وترينديول مع مراجعة المستندات والربط البنكي.',
      sla: 'خلال ٤٨ ساعة عمل',
      priceLabel: 'مجاني مع الاحترافية أو ٧٥٠ ج.م',
      deliverables: ['تجهيز ومراجعة السجل التجاري والبطاقة الضريبية', 'تفعيل حسابات أمازون ونون وجوميا وترينديول', 'ضبط إعدادات الشحن والربط مع OrderFlow']
    },
    {
      key: 'aplus_content',
      icon: 'camera',
      badge: 'مضاعفة التحويل',
      title: 'تصميم صفحات المنتجات ومحتوى A+',
      desc: 'بناء صفحات بيعية احترافية تتضمن صور الاستوديو البيضاء والإنفوجرافيك ومحتوى A+ المتوافق مع SEO.',
      sla: 'خلال ٣ أيام عمل',
      priceLabel: 'تبدأ من ٩٥٠ ج.م (١٠ منتجات)',
      deliverables: ['عناوين ونقاط بيعية متوافقة مع A9 وNoon Search', 'تصميم ٣ شرائح محتوى A+ لكل منتج رئيسي', 'تجهيز صور بخلفية بيضاء نقية ومقاسات المنصات']
    },
    {
      key: 'ppc_ads',
      icon: 'trendUp',
      badge: 'نمو المبيعات',
      title: 'إدارة الإعلانات الممولة (PPC)',
      desc: 'إدارة احترافية لحملات Amazon Sponsored وNoon Ads مع استهداف كلمات بحثية عالية التحويل وتقارير ACOS.',
      sla: 'تقرير أداء أسبوعي',
      priceLabel: '١٬٨٠٠ ج.م / شهريًا',
      deliverables: ['بحث الكلمات المفتاحية الأعلى شراءً في مصر', 'ضبط الميزانيات اليومية وخفض تكلفة الاستحواذ', 'تقرير أسبوعي بالعائد على الإنفاق الإعلاني ROAS']
    },
    {
      key: 'full_management',
      icon: 'briefcase',
      badge: 'إدارة شاملة',
      title: 'الإدارة التشغيلية الكاملة للحساب',
      desc: 'فريق متكامل يتولى متابعة الطلبات والمخزون والمرتجعات والتسعير وصحة الحساب يوميًا بالنيابة عنك.',
      sla: 'مدير حساب مخصص يوميًا',
      priceLabel: 'باقة مخصصة حسب حجم المتجر',
      deliverables: ['مدير حساب مخصص لمتابعة الأسواق الثلاثة وأكثر', 'إدارة التوريد وFBA / Noon Express والمرتجعات', 'اجتماع مراجعة أرباح وتسوية مالية كل أسبوعين']
    },
    {
      key: 'team_training',
      icon: 'book',
      badge: 'تدريب عملي',
      title: 'تدريب فريقك على معايير الأسواق',
      desc: 'ورش عمل تطبيقية لتأهيل فريق تشغيل متجرك على إدارة أمازون ونون وجوميا وقراءة تقارير الربحية.',
      sla: 'جلستان عمليتان أونلاين',
      priceLabel: '١٬٢٠٠ ج.م للفريق بالكامل',
      deliverables: ['شرح عملي لقوانين Buy Box وصحة حساب البائع', 'تطبيق حي على حساب الأرباح وتقليل RTO', 'دليل تشغيل داخلي (SOP) جاهز لفريقك']
    },
    {
      key: 'growth_consult',
      icon: 'message',
      badge: 'مجانية بالكامل',
      title: 'استشارة نمو وتسعير مجانية (٣٠ دقيقة)',
      desc: 'جلسة تشخيصية مع خبير تجارة إلكترونية لتحليل متجرك الحالي ورسم خارطة طريق عملية لمضاعفة مبيعاتك.',
      sla: 'تواصل خلال ٢٤ ساعة',
      priceLabel: '٠ ج.م · مجانية بالكامل',
      deliverables: ['مراجعة سريعة لأهم ٣ فرص زيادة ربح في متجرك', 'تقييم جاهزيتك للتوسع على نون وترينديول وكنز', 'خطة عمل قابلة للتنفيذ الفوري بدون التزام']
    }
  ];

  /**
   * 4. أكاديمية التاجر (المدونة وأدلة البائعين العملية)
   */
  const SELLER_GUIDES = [
    {
      id: 'amazon-spn-egypt',
      category: 'أمازون مصر',
      readMin: '٥ دقائق قراءة',
      title: 'دليل التاجر الشامل للبدء والربح على أمازون مصر (FBA مقابل FBM)',
      summary: 'كيف تفوز بصندوق الشراء Buy Box وتختار بين الشحن عبر أمازون (FBA) أو الشحن الذاتي (FBM) بدون خسارة هامش ربحك.',
      takeaways: [
        'ابدأ بإرسال أعلى ٥ منتجات مبيعًا إلى مخازن أمازون FBA للحصول على شارة Prime وزيادة التحويل حتى ٤٠٪.',
        'احتفظ بالمخزون الاحتياطي متزامنًا على OrderFlow لتفادي نفاد الكمية وهبوط ترتيب المنتج في بحث A9.',
        'احسب عمولة الفئة (١٠٪–١٥٪) + ١٤٪ ضريبة قيمة مضافة على العمولة قبل تثبيت السعر النهائي.'
      ],
      sections: [
        { h: '١. متى تختار FBA ومتى تختار FBM؟', p: 'يفضّل استخدام FBA للمنتجات خفيفة الوزن وسريعة الدوران (أكثر من ٣٠ طلبًا شهريًا) لأن رسوم التخزين تكون منخفضة ومعدل رفض الاستلام أقل بكثير. أما المنتجات كبيرة الحجم أو البطيئة فاشحنها عبر FBM مع بوسطة أو أرامكس.' },
        { h: '٢. أسرار الفوز بـ Buy Box في السوق المصري', p: 'لا يعتمد Buy Box على أقل سعر فقط؛ بل على سرعة الشحن، معدل الإلغاء الصفري، وتوفر المخزون المستمر. ربط متجرك عبر OrderFlow يمنع البيع على المكشوف ويحافظ على تقييم حسابك فوق ٩٨٪.' },
        { h: '٣. تجهيز صفحة المنتج وفق معايير أمازون', p: 'استخدم خلفية بيضاء نقية للصورة الأولى (#FFFFFF) وعنوانًا واضحًا يضم الاسم والموديل والميزة الرئيسية، ثم أضف ٤ نقاط بيعية ومحتوى A+ عبر استوديو الذكاء الاصطناعي في OrderFlow.' }
      ]
    },
    {
      id: 'noon-fbpi-growth',
      category: 'نون مصر',
      readMin: '٤ دقائق قراءة',
      title: 'شرح نموذج نون السريع (Noon FBPI / Express) ومضاعفة الظهور',
      summary: 'خطوات تجهيز الباركود والكتالوج وتفعيل شارة نون إكسبريس لرفع مبيعاتك في القاهرة والإسكندرية والدلتا.',
      takeaways: [
        'المنتجات الحاصلة على شارة Express تحصد أكثر من ٦٥٪ من نقرات المتسوقين على تطبيق نون.',
        'توحيد رموز SKU بين نون وأمازون داخل OrderFlow يختصر ٨٠٪ من وقت الجرد الأسبوعي.',
        'تابع تسعير المنافسين أسبوعيًا عبر رادار الأسعار لتبقى داخل النطاق التنافسي دون حرق الهامش.'
      ],
      sections: [
        { h: '١. تجهيز الكتالوج بدون رفض من فريق الجودة', p: 'أكثر أسباب رفض منتجات نون شيوعًا هي الصور التي تحتوي على شعارات مائية أو خلفيات ملونة. يمكنك الآن توليد صور بخلفية بيضاء مطابقة تمامًا عبر «استوديو الصور» داخل لوحة التحكم.' },
        { h: '٢. إدارة العروض الموسمية والجمعة الصفراء', p: 'قبل الدخول في أي عرض خصم على نون، أدخل سعر العرض في حاسبة الأرباح وتأكد أن صافي الربح بعد عمولة ١٠٪ وضريبة ١٤٪ يغطي تكلفة التغليف والشحن بهامش إيجابي.' }
      ]
    },
    {
      id: 'reduce-cod-rto-egypt',
      category: 'الشحن و COD',
      readMin: '٦ دقائق قراءة',
      title: 'خطة عملية لتقليل مرتجعات الدفع عند الاستلام (RTO) بنسبة ٤٠٪',
      summary: 'أكبر عدو لصافي ربح التاجر المصري هو الشحنات المرتجعة. إليك ٤ إجراءات مجربة لحماية هامشك وتدفقاتك النقدية.',
      takeaways: [
        'تأكيد الطلب برسالة واتساب مهذبة قبل تسليمه للمندوب يخفض رفض الاستلام بنسبة ٣٠٪–٤٢٪.',
        'شحن طلبات القاهرة والجيزة خلال ٢٤ ساعة يضاعف نسبة التسليم الناجح مقارنة بالتأخير لـ ٣ أيام.',
        'أضف مخصص RTO (٥٪–٨٪) داخل تسعيرك من اليوم الأول حتى لا تتآكل أرباحك في نهاية الشهر.'
      ],
      sections: [
        { h: '١. قاعدة الـ ١٥ دقيقة لتأكيد طلبات COD', p: 'كلما تواصلت مع العميل أسرع لتأكيد العنوان وموعد التواجد، زادت جديته في الاستلام. يولّد OrderFlow رسالة واتساب جاهزة ببيانات كل طلب بضغطة واحدة.' },
        { h: '٢. مطابقة تحصيلات بوسطة وأرامكس ومايلرز', p: 'لا تترك تحصيلاتك مبعثرة؛ راجع شاشة تحصيلات COD أسبوعيًا وطابق كل شحنة مسلّمة واسحب الرصيد مباشرة إلى حسابك على إنستاباي لإعادة تدوير رأس المال.' }
      ]
    },
    {
      id: 'egypt-vat-eta-profits',
      category: 'المالية والضرائب',
      readMin: '٥ دقائق قراءة',
      title: 'كيف تحسب ضريبة ١٤٪ على العمولات وتصدر فواتير ETA بدون أخطاء',
      summary: 'لماذا يظن كثير من التجار أنهم يربحون بينما رصيدهم البنكي يتناقص؟ دليلك المبسط لضبط الحسابات بالجنيه المصري.',
      takeaways: [
        'ضريبة القيمة المضافة ١٤٪ تُحتسب فوق عمولة المنصة نفسها (مثلًا عمولة ١٢٪ تصبح فعليًا ١٣٫٦٨٪).',
        'نقطة التعادل الحقيقية يجب أن تشمل: تكلفة البضاعة + الشحن + العمولة بضريبتها + مخصص المرتجعات.',
        'إصدار فاتورة إلكترونية مبسطة برمز QR لكل طلب يحمي متجرك عند المراجعة الضريبية.'
      ],
      sections: [
        { h: '١. معادلة الربح الصافي الحقيقية في مصر', p: 'إذا بعت منتجًا بـ ٦٥٠ ج.م وتكلفته ٣٦٠ ج.م على أمازون بعمولة ١٢٪، فالعمولة ٧٨ ج.م + ١٠٫٩ ج.م ضريبة ق.م + ٤٠ ج.م شحن + ٤٫٣ ج.م مخصص مرتجعات = صافي ربح فعلي ١٥٦٫٨ ج.م فقط.' },
        { h: '٢. أتمتة الفواتير الضريبية المبسطة', p: 'أضف رقمك الضريبي مرة واحدة في إعدادات OrderFlow ليُدرج تلقائيًا في كل فاتورة ضريبية برمز QR جاهز للطباعة أو الإرسال للعميل.' }
      ]
    }
  ];

  /**
   * 5. حساب خطوات الإعداد الذكي للمتجر (Guided Onboarding Checklist — Pure Function)
   */
  function computeOnboardingProgress(stateObj, productsList, aiCacheObj) {
    const integrations = (stateObj && stateObj.integrations) || {};
    const hasMarket = Boolean(integrations.a || integrations.n || integrations.j || integrations.t || integrations.k);
    const hasProducts = Array.isArray(productsList) && productsList.length > 0;
    const hasInstapay = Boolean(stateObj && String(stateObj.instaPayHandle || '').trim().length >= 3);
    const hasAi = Boolean(aiCacheObj && (aiCacheObj.advisor || aiCacheObj.market || aiCacheObj.listing));

    const steps = [
      {
        id: 'market',
        title: 'ربط أول سوق إلكتروني',
        desc: 'فعّل أمازون أو نون أو جوميا أو ترينديول من التكاملات',
        done: hasMarket,
        href: '#/int',
        cta: hasMarket ? 'تم الربط' : 'ربط الآن'
      },
      {
        id: 'product',
        title: 'إضافة وتوحيد منتجات الكتالوج',
        desc: 'أضف منتجك الأول بسعر البيع والتكلفة والمخزون',
        done: hasProducts,
        href: '#/prod',
        cta: hasProducts ? `${productsList.length} منتج` : 'إضافة منتج'
      },
      {
        id: 'instapay',
        title: 'ضبط عنوان InstaPay لتحصيلات COD',
        desc: 'لسحب مستحقات بوسطة وأرامكس ومايلرز لحظيًا',
        done: hasInstapay,
        href: '#/set',
        cta: hasInstapay ? 'مضبوط' : 'ضبط الحساب'
      },
      {
        id: 'ai',
        title: 'تجربة استوديو الذكاء الاصطناعي',
        desc: 'ولّد محتوى SEO وصور استوديو وفحص أسعار السوق',
        done: hasAi,
        href: '#/ai',
        cta: hasAi ? 'مُفعّل' : 'فتح الاستوديو'
      }
    ];

    const completedCount = steps.filter((s) => s.done).length;
    const totalCount = steps.length;
    const percent = Math.round((completedCount / totalCount) * 100);
    return { steps, completedCount, totalCount, percent, isComplete: completedCount === totalCount };
  }

  /**
   * 6. استوديو صور المنتجات (Canvas Studio Generator — متوافق مع شروط أمازون ونون)
   * يرسم بطاقة صورة منتج احترافية قابلة للتحميل PNG والحفظ المباشر في الكتالوج.
   */
  function renderStudioPhotoOnCanvas(canvas, opts = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const ratio = opts.ratio === '4:5' ? '4:5' : '1:1';
    const W = 800;
    const H = ratio === '4:5' ? 1000 : 800;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const preset = opts.preset || 'pure-white';
    const title = String(opts.title || 'منتج مميز عالي الجودة').trim().slice(0, 46);
    const badgeText = String(opts.badgeText || '').trim().slice(0, 24);
    const priceText = String(opts.priceText || '').trim().slice(0, 24);
    const imgEl = opts.imageElement || null;

    // 1. Background
    if (preset === 'pure-white') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, W, H);
    } else if (preset === 'studio-pearl') {
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#F8FBFF');
      grad.addColorStop(0.55, '#EDF5FC');
      grad.addColorStop(1, '#E2EFFA');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // Soft radial studio spotlight
      const rad = ctx.createRadialGradient(W * 0.5, H * 0.44, 40, W * 0.5, H * 0.44, W * 0.48);
      rad.addColorStop(0, 'rgba(255,255,255,0.95)');
      rad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rad;
      ctx.fillRect(0, 0, W, H);
    } else if (preset === 'promo-ocean') {
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#071D35');
      grad.addColorStop(0.6, '#0B3E73');
      grad.addColorStop(1, '#0EA5C6');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // Center white podium card for high contrast
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, 76, 118, W - 152, H - 270, 34);
      ctx.fill();
    }

    // 2. Soft floor shadow under product
    const prodCenterY = preset === 'promo-ocean' ? H * 0.46 : H * 0.47;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(W * 0.5, prodCenterY + 195, 190, 26, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11, 29, 51, 0.11)';
    ctx.fill();
    ctx.restore();

    // 3. Draw uploaded/selected product image OR crisp vector product pedestal
    const boxW = W * 0.62;
    const boxH = H * 0.52;
    const boxX = (W - boxW) / 2;
    const boxY = (preset === 'promo-ocean' ? 148 : 110);

    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      const scale = Math.min(boxW / imgEl.naturalWidth, boxH / imgEl.naturalHeight);
      const dw = imgEl.naturalWidth * scale;
      const dh = imgEl.naturalHeight * scale;
      const dx = (W - dw) / 2;
      const dy = boxY + (boxH - dh) / 2;
      ctx.save();
      roundRect(ctx, dx, dy, dw, dh, 22);
      ctx.clip();
      ctx.drawImage(imgEl, dx, dy, dw, dh);
      ctx.restore();
    } else {
      // Crisp geometric studio product showcase placeholder
      ctx.save();
      const boxGrad = ctx.createLinearGradient(boxX, boxY, boxX + boxW, boxY + boxH);
      boxGrad.addColorStop(0, '#0B57A4');
      boxGrad.addColorStop(1, '#0EA5C6');
      ctx.fillStyle = boxGrad;
      roundRect(ctx, W * 0.28, boxY + 40, W * 0.44, boxH - 80, 34);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      roundRect(ctx, W * 0.32, boxY + 72, W * 0.36, 48, 14);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '800 32px Cairo, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('OrderFlow Studio', W * 0.5, boxY + boxH * 0.52);
      ctx.font = '600 20px Cairo, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillText('ارفع صورة منتجك أو اختر من الكتالوج', W * 0.5, boxY + boxH * 0.52 + 42);
      ctx.restore();
    }

    // 4. Optional Arabic quality badge (top-right in RTL)
    if (badgeText && preset !== 'pure-white') {
      ctx.save();
      ctx.font = '800 24px Cairo, sans-serif';
      const tw = ctx.measureText(badgeText).width;
      const pw = Math.min(340, tw + 52);
      const ph = 54;
      const px = W - pw - 42;
      const py = 40;
      const bGrad = ctx.createLinearGradient(px, py, px + pw, py);
      bGrad.addColorStop(0, '#0B57A4');
      bGrad.addColorStop(1, '#0EA5C6');
      ctx.fillStyle = bGrad;
      roundRect(ctx, px, py, pw, ph, 14);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, px + pw / 2, py + ph / 2 + 2);
      ctx.restore();
    }

    // 5. Optional footer title & price bar (hidden on strict pure-white Amazon main image mode)
    if (preset !== 'pure-white') {
      ctx.save();
      const footerY = H - 118;
      ctx.fillStyle = preset === 'promo-ocean' ? '#FFFFFF' : '#0B1D33';
      ctx.font = '800 30px Alexandria, Cairo, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(title, W / 2, footerY);
      if (priceText) {
        ctx.fillStyle = preset === 'promo-ocean' ? '#6EE7F7' : '#0B57A4';
        ctx.font = '800 28px Alexandria, Cairo, sans-serif';
        ctx.fillText(priceText, W / 2, footerY + 46);
      }
      ctx.restore();
    }

    return canvas.toDataURL('image/jpeg', 0.86);
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function rgbToHex(r, g, b) {
    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  /**
   * 7. مدقق مطابقة صور المنتجات لمواصفات أمازون مصر ونون (Pixel-Level Compliance Auditor)
   */
  function evaluateImageCompliance({ width, height, rgbaPixels, marketplace = 'amazon', actualWidth, actualHeight } = {}) {
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const h = Math.max(0, Math.floor(Number(height) || 0));
    const trueW = Math.max(w, Math.floor(Number(actualWidth) || w));
    const trueH = Math.max(h, Math.floor(Number(actualHeight) || h));
    const mkt = String(marketplace || 'amazon').toLowerCase();
    const isNoon = mkt === 'noon' || mkt === 'n' || mkt === 'trendyol' || mkt === 't';
    const checks = [];
    let score = 0;

    // 1. Resolution check (30 pts)
    const longest = Math.max(trueW, trueH);
    const shortest = Math.min(trueW, trueH);
    let resStatus = 'fail';
    let resMsg = `الدقة الحالية ${trueW}×${trueH} أقل من الحد الأدنى المطلوب (1000px للتكبير).`;
    let resHint = isNoon ? 'ارفع صورة بدقة 1280×1600 أو استخدم الإصلاح التلقائي.' : 'ارفع صورة بدقة 1600×1600 لتفعيل ميزة التكبير (Zoom) على أمازون.';
    if (longest >= 1600 && shortest >= 1000) {
      resStatus = 'pass';
      resMsg = `دقة ممتازة (${trueW}×${trueH}) تدعم التكبير الكامل.`;
      resHint = '';
      score += 30;
    } else if (longest >= 1000 && shortest >= 660) {
      resStatus = 'warn';
      resMsg = `الدقة مقبولة (${trueW}×${trueH}) ولكن يُفضّل 1600px على الأقل للتكبير الاحترافي.`;
      resHint = 'اضغط «إصلاح تلقائي فوري» لرفع المقاس إلى 1600×1600 تلقائيًا.';
      score += 20;
    } else if (longest >= 500) {
      resStatus = 'fail';
      score += 6;
    }
    checks.push({ id: 'resolution', labelAr: 'الدقة ومقاس الصورة', status: resStatus, value: `${trueW}×${trueH}`, messageAr: resMsg, fixHintAr: resHint });

    // 2. Aspect Ratio check (20 pts)
    const ratio = trueH > 0 ? trueW / trueH : 0;
    let ratioStatus = 'fail';
    let ratioMsg = `نسبة الأبعاد (${ratio.toFixed(2)}) غير مطابقة لمتطلبات ${isNoon ? 'نون' : 'أمازون'}.`;
    let ratioHint = isNoon ? 'نون تقبل 1:1 مربع أو 4:5 عمودي (1280×1600).' : 'الصورة الرئيسية في أمازون مصر يُفضّل أن تكون مربعة 1:1.';
    if (isNoon) {
      const is1to1 = Math.abs(ratio - 1) <= 0.03;
      const is4to5 = Math.abs(ratio - 0.8) <= 0.03;
      const isNoonPortrait = Math.abs(ratio - 0.73) <= 0.03;
      if (is1to1 || is4to5 || isNoonPortrait) {
        ratioStatus = 'pass';
        ratioMsg = `نسبة الأبعاد (${is4to5 ? '4:5' : is1to1 ? '1:1' : '730:1000'}) مطابقة لشروط نون مصر.`;
        ratioHint = '';
        score += 20;
      } else if (ratio >= 0.7 && ratio <= 1.2) {
        ratioStatus = 'warn';
        score += 10;
      }
    } else if (Math.abs(ratio - 1) <= 0.02) {
      ratioStatus = 'pass';
      ratioMsg = 'نسبة الأبعاد مربعة 1:1 مطابقة تمامًا لشروط أمازون مصر.';
      ratioHint = '';
      score += 20;
    } else if (Math.abs(ratio - 1) <= 0.12) {
      ratioStatus = 'warn';
      ratioMsg = 'نسبة الأبعاد قريبة من 1:1 لكنها ليست مربعة تمامًا.';
      score += 10;
    }
    checks.push({ id: 'aspect_ratio', labelAr: 'نسبة الأبعاد (Aspect Ratio)', status: ratioStatus, value: ratio ? `${ratio.toFixed(2)}:1` : '—', messageAr: ratioMsg, fixHintAr: ratioHint });

    // 3. Outer 4% border pure white check (30 pts) & 4. Foreground fill ratio (20 pts)
    let borderHex = '#FFFFFF';
    let borderWhitePct = 0;
    let fillRatio = 0;
    const hasPixels = rgbaPixels && rgbaPixels.length >= w * h * 4 && w > 0 && h > 0;

    if (hasPixels) {
      const bx = Math.max(1, Math.floor(w * 0.04));
      const by = Math.max(1, Math.floor(h * 0.04));
      let bTotal = 0, bWhite = 0, sumR = 0, sumG = 0, sumB = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const r = rgbaPixels[idx];
          const g = rgbaPixels[idx + 1];
          const b = rgbaPixels[idx + 2];
          const a = rgbaPixels[idx + 3];
          const er = a < 255 ? Math.round((r * a + 255 * (255 - a)) / 255) : r;
          const eg = a < 255 ? Math.round((g * a + 255 * (255 - a)) / 255) : g;
          const eb = a < 255 ? Math.round((b * a + 255 * (255 - a)) / 255) : b;

          if (x < bx || x >= w - bx || y < by || y >= h - by) {
            bTotal++;
            sumR += er; sumG += eg; sumB += eb;
            if (er >= 253 && eg >= 253 && eb >= 253) bWhite++;
          }
          if (a > 20 && (er < 245 || eg < 245 || eb < 245)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (bTotal > 0) {
        borderHex = rgbToHex(sumR / bTotal, sumG / bTotal, sumB / bTotal);
        borderWhitePct = Math.round((bWhite / bTotal) * 1000) / 10;
      }

      let bgStatus = 'fail';
      let bgMsg = `الخلفية عند الحواف لونها ${borderHex} وليست بيضاء نقية #FFFFFF (${borderWhitePct}٪ فقط أبيض نقي).`;
      let bgHint = 'استخدم «إصلاح تلقائي فوري» لتفريغ الخلفية وتحويلها إلى أبيض نقي #FFFFFF.';
      if (borderWhitePct >= 95) {
        bgStatus = 'pass';
        bgMsg = `خلفية بيضاء نقية ${borderHex} (${borderWhitePct}٪) مطابقة لسياسة المنصة.`;
        bgHint = '';
        score += 30;
      } else if (borderWhitePct >= 75) {
        bgStatus = 'warn';
        bgMsg = `الخلفية شبه بيضاء (${borderHex}) وقد ترفضها مراجعة الجودة الآلية.`;
        score += 15;
      }
      checks.push({ id: 'white_background', labelAr: 'خلفية بيضاء نقية (#FFFFFF)', status: bgStatus, value: borderHex, messageAr: bgMsg, fixHintAr: bgHint });

      if (maxX >= minX && maxY >= minY) {
        const fw = maxX - minX + 1;
        const fh = maxY - minY + 1;
        fillRatio = Math.round(Math.max(fw / w, fh / h) * 1000) / 1000;
      }

      let fillStatus = 'fail';
      const fillPct = Math.round(fillRatio * 100);
      let fillMsg = fillRatio === 0
        ? 'لم يتم اكتشاف جسم المنتج بوضوح داخل الصورة.'
        : fillRatio < 0.75
          ? `المنتج يشغل ${fillPct}٪ فقط من الإطار (أصغر من المطلوب ٨٥٪).`
          : `المنتج قريب جدًا من الحواف (${fillPct}٪ من الإطار).`;
      let fillHint = 'الإصلاح التلقائي يضبط مقاس المنتج وتوسيطه تلقائيًا ليشغل ٨٥٪ من الإطار.';
      if (fillRatio >= 0.75 && fillRatio <= 0.92) {
        fillStatus = 'pass';
        fillMsg = `نسبة ملء المنتج ممتازة (${fillPct}٪ من الإطار — المعيار المثالي ٨٥٪).`;
        fillHint = '';
        score += 20;
      } else if (fillRatio >= 0.6 && fillRatio <= 0.96) {
        fillStatus = 'warn';
        score += 10;
      }
      checks.push({ id: 'fill_ratio', labelAr: 'نسبة ملء المنتج في الإطار (85%)', status: fillStatus, value: `${fillPct}٪`, messageAr: fillMsg, fixHintAr: fillHint });
    } else {
      checks.push({ id: 'white_background', labelAr: 'خلفية بيضاء نقية (#FFFFFF)', status: 'warn', value: '—', messageAr: 'ارفع صورة لفحص لون الخلفية بدقة البكسل.', fixHintAr: '' });
      checks.push({ id: 'fill_ratio', labelAr: 'نسبة ملء المنتج في الإطار (85%)', status: 'warn', value: '—', messageAr: 'ارفع صورة لقياس نسبة ملء المنتج.', fixHintAr: '' });
    }

    return {
      marketplace: isNoon ? 'noon' : 'amazon',
      score: Math.min(100, Math.round(score)),
      passed: score >= 85 && checks.every((c) => c.status !== 'fail'),
      borderHex,
      borderWhitePct,
      fillRatio,
      width: trueW,
      height: trueH,
      checks
    };
  }

  function auditImageElement(sourceImgOrCanvas, marketplace = 'amazon') {
    if (!sourceImgOrCanvas || typeof document === 'undefined') return null;
    const trueW = sourceImgOrCanvas.naturalWidth || sourceImgOrCanvas.width || 0;
    const trueH = sourceImgOrCanvas.naturalHeight || sourceImgOrCanvas.height || 0;
    if (!trueW || !trueH) return null;
    const maxSample = 240;
    const scale = Math.min(1, maxSample / Math.max(trueW, trueH));
    const sw = Math.max(16, Math.round(trueW * scale));
    const sh = Math.max(16, Math.round(trueH * scale));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(sourceImgOrCanvas, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    return evaluateImageCompliance({ width: sw, height: sh, actualWidth: trueW, actualHeight: trueH, rgbaPixels: data, marketplace });
  }

  /**
   * 8. الإصلاح التلقائي الفوري بضغطة زر لشروط أمازون ونون (Flood-Fill + Auto-Scale 85% + 1600x1600)
   */
  function autoFixMarketplaceImage(sourceImgOrCanvas, opts = {}) {
    if (!sourceImgOrCanvas || typeof document === 'undefined') return null;
    const targetMarketplace = opts.targetMarketplace === 'noon' ? 'noon' : 'amazon';
    const fillTarget = Math.min(0.9, Math.max(0.76, Number(opts.fillTarget) || 0.85));
    const removeNearWhiteBg = opts.removeNearWhiteBg !== false;
    const addSoftShadow = Boolean(opts.addSoftShadow);

    const srcW = sourceImgOrCanvas.naturalWidth || sourceImgOrCanvas.width || 800;
    const srcH = sourceImgOrCanvas.naturalHeight || sourceImgOrCanvas.height || 800;

    // 1. Work canvas (capped at 1200px max for instant flood-fill)
    const workScale = Math.min(1, 1200 / Math.max(srcW, srcH));
    const ww = Math.max(32, Math.round(srcW * workScale));
    const wh = Math.max(32, Math.round(srcH * workScale));
    const workCanvas = document.createElement('canvas');
    workCanvas.width = ww;
    workCanvas.height = wh;
    const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    wCtx.drawImage(sourceImgOrCanvas, 0, 0, ww, wh);
    const imgData = wCtx.getImageData(0, 0, ww, wh);
    const px = imgData.data;

    // 2. Sample 4-corner border average background color
    const samplePts = [
      [0, 0], [ww - 1, 0], [0, wh - 1], [ww - 1, wh - 1],
      [Math.floor(ww / 2), 0], [Math.floor(ww / 2), wh - 1],
      [0, Math.floor(wh / 2)], [ww - 1, Math.floor(wh / 2)]
    ];
    let bgR = 0, bgG = 0, bgB = 0, bgCnt = 0;
    for (const [sx, sy] of samplePts) {
      const i = (sy * ww + sx) * 4;
      if (px[i + 3] > 20) {
        bgR += px[i]; bgG += px[i + 1]; bgB += px[i + 2]; bgCnt++;
      }
    }
    if (bgCnt > 0) {
      bgR /= bgCnt; bgG /= bgCnt; bgB /= bgCnt;
    } else {
      bgR = 255; bgG = 255; bgB = 255;
    }

    // 3. Edge-seeded BFS flood-fill (removes connected near-white/uniform studio bg while preserving interior whites)
    if (removeNearWhiteBg) {
      const visited = new Uint8Array(ww * wh);
      const isBg = new Uint8Array(ww * wh);
      const queue = new Int32Array(ww * wh);
      let head = 0, tail = 0;
      const colorDistSq = (idx) => {
        const dr = px[idx] - bgR;
        const dg = px[idx + 1] - bgG;
        const db = px[idx + 2] - bgB;
        return dr * dr + dg * dg + db * db;
      };
      const isNearWhiteNeutral = (idx) => {
        const r = px[idx], g = px[idx + 1], b = px[idx + 2];
        const minC = Math.min(r, g, b);
        const maxC = Math.max(r, g, b);
        return minC >= 205 && (maxC - minC) <= 28;
      };
      const tolSq = 46 * 46;
      const trySeed = (x, y) => {
        const p = y * ww + x;
        if (visited[p]) return;
        const idx = p * 4;
        if (px[idx + 3] <= 20 || colorDistSq(idx) <= tolSq || isNearWhiteNeutral(idx)) {
          visited[p] = 1;
          isBg[p] = 1;
          queue[tail++] = p;
        }
      };

      for (let x = 0; x < ww; x++) { trySeed(x, 0); trySeed(x, wh - 1); }
      for (let y = 0; y < wh; y++) { trySeed(0, y); trySeed(ww - 1, y); }

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % ww;
        const cy = (cur - cx) / ww;
        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx < ww - 1 ? cur + 1 : -1,
          cy > 0 ? cur - ww : -1,
          cy < wh - 1 ? cur + ww : -1
        ];
        for (let k = 0; k < 4; k++) {
          const np = neighbors[k];
          if (np < 0 || visited[np]) continue;
          const nIdx = np * 4;
          if (px[nIdx + 3] <= 20 || colorDistSq(nIdx) <= tolSq || isNearWhiteNeutral(nIdx)) {
            visited[np] = 1;
            isBg[np] = 1;
            queue[tail++] = np;
          }
        }
      }

      // Apply transparency + 1px soft edge feathering
      for (let p = 0; p < ww * wh; p++) {
        if (isBg[p]) {
          px[p * 4 + 3] = 0;
        } else {
          const x = p % ww;
          const y = (p - x) / ww;
          let bgAdj = 0;
          if (x > 0 && isBg[p - 1]) bgAdj++;
          if (x < ww - 1 && isBg[p + 1]) bgAdj++;
          if (y > 0 && isBg[p - ww]) bgAdj++;
          if (y < wh - 1 && isBg[p + ww]) bgAdj++;
          if (bgAdj > 0) {
            const idx = p * 4;
            const d = Math.sqrt(colorDistSq(idx));
            if (d < 72) {
              px[idx + 3] = Math.round(px[idx + 3] * Math.min(1, Math.max(0.25, (d - 28) / 44)));
            }
          }
        }
      }
      wCtx.putImageData(imgData, 0, 0);
    }

    // 4. Compute tight foreground bounding box
    let minX = ww, minY = wh, maxX = -1, maxY = -1;
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const idx = (y * ww + x) * 4;
        const a = px[idx + 3];
        if (a > 24 && (px[idx] < 248 || px[idx + 1] < 248 || px[idx + 2] < 248)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) {
      minX = 0; minY = 0; maxX = ww - 1; maxY = wh - 1;
    }
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    // 5. Render onto crisp high-resolution marketplace canvas
    const targetW = targetMarketplace === 'noon' ? 1280 : 1600;
    const targetH = 1600;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetW;
    outCanvas.height = targetH;
    const oCtx = outCanvas.getContext('2d');
    oCtx.fillStyle = '#FFFFFF';
    oCtx.fillRect(0, 0, targetW, targetH);

    // Scale so longest relative axis occupies exactly fillTarget (85%) without clipping either axis
    const maxDrawW = targetW * fillTarget;
    const maxDrawH = targetH * fillTarget;
    const drawScale = Math.min(maxDrawW / cropW, maxDrawH / cropH);
    const dw = Math.round(cropW * drawScale);
    const dh = Math.round(cropH * drawScale);
    const dx = Math.round((targetW - dw) / 2);
    const dy = Math.round((targetH - dh) / 2);

    if (addSoftShadow) {
      oCtx.save();
      const sy = Math.min(targetH * 0.93, dy + dh - 8);
      const radGrad = oCtx.createRadialGradient(targetW / 2, sy, 10, targetW / 2, sy, dw * 0.42);
      radGrad.addColorStop(0, 'rgba(15, 23, 42, 0.14)');
      radGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
      oCtx.fillStyle = radGrad;
      oCtx.beginPath();
      oCtx.ellipse(targetW / 2, sy, dw * 0.44, Math.max(18, Math.round(targetH * 0.022)), 0, 0, Math.PI * 2);
      oCtx.fill();
      oCtx.restore();
    }

    oCtx.imageSmoothingEnabled = true;
    oCtx.imageSmoothingQuality = 'high';
    oCtx.drawImage(workCanvas, minX, minY, cropW, cropH, dx, dy, dw, dh);

    const pngDataUrl = outCanvas.toDataURL('image/png');
    const amazonCompliance = auditImageElement(outCanvas, 'amazon');
    const noonCompliance = auditImageElement(outCanvas, 'noon');
    const compliance = targetMarketplace === 'noon' ? noonCompliance : amazonCompliance;

    return {
      canvas: outCanvas,
      dataUrl: pngDataUrl,
      width: targetW,
      height: targetH,
      compliance,
      amazonCompliance,
      noonCompliance
    };
  }

  return {
    PLATFORM_LOGO_ASSETS,
    PLATFORM_LOGOS: PLATFORM_LOGO_ASSETS,
    renderPlatformLogo,
    PARTNER_CERTIFICATIONS,
    SOLUTIONS_TABS,
    EXPERT_SERVICES_UI,
    SELLER_GUIDES,
    computeOnboardingProgress,
    renderStudioPhotoOnCanvas,
    evaluateImageCompliance,
    auditImageElement,
    autoFixMarketplaceImage
  };
});
