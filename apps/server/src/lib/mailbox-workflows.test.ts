import { describe, expect, it, vi } from 'vitest';

vi.mock('./server-utils', () => ({ connectionToDriver: vi.fn(), getThreadsFromDB: vi.fn() }));

import { mailboxWorkflowInternals } from './mailbox-workflows';

const { cleanupCandidateSampleLimit, isCleanupThreadEligible, takeCleanupRunBatch } =
  mailboxWorkflowInternals;

describe('sender cleanup safety', () => {
  it('uses the latest non-draft message for the exact age cutoff', () => {
    const cutoff = new Date('2026-09-09T12:00:00.000Z');

    expect(
      isCleanupThreadEligible(
        {
          messages: [
            { receivedOn: '2026-09-08T12:00:00.000Z' },
            { receivedOn: '2026-09-10T12:00:00.000Z', isDraft: true },
          ],
        },
        cutoff,
      ),
    ).toBe(true);
    expect(
      isCleanupThreadEligible({ messages: [{ receivedOn: '2026-09-09T12:00:00.000Z' }] }, cutoff),
    ).toBe(true);
    expect(
      isCleanupThreadEligible({ messages: [{ receivedOn: '2026-09-09T12:00:00.001Z' }] }, cutoff),
    ).toBe(false);
    expect(
      isCleanupThreadEligible(
        {
          messages: [
            { receivedOn: '2026-09-09T12:00:00.001Z' },
            { receivedOn: '2026-09-08T12:00:00.000Z' },
          ],
        },
        cutoff,
      ),
    ).toBe(false);
    expect(isCleanupThreadEligible({ messages: [{ receivedOn: 'unknown' }] }, cutoff)).toBe(false);
  });

  it('caps each cleanup run at twenty threads', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `thread-${index}`);

    expect(takeCleanupRunBatch(ids)).toEqual(ids.slice(0, 20));
  });

  it('caps the recent candidate sample across any number of mailboxes', () => {
    const threeMailboxes = Array.from({ length: 3 }, (_, index) =>
      cleanupCandidateSampleLimit(index, 3),
    );
    const manyMailboxes = Array.from({ length: 150 }, (_, index) =>
      cleanupCandidateSampleLimit(index, 150),
    );

    expect(threeMailboxes).toEqual([34, 33, 33]);
    expect(threeMailboxes.reduce((total, count) => total + count, 0)).toBe(100);
    expect(manyMailboxes.reduce((total, count) => total + count, 0)).toBe(100);
  });
});
