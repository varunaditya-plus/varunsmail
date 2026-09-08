import type { GmailPollJob } from './gmail-poll-state';
import type { ZeroEnv } from '../env';

type RefreshEnv = Pick<ZeroEnv, 'gmail_sync_queue' | 'WORKFLOW_RUNNER' | 'gmail_processing_threads'>;

export async function refreshGmailThread(
  env: RefreshEnv,
  connectionId: string,
  threadId: string,
): Promise<boolean> {
  const job: GmailPollJob = {
    type: 'gmail-poll-thread', connectionId, threadId, index: false, notify: true,
  };
  // Retain a retry before attempting an immediate refresh. Gmail has already
  // accepted the action; cache failures must not cause callers to repeat it.
  try {
    await env.gmail_sync_queue.send(job, { contentType: 'json' });
  } catch {
    console.error('[Gmail mutation] Could not queue cache reconciliation');
  }
  try {
    await env.gmail_processing_threads.delete(`gmail_inbox_total_${connectionId}`);
    const runner = env.WORKFLOW_RUNNER.get(
      env.WORKFLOW_RUNNER.idFromName(`gmail-thread:${connectionId}:${threadId}`),
    );
    return (await runner.processPolledThread(job)) === undefined;
  } catch {
    console.error('[Gmail mutation] Cache reconciliation is pending');
    return false;
  }
}

export async function applyGmailChange<T>(
  env: RefreshEnv,
  connectionId: string,
  threadId: string,
  change: () => Promise<T>,
) {
  const result = await change();
  const synced = await refreshGmailThread(env, connectionId, threadId);
  return { result, syncPending: !synced };
}
