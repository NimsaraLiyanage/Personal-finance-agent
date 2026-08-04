'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';

import {
  getPushConfig,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
} from '@/app/actions/push';

// Registers the service worker and offers to turn notifications on.
//
// Deliberately NOT a prompt on load. A permission dialog someone did not ask
// for is the fastest way to get "Block" clicked forever, and browsers now
// penalise sites that do it. The browser only sees `requestPermission` after a
// deliberate click on a control that says what it is for.
//
// It renders nothing at all when push is unconfigured, unsupported, or already
// denied — an offer that cannot be accepted is just clutter.

type State = 'loading' | 'unavailable' | 'off' | 'on' | 'denied';

export default function NotificationToggle() {
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const register = useCallback(async () => {
    if (!('serviceWorker' in navigator)) return null;
    try {
      return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (err) {
      console.error('[pwa] service worker registration failed', err);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // The worker is registered even when push is off — it is also what
      // serves the offline page.
      const registration = await register();

      const supported =
        typeof window !== 'undefined' &&
        'Notification' in window &&
        'PushManager' in window &&
        Boolean(registration);

      if (!supported) {
        if (!cancelled) setState('unavailable');
        return;
      }

      const existing = await registration!.pushManager.getSubscription();
      const config = await getPushConfig(existing?.endpoint);

      if (cancelled) return;
      if (!config.enabled) setState('unavailable');
      else if (Notification.permission === 'denied') setState('denied');
      else if (existing && config.subscribed) setState('on');
      else setState('off');
    })();

    return () => {
      cancelled = true;
    };
  }, [register]);

  const enable = () => {
    setMessage(null);
    startTransition(async () => {
      const registration = await navigator.serviceWorker.ready;
      const config = await getPushConfig();
      if (!config.publicKey) {
        setMessage('Push is not configured on this server.');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }

      try {
        const subscription = await registration.pushManager.subscribe({
          // Required by every browser now: a push that cannot show a
          // notification is not allowed to wake the worker.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        });

        const saved = await savePushSubscription(
          JSON.parse(JSON.stringify(subscription)),
          navigator.userAgent,
        );
        if (!saved.ok) {
          setMessage(saved.error ?? 'Could not save this device.');
          return;
        }

        setState('on');
        // Prove it works immediately. "We'll notify you next week" is not
        // something anyone should have to take on trust.
        const test = await sendTestPush();
        if (!test.ok) setMessage(test.error ?? null);
      } catch (err) {
        console.error('[pwa] subscribe failed', err);
        setMessage('Could not turn on notifications on this device.');
      }
    });
  };

  const disable = () => {
    setMessage(null);
    startTransition(async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await removePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState('off');
    });
  };

  if (state === 'loading' || state === 'unavailable') return null;

  return (
    <section className="card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        Weekly briefing
      </h2>

      {state === 'denied' ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          Notifications are blocked for this site. Turn them back on in your browser&rsquo;s site
          settings if you want the briefing to reach you.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {state === 'on'
              ? 'This device will get a nudge when a new briefing is written. The numbers stay in the app.'
              : 'Get a nudge on this device when there is something worth knowing — once a week, not every purchase.'}
          </p>

          <button
            type="button"
            onClick={state === 'on' ? disable : enable}
            disabled={pending}
            className={`mt-3 rounded-xl px-3.5 py-2 text-sm font-medium transition-all disabled:opacity-50 ${
              state === 'on'
                ? 'border border-line text-ink-dim hover:border-line-strong hover:text-ink'
                : 'bg-accent text-white hover:brightness-110'
            }`}
          >
            {pending ? 'Just a moment…' : state === 'on' ? 'Turn off' : 'Turn on notifications'}
          </button>
        </>
      )}

      {message && (
        <p role="status" className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          {message}
        </p>
      )}
    </section>
  );
}

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants raw bytes.
 * Browsers have never accepted the string form, so this conversion is not
 * optional even though every tutorial makes it look like boilerplate.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  // Backed by a plain ArrayBuffer, which is what `applicationServerKey` wants —
  // a generic Uint8Array could be over a SharedArrayBuffer and is rejected.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
