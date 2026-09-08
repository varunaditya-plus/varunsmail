import type { ParsedMessage } from '../types';

type ShardSql = {
  exec: (query: string, ...bindings: (string | number | null)[]) => Promise<{ array: unknown[] }>;
};

export async function hasCachedGmailThread(shard: ShardSql, threadId: string) {
  return (await shard.exec('SELECT id FROM threads WHERE id = ?', threadId)).array.length > 0;
}

export async function deleteCachedGmailThread(shard: ShardSql, threadId: string) {
  await shard.exec('DELETE FROM thread_labels WHERE thread_id = ?', threadId);
  await shard.exec('DELETE FROM threads WHERE id = ?', threadId);
}

export async function saveCachedGmailThread(
  shard: ShardSql,
  threadId: string,
  latest: ParsedMessage,
  labels: string[],
) {
  await shard.exec(
    'INSERT INTO threads (id, thread_id, provider_id, latest_sender, latest_received_on, latest_subject) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET latest_sender = excluded.latest_sender, latest_received_on = excluded.latest_received_on, latest_subject = excluded.latest_subject',
    threadId,
    threadId,
    'google',
    JSON.stringify(latest.sender),
    latest.receivedOn,
    latest.subject,
  );
  await shard.exec('DELETE FROM thread_labels WHERE thread_id = ?', threadId);
  for (const labelId of labels) {
    await shard.exec(
      'INSERT INTO labels (id, name, color) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
      labelId,
      labelId,
      '#000000',
    );
    await shard.exec(
      'INSERT INTO thread_labels (thread_id, label_id) VALUES (?, ?) ON CONFLICT(thread_id, label_id) DO NOTHING',
      threadId,
      labelId,
    );
  }
}
