import {
  indexPolledThread,
  normalizeGmailThread,
  persistPolledThread,
  type PollIndexCheckpoint,
  gmailThreadFolderLabels,
  refreshGmailMetadata,
  processPendingGmailIndex,
  type GmailThreadMetadata,
  applyLocalSnooze,
} from './gmail-poll-thread';
import {
  GmailPollError,
  pollGmailChanges,
  type GmailPollJob,
  type GmailPollState,
  importGmailInbox,
  type GmailInboxImportState,
} from './gmail-poll-state';
import {
  aggregateShardDataEffect,
  connectionToDriver,
  getZeroAgent,
  getZeroSocketAgent,
  sendDoState,
} from './server-utils';
import {
  createDefaultWorkflows,
  type WorkflowContext,
} from '../thread-workflow-utils/workflow-engine';
import { OutgoingMessageType } from '../routes/agent/types';
import type { IGetThreadResponse } from './driver/types';
import { hasCachedGmailThread } from './gmail-poll-sql';
import { OAuth2Client } from 'google-auth-library';
import { connection } from '../db/schema';
import type { ZeroEnv } from '../env';
import { eq } from 'drizzle-orm';
import { createDb } from '../db';
import { Effect } from 'effect';
import { applyMailboxWorkflowPolicy } from './mailbox-workflows';
import { setMailboxSyncStatus } from './mailbox-activity';

const getConnection = async (env: ZeroEnv, connectionId: string) => {
  const { db } = createDb(env.DB);
  return db.query.connection.findFirst({ where: eq(connection.id, connectionId) });
};

export async function queueGmailRefresh(env: ZeroEnv, job: GmailPollJob) {
  await env.gmail_sync_queue.send(job, { contentType: 'json' });
}

const gmailRequest = (env: ZeroEnv, refreshToken: string) => {
  const oauth = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: refreshToken });
  return async <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const { token } = await oauth.getAccessToken();
    if (!token) throw new Error('Google did not return an access token');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const error = await response
        .json<{ error?: { errors?: { reason?: string }[] } }>()
        .catch(() => undefined);
      const quota =
        response.status === 429 ||
        (error?.error?.errors ?? []).some(({ reason }) =>
          [
            'userRateLimitExceeded',
            'rateLimitExceeded',
            'quotaExceeded',
            'dailyLimitExceeded',
          ].includes(reason ?? ''),
        );
      throw new GmailPollError(response.status, quota);
    }
    return response.json<T>();
  };
};

export async function pollGoogleMailbox(
  env: ZeroEnv,
  storage: DurableObjectStorage,
  connectionId: string,
) {
  const mailbox = await getConnection(env, connectionId);
  if (mailbox?.providerId !== 'google' || !mailbox.refreshToken) return;
  await setMailboxSyncStatus(env, connectionId, 'syncing').catch((error) =>
    console.error('[GMAIL_POLL] Could not record sync start', error),
  );
  try {
    const request = gmailRequest(env, mailbox.refreshToken);
    const backfillCount = String(
      Math.max(1, Math.min(100, Number(env.GMAIL_POLL_BACKFILL_COUNT) || 10)),
    );
    await pollGmailChanges({
      connectionId,
      readState: () => storage.get<GmailPollState>('gmail-poll-state'),
      saveState: (state) => storage.put('gmail-poll-state', state),
      profile: () => request('profile'),
      history: (historyId, pageToken) =>
        request('history', { startHistoryId: historyId, pageToken, maxResults: '100' }),
      threads: (pageToken) =>
        request('threads', { pageToken, maxResults: backfillCount, includeSpamTrash: 'true' }),
      cachedThreads: async (cursor) => {
        const prefix = `${connectionId}/`;
        const page = await env.THREADS_BUCKET.list({ prefix, cursor, limit: Number(backfillCount) });
        return {
          ids: page.objects
            .filter(({ key }) => key.endsWith('.json'))
            .map(({ key }) => key.slice(prefix.length, -5)),
          cursor: page.truncated ? page.cursor : undefined,
        };
      },
      enqueue: async (jobs) => {
        await env.thread_queue.sendBatch(jobs.map((body) => ({ body, contentType: 'json' })));
      },
      enqueueHistory: async (jobs) => {
        await env.gmail_sync_queue.sendBatch(jobs.map((body) => ({ body, contentType: 'json' })));
      },
      canBackfill: async () => {
        try {
          const [cache, index] = await Promise.all([
            env.thread_queue.metrics(),
            env.gmail_index_queue.metrics(),
          ]);
          return cache.backlogCount < 1000 && index.backlogCount < 100;
        } catch {
          return false;
        }
      },
    });
    await setMailboxSyncStatus(env, connectionId, 'healthy');
  } catch (error) {
    await setMailboxSyncStatus(env, connectionId, 'error', error).catch((statusError) =>
      console.error('[GMAIL_POLL] Could not record sync failure', statusError),
    );
    throw error;
  }
}

