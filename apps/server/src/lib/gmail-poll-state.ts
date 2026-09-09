export type GmailPollJob = {
  type: 'gmail-poll-thread';
  connectionId: string;
  threadId: string;
  index: boolean;
  deletedMessageIds?: string[];
  quotaRetries?: number;
  notify?: boolean;
  indexOnly?: boolean;
};

type HistoryMessage = { id?: string | null; threadId?: string | null; labelIds?: string[] | null };
type HistoryChange = { message?: HistoryMessage; labelIds?: string[] | null };
export type GmailHistoryRecord = {
  messagesAdded?: HistoryChange[] | null;
  messagesDeleted?: HistoryChange[] | null;
  labelsAdded?: HistoryChange[] | null;
  labelsRemoved?: HistoryChange[] | null;
};

export type GmailPollState = {
  historyId: string;
  historyPageToken?: string;
  lastHistoryAt?: number;
  backfill?: { phase: 'mailbox' | 'cache'; pageToken?: string };
};

export class GmailPollError extends Error {
  constructor(
    public status: number,
    public quota = false,
  ) {
    super(`Gmail polling request failed (${status})`);
  }
}

export type GmailPollFailure = { status?: number; quota: boolean };

export function gmailPollFailure(error: unknown): GmailPollFailure {
  if (error instanceof GmailPollError)
    return { status: error.status, quota: error.quota || error.status === 429 };
  if (!error || typeof error !== 'object') return { quota: false };
  const value = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    originalError?: unknown;
    response?: { status?: unknown };
  };
  const status = Number(value.status ?? value.code ?? value.response?.status) || undefined;
  const original = value.originalError ? gmailPollFailure(value.originalError) : undefined;
  return {
    status: status ?? original?.status,
    quota:
      original?.quota === true ||
      status === 429 ||
      (status === 403 &&
        typeof value.message === 'string' &&
        /quota|rate.?limit/i.test(value.message)),
  };
}

export type GmailInboxImportState = { pageToken?: string; queued: number; complete: boolean };

export async function importGmailInbox(options: {
  connectionId: string;
  readState: () => Promise<GmailInboxImportState | undefined>;
  saveState: (state: GmailInboxImportState) => Promise<void>;
  threads: (pageToken?: string) => Promise<{ threads?: { id: string }[]; nextPageToken?: string }>;
  enqueue: (jobs: GmailPollJob[]) => Promise<void>;
}) {
  const previous = await options.readState();
  let state: GmailInboxImportState =
    previous && !previous.complete ? previous : { queued: 0, complete: false };
  for (let page = 0; page < 5; page++) {
    let response;
    try {
      response = await options.threads(state.pageToken);
    } catch (error) {
      if (!(error instanceof GmailPollError) || error.status !== 400 || !state.pageToken)
        throw error;
      state = { queued: 0, complete: false };
      response = await options.threads();
    }
    const jobs: GmailPollJob[] = (response.threads ?? []).map(({ id }) => ({
      type: 'gmail-poll-thread',
      connectionId: options.connectionId,
      threadId: id,
      index: false,
    }));
    for (let offset = 0; offset < jobs.length; offset += 100)
      await options.enqueue(jobs.slice(offset, offset + 100));
    state = {
      pageToken: response.nextPageToken,
      queued: state.queued + jobs.length,
      complete: !response.nextPageToken,
    };
    await options.saveState(state);
    if (state.complete) break;
  }
  return state;
}

export async function consumeGmailPollJob(
  message: {
    body: GmailPollJob;
    ack: () => void;
    retry: (options: { delaySeconds: number }) => void;
  },
  process: (job: GmailPollJob) => Promise<GmailPollFailure | void>,
  onError: (failure: ReturnType<typeof gmailPollFailure>) => void,
  deferQuota?: (job: GmailPollJob, delaySeconds: number) => Promise<void>,
) {
  try {
    const failure = await process(message.body);
    if (failure) {
      onError(failure);
      if (failure.quota && deferQuota) {
        const quotaRetries = (message.body.quotaRetries ?? 0) + 1;
        const delaySeconds = Math.min(1800, 120 * 2 ** Math.min(quotaRetries, 4));
        // Acknowledge only after the delayed copy is durable; quota limits must not lose mail jobs.
        await deferQuota({ ...message.body, quotaRetries }, delaySeconds);
        message.ack();
      } else {
        message.retry({ delaySeconds: 60 });
      }
      return;
    }
    message.ack();
  } catch (error) {
    onError(gmailPollFailure(error));
    message.retry({ delaySeconds: 60 });
  }
}

