// Service worker.
//
// ── What this deliberately does NOT do ──────────────────────────────────────
// It does not cache pages, API responses, or anything else carrying a number.
//
// That is the whole design. The standard PWA recipe is stale-while-revalidate
// on navigations, which for a finance app means opening it on the bus and being
// shown last Tuesday's balance with no indication that it is old. A wrong
// balance presented confidently is worse than a page that says it cannot reach
// the network — the first is a lie the person will act on.
//
// So the cache holds exactly two kinds of thing:
//   1. Build assets, which Next.js already fingerprints by content hash and
//      which therefore cannot go stale.
//   2. One offline page, whose entire job is to say "you are offline".
//
// What the worker is actually here for is push: a briefing that arrives on a
// phone without the app being open.

const VERSION = 'tally-v1';
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = '/offline';

// Fingerprinted, immutable, safe to keep. Anything else is not.
const CACHEABLE = /^\/(_next\/static|icons)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([OFFLINE_URL, '/icons/icon-192.png']))
      // A failed precache must not leave a broken worker installed forever.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Build assets: cache-first, because their URL changes when they change.
  if (CACHEABLE.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Navigations: network only. If the network is gone, say so — never serve a
  // remembered page that would show remembered money.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((page) => page || Response.error())),
    );
  }

  // Everything else (API calls, Server Action posts) falls through to the
  // network untouched. No handler is the correct handler.
});

// ── Push ────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Tally';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Same tag replaces rather than stacks: two unread briefings should be
      // one notification, not a pile of them.
      tag: payload.tag || 'tally',
      data: { url: payload.url || '/' },
      requireInteraction: false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus a tab that is already open rather than piling up new ones.
      for (const client of clients) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      for (const client of clients) {
        if ('navigate' in client && 'focus' in client) {
          return client.navigate(target).then((c) => c && c.focus());
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
