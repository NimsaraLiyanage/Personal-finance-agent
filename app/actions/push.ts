'use server';

// Registering and forgetting a device for push.
//
// The subscription is minted by the browser against the push service — this
// server never chooses the endpoint, it only stores what the browser hands back
// and is scoped to the caller's own user id, so a tampered payload can only
// ever register a device against the person who is signed in.

import { z } from 'zod';

import { prisma } from '@/lib/db';
import { pushEnabled, sendToUser, vapidPublicKey } from '@/lib/push';
import { readUser, resolveUser } from '@/lib/session';

const SubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(300),
  }),
});

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  /** Whether this browser is already registered. */
  subscribed: boolean;
}

export async function getPushConfig(endpoint?: string): Promise<PushConfig> {
  const enabled = pushEnabled();
  if (!enabled) return { enabled: false, publicKey: null, subscribed: false };

  const user = await readUser();
  const subscribed =
    Boolean(user && endpoint) &&
    (await prisma.pushSubscription.count({
      where: { userId: user!.userId, endpoint: endpoint! },
    })) > 0;

  return { enabled: true, publicKey: vapidPublicKey(), subscribed };
}

export async function savePushSubscription(
  raw: unknown,
  userAgent?: string,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = SubscriptionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'That subscription looks wrong.' };
  if (!pushEnabled()) return { ok: false, error: 'Push is not configured on this server.' };

  const { userId } = await resolveUser();

  // Upsert on the endpoint: the same device re-registering after a permission
  // reset must move to the current user rather than collide with its old row.
  await prisma.pushSubscription.upsert({
    where: { endpoint: parsed.data.endpoint },
    create: {
      userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent: userAgent?.slice(0, 200) ?? null,
    },
    update: {
      userId,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent: userAgent?.slice(0, 200) ?? null,
    },
  });

  return { ok: true };
}

export async function removePushSubscription(endpoint: string): Promise<{ ok: boolean }> {
  const user = await readUser();
  if (!user) return { ok: true };
  // Scoped delete: an endpoint guessed from elsewhere matches nothing.
  await prisma.pushSubscription.deleteMany({ where: { userId: user.userId, endpoint } });
  return { ok: true };
}

/** Prove to the person that it works, right after they allow it. */
export async function sendTestPush(): Promise<{ ok: boolean; error?: string }> {
  const user = await readUser();
  if (!user) return { ok: false, error: 'Nothing to notify yet.' };

  const result = await sendToUser(user.userId, {
    title: 'Tally',
    body: 'Notifications are on. This is what a weekly briefing will look like.',
    url: '/',
    tag: 'tally-test',
  });

  if (result.sent === 0) {
    return { ok: false, error: 'Could not reach this device. Try turning it on again.' };
  }
  return { ok: true };
}
