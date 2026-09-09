import { and, desc, eq, inArray } from 'drizzle-orm';

import { connection, mailboxAction, mailboxSyncStatus } from '../db/schema';
import type { ZeroEnv } from '../env';
import { createDb } from '../db';

export type OutboxState = {
  status: 'pending' | 'retrying' | 'failed' | 'cancelled' | 'sent';
  sendAt?: number;
  createdAt?: number;
  attempts?: number;
  error?: string;
};

const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

export function parseOutboxState(value: string | null): OutboxState {
  if (!value) return { status: 'pending' };
  try {
    const parsed = JSON.parse(value) as OutboxState;
    if (parsed && ['pending', 'retrying', 'failed', 'cancelled', 'sent'].includes(parsed.status)) {
      return parsed;
    }
  } catch {
    if (value === 'cancelled') return { status: 'cancelled' };
  }
  return { status: 'pending' };
}

export function writeOutboxState(namespace: KVNamespace, messageId: string, state: OutboxState) {
  return namespace.put(messageId, JSON.stringify(state), { expirationTtl: 31_536_000 });
}

export function describeLabelAction(addLabels: string[], removeLabels: string[]) {
  if (addLabels.includes('TRASH')) return 'move to trash';
  if (addLabels.includes('SPAM')) return 'mark as spam';
  if (addLabels.includes('INBOX')) return 'move to inbox';
  if (removeLabels.includes('INBOX')) return 'archive';
  if (addLabels.includes('UNREAD')) return 'mark unread';
  if (removeLabels.includes('UNREAD')) return 'mark read';
  if (addLabels.includes('STARRED')) return 'star';
  if (removeLabels.includes('STARRED')) return 'unstar';
  if (addLabels.includes('IMPORTANT')) return 'mark important';
  if (removeLabels.includes('IMPORTANT')) return 'unmark important';
  if (addLabels.length || removeLabels.length) return 'change labels';
  return 'update thread';
}

async function writeMailboxSyncStatus(
  env: ZeroEnv,
  connectionId: string,
  status: 'syncing' | 'healthy' | 'error',
  error?: unknown,
) {
  const { db } = createDb(env.DB);
  const mailbox = await db.query.connection.findFirst({
    where: eq(connection.id, connectionId),
    columns: { userId: true },
  });
  if (!mailbox) return;
  const now = new Date();
  await db
    .insert(mailboxSyncStatus)
    .values({
      connectionId,
      userId: mailbox.userId,
      status,
      lastAttemptAt: now,
      lastSuccessAt: status === 'healthy' ? now : null,
      lastError: status === 'error' ? safeError(error) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mailboxSyncStatus.connectionId,
      set: {
        status,
        lastAttemptAt: now,
        ...(status === 'healthy' ? { lastSuccessAt: now } : {}),
        lastError: status === 'error' ? safeError(error) : null,
        updatedAt: now,
      },
    });
}

export async function setMailboxSyncStatus(
  env: ZeroEnv,
  connectionId: string,
  status: 'syncing' | 'healthy' | 'error',
  error?: unknown,
) {
  try {
    await writeMailboxSyncStatus(env, connectionId, status, error);
  } catch (writeError) {
    console.error('[MAILBOX_ACTIVITY] Failed to record sync status', safeError(writeError));
  }
}

type MailboxActionInput = {
  userId?: string;
  connectionId?: string;
  threadId?: string;
  messageId?: string;
  action: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  detail?: string;
};

