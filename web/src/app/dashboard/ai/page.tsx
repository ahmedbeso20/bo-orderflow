'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';
import { fmtEGP } from '@/lib/format';

type AiTab = 'listing' | 'advisor' | 'pricing' | 'chat';

interface ListingResult {
  amazonTitle?: string;
  noonTitle?: string;
  jumiaTitle?: string;
  descriptionIntro?: string;
  bulletPoints?: string[];
  keywords?: string | string[];
  pricingTip?: string;
  aplusHighlights?: Array<{ title: string; body: string }>;
}

interface AdvisorResult {
  headline?: string;
  urgentRestockTip?: string;
  profitOptimizationTip?: string;
  cashflowAndCodTip?: string;
  strategicPlan?: string;
}

interface PriceRadarResult {
  name?: string;
  minPrice?: number;
  avgPrice?: number;
  maxPrice?: number;
  recommended?: number;
  platforms?: Array<{ market: string; price: number; badge?: string }>;
  text?: string;
  sources?: Array<{ uri: string; title: string }>;
}

export default function AiStudioPage() {
  const { data: boot } = useBootstrap();
  const [tab, setTab] = useState<AiTab>('listing');
  const [productName, setProductName] = useState('');
  const [features, setFeatures] = useState('');
  const [thinking, setThinking] = useState(false);
  const [prompt, setPrompt] = useState('');

  const [listingRes, setListingRes] = useState<ListingResult | null>(null);
  const [advisorRes, setAdvisorRes] = useState<AdvisorResult | null>(null);
  const [pricingRes, setPricingRes] = useState<PriceRadarResult | null>(null);
  const [chatAnswer, setChatAnswer] = useState('');
  const [sourceTag, setSourceTag] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function clearOutputs() {
    setListingRes(null);
    setAdvisorRes(null);
    setPricingRes(null);
    setChatAnswer('');
    setSourceTag('');
    setError('');
  }

  async function runTool(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    clearOutputs();
    try {
      if (tab === 'listing') {
        const res = await api.post<{ source?: string; data?: ListingResult }>('/api/ai/listing', {
          name: productName.trim(),
          features: features.trim()
        });
        setListingRes(res.data || {});
        setSourceTag(res.source || '');
      } else if (tab === 'advisor') {
        const res = await api.post<{ advisor?: { source?: string; data?: AdvisorResult } }>('/api/ai/advisor', {
          thinking
        });
        setAdvisorRes(res.advisor?.data || {});
        setSourceTag(res.advisor?.source || '');
      } else if (tab === 'pricing') {
        const res = await api.post<{ market?: PriceRadarResult & { source?: string } }>('/api/ai/price-radar', {
          name: productName.trim()
        });
        setPricingRes(res.market || {});
        setSourceTag(res.market?.source || '');
      } else {
        const res = await api.post<{ source?: string; answer?: string }>('/api/ai/chat', { question: prompt.trim() });
        setChatAnswer(res.answer || '');
        setSourceTag(res.source || '');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تشغيل الأداة');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="استوديو الذكاء الاصطناعي" subtitle="توليد وصف A+، مستشار النمو، رادار التسعير، ومساعد البائع" user={boot?.me}>
      <div className="flex flex-wrap gap-2 mb-6">
        {[
          ['listing', '✍️ كاتب وصف A+'],
          ['advisor', '🧭 مستشار النمو'],
          ['pricing', '🎯 رادار التسعير'],
          ['chat', '💬 مساعد البائع']
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setTab(k as AiTab); clearOutputs(); }}
            className={`rounded-xl px-4 py-2 text-xs font-bold ${
              tab === k ? 'bg-[#0C5CA4] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={runTool} className="of-card p-6 space-y-4 mb-6">
        {(tab === 'listing' || tab === 'pricing') && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-bold block">
                {tab === 'listing' ? 'اسم المنتج لتوليد وصف A+ وكلمات SEO' : 'اسم المنتج لفحص أسعاره في السوق المصري'}
              </label>
              <input
                className="of-input"
                placeholder="مثال: سماعة بلوتوث لاسلكية بعزل ضوضاء"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                required
              />
            </div>
            {tab === 'listing' && (
              <div className="space-y-1">
                <label className="text-xs font-bold block">أبرز المميزات (اختياري)</label>
                <input
                  className="of-input"
                  placeholder="مثال: بطارية 30 ساعة، شحن سريع Type-C، ضمان سنة"
                  value={features}
                  onChange={(e) => setFeatures(e.target.value)}
                />
              </div>
            )}
          </div>
        )}
        {tab === 'advisor' && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--muted)]">
              يحلل المستشار كتالوج منتجاتك، المخزون المنخفض، هامش الربح، ومستحقات COD الجاهزة للسحب لتقديم توصيات فورية.
            </p>
            <label className="inline-flex items-center gap-2 text-xs font-bold cursor-pointer">
              <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
              <span>تفعيل وضع التحليل الاستراتيجي العميق (High Thinking)</span>
            </label>
          </div>
        )}
        {tab === 'chat' && (
          <div className="space-y-1">
            <label className="text-xs font-bold block">سؤالك حول مبيعاتك أو مخزونك</label>
            <textarea
              rows={3}
              className="of-input"
              placeholder="مثال: كيف أقلل نسبة مرتجعات COD في المحافظات؟"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </div>
        )}
        {error && <p className="text-xs font-bold text-[var(--danger)]">{error}</p>}
        <button type="submit" disabled={loading} className="rounded-xl bg-[#0C5CA4] px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60">
          {loading ? 'جارٍ التحليل...' : 'تشغيل الأداة الآن'}
        </button>
      </form>

      {listingRes && (
        <section className="of-card p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">محتوى A+ وعناوين المنصات</h2>
            {sourceTag && <span className="text-[11px] font-mono-num text-[var(--muted)]">{sourceTag}</span>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {listingRes.amazonTitle && (
              <div className="rounded-xl border border-[var(--border)] p-4 space-y-1">
                <div className="text-xs font-bold text-[var(--primary)]">عنوان أمازون مصر (A9)</div>
                <p className="text-sm font-bold">{listingRes.amazonTitle}</p>
              </div>
            )}
            {listingRes.noonTitle && (
              <div className="rounded-xl border border-[var(--border)] p-4 space-y-1">
                <div className="text-xs font-bold text-amber-600">عنوان نون مصر</div>
                <p className="text-sm font-bold">{listingRes.noonTitle}</p>
              </div>
            )}
            {listingRes.jumiaTitle && (
              <div className="rounded-xl border border-[var(--border)] p-4 space-y-1">
                <div className="text-xs font-bold text-emerald-700">عنوان جوميا مصر</div>
                <p className="text-sm font-bold">{listingRes.jumiaTitle}</p>
              </div>
            )}
          </div>
          {listingRes.descriptionIntro && (
            <div className="space-y-1">
              <strong className="text-xs text-[var(--muted)]">الوصف الافتتاحي</strong>
              <p className="text-sm leading-relaxed">{listingRes.descriptionIntro}</p>
            </div>
          )}
          {listingRes.bulletPoints && listingRes.bulletPoints.length > 0 && (
            <div className="space-y-1.5">
              <strong className="text-xs text-[var(--muted)]">النقاط البيعية (Bullet Points)</strong>
              <ul className="list-disc pr-5 space-y-1 text-sm">
                {listingRes.bulletPoints.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
          {listingRes.aplusHighlights && listingRes.aplusHighlights.length > 0 && (
            <div className="space-y-2">
              <strong className="text-xs text-[var(--muted)]">بطاقات محتوى A+</strong>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {listingRes.aplusHighlights.map((h, i) => (
                  <div key={i} className="rounded-xl bg-[var(--surface-alt)] p-4 space-y-1">
                    <div className="font-extrabold text-sm">{h.title}</div>
                    <p className="text-xs text-[var(--muted)] leading-relaxed">{h.body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {listingRes.keywords && (
            <div className="rounded-xl border border-[var(--border)] p-3 text-xs">
              <strong>الكلمات المفتاحية (SEO): </strong>
              <span>{Array.isArray(listingRes.keywords) ? listingRes.keywords.join('، ') : listingRes.keywords}</span>
            </div>
          )}
          {listingRes.pricingTip && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs font-bold text-emerald-800 dark:text-emerald-200">
              💡 نصيحة التسعير: {listingRes.pricingTip}
            </div>
          )}
        </section>
      )}

      {advisorRes && (
        <section className="of-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">{advisorRes.headline || 'تقرير مستشار النمو'}</h2>
            {sourceTag && <span className="text-[11px] font-mono-num text-[var(--muted)]">{sourceTag}</span>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {advisorRes.urgentRestockTip && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-1.5">
                <div className="text-xs font-extrabold text-amber-800 dark:text-amber-300">📦 توصية إعادة التوريد العاجلة</div>
                <p className="text-sm leading-relaxed">{advisorRes.urgentRestockTip}</p>
              </div>
            )}
            {advisorRes.profitOptimizationTip && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-1.5">
                <div className="text-xs font-extrabold text-emerald-800 dark:text-emerald-300">📈 تعظيم هامش الربح</div>
                <p className="text-sm leading-relaxed">{advisorRes.profitOptimizationTip}</p>
              </div>
            )}
            {advisorRes.cashflowAndCodTip && (
              <div className="rounded-xl border border-[#0C5CA4]/40 bg-[#0C5CA4]/5 p-4 space-y-1.5">
                <div className="text-xs font-extrabold text-[var(--primary)]">💰 التدفق النقدي وCOD</div>
                <p className="text-sm leading-relaxed">{advisorRes.cashflowAndCodTip}</p>
              </div>
            )}
          </div>
          {advisorRes.strategicPlan && (
            <div className="rounded-xl bg-[var(--surface-alt)] p-4 space-y-1.5">
              <strong className="text-xs">الخطة التنفيذية الاستراتيجية</strong>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{advisorRes.strategicPlan}</pre>
            </div>
          )}
        </section>
      )}

      {pricingRes && (
        <section className="of-card p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-base">رادار التسعير: {pricingRes.name}</h2>
            {sourceTag && <span className="text-[11px] font-mono-num text-[var(--muted)]">{sourceTag}</span>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[var(--surface-alt)] p-4">
              <div className="text-xs text-[var(--muted)]">أقل سعر</div>
              <div className="text-lg font-extrabold font-mono-num">{fmtEGP(pricingRes.minPrice)}</div>
            </div>
            <div className="rounded-xl bg-[var(--surface-alt)] p-4">
              <div className="text-xs text-[var(--muted)]">متوسط السوق</div>
              <div className="text-lg font-extrabold font-mono-num">{fmtEGP(pricingRes.avgPrice)}</div>
            </div>
            <div className="rounded-xl bg-[var(--surface-alt)] p-4">
              <div className="text-xs text-[var(--muted)]">أعلى سعر</div>
              <div className="text-lg font-extrabold font-mono-num">{fmtEGP(pricingRes.maxPrice)}</div>
            </div>
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-4 border border-emerald-500/40">
              <div className="text-xs font-bold text-emerald-700 dark:text-emerald-300">السعر الموصى به</div>
              <div className="text-lg font-extrabold font-mono-num text-emerald-700 dark:text-emerald-300">{fmtEGP(pricingRes.recommended)}</div>
            </div>
          </div>
          {pricingRes.platforms && pricingRes.platforms.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {pricingRes.platforms.map((pl, idx) => (
                <div key={idx} className="rounded-xl border border-[var(--border)] p-3.5 space-y-1">
                  <div className="font-bold text-xs">{pl.market}</div>
                  <div className="font-mono-num font-extrabold text-base">{fmtEGP(pl.price)}</div>
                  {pl.badge && <div className="text-[11px] text-[var(--muted)]">{pl.badge}</div>}
                </div>
              ))}
            </div>
          )}
          {pricingRes.text && <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{pricingRes.text}</pre>}
          {pricingRes.sources && pricingRes.sources.length > 0 && (
            <div className="pt-2 border-t border-[var(--border)] space-y-1 text-xs">
              <strong>مصادر البحث:</strong>
              <ul className="list-disc pr-5 space-y-1">
                {pricingRes.sources.map((s, i) => (
                  <li key={i}>
                    <a href={s.uri} target="_blank" rel="noreferrer" className="text-[var(--primary)] underline">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {chatAnswer && (
        <section className="of-card p-6 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold text-sm">رد مساعد البائع</h2>
            {sourceTag && <span className="text-[11px] font-mono-num text-[var(--muted)]">{sourceTag}</span>}
          </div>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{chatAnswer}</pre>
        </section>
      )}
    </AppShell>
  );
}
