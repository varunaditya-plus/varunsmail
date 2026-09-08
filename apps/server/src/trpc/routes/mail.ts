import {
  getThreadsFromDB,
  getZeroAgent,
  getZeroDB,
  getThread,
  modifyThreadLabelsInDB,
  deleteAllSpam,
  reSyncThread,
} from '../../lib/server-utils';
import {
  IGetThreadResponseSchema,
  IGetThreadsResponseSchema,
  type IGetThreadsResponse,
} from '../../lib/driver/types';
import { updateWritingStyleMatrix } from '../../services/writing-style-service';
import type { DeleteAllSpamResponse, IEmailSendBatch } from '../../types';
import { activeDriverProcedure, router, privateProcedure } from '../trpc';
import { processEmailHtml } from '../../lib/email-processor';
import { listMailboxThreads } from '../../lib/mailbox-list';
import { runMailboxChanges } from '../../lib/mailbox-changes';
import {
  decodeUnifiedInboxCursor,
  mergeUnifiedInboxPages,
  type UnifiedInboxPage,
} from '../../lib/unified-inbox';
import { defaultPageSize, FOLDERS } from '../../lib/utils';
import { toAttachmentFiles } from '../../lib/attachments';
import { serializedFileSchema } from '../../lib/schemas';
import { getContext } from 'hono/context-storage';
import { type HonoContext } from '../../ctx';
import { TRPCError } from '@trpc/server';
import { env } from '../../env';
import { z } from 'zod';

const senderSchema = z.object({
  name: z.string().optional(),
  email: z.string(),
});

const threadIdsSchema = z.object({
  ids: z.string().array(),
  connectionId: z.string().optional(),
});

async function getOwnedConnection(userId: string, connectionId?: string) {
  const db = await getZeroDB(userId);
  if (connectionId) {
    const mailbox = await db.findUserConnection(connectionId);
    if (!mailbox) throw new TRPCError({ code: 'NOT_FOUND', message: 'Mailbox not found' });
    return mailbox;
  }

  const user = await db.findUser();
  const mailbox =
    (user?.defaultConnectionId
      ? await db.findUserConnection(user.defaultConnectionId)
      : undefined) ?? (await db.findFirstConnection());
  if (!mailbox) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Connect a mailbox first' });
  return mailbox;
}

// const getFolderLabelId = (folder: string) => {
//   // Handle special cases first
//   if (folder === 'bin') return 'TRASH';
//   if (folder === 'archive') return ''; // Archive doesn't have a specific label

//   // For other folders, convert to uppercase (same as database method)
//   return folder.toUpperCase();
// };

