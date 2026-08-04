import type { MetadataRoute } from 'next';

// The web app manifest — what turns a tab into something on a home screen.
//
// `display: standalone` is the point: no address bar, no browser chrome, opened
// from the launcher like anything else on the phone. For a market where the
// mobile app is the eventual product, this is the version that ships first and
// costs nothing.
//
// The maskable icons are not optional. Android crops every launcher icon to
// whatever shape the device uses; an icon without a `maskable` variant gets a
// white box drawn behind it and looks like a bookmark rather than an app.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Tally — personal finance',
    short_name: 'Tally',
    description:
      'Track what you spend, understand where it goes and get told what changed before you ask.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Matches --color-canvas, so the splash screen does not flash white.
    background_color: '#f4f5f7',
    theme_color: '#1f8a6d',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press the icon to jump straight to the two things people open the
    // app to do.
    shortcuts: [
      { name: 'Add an entry', short_name: 'Add', url: '/?add=1' },
      { name: 'Ask the assistant', short_name: 'Ask', url: '/chat' },
    ],
  };
}
