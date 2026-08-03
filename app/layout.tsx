import type { Metadata, Viewport } from 'next';
import './globals.css';
import SiteNav from '@/components/SiteNav';

export const metadata: Metadata = {
  title: 'Tally — personal finance agent',
  description:
    'A conversational finance assistant: log spending by text or voice, and get answers from your own ledger.',
};

export const viewport: Viewport = {
  themeColor: '#f2f4f7',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* The shell owns the viewport height and the nav; each page decides how
          its own body scrolls, because the chat pins to the bottom and the
          dashboard scrolls from the top. */}
      <body className="flex h-dvh flex-col overflow-hidden bg-canvas antialiased">
        <SiteNav />
        <div className="min-h-0 flex-1">{children}</div>
      </body>
    </html>
  );
}
