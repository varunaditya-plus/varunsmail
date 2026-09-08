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
  if (folder !== 'snoozed') {
    const response = await sources.live({
      folder,
      query: q,
      // A timestamp from the old local cache is not a Gmail page token.
      pageToken: liveCursor
        ? cursor.slice('gmail:'.length)
        : /^\d{4}-\d{2}-\d{2}T/.test(cursor)
          ? undefined
          : cursor || undefined,
      maxResults,
      labelIds,
    });
    return {
      ...response,
      nextPageToken: response.nextPageToken ? `gmail:${response.nextPageToken}` : null,
    };
  }
  return sources.cache({
    folder,
    pageToken: liveCursor ? '' : cursor,
    maxResults,
    labelIds,
    ...(q ? { q } : {}),
  });
}