export function planGmailChanges(connectionId: string, history: GmailHistoryRecord[]) {
  const changes = new Map<string, GmailPollJob>();
  const add = (change: HistoryChange, index: boolean, deleted = false) => {
    const threadId = change.message?.threadId;
    if (!threadId) return;
    const job = changes.get(threadId) ?? {
      type: 'gmail-poll-thread' as const,
      connectionId,
      threadId,
      index: false,
      notify: true,
    };
    job.index ||= index;
    if (deleted && change.message?.id) {
      job.deletedMessageIds = [...new Set([...(job.deletedMessageIds ?? []), change.message.id])];
    }
    changes.set(threadId, job);
  };
  for (const record of history) {
    for (const change of record.messagesAdded ?? []) {
      add(change, !change.message?.labelIds?.includes('DRAFT'));
    }
    for (const change of record.messagesDeleted ?? []) add(change, true, true);
    for (const change of record.labelsAdded ?? []) add(change, false);
    for (const change of record.labelsRemoved ?? []) add(change, false);
  }
  return [...changes.values()];
}

export async function pollGmailChanges(options: {
  connectionId: string;
  readState: () => Promise<GmailPollState | undefined>;
  saveState: (state: GmailPollState) => Promise<void>;
  profile: () => Promise<{ historyId?: string }>;
  history: (
    historyId: string,
    pageToken?: string,
  ) => Promise<{
    history?: GmailHistoryRecord[];
    historyId?: string;
    nextPageToken?: string;
  }>;
  threads: (pageToken?: string) => Promise<{ threads?: { id: string }[]; nextPageToken?: string }>;
  cachedThreads: (cursor?: string) => Promise<{ ids: string[]; cursor?: string }>;
  enqueue: (jobs: GmailPollJob[]) => Promise<void>;
  enqueueHistory?: (jobs: GmailPollJob[]) => Promise<void>;
  canBackfill?: () => Promise<boolean>;
  historyIntervalMs?: number;
  now?: () => number;
}) {
  let state = await options.readState();
  const now = (options.now ?? Date.now)();
  const historyIntervalMs = options.historyIntervalMs ?? 5 * 60 * 1000;
  const enqueue = async (jobs: GmailPollJob[], history = false) => {
    for (let offset = 0; offset < jobs.length; offset += 100) {
      await (history ? (options.enqueueHistory ?? options.enqueue) : options.enqueue)(
        jobs.slice(offset, offset + 100),
      );
    }
  };
  const beginBackfill = async (): Promise<GmailPollState> => {
    const { historyId } = await options.profile();
    if (!historyId) throw new Error('Gmail did not return a history cursor');
    return { historyId, lastHistoryAt: now, backfill: { phase: 'mailbox' } };
  };

  if (!state) {
    state = await beginBackfill();
  } else if (
    state.historyPageToken ||
    !state.lastHistoryAt ||
    now - state.lastHistoryAt >= historyIntervalMs
  ) {
    // Bound each run's work; a saved page token resumes a large change burst.
    for (let page = 0; page < 5; page++) {
      let response;
      try {
        response = await options.history(state.historyId, state.historyPageToken);
      } catch (error) {
        if (error instanceof GmailPollError && error.status === 400 && state.historyPageToken) {
          state = { ...state, historyPageToken: undefined };
          continue;
        }
        if (!(error instanceof GmailPollError) || error.status !== 404) throw error;
        state = await beginBackfill();
        break;
      }
      await enqueue(planGmailChanges(options.connectionId, response.history ?? []), true);
      state = {
        ...state,
        historyId: response.nextPageToken
          ? state.historyId
          : (response.historyId ?? state.historyId),
        historyPageToken: response.nextPageToken,
        lastHistoryAt: response.nextPageToken ? state.lastHistoryAt : now,
      };
      // Queue acceptance precedes the checkpoint; interrupted work can be replayed safely.
      await options.saveState(state);
      if (!state.historyPageToken) break;
    }
    if (state.historyPageToken) return;
  }

  if (!state.backfill) return;
  if (options.canBackfill && !(await options.canBackfill())) {
    await options.saveState(state);
    return;
  }
  const backfill = state.backfill;
  if (backfill.phase === 'mailbox') {
    let response;
    try {
      response = await options.threads(backfill.pageToken);
    } catch (error) {
      if (!(error instanceof GmailPollError) || error.status !== 400 || !backfill.pageToken)
        throw error;
      response = await options.threads();
    }
    await enqueue(
      (response.threads ?? []).map(({ id }) => ({
        type: 'gmail-poll-thread',
        connectionId: options.connectionId,
        threadId: id,
        index: true,
      })),
    );
    state = {
      ...state,
      backfill: response.nextPageToken
        ? { phase: 'mailbox', pageToken: response.nextPageToken }
        : { phase: 'cache' },
    };
  } else {
    // Recheck cached objects as well: expired history can hide permanent deletions.
    const response = await options.cachedThreads(backfill.pageToken);
    await enqueue(
      response.ids.map((threadId) => ({
        type: 'gmail-poll-thread',
        connectionId: options.connectionId,
        threadId,
        index: false,
      })),
    );
    state = {
      ...state,
      backfill: response.cursor ? { phase: 'cache', pageToken: response.cursor } : undefined,
    };
  }
  await options.saveState(state);
}
