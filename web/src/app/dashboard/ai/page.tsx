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
        const res = await api.post<{ title?: string; description?: string; bullets?: string[] }>('/api/ai/listing', {
          name: productName.trim(),
          market: 'amazon'
        });
        setOutput([res.title, '', res.description, '', ...(res.bullets || []).map((b) => `• ${b}`)].filter(Boolean).join('\n'));
      } else if (tab === 'advisor') {
        const res = await api.post<{ summary?: string; actions?: string[] }>('/api/ai/advisor', {});
        setOutput([res.summary, '', ...(res.actions || []).map((a) => `• ${a}`)].filter(Boolean).join('\n'));
      } else if (tab === 'pricing') {
        const res = await api.post<{ summary?: string; recommendations?: Array<{ name: string; suggestedPrice: number; reason: string }> }>('/api/ai/pricing', {});
        const lines = (res.recommendations || []).map((r) => `• ${r.name}: سعر مقترح ${r.suggestedPrice} ج.م — ${r.reason}`);
        setOutput([res.summary, '', ...lines].filter(Boolean).join('\n'));
      } else {
        const res = await api.post<{ reply?: string }>('/api/ai/chat', { message: prompt.trim() });
        setOutput(res.reply || '');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تشغيل الأداة');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="استوديو الذكاء الاصطناعي" subtitle="توليد وصف A+، مستشار النمو، رادار التسعير، ومحادثة البائع" user={boot?.me}>
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
        {tab === 'listing' && (
          <div className="space-y-1">
            <label className="text-xs font-bold block">اسم المنتج لتوليد وصف A+ وكلمات SEO</label>
            <input
              className="of-input"
              placeholder="مثال: سماعة بلوتوث لاسلكية بعزل ضوضاء"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              required
            />
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
