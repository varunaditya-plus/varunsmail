import { describe, expect, it } from 'vitest';

import { searchAcrossAccounts } from './cross-account-search';

const accounts = [
  { id: 'work', email: 'work@example.com', name: 'Work' },
  { id: 'personal', email: 'me@example.com', name: 'Personal' },
];

describe('cross-account mailbox search', () => {
it('merges ranked results across accounts and keeps account-scoped thread identities', async () => {
  const result = await searchAcrossAccounts(
    accounts,
    { query: 'receipts', folder: 'inbox', maxResults: 3 },
    {
      search: async (connectionId) => ({
        threadIds: connectionId === 'work' ? ['shared', 'work-2'] : ['shared', 'personal-2'],
        source: connectionId === 'work' ? 'autorag' : 'raw',
      }),
      loadThread: async (connectionId, threadId) => ({
        latest: {
          subject: `${connectionId}:${threadId}`,
          sender: { name: 'Sender', email: 'sender@example.com' },
          receivedOn: '2026-09-09T10:00:00.000Z',
          decodedBody: '<p>Exact <strong>matching</strong> content</p>',
        },
      }),
    },
  );

  expect(
    result.sources.map((source) => `${source.connectionId}:${source.threadId}`),
  ).toEqual(['work:shared', 'personal:shared', 'work:work-2']);
  expect(result.sources.map((source) => source.provenance)).toEqual([
    'semantic',
    'provider',
    'semantic',
  ]);
  expect(result.sources[0].excerpt).toBe('Exact matching content');
});

it('returns results from healthy accounts when another account search fails', async () => {
  const result = await searchAcrossAccounts(
    accounts,
    { query: 'travel', folder: 'inbox', maxResults: 5 },
    {
      search: async (connectionId) => {
        if (connectionId === 'work') throw new Error('token expired');
        return { threadIds: ['flight'], source: 'raw' };
      },
      loadThread: async () => ({ latest: { subject: 'Flight confirmation' } }),
    },
  );

  expect(result.searchedAccounts).toBe(1);
  expect(result.totalAccounts).toBe(2);
  expect(result.sources[0].threadId).toBe('flight');
  expect(result.failures).toEqual([
    {
      connectionId: 'work',
      accountEmail: 'work@example.com',
      reason: 'Search unavailable',
    },
  ]);
});

it('preserves the exact source reference when thread details cannot be loaded', async () => {
  const result = await searchAcrossAccounts(
    [accounts[0]],
    { query: 'invoice', folder: 'inbox', maxResults: 1 },
    {
      search: async () => ({ threadIds: ['invoice-1'], source: 'autorag' }),
      loadThread: async () => {
        throw new Error('temporarily unavailable');
      },
    },
  );

  expect(result.sources[0].threadId).toBe('invoice-1');
  expect(result.sources[0].connectionId).toBe('work');
  expect(result.sources[0].unavailable).toBe(true);
  expect(result.unavailableSources).toBe(1);
});

it('grounds a source in the matching message rather than an unrelated latest reply', async () => {
  const result = await searchAcrossAccounts(
    [accounts[0]],
    { query: 'flight confirmation code', folder: 'all', maxResults: 1 },
    {
      search: async () => ({ threadIds: ['travel'], source: 'raw' }),
      loadThread: async () => ({
        latest: { subject: 'Re: Flight', decodedBody: '<p>Thanks!</p>' },
        messages: [
          {
            subject: 'Flight confirmation',
            sender: { name: 'Airline', email: 'travel@example.com' },
            receivedOn: '2026-09-08T10:00:00.000Z',
            decodedBody: '<p>Your flight confirmation code is BCN123.</p>',
          },
          { subject: 'Re: Flight', decodedBody: '<p>Thanks!</p>' },
        ],
      }),
    },
  );

  expect(result.sources[0].excerpt).toContain('BCN123');
  expect(result.sources[0].sender.email).toBe('travel@example.com');
});
});
