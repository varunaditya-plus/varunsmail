import { describe, expect, it } from 'vitest';
import {
  decodeUnifiedInboxCursor,
  mergeUnifiedInboxPages,
  type UnifiedInboxPage,
} from '../src/lib/unified-inbox';
import { mergeThreadCachePages } from '../src/lib/thread-cache-page';
import { decodeThreadCursor } from '../src/lib/thread-cursor';

function page(
  connectionId: string,
  threads: [id: string, receivedOn: string][],
  nextPageToken: string | null = null,
): UnifiedInboxPage {
  return {
    connection: {
      id: connectionId,
      email: `${connectionId}@example.com`,
      name: connectionId,
      picture: null,
    },
    page: {
      threads: threads.map(([id, receivedOn]) => ({
        id,
        historyId: null,
        $raw: { latestReceivedOn: receivedOn },
      })),
      nextPageToken,
    },
  };
}

describe('unified inbox pagination', () => {
  it('merges interleaved accounts in a stable global order', () => {
    const result = mergeUnifiedInboxPages(
      [
        page('a', [
          ['a-1', '2026-09-09T12:00:00.000Z'],
          ['a-2', '2026-09-09T10:00:00.000Z'],
        ]),
        page('b', [
          ['b-1', '2026-09-09T11:00:00.000Z'],
          ['b-2', '2026-09-09T09:00:00.000Z'],
        ]),
      ],
      {},
      4,
    );

    expect(result.threads.map((thread) => thread.key)).toEqual([
      'a:a-1',
      'b:b-1',
      'a:a-2',
      'b:b-2',
    ]);
  });

  it('keeps identical Gmail IDs distinct between accounts', () => {
    const result = mergeUnifiedInboxPages(
      [
        page('a', [['same-id', '2026-09-09T12:00:00.000Z']]),
        page('b', [['same-id', '2026-09-09T12:00:00.000Z']]),
      ],
      {},
      10,
    );

    expect(result.threads.map((thread) => thread.key)).toEqual(['a:same-id', 'b:same-id']);
  });

  it('advances only the account represented in the emitted page', () => {
    const result = mergeUnifiedInboxPages(
      [
        page('a', [['newest', '2026-09-09T12:00:00.000Z']], 'more-a'),
        page('b', [['later', '2026-09-09T11:00:00.000Z']], 'more-b'),
      ],
      { b: 'unchanged-b-cursor' },
      1,
    );
    const cursor = decodeUnifiedInboxCursor(result.nextPageToken!);

    expect(decodeThreadCursor(cursor.a)).toEqual({
      receivedOn: '2026-09-09T12:00:00.000Z',
      threadId: 'newest',
    });
    expect(cursor.b).toBe('unchanged-b-cursor');
  });

  it('uses the thread ID to paginate equal timestamps', () => {
    const result = mergeThreadCachePages(
      [
        {
          threads: [
            { id: 'a', historyId: null, $raw: { latestReceivedOn: '2026-09-09' } },
            { id: 'c', historyId: null, $raw: { latestReceivedOn: '2026-09-09' } },
            { id: 'b', historyId: null, $raw: { latestReceivedOn: '2026-09-09' } },
          ],
          nextPageToken: 'more',
        },
      ],
      2,
    );

    expect(result.threads.map((thread) => thread.id)).toEqual(['c', 'b']);
    expect(decodeThreadCursor(result.nextPageToken!)).toEqual({
      receivedOn: '2026-09-09',
      threadId: 'b',
    });
  });

  it('rejects malformed unified cursors', () => {
    expect(() => decodeUnifiedInboxCursor('{"version":2}')).toThrow('Invalid unified inbox cursor');
  });
});
