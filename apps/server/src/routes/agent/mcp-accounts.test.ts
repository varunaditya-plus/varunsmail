import { describe, expect, it } from 'vitest';

import {
  type McpConnection,
  getDefaultConnectionAfterDisconnect,
  isMcpSendAsAllowed,
  listMcpMailboxAccounts,
  mcpDraftMatchesAccount,
  resolveMcpMailboxAccount,
  scopeMcpDraftQuery,
} from './mcp-accounts';

const connections: McpConnection[] = [
  {
    id: 'primary',
    email: 'varunaditya.aga@gmail.com',
    name: 'Primary',
    picture: null,
    providerId: 'google',
    accessToken: 'access',
    refreshToken: 'refresh',
  },
  {
    id: 'second',
    email: 'second@gmail.com',
    name: 'Second',
    picture: null,
    providerId: 'google',
    accessToken: 'access',
    refreshToken: 'refresh',
  },
];

describe('MCP mailbox accounts', () => {
  it('lists real connections and the configured alias without exposing credentials', () => {
    const accounts = listMcpMailboxAccounts(connections, 'second');

    expect(accounts.map(({ id }) => id)).toEqual(['primary', 'second', 'alias:barcelonahackathon']);
    expect(accounts[1].isDefault).toBe(true);
    expect(accounts[2]).toMatchObject({
      connectionId: 'primary',
      email: 'varun@barcelonahackathon.com',
      fromEmail: 'varun@barcelonahackathon.com',
      labelName: 'barcelonahackathon',
      kind: 'alias',
    });
    expect(JSON.stringify(accounts)).not.toContain('refresh');
  });

  it('resolves every call by connection ID or email instead of mutable active state', () => {
    expect(resolveMcpMailboxAccount(connections, 'primary', 'second@gmail.com').connectionId).toBe(
      'second',
    );
    expect(
      resolveMcpMailboxAccount(connections, 'primary', 'alias:barcelonahackathon'),
    ).toMatchObject({
      connectionId: 'primary',
      fromEmail: 'varun@barcelonahackathon.com',
    });
    expect(resolveMcpMailboxAccount(connections, 'second').connectionId).toBe('second');
  });

  it('rejects an account outside the owner account list', () => {
    expect(() => resolveMcpMailboxAccount(connections, 'primary', 'someone-else')).toThrow(
      'Mailbox account not found',
    );
  });

  it('keeps or chooses a valid physical default after disconnecting', () => {
    expect(getDefaultConnectionAfterDisconnect(connections, 'second', 'primary')).toBe('second');
    expect(getDefaultConnectionAfterDisconnect(connections, 'primary', 'primary')).toBe('second');
    expect(getDefaultConnectionAfterDisconnect(connections, null, 'second')).toBe('primary');
  });

  it('scopes alias drafts by From and rejects source-account drafts', () => {
    const alias = listMcpMailboxAccounts(connections, 'primary').at(-1)!;
    const aliasDraft = {
      rawMessage: {
        payload: {
          headers: [{ name: 'From', value: 'Barcelona <varun@barcelonahackathon.com>' }],
        },
      },
    };
    const primaryDraft = {
      rawMessage: {
        payload: { headers: [{ name: 'from', value: 'varunaditya.aga@gmail.com' }] },
      },
    };

    expect(scopeMcpDraftQuery('subject:test', alias)).toBe(
      'subject:test from:varun@barcelonahackathon.com',
    );
    expect(mcpDraftMatchesAccount(aliasDraft, alias)).toBe(true);
    expect(mcpDraftMatchesAccount(primaryDraft, alias)).toBe(false);
    expect(mcpDraftMatchesAccount({}, alias)).toBe(false);
  });

  it('validates display-name From values against provider send-as aliases', () => {
    const aliases = [
      { email: 'varunaditya.aga@gmail.com' },
      { email: 'varun@barcelonahackathon.com' },
    ];

    expect(isMcpSendAsAllowed(aliases, 'Varun <varun@barcelonahackathon.com>')).toBe(true);
    expect(isMcpSendAsAllowed(aliases, 'spoof@example.com')).toBe(false);
  });
});
