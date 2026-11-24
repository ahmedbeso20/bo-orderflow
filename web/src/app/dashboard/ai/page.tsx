'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { api, ApiError } from '@/lib/api';
import { useBootstrap } from '@/lib/useBootstrap';

type AiTab = 'listing' | 'advisor' | 'pricing' | 'chat';

export default function AiStudioPage() {
  const { data: boot } = useBootstrap();
  const [tab, setTab] = useState<AiTab>('listing');
  const [productName, setProductName] = useState('');
  const [features, setFeatures] = useState('');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runTool(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setOutput('');
    try {
      if (tab === 'listing') {
        const res = await api.post<{
          data?: { title?: string; desc?: string; description?: string; bullets?: string[]; keywords?: string[] };
        }>('/api/ai/listing', {
          name: productName.trim(),
          features: features.trim()
        });
        const d = res.data || {};
        const lines = [
          d.title ? `العنوان المقترح: ${d.title}` : '',
          d.desc || d.description || '',
          ...(d.bullets || []).map((b) => `• ${b}`),
          d.keywords && d.keywords.length > 0 ? `\nالكلمات المفتاحية: ${d.keywords.join(' ، ')}` : ''
        ];
        setOutput(lines.filter(Boolean).join('\n'));
      } else if (tab === 'advisor') {
        const res = await api.post<{
          advisor?: {
            data?: {
              summary?: string;
              headline?: string;
              tips?: Array<string | { title?: string; detail?: string; text?: string }>;
              actions?: string[];
            };
          };
        }>('/api/ai/advisor', {});
        const d = res.advisor?.data || {};
        const tips = (d.tips || []).map((t) =>
          typeof t === 'string' ? `• ${t}` : `• ${t.title ? `${t.title}: ` : ''}${t.detail || t.text || ''}`
        );
        const acts = (d.actions || []).map((a) => `✓ ${a}`);
        setOutput([d.headline, d.summary, '', ...tips, ...acts].filter(Boolean).join('\n'));
      } else if (tab === 'pricing') {
        const res = await api.post<{
          market?: {
            name?: string;
            text?: string;
            minPrice?: number;
            avgPrice?: number;
            maxPrice?: number;
            recommendedPrice?: number;
            advice?: string;
          };
        }>('/api/ai/price-radar', { name: productName.trim() });
        const m = res.market || {};
        const lines = [
          m.name ? `تحليل أسعار السوق المصري لـ: ${m.name}` : '',
          m.minPrice && m.maxPrice ? `النطاق السعري: ${m.minPrice} - ${m.maxPrice} ج.م (المتوسط: ${m.avgPrice || '—'} ج.م)` : '',
          m.recommendedPrice ? `السعر التنافسي المقترح: ${m.recommendedPrice} ج.م` : '',
          m.advice || '',
          m.text || ''
        ];
        setOutput(lines.filter(Boolean).join('\n'));
      } else {
        const res = await api.post<{ answer?: string }>('/api/ai/chat', { question: prompt.trim() });
        setOutput(res.answer || '');
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
            onClick={() => { setTab(k as AiTab); setOutput(''); setError(''); }}
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

      {output && (
        <section className="of-card p-6">
          <h2 className="font-extrabold text-sm mb-3">النتيجة</h2>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{output}</pre>
        </section>
      )}
    </AppShell>
  );
}
