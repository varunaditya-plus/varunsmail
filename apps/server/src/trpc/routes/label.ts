import { activeDriverProcedure, createRateLimiterMiddleware, router } from '../trpc';
import { getZeroAgent, getZeroDB } from '../../lib/server-utils';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

async function getConnectionId(
  ctx: { activeConnection: { id: string }; sessionUser: { id: string } },
  connectionId?: string,
) {
  if (!connectionId) return ctx.activeConnection.id;
  const db = await getZeroDB(ctx.sessionUser.id);
  if (!(await db.findUserConnection(connectionId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Mailbox not found' });
  }
  return connectionId;
}

export const labelsRouter = router({
  list: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:get-labels-${sessionUser?.id}`,
        limiter: 120,
      }),
    )
    .input(z.object({ connectionId: z.string().optional() }).optional())
    .output(
      z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          color: z
            .object({
              backgroundColor: z.string(),
              textColor: z.string(),
            })
            .optional(),
          type: z.string(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const connectionId = await getConnectionId(ctx, input?.connectionId);
      const { stub: agent } = await getZeroAgent(connectionId);
      return await agent.getUserLabels();
    }),
  create: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:labels-post-${sessionUser?.id}`,
        limiter: 60,
      }),
    )
    .input(
      z.object({
        name: z.string(),
        connectionId: z.string().optional(),
        color: z
          .object({
            backgroundColor: z.string(),
            textColor: z.string(),
          })
          .default({
            backgroundColor: '',
            textColor: '',
          }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const connectionId = await getConnectionId(ctx, input.connectionId);
      const { stub: agent } = await getZeroAgent(connectionId);
      const label = {
        name: input.name,
        color: input.color,
        type: 'user',
      };
      return await agent.createLabel(label);
    }),
  update: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:labels-patch-${sessionUser?.id}`,
        limiter: 60,
      }),
    )
    .input(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string().optional(),
        color: z
          .object({
            backgroundColor: z.string(),
            textColor: z.string(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { activeConnection } = ctx;
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      const { id, ...label } = input;
      return await agent.updateLabel(id, label);
    }),
  delete: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:labels-delete-${sessionUser?.id}`,
        limiter: 60,
      }),
    )
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { activeConnection } = ctx;
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      return await agent.deleteLabel(input.id);
    }),
});
