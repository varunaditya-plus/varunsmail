import { type Account, betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getZeroDB, resetConnection } from './server-utils';
import { jwt, bearer, mcp } from 'better-auth/plugins';
import { getSocialProviders } from './auth-providers';
import { ownerAuthOptions } from './owner-auth';
import { defaultUserSettings } from './schemas';
import { APIError } from 'better-auth/api';
import { type EProviders } from '../types';
import { createDriver } from './driver';
import { createDb } from '../db';
import { env } from '../env';

const connectionHandlerHook = async (account: Account) => {
  if (account.providerId === 'credential') return;

  if (!account.accessToken || !account.refreshToken) {
    console.error('Missing mailbox tokens', { accountId: account.id });
    throw new APIError('EXPECTATION_FAILED', {
      message: 'Google did not return mailbox access. Reconnect the account and grant access.',
    });
  }

  const driver = createDriver(account.providerId, {
    auth: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      userId: account.userId,
      email: '',
    },
  });

  const userInfo = await driver.getUserInfo().catch(async () => {
    if (account.accessToken) {
      await driver.revokeToken(account.accessToken);
      await resetConnection(account.id);
    }
    throw new Response(null, { status: 301, headers: { Location: '/' } });
  });

  if (!userInfo?.address) {
    try {
      await Promise.allSettled(
        [account.accessToken, account.refreshToken]
          .filter(Boolean)
          .map((t) => driver.revokeToken(t as string)),
      );
      await resetConnection(account.id);
    } catch (error) {
      console.error('Failed to revoke tokens:', error);
    }
    throw new Response(null, { status: 303, headers: { Location: '/' } });
  }

  const updatingInfo = {
    name: userInfo.name || 'Unknown',
    picture: userInfo.photo || '',
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    scope: driver.getScope(),
    expiresAt: account.accessTokenExpiresAt ?? new Date(Date.now() + 3600000),
  };

  const db = await getZeroDB(account.userId);
  const [result] = await db.createConnection(
    account.providerId as EProviders,
    userInfo.address,
    updatingInfo,
  );

  if (env.GOOGLE_S_ACCOUNT && env.GOOGLE_S_ACCOUNT !== '{}') {
    await env.subscribe_queue.send({
      connectionId: result.id,
      providerId: account.providerId,
    });
  }
};

const createAuthConfig = () => {
  const { db } = createDb(env.DB);
  const ownerOptions = ownerAuthOptions(env.OWNER_EMAIL);

  return {
    ...ownerOptions,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      cookiePrefix: env.NODE_ENV === 'development' ? 'better-auth-dev' : 'better-auth',
      crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN },
    },
    baseURL: env.VITE_PUBLIC_BACKEND_URL,
    trustedOrigins: [env.VITE_PUBLIC_APP_URL, env.VITE_PUBLIC_BACKEND_URL],
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24 * 3,
    },
    socialProviders: getSocialProviders(env as unknown as Record<string, string>),
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        trustedProviders: ['google'],
      },
    },
    onAPIError: {
      errorURL: `${env.VITE_PUBLIC_APP_URL}/login`,
    },
  } satisfies BetterAuthOptions;
};

export const createAuth = () => {
  const config = createAuthConfig();

  return betterAuth({
    ...config,
    plugins: [mcp({ loginPage: env.VITE_PUBLIC_APP_URL + '/login' }), jwt(), bearer()],
    databaseHooks: {
      ...config.databaseHooks,
      account: {
        create: { after: connectionHandlerHook },
        update: { after: connectionHandlerHook },
      },
      session: {
        create: {
          ...config.databaseHooks.session.create,
          after: async (session) => {
            const db = await getZeroDB(session.userId);
            if (!(await db.findUserSettings())) {
              await db.insertUserSettings(defaultUserSettings);
            }
          },
        },
      },
    },
  });
};

export const createSimpleAuth = () => betterAuth(createAuthConfig());

export type Auth = ReturnType<typeof createAuth>;
export type SimpleAuth = ReturnType<typeof createSimpleAuth>;
