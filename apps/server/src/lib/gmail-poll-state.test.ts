import { describe, expect, it, vi } from 'vitest';

import { pollGmailChanges, type GmailPollState } from './gmail-poll-state';

function options(state: GmailPollState | undefined, now = 600_000) {
  return {
    readState: vi.fn(async () => state),
    saveState: vi.fn(async () => undefined),
    profile: vi.fn(async () => ({ historyId: 'profile-history' })),
    history: vi.fn(async () => ({ historyId: 'next-history' })),
    threads: vi.fn(async () => ({ threads: [] })),
    cachedThreads: vi.fn(async () => ({ ids: [] })),
    enqueue: vi.fn(async () => undefined),
    connectionId: 'connection-1',
    now: () => now,
  };
}

describe('pollGmailChanges', () => {
  it('does not request unchanged Gmail history inside the polling interval', async () => {
    const setup = options({ historyId: 'current', lastHistoryAt: 500_000 });

    await pollGmailChanges(setup);

    expect(setup.history).not.toHaveBeenCalled();
    expect(setup.profile).not.toHaveBeenCalled();
  });

  it('requests history and advances the checkpoint when the interval expires', async () => {
    const setup = options({ historyId: 'current', lastHistoryAt: 100_000 });

    await pollGmailChanges(setup);

    expect(setup.history).toHaveBeenCalledWith('current', undefined);
    expect(setup.saveState).toHaveBeenCalledWith({
      historyId: 'next-history',
      historyPageToken: undefined,
      lastHistoryAt: 600_000,
    });
  });

  it('finishes paginated history immediately even inside the interval', async () => {
    const setup = options({
      historyId: 'current',
      historyPageToken: 'page-2',
      lastHistoryAt: 590_000,
    });

    await pollGmailChanges(setup);

    expect(setup.history).toHaveBeenCalledWith('current', 'page-2');
  });
});
