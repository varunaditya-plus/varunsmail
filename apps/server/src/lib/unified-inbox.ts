import type { IGetThreadsResponse, ThreadListItem } from './driver/types';

export type UnifiedInboxCursor = Record<string, string>;

export type UnifiedInboxPage = {
  connection: {
    id: string;
    email: string;
    name: string | null;
    picture: string | null;
  };
  page: IGetThreadsResponse;
};

export function encodeUnifiedInboxCursor(cursor: UnifiedInboxCursor) {
  return JSON.stringify({ version: 1, connections: cursor });
}

export function decodeUnifiedInboxCursor(value?: string): UnifiedInboxCursor {
  if (!value) return {};

  const parsed = JSON.parse(value) as { version?: unknown; connections?: unknown };
  if (parsed.version !== 1 || !parsed.connections || typeof parsed.connections !== 'object') {
    throw new Error('Invalid unified inbox cursor');
  }

  const connections: UnifiedInboxCursor = {};
  for (const [connectionId, cursor] of Object.entries(parsed.connections)) {
    if (typeof cursor !== 'string') throw new Error('Invalid unified inbox cursor');
    connections[connectionId] = cursor;
  }
  return connections;
}

function receivedOn(thread: ThreadListItem) {
  return (
    thread.receivedOn ??
    (thread.$raw as { latestReceivedOn?: string } | undefined)?.latestReceivedOn ??
    ''
  );
}

export function mergeUnifiedInboxPages(
  pages: UnifiedInboxPage[],
  previousCursor: UnifiedInboxCursor,
  maxResults: number,
): IGetThreadsResponse {
  const candidates = pages
    .flatMap(({ connection, page }) =>
      page.threads.map((thread) => ({
        ...thread,
        connectionId: connection.id,
        key: `${connection.id}:${thread.id}`,
        receivedOn: receivedOn(thread),
        account: connection,
      })),
    )
    .sort((a, b) => {
      const dateOrder = b.receivedOn.localeCompare(a.receivedOn);
      if (dateOrder) return dateOrder;
      const connectionOrder = a.connectionId.localeCompare(b.connectionId);
      return connectionOrder || b.id.localeCompare(a.id);
    });

  const seen = new Set<string>();
  const unique = candidates.filter((thread) => {
    if (seen.has(thread.key)) return false;
    seen.add(thread.key);
    return true;
  });
  const threads = unique.slice(0, maxResults);
  const nextCursor = { ...previousCursor };

  for (const thread of threads) {
    nextCursor[thread.connectionId] = JSON.stringify([thread.receivedOn, thread.id]);
  }

  const hasMore =
    unique.length > threads.length || pages.some(({ page }) => Boolean(page.nextPageToken));

  return {
    threads,
    nextPageToken: hasMore && threads.length ? encodeUnifiedInboxCursor(nextCursor) : null,
  };
}
