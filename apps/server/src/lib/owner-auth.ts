import { createAuthMiddleware, APIError } from 'better-auth/api';
import type { BetterAuthOptions } from 'better-auth';

export const ownerAuthOptions = (ownerEmail: string) => {
  const email = ownerEmail.trim().toLowerCase();
  if (!email) throw new Error('OWNER_EMAIL must be configured');

  return {
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/sign-up') || ctx.path === '/sign-in/social') {
          throw new APIError('FORBIDDEN', { message: 'Account registration is disabled' });
        }
        if (
          ctx.path === '/sign-in/email' &&
          (typeof ctx.body?.email !== 'string' || ctx.body.email.trim().toLowerCase() !== email)
        ) {
          throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' });
        }
        if (ctx.path === '/delete-user' || ctx.path === '/change-email') {
          throw new APIError('FORBIDDEN', {
            message: 'The owner account is managed by the server administrator',
          });
        }
        if (ctx.path === '/unlink-account' && ctx.body?.providerId === 'credential') {
          throw new APIError('FORBIDDEN', { message: 'The owner password cannot be removed' });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            throw new APIError('FORBIDDEN', { message: 'Account registration is disabled' });
          },
        },
        update: {
          before: async (user) => {
            if (user.email && user.email.trim().toLowerCase() !== email) {
              throw new APIError('FORBIDDEN', { message: 'The owner email cannot be changed' });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            if (!user || user.email.toLowerCase() !== email) {
              throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' });
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
};
