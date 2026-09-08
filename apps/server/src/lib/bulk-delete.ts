import { env } from '../env';

export interface BulkDeleteResult {
  successful: number;
  failed: number;
}

export const bulkDeleteKeys = async (keys: string[]): Promise<BulkDeleteResult> => {
  const result = { successful: 0, failed: 0 };

  for (let offset = 0; offset < keys.length; offset += 50) {
    const deletions = await Promise.allSettled(
      keys.slice(offset, offset + 50).map((key) => env.gmail_processing_threads.delete(key)),
    );
    for (const deletion of deletions) {
      if (deletion.status === 'fulfilled') result.successful++;
      else result.failed++;
    }
  }

  return result;
};