export const mailRouter = router({
  suggestRecipients: activeDriverProcedure
    .input(
      z.object({
        query: z.string().optional().default(''),
        limit: z.number().optional().default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { activeConnection } = ctx;
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(activeConnection.id, executionCtx);

      return await agent.suggestRecipients(input.query, input.limit);
    }),
  forceSync: activeDriverProcedure.mutation(async ({ ctx }) => {
    const { activeConnection } = ctx;
    const runner = env.WORKFLOW_RUNNER.get(
      env.WORKFLOW_RUNNER.idFromName(`gmail-poll:${activeConnection.id}`),
    );
    await runner.pollMailbox(activeConnection.id);
    return runner.importInbox(activeConnection.id);
  }),
  get: privateProcedure
    .input(
      z.object({
        id: z.string(),
        connectionId: z.string().optional(),
      }),
    )
    .output(IGetThreadResponseSchema)
    .query(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const result = (await getThread(mailbox.id, input.id)).result;
      return {
        ...result,
        messages: result.messages.map((message) => ({ ...message, connectionId: mailbox.id })),
        latest: result.latest ? { ...result.latest, connectionId: mailbox.id } : undefined,
      };
    }),
  listUnifiedThreads: privateProcedure
    .input(
      z.object({
        q: z.string().optional().default(''),
        maxResults: z.number().int().min(1).max(500).optional().default(defaultPageSize),
        cursor: z.string().optional().default(''),
        labelIds: z.array(z.string()).optional().default([]),
        connectionIds: z.array(z.string()).optional().default([]),
      }),
    )
    .output(IGetThreadsResponseSchema)
    .query(async ({ ctx, input }) => {
      const db = await getZeroDB(ctx.sessionUser.id);
      const owned = (await db.findManyConnections())
        .filter((mailbox) => mailbox.providerId === 'google')
        .sort((a, b) => a.id.localeCompare(b.id));
      const ownedIds = new Set(owned.map((mailbox) => mailbox.id));

      if (input.connectionIds.some((connectionId) => !ownedIds.has(connectionId))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Mailbox filter is not owned' });
      }

      let cursor: Record<string, string>;
      try {
        cursor = decodeUnifiedInboxCursor(input.cursor);
      } catch {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid inbox cursor' });
      }

      const selected = input.connectionIds.length
        ? owned.filter((mailbox) => input.connectionIds.includes(mailbox.id))
        : owned;
      const results = await Promise.allSettled(
        selected.map(async (mailbox) => ({
          connection: {
            id: mailbox.id,
            email: mailbox.email,
            name: mailbox.name,
            picture: mailbox.picture,
          },
          page: await getThreadsFromDB(mailbox.id, {
            folder: FOLDERS.INBOX,
            q: input.q,
            labelIds: input.labelIds,
            maxResults: Math.min(500, input.maxResults + 1),
            pageToken: cursor[mailbox.id] ?? '',
          }),
        })),
      );
      const pages: UnifiedInboxPage[] = [];
      const partialFailures: { connectionId: string; email: string; message: string }[] = [];

      results.forEach((result, index) => {
        const mailbox = selected[index]!;
        if (result.status === 'fulfilled') {
          pages.push(result.value);
        } else {
          console.error('[listUnifiedThreads] Mailbox failed', mailbox.id, result.reason);
          partialFailures.push({
            connectionId: mailbox.id,
            email: mailbox.email,
            message: 'This mailbox could not be loaded.',
          });
        }
      });

      return {
        ...mergeUnifiedInboxPages(pages, cursor, input.maxResults),
        partialFailures,
      };
    }),
  listThreads: activeDriverProcedure
    .input(
      z.object({
        folder: z.string().optional().default('inbox'),
        q: z.string().optional().default(''),
        maxResults: z.number().int().min(1).max(500).optional().default(defaultPageSize),
        cursor: z.string().optional().default(''),
        labelIds: z.array(z.string()).optional().default([]),
      }),
    )
    .output(IGetThreadsResponseSchema)
    .query(async ({ ctx, input }) => {
      const { folder, maxResults, cursor, q, labelIds } = input;
      const { activeConnection } = ctx;
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(activeConnection.id, executionCtx);

      console.debug('[listThreads] input:', { folder, maxResults, cursor, q, labelIds });

      if (folder === FOLDERS.DRAFT) {
        console.debug('[listThreads] Listing drafts');
        const drafts = await agent.listDrafts({
          q,
          maxResults,
          pageToken: cursor,
        });
        console.debug('[listThreads] Drafts result:', drafts);
        return drafts;
      }

      type ThreadItem = { id: string; historyId: string | null; $raw?: unknown };

      const threadsResponse: IGetThreadsResponse = await listMailboxThreads(
        { folder, q, cursor, maxResults, labelIds },
        {
          live: (params) => agent.rawListThreads(params),
          cache: (params) => getThreadsFromDB(activeConnection.id, params),
        },
      );

      if (folder === FOLDERS.SNOOZED) {
        const nowTs = Date.now();
        const filtered: ThreadItem[] = [];

        console.debug('[listThreads] Filtering snoozed threads at', new Date(nowTs).toISOString());

        await Promise.all(
          threadsResponse.threads.map(async (t: ThreadItem) => {
            const keyName = `${t.id}__${activeConnection.id}`;
            try {
              const wakeAtIso = await env.snoozed_emails.get(keyName);
              if (!wakeAtIso) {
                filtered.push(t);
                return;
              }

              const wakeAt = new Date(wakeAtIso).getTime();
              if (wakeAt > nowTs) {
                filtered.push(t);
                return;
              }

              console.debug('[UNSNOOZE_ON_ACCESS] Expired thread', t.id, {
                wakeAtIso,
                now: new Date(nowTs).toISOString(),
              });

              await modifyThreadLabelsInDB(activeConnection.id, t.id, ['INBOX'], ['SNOOZED']);
              await env.snoozed_emails.delete(keyName);
            } catch (error) {
              console.error('[UNSNOOZE_ON_ACCESS] Failed for', t.id, error);
              filtered.push(t);
            }
          }),
        );

        threadsResponse.threads = filtered;
        console.debug('[listThreads] Snoozed threads after filtering:', filtered);
      }

      console.debug('[listThreads] Returning threadsResponse:', threadsResponse);
      return threadsResponse;
    }),
  markAsRead: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, [], ['UNREAD']),
        ),
      );
    }),
  markAsUnread: privateProcedure
    .input(threadIdsSchema)
    // TODO: Add batching
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['UNREAD'], []),
        ),
      );
    }),
  markAsImportant: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['IMPORTANT'], []),
        ),
      );
    }),
  modifyLabels: privateProcedure
    .input(
      z.object({
        threadId: z.string().array(),
        addLabels: z.string().array().optional().default([]),
        removeLabels: z.string().array().optional().default([]),
        connectionId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(mailbox.id, executionCtx);
      const { threadId, addLabels, removeLabels } = input;

      console.log(`Server: updateThreadLabels called for thread ${threadId}`);
      console.log(`Adding labels: ${addLabels.join(', ')}`);
      console.log(`Removing labels: ${removeLabels.join(', ')}`);

      const result = await agent.normalizeIds(threadId);
      const { threadIds } = result;

      if (threadIds.length) {
        await runMailboxChanges(
          threadIds.map((threadId) => () =>
            modifyThreadLabelsInDB(mailbox.id, threadId, addLabels, removeLabels),
          ),
        );
        return { success: true };
      }

      console.log('Server: No label changes specified');
      return { success: false, error: 'No label changes specified' };
    }),

  toggleStar: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(mailbox.id, executionCtx);
      const { threadIds } = await agent.normalizeIds(input.ids);

      if (!threadIds.length) {
        return { success: false, error: 'No thread IDs provided' };
      }

      const threadResults = await Promise.allSettled(
        threadIds.map(async (id: string) => {
          const thread = await getThread(mailbox.id, id);
          return thread.result;
        }),
      );

      let anyStarred = false;
      let processedThreads = 0;

      for (const result of threadResults) {
        if (result.status === 'fulfilled' && result.value && result.value.messages.length > 0) {
          processedThreads++;
          const isThreadStarred = result.value.messages.some((message) =>
            message.tags?.some((tag) => tag.name.toLowerCase().startsWith('starred')),
          );
          if (isThreadStarred) {
            anyStarred = true;
            break;
          }
        }
      }

      const shouldStar = processedThreads > 0 && !anyStarred;

      await runMailboxChanges(
        threadIds.map((threadId) => () =>
          modifyThreadLabelsInDB(
            mailbox.id,
            threadId,
            shouldStar ? ['STARRED'] : [],
            shouldStar ? [] : ['STARRED'],
          ),
        ),
      );

      return { success: true };
    }),
  toggleImportant: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(mailbox.id, executionCtx);
      const { threadIds } = await agent.normalizeIds(input.ids);

      if (!threadIds.length) {
        return { success: false, error: 'No thread IDs provided' };
      }

      const threadResults = await Promise.allSettled(
        threadIds.map(async (id: string) => {
          const thread = await getThread(mailbox.id, id);
          return thread.result;
        }),
      );

      let anyImportant = false;
      let processedThreads = 0;

      for (const result of threadResults) {
        if (result.status === 'fulfilled' && result.value && result.value.messages.length > 0) {
          processedThreads++;
          const isThreadImportant = result.value.messages.some((message) =>
            message.tags?.some((tag) => tag.name.toLowerCase().startsWith('important')),
          );
          if (isThreadImportant) {
            anyImportant = true;
            break;
          }
        }
      }

      const shouldMarkImportant = processedThreads > 0 && !anyImportant;

      await runMailboxChanges(
        threadIds.map((threadId) => () =>
          modifyThreadLabelsInDB(
            mailbox.id,
            threadId,
            shouldMarkImportant ? ['IMPORTANT'] : [],
            shouldMarkImportant ? [] : ['IMPORTANT'],
          ),
        ),
      );

      return { success: true };
    }),
  bulkStar: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['STARRED'], []),
        ),
      );
    }),
  bulkMarkImportant: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['IMPORTANT'], []),
        ),
      );
    }),
  bulkUnstar: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, [], ['STARRED']),
        ),
      );
    }),
  deleteAllSpam: activeDriverProcedure.mutation(async ({ ctx }): Promise<DeleteAllSpamResponse> => {
    const { activeConnection } = ctx;
    try {
      const result = await deleteAllSpam(activeConnection.id);
      return {
        success: true,
        message: `Spam emails deleted ${result.deletedCount} threads`,
        count: result.deletedCount,
      };
    } catch (error) {
      console.error('Error deleting spam emails:', error);
      return {
        success: false,
        message: 'Failed to delete spam emails',
        error: String(error),
        count: 0,
      };
    }
  }),
  bulkUnmarkImportant: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, [], ['IMPORTANT']),
        ),
      );
    }),

  send: privateProcedure
    .input(
      z.object({
        to: z.array(senderSchema),
        subject: z.string(),
        message: z.string(),
        attachments: z.array(serializedFileSchema).optional().default([]),
        headers: z.record(z.string()).optional().default({}),
        cc: z.array(senderSchema).optional(),
        bcc: z.array(senderSchema).optional(),
        threadId: z.string().optional(),
        fromEmail: z.string().optional(),
        draftId: z.string().optional(),
        isForward: z.boolean().optional(),
        originalMessage: z.string().optional(),
        scheduleAt: z.string().optional(),
        connectionId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { sessionUser } = ctx;
      const { draftId, scheduleAt, attachments, connectionId, ...mail } = input;
      const mailbox = await getOwnedConnection(sessionUser.id, connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const agent = await getZeroAgent(mailbox.id, executionCtx);

      const db = await getZeroDB(sessionUser.id);
      const userSettings = await db.findUserSettings();
      const undoSendEnabled = userSettings?.settings?.undoSendEnabled ?? false;
      const shouldSchedule = !!scheduleAt || undoSendEnabled;

      const afterTask = async () => {
        try {
          console.warn('Saving writing style matrix...');
          await updateWritingStyleMatrix(mailbox.id, input.message);
          console.warn('Saved writing style matrix.');
        } catch (error) {
          console.error('Failed to save writing style matrix', error);
        }
      };

      if (shouldSchedule) {
        const messageId = crypto.randomUUID();

        // Validate scheduleAt if provided
        let targetTime: number;
        if (scheduleAt) {
          const parsedTime = Date.parse(scheduleAt);
          if (isNaN(parsedTime)) {
            return { success: false, error: 'Invalid schedule date format' } as const;
          }

          const now = Date.now();

          if (parsedTime <= now) {
            return { success: false, error: 'Schedule time must be in the future' } as const;
          }

          targetTime = parsedTime;
        } else {
          targetTime = Date.now() + 15_000;
        }

        const rawDelaySeconds = Math.floor((targetTime - Date.now()) / 1000);
        const pendingTtl = Math.max(86400, rawDelaySeconds + 86400);
        const maxQueueDelay = 43200; // 12 hours
        const isLongTerm = rawDelaySeconds > maxQueueDelay;

        const {
          pending_emails_status: statusKV,
          pending_emails_payload: payloadKV,
          scheduled_emails: scheduledKV,
          send_email_queue,
        } = env;

        try {
          await statusKV.put(messageId, 'pending', {
            expirationTtl: pendingTtl,
          });
        } catch (error) {
          console.error(`Failed to write pending status to KV for message ${messageId}`, error);
          return { success: false, error: 'Failed to schedule email status' } as const;
        }

        const mailPayload = {
          ...mail,
          draftId,
          attachments,
          connectionId: mailbox.id,
        };

        try {
          await payloadKV.put(messageId, JSON.stringify(mailPayload), {
            expirationTtl: pendingTtl,
          });
        } catch (error) {
          console.error(`Failed to write email payload to KV for message ${messageId}`, error);
          return { success: false, error: 'Failed to schedule email payload' } as const;
        }

        if (isLongTerm) {
          try {
            await scheduledKV.put(
              messageId,
              JSON.stringify({
                messageId,
                connectionId: mailbox.id,
                sendAt: targetTime,
              }),
              { expirationTtl: Math.min(Math.ceil(rawDelaySeconds + 3600), 31556952) },
            );
          } catch (error) {
            console.error(
              `Failed to write long-term schedule to KV for message ${messageId}`,
              error,
            );
            return { success: false, error: 'Failed to schedule email (long-term)' } as const;
          }
        } else {
          const delaySeconds = rawDelaySeconds;
          const queueBody: IEmailSendBatch = {
            messageId,
            connectionId: mailbox.id,
            sendAt: targetTime,
          };
          try {
            await send_email_queue.send(queueBody, { delaySeconds });
          } catch (error) {
            console.error(`Failed to enqueue email send for message ${messageId}`, error);
            return { success: false, error: 'Failed to enqueue email send' } as const;
          }
        }

        ctx.c.executionCtx.waitUntil(afterTask());

        if (isLongTerm) {
          return { success: true, scheduled: true, messageId, sendAt: targetTime };
        } else {
          return { success: true, queued: true, messageId, sendAt: targetTime };
        }
      }

      const mailWithAttachments = {
        ...mail,
        attachments: attachments?.map((att: any) =>
          typeof att?.arrayBuffer === 'function' ? att : toAttachmentFiles([att])[0],
        ),
      } as typeof mail & { attachments: any[] };

      if (draftId) {
        await agent.stub.sendDraft(draftId, mailWithAttachments);
      } else {
        await agent.stub.create(mailWithAttachments);
      }

      console.log('[send] input.threadId:', input);

      ctx.c.executionCtx.waitUntil(afterTask());
      return { success: true };
    }),
  unsend: privateProcedure
    .input(
      z.object({
        messageId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { messageId } = input;
      const db = await getZeroDB(ctx.sessionUser.id);
      const {
        pending_emails_status: statusKV,
        pending_emails_payload: payloadKV,
        scheduled_emails: scheduledKV,
      } = env;

      const scheduledData = await scheduledKV.get(messageId);
      if (scheduledData) {
        try {
          const { connectionId } = JSON.parse(scheduledData);
          if (!connectionId || !(await db.findUserConnection(connectionId))) {
            return {
              success: false,
              error: 'Unauthorized scheduled email',
            } as const;
          }
        } catch (error) {
          console.error('Failed to parse scheduled data for ownership verification:', error);
          return { success: false, error: 'Invalid scheduled email data' } as const;
        }
      }

      const payloadData = await payloadKV.get(messageId);
      if (payloadData) {
        try {
          const payload = JSON.parse(payloadData);
          if (payload.connectionId && !(await db.findUserConnection(payload.connectionId))) {
            return {
              success: false,
              error: 'Unauthorized queued email',
            } as const;
          }
        } catch (error) {
          console.error('Failed to parse payload data:', error);
          return { success: false, error: 'Invalid payload data' } as const;
        }
      }

      await statusKV.put(messageId, 'cancelled', {
        expirationTtl: 60 * 60,
      });

      await payloadKV.delete(messageId);
      await scheduledKV.delete(messageId); // Clean up long-term schedule if it exists

      return { success: true };
    }),
  delete: privateProcedure
    .input(
      z.object({
        id: z.string(),
        connectionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub } = await getZeroAgent(mailbox.id, executionCtx);
      await stub.delete(input.id);
      return true;
    }),
  bulkDelete: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['TRASH'], ['INBOX']),
        ),
      );
    }),
  bulkArchive: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      return runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, [], ['INBOX']),
        ),
      );
    }),
  bulkMute: activeDriverProcedure
    .input(
      z.object({
        ids: z.string().array(),
      }),
    )
    .mutation(() => {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Gmail does not expose native mute through its API.' });
    }),
  getEmailAliases: privateProcedure
    .input(z.object({ connectionId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input?.connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(mailbox.id, executionCtx);
      const aliases = await agent.getEmailAliases();
      const result: { email: string; name?: string; primary?: boolean }[] = [];
      for (const { email, name, primary } of aliases) result.push({ email, name, primary });
      return result;
    }),
  snoozeThreads: privateProcedure
    .input(
      z.object({
        ids: z.string().array(),
        wakeAt: z.string(),
        connectionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      if (!input.ids.length) {
        return { success: false, error: 'No thread IDs provided' };
      }

      const wakeAtDate = new Date(input.wakeAt);
      if (!Number.isFinite(wakeAtDate.getTime()) || wakeAtDate <= new Date()) {
        return { success: false, error: 'Snooze time must be in the future' };
      }

      await runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['SNOOZED'], ['INBOX']),
        ),
      );

      const wakeAtIso = wakeAtDate.toISOString();
      await Promise.all(
        input.ids.map((threadId) =>
          env.snoozed_emails.put(`${threadId}__${mailbox.id}`, wakeAtIso, {
            metadata: { wakeAt: wakeAtIso },
          }),
        ),
      );

      return { success: true };
    }),
  unsnoozeThreads: privateProcedure
    .input(threadIdsSchema)
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      if (!input.ids.length) return { success: false, error: 'No thread IDs' };
      await runMailboxChanges(
        input.ids.map((threadId) => () =>
          modifyThreadLabelsInDB(mailbox.id, threadId, ['INBOX'], ['SNOOZED']),
        ),
      );
      await Promise.all(
        input.ids.map((threadId) =>
          env.snoozed_emails.delete(`${threadId}__${mailbox.id}`),
        ),
      );
      return { success: true };
    }),
  getMessageAttachments: privateProcedure
    .input(
      z.object({
        messageId: z.string(),
        connectionId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const executionCtx = getContext<HonoContext>().executionCtx;
      const { stub: agent } = await getZeroAgent(mailbox.id, executionCtx);
      return agent.getMessageAttachments(input.messageId) as Promise<
        {
          filename: string;
          mimeType: string;
          size: number;
          attachmentId: string;
          headers: {
            name: string;
            value: string;
          }[];
          body: string;
        }[]
      >;
    }),
  processEmailContent: privateProcedure
    .input(
      z.object({
        html: z.string(),
        shouldLoadImages: z.boolean(),
        theme: z.enum(['light', 'dark']),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const { processedHtml, hasBlockedImages } = processEmailHtml({
          html: input.html,
          shouldLoadImages: input.shouldLoadImages,
          theme: input.theme,
        });

        return {
          processedHtml,
          hasBlockedImages,
        };
      } catch (error) {
        console.error('Error processing email content:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process email content',
        });
      }
    }),
  getRawEmail: privateProcedure
    .input(
      z.object({
        id: z.string(),
        connectionId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const { stub: agent } = await getZeroAgent(mailbox.id);
      return agent.getRawEmail(input.id);
    }),
  verifyEmail: privateProcedure
    .input(
      z.object({
        id: z.string(),
        connectionId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      try {
        const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
        const { stub: agent } = await getZeroAgent(mailbox.id);

        console.log(`[VERIFY_EMAIL] Getting raw email for message ID: ${input.id}`);
        const rawEmail = await agent.getRawEmail(input.id);

        const { verify } = await import('../../lib/email-verification');
        const result = await verify(rawEmail);
        console.log(`[VERIFY_EMAIL] Verification result for message ID ${input.id}:`, result);
        return result;
      } catch (error) {
        console.error('Email verification error:', error);
        return { isVerified: false };
      }
    }),
});
