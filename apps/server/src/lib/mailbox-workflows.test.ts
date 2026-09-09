import { describe, expect, it, vi } from 'vitest';

vi.mock('./server-utils', () => ({ connectionToDriver: vi.fn(), getThreadsFromDB: vi.fn() }));

import { mailboxWorkflowInternals } from './mailbox-workflows';

const { cleanupCandidateSampleLimit, isCleanupThreadEligible, selectCleanupRunBatch } =
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

  it('scans past ineligible matches and caps each cleanup run at twenty threads', () => {
    const cutoff = new Date('2026-09-09T12:00:00.000Z');
    const active = Array.from({ length: 20 }, (_, index) => ({
      threadId: `active-${index}`,
      thread: { messages: [{ receivedOn: '2026-09-09T12:00:00.001Z' }] },
    }));
    const eligible = Array.from({ length: 25 }, (_, index) => ({
      threadId: `eligible-${index}`,
      thread: { messages: [{ receivedOn: '2026-09-08T12:00:00.000Z' }] },
    }));

    expect(selectCleanupRunBatch([...active, ...eligible], cutoff)).toEqual(
      eligible.slice(0, 20).map(({ threadId }) => threadId),
    );
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
