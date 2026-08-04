import type { Metadata, Viewport } from 'next';
import './globals.css';
import SiteNav from '@/components/SiteNav';

export const metadata: Metadata = {
  title: 'Tally — personal finance agent',
  description:
    'A conversational finance assistant: log spending by text or voice, and get answers from your own ledger.',
  // Installable: app/manifest.ts describes it, these two make iOS treat it as
  // an app rather than a bookmark (Safari still ignores most of the manifest).
  appleWebApp: { capable: true, title: 'Tally', statusBarStyle: 'default' },
  icons: { apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  // The brand green, not the canvas: this paints the Android status bar and
  // the iOS notch area once the app is installed.
  themeColor: '#1f8a6d',
  width: 'device-width',
  initialScale: 1,
  // Standalone apps should not rubber-band like a web page, but pinch-zoom
  // stays available — disabling it locks out anyone who needs to enlarge text.
  viewportFit: 'cover',
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
