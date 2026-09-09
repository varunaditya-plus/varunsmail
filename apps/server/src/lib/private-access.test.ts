import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it, vi } from 'vitest';

import {
  getMcpAuthorizationServerMetadata,
  getMcpPluginOptions,
  getMcpProtectedResourceMetadata,
  getOwnerMcpUserId,
  MCP_AUTHORIZATION_SCOPES,
  MCP_FULL_MAIL_SCOPE,
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
        scopes: `openid ${MCP_FULL_MAIL_SCOPE}`,
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
        scopes: MCP_FULL_MAIL_SCOPE,
      }),
      findUser,
    });

    expect(userId).toBeUndefined();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('rejects missing or serialized expiry data and non-owner access tokens', async () => {
    const missingExpiry = await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), {
      ownerEmail,
      getMcpSession: async () => ({ userId: 'owner-id', scopes: MCP_FULL_MAIL_SCOPE }),
      findUser: async () => ({ email: ownerEmail }),
    });
    const serializedExpiry = await getOwnerMcpUserId(
      new Headers({ Authorization: 'Bearer token' }),
      {
        ownerEmail,
        getMcpSession: async () => ({
          userId: 'owner-id',
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopes: MCP_FULL_MAIL_SCOPE,
        }),
        findUser: async () => ({ email: ownerEmail }),
      },
    );
    const wrongOwner = await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), {
      ownerEmail,
      getMcpSession: async () => ({
        userId: 'other-id',
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        scopes: MCP_FULL_MAIL_SCOPE,
      }),
      findUser: async () => ({ email: 'other@example.com' }),
    });

    expect(missingExpiry).toBeUndefined();
    expect(serializedExpiry).toBeUndefined();
    expect(wrongOwner).toBeUndefined();
  });

  it('requires the exact full-mail scope before loading the owner', async () => {
    const findUser = vi.fn(async () => ({ email: ownerEmail }));
    const options = {
      ownerEmail,
      getMcpSession: async () => ({
        userId: 'owner-id',
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        scopes: 'openid mail:fuller',
      }),
      findUser,
    };

    expect(
      await getOwnerMcpUserId(new Headers({ Authorization: 'Bearer token' }), options),
    ).toBeUndefined();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('configures Better Auth to accept the full-mail scope for dynamic clients', () => {
    expect(getMcpPluginOptions('https://mail.example.com/login')).toEqual({
      loginPage: 'https://mail.example.com/login',
      oidcConfig: {
        loginPage: 'https://mail.example.com/login',
        allowDynamicClientRegistration: true,
        scopes: [MCP_FULL_MAIL_SCOPE],
        defaultScope: `openid ${MCP_FULL_MAIL_SCOPE}`,
        metadata: { scopes_supported: MCP_AUTHORIZATION_SCOPES },
      },
    });
  });

  it('adds the full-mail scope to standards-compatible authorization metadata', () => {
    const metadata = getMcpAuthorizationServerMetadata({
      issuer: 'https://mail.example.com',
      authorization_endpoint: 'https://mail.example.com/api/auth/mcp/authorize',
      token_endpoint: 'https://mail.example.com/api/auth/mcp/token',
      registration_endpoint: 'https://mail.example.com/api/auth/mcp/register',
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid'],
    });

    expect(OAuthMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(metadata?.scopes_supported).toEqual(MCP_AUTHORIZATION_SCOPES);
  });

  it('publishes protected-resource metadata for every MCP transport', () => {
    const metadata = getMcpProtectedResourceMetadata('https://mail.example.com/path');

    expect(OAuthProtectedResourceMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(metadata).toEqual({
      resource: 'https://mail.example.com/mcp',
      authorization_servers: ['https://mail.example.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: [MCP_FULL_MAIL_SCOPE],
      resource_name: 'Varunsmail',
    });
  });

  it('returns a bearer challenge that points to protected-resource metadata', () => {
    const response = unauthorizedMcpResponse('https://mail.example.com/path');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource", scope="${MCP_FULL_MAIL_SCOPE}"`,
    );
  });
});
