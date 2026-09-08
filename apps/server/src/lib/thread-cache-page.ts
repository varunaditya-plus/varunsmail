import type { IGetThreadsResponse } from './driver/types';

export function mergeThreadCachePages(
  pages: IGetThreadsResponse[],
  maxResults: number,
): IGetThreadsResponse {
  const receivedOn = (thread: IGetThreadsResponse['threads'][number]) =>
    (thread.$raw as { latestReceivedOn?: string } | undefined)?.latestReceivedOn ?? '';
  const sorted = pages
    .flatMap((page) => page.threads)
    .sort((a, b) => receivedOn(b).localeCompare(receivedOn(a)));
  const seen = new Set<string>();
  const unique = sorted.filter((thread) => {
    if (seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  });
  const selected = unique.slice(0, maxResults);
  const hasMore = unique.length > maxResults || pages.some((page) => page.nextPageToken);
  return {
    threads: selected.map(({ id, historyId }) => ({ id, historyId })),
    nextPageToken:
      hasMore && selected.length ? receivedOn(selected[selected.length - 1]) || null : null,
  };
}
