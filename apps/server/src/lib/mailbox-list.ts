import type { IGetThreadsResponse } from './driver/types';

type ListInput = {
  folder: string;
  q: string;
  cursor: string;
  maxResults: number;
  labelIds: string[];
};

export async function listMailboxThreads(
  input: ListInput,
  sources: {
    live: (params: {
      folder: string;
      query: string;
      pageToken?: string;
      maxResults: number;
      labelIds: string[];
    }) => Promise<IGetThreadsResponse>;
    cache: (params: {
      folder: string;
      pageToken: string;
      maxResults: number;
      labelIds: string[];
      q?: string;
    }) => Promise<IGetThreadsResponse>;
  },
): Promise<IGetThreadsResponse> {
  const { folder, q, cursor, maxResults, labelIds } = input;
  const liveCursor = cursor.startsWith('gmail:');
  if (liveCursor) {
    const response = await sources.live({
      folder,
      query: q,
      pageToken: cursor.slice('gmail:'.length),
      maxResults,
      labelIds,
    });
    return {
      ...response,
      nextPageToken: response.nextPageToken ? `gmail:${response.nextPageToken}` : null,
    };
  }

  const cached = await sources.cache({
    folder,
    pageToken: cursor,
    maxResults,
    labelIds,
    ...(q ? { q } : {}),
  });
  if (cached.threads.length || cursor || folder !== 'inbox' || q || labelIds.length) return cached;

  // A newly connected mailbox may not have produced its first cached page yet.
  const response = await sources.live({ folder, query: q, maxResults, labelIds });
  return {
    ...response,
    nextPageToken: response.nextPageToken ? `gmail:${response.nextPageToken}` : null,
  };
}
