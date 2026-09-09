import { describe, expect, it, vi } from 'vitest';

import { listMailboxThreads } from './mailbox-list';

const input = {
  folder: 'inbox',
  q: '',
  cursor: '',
  maxResults: 50,
  labelIds: [],
};

function sources(cachedThreads: { id: string }[] = []) {
  return {
    live: vi.fn(async () => ({
      threads: [{ id: 'live', historyId: null }],
      nextPageToken: 'next-live',
    })),
    cache: vi.fn(async () => ({
      threads: cachedThreads.map(({ id }) => ({ id, historyId: null })),
      nextPageToken: cachedThreads.length ? 'next-cache' : null,
    })),
  };
}

describe('listMailboxThreads', () => {
  it('serves synchronized mailbox pages without calling Gmail', async () => {
    const providers = sources([{ id: 'cached' }]);

    const result = await listMailboxThreads(input, providers);

    expect(result.threads[0]?.id).toBe('cached');
    expect(providers.live).not.toHaveBeenCalled();
  });

  it('uses Gmail only before a new inbox has its first cached page', async () => {
    const providers = sources();

    const result = await listMailboxThreads(input, providers);

    expect(result.threads[0]?.id).toBe('live');
    expect(result.nextPageToken).toBe('gmail:next-live');
  });

  it('does not bypass the cache for an empty search result', async () => {
    const providers = sources();

    const result = await listMailboxThreads({ ...input, q: 'missing' }, providers);

    expect(result.threads).toEqual([]);
    expect(providers.live).not.toHaveBeenCalled();
  });

  it('continues legacy Gmail pagination until its cursor is exhausted', async () => {
    const providers = sources([{ id: 'cached' }]);

    await listMailboxThreads({ ...input, cursor: 'gmail:page-2' }, providers);

    expect(providers.cache).not.toHaveBeenCalled();
    expect(providers.live).toHaveBeenCalledWith({
      folder: 'inbox',
      query: '',
      pageToken: 'page-2',
      maxResults: 50,
      labelIds: [],
    });
  });
});