type ShardClient = Awaited<ReturnType<typeof getZeroAgent>>;

export async function importGoogleInbox(
  env: ZeroEnv,
  storage: DurableObjectStorage,
  connectionId: string,
) {
  const mailbox = await getConnection(env, connectionId);
  if (mailbox?.providerId !== 'google' || !mailbox.refreshToken)
    throw new Error('Gmail connection is not authorized');
  const request = gmailRequest(env, mailbox.refreshToken);
  return importGmailInbox({
    connectionId,
    readState: () => storage.get<GmailInboxImportState>('gmail-inbox-import'),
    saveState: (state) => storage.put('gmail-inbox-import', state),
    threads: (pageToken) => request('threads', { pageToken, maxResults: '500', labelIds: 'INBOX' }),
    enqueue: async (jobs) => {
      await env.thread_queue.sendBatch(jobs.map((body) => ({ body, contentType: 'json' })));
    },
  });
}

export async function refreshPolledThread(
  env: ZeroEnv,
  storage: DurableObjectStorage,
  job: GmailPollJob,
) {
  const mailbox = await getConnection(env, job.connectionId);
  if (mailbox?.providerId !== 'google' || !mailbox.refreshToken) return;
  const threadKey = `${job.connectionId}/${job.threadId}.json`;
  if (job.indexOnly) {
    await processPendingGmailIndex({
      readCheckpoint: () => storage.get<PollIndexCheckpoint>('poll-index-checkpoint'),
      readThread: async () => {
        const cached = await env.THREADS_BUCKET.get(threadKey);
        return cached ? cached.json<IGetThreadResponse>() : undefined;
      },
      clearCheckpoint: async () => {
        await storage.delete('poll-index-checkpoint');
      },
      indexThread: async (thread, forceSummary) => {
        const engine = createDefaultWorkflows();
        const context: WorkflowContext = {
          connectionId: job.connectionId,
          threadId: job.threadId,
          thread: normalizeGmailThread(thread, job.connectionId, job.threadId, new Map()),
          foundConnection: mailbox,
          results: new Map(),
          env,
          forceSummary,
        };
        try {
          await indexPolledThread(context, (prepared) =>
            engine.executeWorkflowChain(['message-vectorization', 'thread-summary'], prepared),
          );
        } finally {
          engine.clearContext(context);
        }
      },
    });
    return;
  }
  const request = gmailRequest(env, mailbox.refreshToken);
  const cached = await env.THREADS_BUCKET.get(threadKey);
  const previous = cached ? await cached.json<IGetThreadResponse>() : undefined;
  let deleted = false;
  let internalDates = new Map<string, string>();
  let refreshed: IGetThreadResponse | undefined;
  if (previous) {
    try {
      const metadata = await request<GmailThreadMetadata>(
        `threads/${encodeURIComponent(job.threadId)}`,
        { format: 'minimal' },
      );
      internalDates = new Map(
        metadata.messages
          ?.filter((message) => message.internalDate)
          .map(({ id, internalDate }) => [id, internalDate!]),
      );
      refreshed = refreshGmailMetadata(previous, metadata);
    } catch (error) {
      if (!(error instanceof GmailPollError) || error.status !== 404) throw error;
      deleted = true;
    }
  } else {
    try {
      refreshed = await connectionToDriver(mailbox).get(job.threadId);
    } catch (error) {
      if (gmailPollFailure(error).status !== 404) throw error;
      deleted = true;
    }
  }

  const active = await getZeroAgent(job.connectionId);
  const existing = await Effect.runPromise(
    aggregateShardDataEffect<{ shard: ShardClient; found: boolean }[]>(
      job.connectionId,
      (shard) =>
        Effect.promise(async () => [
          {
            shard,
            found: await hasCachedGmailThread(shard, job.threadId),
          },
        ]),
      (rows) => rows.flat(),
    ),
  );
  const targets = existing.filter(({ found }) => found).map(({ shard }) => shard);
  if (!targets.length && !deleted) targets.push(active);

  const removedMessageIds = new Set(job.deletedMessageIds ?? []);
  const removeVectors = async () => {
    const ids = [...removedMessageIds];
    for (let offset = 0; offset < ids.length; offset += 100) {
      await env.VECTORIZE_MESSAGE.deleteByIds(ids.slice(offset, offset + 100));
    }
  };
  const notify = async (labelIds: string[] = []) => {
    if (!job.notify) return;
    const socket = await getZeroSocketAgent(job.connectionId);
    await socket.invalidateDoStateCache();
    await socket.broadcastChatMessage({
      type: OutgoingMessageType.Mail_Get,
      threadId: job.threadId,
    });
    const folders = new Set([
      'inbox',
      'sent',
      'archive',
      'bin',
      'spam',
      'draft',
      'snoozed',
      ...(previous?.labels.map(({ id }) => id) ?? []),
      ...labelIds,
    ]);
    for (const folder of folders) {
      await socket.broadcastChatMessage({ type: OutgoingMessageType.Mail_List, folder });
    }
    await sendDoState(job.connectionId);
  };
  if (deleted) {
    for (const message of previous?.messages ?? []) removedMessageIds.add(message.id);
    await removeVectors();
    await env.VECTORIZE.deleteByIds([job.threadId]);
    for (const shard of targets) {
      await shard.stub.deletePolledThread(job.threadId);
    }
    await env.THREADS_BUCKET.delete(threadKey);
    await notify();
    await storage.delete('poll-index-checkpoint');
  } else {
    const thread = applyLocalSnooze(
      normalizeGmailThread(
        refreshed ?? (await connectionToDriver(mailbox).get(job.threadId)),
        job.connectionId,
        job.threadId,
        internalDates,
      ),
      await env.snoozed_emails.get(`${job.threadId}__${job.connectionId}`),
    );
    if (!thread.latest) throw new Error('Gmail thread has no latest message');
    if (await applyMailboxWorkflowPolicy(env, mailbox, thread)) return;
    const currentMessageIds = new Set(thread.messages.map(({ id }) => id));
    for (const message of previous?.messages ?? []) {
      if (!currentMessageIds.has(message.id)) removedMessageIds.add(message.id);
    }
    await persistPolledThread({
      index: job.index,
      removedMessageIds,
      readCheckpoint: () => storage.get<PollIndexCheckpoint>('poll-index-checkpoint'),
      saveCheckpoint: (checkpoint) => storage.put('poll-index-checkpoint', checkpoint),
      removeVectors: async () => {
        await removeVectors();
        if (removedMessageIds.size) await env.VECTORIZE.deleteByIds([job.threadId]);
      },
      saveThread: async () => {
        await env.THREADS_BUCKET.put(threadKey, JSON.stringify(thread), {
          customMetadata: { threadId: job.threadId },
        });
        const latest = thread.latest!;
        const labels = gmailThreadFolderLabels(thread);
        for (const shard of targets) {
          await shard.stub.storePolledThread(job.threadId, latest, labels);
        }
        await notify(labels);
      },
      indexThread: async () => {
        await env.gmail_index_queue.send(
          {
            type: 'gmail-poll-thread',
            connectionId: job.connectionId,
            threadId: job.threadId,
            index: true,
            indexOnly: true,
            notify: false,
          } satisfies GmailPollJob,
          { contentType: 'json' },
        );
      },
    });
  }
}
