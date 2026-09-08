import type { WorkflowContext } from '../thread-workflow-utils/workflow-engine';
import { messageToXML } from '../thread-workflow-utils/workflow-utils';
import type { IGetThreadResponse } from './driver/types';

export type PollIndexCheckpoint = { pending: boolean; forceSummary: boolean };

export type GmailThreadMetadata = {
  messages?: { id: string; internalDate?: string; labelIds?: string[] }[];
};

export function applyLocalSnooze(
  thread: IGetThreadResponse,
  wakeAt: string | null,
  now = Date.now(),
) {
  const active = wakeAt !== null && new Date(wakeAt).getTime() > now;
  thread.labels = thread.labels.filter(({ id }) => id !== 'SNOOZED');
  if (active) thread.labels.push({ id: 'SNOOZED', name: 'Snoozed' });
  return thread;
}

export function refreshGmailMetadata(
  previous: IGetThreadResponse | undefined,
  metadata: GmailThreadMetadata,
): IGetThreadResponse | undefined {
  if (!previous || !metadata.messages?.length) return;
  const cached = new Map(previous.messages.map((message) => [message.id, message]));
  // Gmail messages are immutable; changed message IDs require a fresh body fetch.
  if (metadata.messages.some(({ id }) => !cached.has(id))) return;
  const labels = new Set<string>();
  const messages = metadata.messages.map(({ id, labelIds = [] }) => {
    const message = cached.get(id)!;
    for (const label of labelIds) labels.add(label);
    return {
      ...message,
      tags: labelIds.map(
        (id) => message.tags.find((tag) => tag.id === id) ?? { id, name: id, type: 'user' },
      ),
      unread: labelIds.includes('UNREAD'),
      isDraft: labelIds.includes('DRAFT'),
    };
  });
  return {
    ...previous,
    messages,
    latest: messages.findLast((message) => !message.isDraft) ?? messages.at(-1),
    hasUnread: messages.some((message) => message.unread),
    totalReplies: messages.filter((message) => !message.isDraft).length,
    labels: [...labels].map((id) => ({ id, name: id })),
  };
}

export function gmailThreadFolderLabels(thread: IGetThreadResponse) {
  const labels = new Set(thread.labels.map(({ id }) => id));
  if (!['INBOX', 'SPAM', 'TRASH', 'DRAFT'].some((label) => labels.has(label)))
    labels.add('ARCHIVE');
  return [...labels];
}

export async function persistPolledThread(options: {
  index: boolean;
  removedMessageIds: Set<string>;
  readCheckpoint: () => Promise<PollIndexCheckpoint | undefined>;
  saveCheckpoint: (checkpoint: PollIndexCheckpoint) => Promise<void>;
  removeVectors: () => Promise<void>;
  saveThread: () => Promise<void>;
  indexThread: (forceSummary: boolean) => Promise<void>;
}) {
  const checkpoint = (await options.readCheckpoint()) ?? { pending: false, forceSummary: false };
  checkpoint.pending ||= options.index || options.removedMessageIds.size > 0;
  checkpoint.forceSummary ||= options.removedMessageIds.size > 0;
  if (checkpoint.pending) await options.saveCheckpoint(checkpoint);
  // Failed vector cleanup must leave the old cache intact so retry can recover the removed IDs.
  await options.removeVectors();
  await options.saveThread();
  if (checkpoint.pending) {
    await options.indexThread(checkpoint.forceSummary);
  }
}

export async function processPendingGmailIndex(options: {
  readCheckpoint: () => Promise<PollIndexCheckpoint | undefined>;
  readThread: () => Promise<IGetThreadResponse | undefined>;
  indexThread: (thread: IGetThreadResponse, forceSummary: boolean) => Promise<void>;
  clearCheckpoint: () => Promise<void>;
}) {
  const checkpoint = await options.readCheckpoint();
  if (!checkpoint?.pending) return;
  const thread = await options.readThread();
  if (thread) await options.indexThread(thread, checkpoint.forceSummary);
  await options.clearCheckpoint();
}

export function normalizeGmailThread(
  thread: IGetThreadResponse,
  connectionId: string,
  threadId: string,
  internalDates: Map<string, string>,
) {
  const messages = thread.messages.map((message) => {
    const receivedOn = new Date(message.receivedOn).getTime();
    const internalDate = Number(internalDates.get(message.id));
    return {
      ...message,
      connectionId,
      threadId,
      receivedOn: new Date(
        Number.isFinite(receivedOn) ? receivedOn : Number.isFinite(internalDate) ? internalDate : 0,
      ).toISOString(),
    };
  });
  return {
    ...thread,
    messages,
    latest: messages.findLast((message) => !message.isDraft) ?? messages.at(-1),
  };
}

export async function indexPolledThread(
  context: WorkflowContext,
  execute: (context: WorkflowContext) => Promise<{
    results: Map<string, unknown>;
    errors: Map<string, Error>;
  }>,
) {
  const candidates = await Promise.all(
    context.thread.messages.map(async (message) =>
      !message.isDraft && (await messageToXML(message)) ? message : undefined,
    ),
  );
  const messages = candidates.filter((message) => message !== undefined);
  // Short acknowledgements, attachment-only messages and drafts have no indexable body.
  if (!messages.length) return;
  const { results, errors } = await execute({
    ...context,
    thread: { ...context.thread, messages, latest: messages.at(-1) },
  });
  if (errors.size) throw new Error(`Mail indexing failed in ${[...errors.keys()].join(', ')}`);
  const expected = results.get('find-messages-to-vectorize') as
    | { messagesToVectorize?: unknown[] }
    | undefined;
  const vectors = results.get('vectorize-messages') as { embeddings?: unknown[] } | undefined;
  if ((vectors?.embeddings?.length ?? 0) < (expected?.messagesToVectorize?.length ?? 0)) {
    throw new Error('Some message embeddings were not generated');
  }
  if (!(results.get('upsert-thread-summary') as { upserted?: boolean } | undefined)?.upserted) {
    throw new Error('Thread summary was not indexed');
  }
}
