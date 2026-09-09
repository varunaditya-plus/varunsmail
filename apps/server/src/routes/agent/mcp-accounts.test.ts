import { describe, expect, it } from 'vitest';

import {
  type McpConnection,
  listMcpMailboxAccounts,
  resolveMcpMailboxAccount,
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
});
