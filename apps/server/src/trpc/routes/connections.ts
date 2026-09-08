import { createRateLimiterMiddleware, privateProcedure, publicProcedure, router } from '../trpc';
import { getActiveConnection, getZeroDB } from '../../lib/server-utils';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { env } from '../../env';

export const connectionsRouter = router({
  syncInbox: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getZeroDB(ctx.sessionUser.id);
      const mailbox = await db.findUserConnection(input.connectionId);
      if (!mailbox) throw new TRPCError({ code: 'NOT_FOUND' });
      if (mailbox.providerId !== 'google' || !mailbox.refreshToken) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Gmail connection is not authorized' });
      }
      const runner = env.WORKFLOW_RUNNER.get(env.WORKFLOW_RUNNER.idFromName(`gmail-poll:${mailbox.id}`));
      return runner.importInbox(mailbox.id);
    }),
  list: privateProcedure
    .use(
      createRateLimiterMiddleware({
        limiter: 120,
        generatePrefix: ({ sessionUser }) => `ratelimit:get-connections-${sessionUser?.id}`,
      }),
    )
    .query(async ({ ctx }) => {
      const { sessionUser } = ctx;
      const db = await getZeroDB(sessionUser.id);
      const connections = await db.findManyConnections();

      const disconnectedIds = connections
        .filter((c) => !c.accessToken || !c.refreshToken)
        .map((c) => c.id);

      return {
        connections: connections.map((connection) => {
          return {
            id: connection.id,
            email: connection.email,
            name: connection.name,
            picture: connection.picture,
            createdAt: connection.createdAt,
            providerId: connection.providerId,
          };
        }),
        disconnectedIds,
      };
    }),
  setDefault: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { connectionId } = input;
      const user = ctx.sessionUser;
      const db = await getZeroDB(user.id);
      const foundConnection = await db.findUserConnection(connectionId);
      if (!foundConnection) throw new TRPCError({ code: 'NOT_FOUND' });
      await db.updateUser({ defaultConnectionId: connectionId });
    }),
  delete: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { connectionId } = input;
      const user = ctx.sessionUser;
      const db = await getZeroDB(user.id);
      await db.deleteConnection(connectionId);

      const activeConnection = await getActiveConnection();
      if (connectionId === activeConnection.id) await db.updateUser({ defaultConnectionId: null });
    }),
  getDefault: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.sessionUser) return null;
    const db = await getZeroDB(ctx.sessionUser.id);
    const user = await db.findUser();
    const connection = (user?.defaultConnectionId ? await db.findUserConnection(user.defaultConnectionId) : undefined) ?? await db.findFirstConnection();
    if (!connection) return null;
    return {
      id: connection.id,
      email: connection.email,
      name: connection.name,
      picture: connection.picture,
      createdAt: connection.createdAt,
      providerId: connection.providerId,
    };
  }),
});
