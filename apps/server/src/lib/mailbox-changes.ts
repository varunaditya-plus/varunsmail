export async function runMailboxChanges<T>(tasks: (() => Promise<T>)[], concurrency = 4): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const errors: unknown[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        errors.push(error);
      }
    }
  }));
  if (errors.length) throw new AggregateError(errors, `${errors.length} of ${tasks.length} mailbox changes failed. Completed changes were kept.`);
  return results;
}