async function writeMailboxAction(env: ZeroEnv, input: MailboxActionInput) {
  const { db } = createDb(env.DB);
  const userId =
    input.userId ??
    (input.connectionId
      ? (
          await db.query.connection.findFirst({
            where: eq(connection.id, input.connectionId),
            columns: { userId: true },
          })
        )?.userId
      : undefined);
  if (!userId) return;
  const now = new Date();
  const existing = input.messageId
    ? await db.query.mailboxAction.findFirst({
        where: and(eq(mailboxAction.userId, userId), eq(mailboxAction.messageId, input.messageId)),
        orderBy: desc(mailboxAction.createdAt),
      })
    : undefined;
  if (existing) {
    await db
      .update(mailboxAction)
      .set({ status: input.status, detail: input.detail?.slice(0, 300), updatedAt: now })
      .where(eq(mailboxAction.id, existing.id));
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db.insert(mailboxAction).values({
    id,
    userId,
    connectionId: input.connectionId ?? null,
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    action: input.action,
    status: input.status,
    detail: input.detail?.slice(0, 300) ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function recordMailboxAction(env: ZeroEnv, input: MailboxActionInput) {
  try {
    return await writeMailboxAction(env, input);
  } catch (error) {
    console.error('[MAILBOX_ACTIVITY] Failed to record mailbox action', safeError(error));
  }
}

export async function listMailboxActivity(env: ZeroEnv, userId: string) {
  const { db } = createDb(env.DB);
  const mailboxes = await db.query.connection.findMany({
    where: eq(connection.userId, userId),
    columns: { id: true, email: true, name: true, providerId: true },
  });
  const connectionIds = mailboxes.map(({ id }) => id);
  const [statuses, actions] = await Promise.all([
    connectionIds.length
      ? db.query.mailboxSyncStatus.findMany({
          where: inArray(mailboxSyncStatus.connectionId, connectionIds),
        })
      : [],
    db.query.mailboxAction.findMany({
      where: eq(mailboxAction.userId, userId),
      orderBy: desc(mailboxAction.createdAt),
      limit: 100,
    }),
  ]);
  return {
    mailboxes: mailboxes.map((mailbox) => ({
      ...mailbox,
      sync: statuses.find(({ connectionId }) => connectionId === mailbox.id) ?? null,
    })),
    actions,
  };
}

export async function listOutbox(env: ZeroEnv, userId: string) {
  const { db } = createDb(env.DB);
  const mailboxes = await db.query.connection.findMany({
    where: eq(connection.userId, userId),
    columns: { id: true, email: true },
  });
  const owned = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox.email]));
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await env.pending_emails_payload.list({ cursor, limit: 1000 });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const key of page.keys) {
      const payloadText = await env.pending_emails_payload.get(key.name);
      if (!payloadText) continue;
      try {
        const payload = JSON.parse(payloadText) as {
          connectionId?: string;
          subject?: string;
          to?: { email?: string }[];
          fromEmail?: string;
        };
        if (!payload.connectionId || !owned.has(payload.connectionId)) continue;
        const state = parseOutboxState(await env.pending_emails_status.get(key.name));
        if (state.status === 'cancelled' || state.status === 'sent') continue;
        items.push({
          messageId: key.name,
          connectionId: payload.connectionId,
          accountEmail: owned.get(payload.connectionId)!,
          fromEmail: payload.fromEmail,
          to: payload.to?.flatMap(({ email }) => (email ? [email] : [])) ?? [],
          subject: payload.subject ?? '',
          ...state,
        });
      } catch {
        continue;
      }
    }
  } while (cursor);
  return items.sort((a, b) => (a.sendAt ?? a.createdAt ?? 0) - (b.sendAt ?? b.createdAt ?? 0));
}

export async function retryOutbox(env: ZeroEnv, userId: string, messageId: string) {
  const payloadText = await env.pending_emails_payload.get(messageId);
  if (!payloadText) throw new Error('Outbox message is no longer available');
  const payload = JSON.parse(payloadText) as { connectionId?: string };
  if (!payload.connectionId) throw new Error('Outbox message has no mailbox');
  const { db } = createDb(env.DB);
  const mailbox = await db.query.connection.findFirst({
    where: and(eq(connection.id, payload.connectionId), eq(connection.userId, userId)),
  });
  if (!mailbox) throw new Error('Outbox message does not belong to this account');
  const now = Date.now();
  await writeOutboxState(env.pending_emails_status, messageId, {
    status: 'pending',
    sendAt: now,
    createdAt: now,
    attempts: 0,
  });
  await env.scheduled_emails.delete(messageId);
  await env.send_email_queue.send({ messageId, connectionId: mailbox.id, sendAt: now });
  await recordMailboxAction(env, {
    userId,
    connectionId: mailbox.id,
    messageId,
    action: 'send email',
    status: 'pending',
    detail: 'Retry queued',
  });
  return { success: true };
}

export async function cancelOutbox(env: ZeroEnv, userId: string, messageId: string) {
  const payloadText = await env.pending_emails_payload.get(messageId);
  if (!payloadText) throw new Error('Outbox message is no longer available');
  const payload = JSON.parse(payloadText) as { connectionId?: string };
  if (!payload.connectionId) throw new Error('Outbox message has no mailbox');
  const { db } = createDb(env.DB);
  const mailbox = await db.query.connection.findFirst({
    where: and(eq(connection.id, payload.connectionId), eq(connection.userId, userId)),
  });
  if (!mailbox) throw new Error('Outbox message does not belong to this account');
  await writeOutboxState(env.pending_emails_status, messageId, {
    status: 'cancelled',
    createdAt: Date.now(),
  });
  await Promise.all([
    env.pending_emails_payload.delete(messageId),
    env.scheduled_emails.delete(messageId),
  ]);
  await recordMailboxAction(env, {
    userId,
    connectionId: mailbox.id,
    messageId,
    action: 'send email',
    status: 'cancelled',
    detail: 'Cancelled from outbox',
  });
  return { success: true };
}
