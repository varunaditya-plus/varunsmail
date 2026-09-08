type CountCache = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>;
};

export async function cachedInboxThreadCount(
  connectionId: string,
  cache: CountCache,
  fetchCount: () => Promise<number>,
): Promise<number> {
  const key = `gmail_inbox_total_${connectionId}`;
  const cached = await cache.get(key);
  if (cached === 'unavailable') throw new Error('Gmail inbox total is temporarily unavailable');
  if (cached !== null) {
    const count = Number(cached);
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  let count: number;
  try {
    count = await fetchCount();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Gmail inbox total');
  } catch (error) {
    await cache.put(key, 'unavailable', { expirationTtl: 60 });
    throw error;
  }
  await cache.put(key, String(count), { expirationTtl: 60 });
  return count;
}

export function replaceInboxCount(
  counts: { label: string; count: number }[],
  inboxCount: number | undefined,
) {
  const result = counts.filter(({ label }) => label.toLowerCase() !== 'inbox');
  if (inboxCount !== undefined) result.push({ label: 'inbox', count: inboxCount });
  return result;
}
