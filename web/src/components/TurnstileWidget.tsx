'use client';

import React, { useEffect, useRef } from 'react';
import { useTheme } from '@/components/ThemeProvider';

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: 'light' | 'dark' | 'auto';
      language?: string;
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface TurnstileWidgetProps {
  siteKey?: string;
  onToken: (token: string) => void;
}

const SCRIPT_ID = 'cf-turnstile-script';

export function TurnstileWidget({ siteKey, onToken }: TurnstileWidgetProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbackRef = useRef(onToken);
  callbackRef.current = onToken;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;

    const mount = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: theme === 'dark' ? 'dark' : 'light',
        language: 'ar',
        callback: (token) => callbackRef.current(token),
        'expired-callback': () => callbackRef.current(''),
        'error-callback': () => callbackRef.current('')
      });
    };

    if (window.turnstile) {
      mount();
    } else {
      let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', mount);
      return () => {
        cancelled = true;
        script?.removeEventListener('load', mount);
      };
    }

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, theme]);

  if (!siteKey) return null;

  return (
    <div className="flex justify-center py-1" dir="ltr">
      <div ref={containerRef} />
    </div>
  );
}
