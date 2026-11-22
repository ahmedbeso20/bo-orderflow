import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';

export const metadata: Metadata = {
  title: 'OrderFlow — إدارة متاجر أمازون ونون وجوميا',
  description: 'لوحة تحكم موحّدة لإدارة متاجرك على أمازون مصر ونون وجوميا وترينديول وكنز بالجنيه المصري — مخزون موحّد، أرباح حقيقية، تحصيلات COD وفواتير وذكاء اصطناعي.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' }
};

export const viewport: Viewport = {
  themeColor: '#0C5CA4',
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Alexandria:wght@600;700;800&family=Cairo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
