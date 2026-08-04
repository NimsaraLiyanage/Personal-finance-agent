// Web push — sending a notification to a phone with the app closed.
//
// The point of the whole feature: the weekly briefing is only proactive if it
// reaches someone who is not already looking at the app. A card on a dashboard
// they open once a fortnight is not proactive, it is a page.
//
// Two rules this module holds to:
//
//   1. **No figures in the payload.** A notification renders on a lock screen
//      in front of whoever is nearby. "Your week is ready" is a nudge;
//      "You spent Rs 47,300 this week" is someone's salary, readable across a
//      bus. The numbers live behind the tap.
//   2. **A dead endpoint is deleted immediately.** Push services answer 404 or
//      410 for a subscription that no longer exists — reinstalled app, cleared
//      site data, expired token. Ignore that and the table fills with addresses
//      nothing can ever reach, and every send gets slower.

import webpush from 'web-push';

import { prisma } from '../db';

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should land. */
  url?: string;
  /** Same tag replaces rather than stacks. */
  tag?: string;
}

let configured = false;

/**
 * VAPID identifies this server to the push service.
 *
 * Absent keys are not an error — push is optional, and the rest of the app must
 * work without it. Callers check `pushEnabled()` and skip quietly.
 */
export function pushEnabled(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim(),
  );
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

function configure(): boolean {
  if (configured) return true;
  if (!pushEnabled()) return false;

  webpush.setVapidDetails(
    // A contact the push service can reach if this server misbehaves.
    process.env.VAPID_SUBJECT?.trim() || 'mailto:hello@example.com',
    process.env.VAPID_PUBLIC_KEY!.trim(),
    process.env.VAPID_PRIVATE_KEY!.trim(),
  );
  configured = true;
  return true;
}

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Send to every device a person has registered.
 *
 * One failure never stops the others: a stale laptop subscription must not cost
 * them the notification on their phone.
 */
export async function sendToUser(userId: string, payload: PushPayload): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  if (!configure()) return result;

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return result;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/',
    tag: payload.tag ?? 'tally',
  });

  const dead: string[] = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          body,
          { TTL: 60 * 60 * 24 },
        );
        result.sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the endpoint is gone for good. Anything else might be
        // transient, so the row survives to try again next week.
        if (status === 404 || status === 410) {
          dead.push(subscription.id);
          result.removed++;
        } else {
          console.error('[push] send failed', status, (err as Error).message);
          result.failed++;
        }
      }
    }),
  );

  if (dead.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } });
  }

  const alive = subscriptions.filter((s) => !dead.includes(s.id)).map((s) => s.id);
  if (alive.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: alive } },
      data: { lastSentAt: new Date() },
    });
  }

  return result;
}
