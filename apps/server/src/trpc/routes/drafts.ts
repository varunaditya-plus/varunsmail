import type { MailManager } from '../../lib/driver/types';
import { privateProcedure, router } from '../trpc';
import { getZeroAgent, getZeroDB } from '../../lib/server-utils';
import { createDraftData } from '../../lib/schemas';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

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

export const draftsRouter = router({
  create: privateProcedure
    .input(createDraftData.extend({ connectionId: z.string().optional() }))
    .mutation(async ({ input: { connectionId, ...input }, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, connectionId);
      const { stub: agent } = await getZeroAgent(mailbox.id);
      return agent.createDraft(input);
    }),
  get: privateProcedure
    .input(z.object({ id: z.string(), connectionId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const { stub: agent } = await getZeroAgent(mailbox.id);
      const { id } = input;
      return agent.getDraft(id) as ReturnType<MailManager['getDraft']>;
    }),
  list: privateProcedure
    .input(
      z.object({
        q: z.string().optional(),
        maxResults: z.number().optional(),
        pageToken: z.string().optional(),
        connectionId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const { stub: agent } = await getZeroAgent(mailbox.id);
      const { q, maxResults, pageToken } = input;
      return agent.listDrafts({ q, maxResults, pageToken }) as Awaited<
        ReturnType<MailManager['listDrafts']>
      >;
    }),
  delete: privateProcedure
    .input(
      z.object({
        id: z.string().min(1, 'id is required'),
        connectionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const mailbox = await getOwnedConnection(ctx.sessionUser.id, input.connectionId);
      const { stub: agent } = await getZeroAgent(mailbox.id);
      await agent.deleteDraft(input.id);
      return true;
    }),
});
