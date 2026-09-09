import { OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it, vi } from 'vitest';

import {
  getMcpProtectedResourceMetadata,
  getOwnerMcpUserId,
  unauthorizedMcpResponse,
} from './private-access';

const ownerEmail = 'owner@example.com';

describe('MCP private access', () => {
  it('accepts an unexpired owner access token', async () => {
    const userId = await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), {
      ownerEmail,
      getMcpSession: async () => ({
        userId: 'owner-id',
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
      }),
      findUser: async () => ({ email: 'OWNER@example.com' }),
    });

    expect(userId).toBe('owner-id');
  });

  it('rejects an expired MCP access token before loading its user', async () => {
    const findUser = vi.fn(async () => ({ email: ownerEmail }));
    const userId = await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), {
      ownerEmail,
      getMcpSession: async () => ({
        userId: 'owner-id',
        accessTokenExpiresAt: new Date(Date.now() - 1),
      }),
      findUser,
    });

    expect(userId).toBeUndefined();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('rejects missing or serialized expiry data and non-owner access tokens', async () => {
    const missingExpiry = await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), {
      ownerEmail,
      getMcpSession: async () => ({ userId: 'owner-id' }),
      findUser: async () => ({ email: ownerEmail }),
    });
    const serializedExpiry = await getOwnerMcpUserId(
      new Headers({ Authorization: 'Bearer token' }),
      {
        ownerEmail,
        getMcpSession: async () => ({
          userId: 'owner-id',
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        findUser: async () => ({ email: ownerEmail }),
      },
    );
    const wrongOwner = await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), {
      ownerEmail,
      getMcpSession: async () => ({
        userId: 'other-id',
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
      }),
      findUser: async () => ({ email: 'other@example.com' }),
    });

    expect(missingExpiry).toBeUndefined();
    expect(serializedExpiry).toBeUndefined();
    expect(wrongOwner).toBeUndefined();
  });

  it('publishes protected-resource metadata for every MCP transport', () => {
    const metadata = getMcpProtectedResourceMetadata('https://mail.example.com/path');

    expect(OAuthProtectedResourceMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(metadata).toEqual({
      resource: 'https://mail.example.com/mcp',
      authorization_servers: ['https://mail.example.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', 'email'],
      resource_name: 'Varunsmail',
    });
  });

  it('returns a bearer challenge that points to protected-resource metadata', () => {
    const response = unauthorizedMcpResponse('https://mail.example.com/path');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource", scope="openid profile email"',
    );
  });
});
