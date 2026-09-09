import {
  classifyBundleKind,
  findLatestIncomingMessage,
  isDefinitiveNotFoundError,
  isIncomingMessage,
  isBundleReleaseDue,
  matchesBundleMatcher,
  mergeLabelChanges,
  normalizeSenderEmail,
  ruleLabelChange,
  runProviderFirst,
  screeningLabelChange,
  senderExistedBeforeScreening,
  shouldCancelReplyReminder,
  shouldReleaseHeldBundle,
  threadHasLabel,
  isRuleApplicable,
  validateFocusOrder,
  type BundleMatcherInput,
  type LabelChange,
} from './mailbox-workflows-core';
import {
  bundleMatcher,
  bundleThread,
  cleanupRule,
  connection,
  focusThread,
  mailBundle,
  mailRule,
  mailRuleThread,
  senderDecision,
  senderScreenedThread,
  senderScreeningConfig,
  smartFolder,
  threadReminder,
  userSettings,
} from '../db/schema';
import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { IGetThreadResponse } from './driver/types';
import { applyGmailChange } from './gmail-mutations';
import { connectionToDriver, getThreadsFromDB } from './server-utils';
import {
  cancelOutbox,
  listMailboxActivity,
  listOutbox,
  recordMailboxAction,
  retryOutbox,
} from './mailbox-activity';
import { isValidTimezone } from './timezones';
import { listMailboxAssets, type ListMailboxAssetsInput } from './mailbox-assets';
import type { ZeroEnv } from '../env';
import { createDb } from '../db';

const FOCUS_LABEL = 'Varunsmail/Focus';
const REMINDER_LABEL = 'Varunsmail/Reminded';
const MAX_CRON_ATTEMPTS = 8;
const CLEANUP_CANDIDATE_SAMPLE_SIZE = 100;
const CLEANUP_RUN_BATCH_SIZE = 20;
const focusLabelIds = new Map<string, string | null>();

type Connection = typeof connection.$inferSelect;
type RuleAction = 'archive' | 'label' | 'important';
type ScreeningDecision = 'pending' | 'allow' | 'archive' | 'block' | 'spam';
type SmartFolderSort = 'newest' | 'oldest' | 'sender' | 'domain';
type BundleInput = {
  name: string;
  deliveryMode: 'immediate' | 'scheduled';
  deliveryTimes: string[];
  timezone?: string;
  enabled?: boolean;
  matchers: BundleMatcherInput[];
};

type ThreadSummary = {
  connectionId: string;
  threadId: string;
  receivedAt?: string;
  subject?: string;
  senderName?: string;
  senderEmail?: string;
};

const threadKey = (connectionId: string, threadId: string) => `${connectionId}/${threadId}.json`;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);

function isCleanupThreadEligible(
  thread: { messages: { isDraft?: boolean; receivedOn: string }[] },
  cutoff: Date,
) {
  let latestReceivedAt: number | undefined;
  for (const message of thread.messages) {
    if (message.isDraft) continue;
    const receivedAt = Date.parse(message.receivedOn);
    if (!Number.isFinite(receivedAt)) return false;
    latestReceivedAt = Math.max(latestReceivedAt ?? receivedAt, receivedAt);
  }
  return latestReceivedAt !== undefined && latestReceivedAt <= cutoff.getTime();
}

function takeCleanupRunBatch(threadIds: string[]) {
  return threadIds.slice(0, CLEANUP_RUN_BATCH_SIZE);
}

function cleanupCandidateSampleLimit(mailboxIndex: number, mailboxCount: number) {
  if (!mailboxCount) return 0;
  const base = Math.floor(CLEANUP_CANDIDATE_SAMPLE_SIZE / mailboxCount);
  return base + (mailboxIndex < CLEANUP_CANDIDATE_SAMPLE_SIZE % mailboxCount ? 1 : 0);
}

function requireLabelInput(action: RuleAction, labelId?: string) {
  if (action === 'label' && !labelId) throw new Error('Choose a Gmail label for this rule');
  if (action !== 'label' && labelId) throw new Error('Only label rules accept a label');
}

function normalizeMatcher(matcher: BundleMatcherInput) {
  const value = matcher.kind === 'sender' ? normalizeSenderEmail(matcher.value ?? '') : null;
  if (matcher.kind === 'sender' && !value) throw new Error('Sender matchers require an email');
  return { connectionId: matcher.connectionId ?? null, kind: matcher.kind, value };
}

function validateBundleInput(input: BundleInput) {
  if (!input.name.trim()) throw new Error('Bundle name is required');
  if (!input.matchers.length) throw new Error('Add at least one bundle matcher');
  if (input.deliveryTimes.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error('Bundle delivery times must use HH:mm');
  }
  if (input.deliveryMode === 'scheduled' && !input.deliveryTimes.length) {
    throw new Error('Scheduled bundles need at least one delivery time');
  }
  if (input.timezone && !isValidTimezone(input.timezone)) throw new Error('Invalid timezone');
}

async function readCachedThread(env: ZeroEnv, connectionId: string, threadId: string) {
  const object = await env.THREADS_BUCKET.get(threadKey(connectionId, threadId));
  return object ? object.json<IGetThreadResponse>() : undefined;
}

async function readThread(env: ZeroEnv, mailbox: Connection, threadId: string) {
  return (
    (await readCachedThread(env, mailbox.id, threadId)) ?? connectionToDriver(mailbox).get(threadId)
  );
}

function summarizeThread(connectionId: string, threadId: string, thread?: IGetThreadResponse) {
  const message = thread?.latest ?? thread?.messages.at(-1);
  return {
    connectionId,
    threadId,
    receivedAt: message?.receivedOn,
    subject: message?.subject,
    senderName: message?.sender.name,
    senderEmail: message?.sender.email,
  } satisfies ThreadSummary;
}

async function queueReconcile(env: ZeroEnv, connectionId: string, threadId: string) {
  await env.gmail_sync_queue.send(
    {
      type: 'gmail-poll-thread',
      connectionId,
      threadId,
      index: false,
      notify: true,
    },
    { contentType: 'json' },
  );
}

async function mutateAndReconcile(
  env: ZeroEnv,
  mailbox: Connection,
  threadId: string,
  change: LabelChange,
) {
  const labels = mergeLabelChanges(change);
  if (!labels.addLabels.length && !labels.removeLabels.length) return false;
  const result = await applyGmailChange(env, mailbox.id, threadId, () =>
    connectionToDriver(mailbox).modifyLabels([threadId], labels),
  );
  return result.syncPending;
}

async function getFocusLabelId(
  driver: ReturnType<typeof connectionToDriver>,
  connectionId: string,
  refresh = false,
) {
  if (!refresh && focusLabelIds.has(connectionId)) {
    return focusLabelIds.get(connectionId) ?? undefined;
  }
  const label = (await driver.getUserLabels()).find(({ name }) => name === FOCUS_LABEL);
  focusLabelIds.set(connectionId, label?.id || null);
  return label?.id || undefined;
}

async function getBundleWithMatchers(env: ZeroEnv, userId: string, id: string) {
  const { db } = createDb(env.DB);
  const bundle = await db.query.mailBundle.findFirst({
    where: and(eq(mailBundle.id, id), eq(mailBundle.userId, userId)),
  });
  if (!bundle) throw new Error('Bundle not found');
  const matchers = await db.query.bundleMatcher.findMany({
    where: eq(bundleMatcher.bundleId, bundle.id),
    orderBy: asc(bundleMatcher.createdAt),
  });
  return { ...bundle, matchers };
}

export class MailboxWorkflows {
  private db;

  constructor(
    private env: ZeroEnv,
    private userId: string,
  ) {
    this.db = createDb(env.DB).db;
  }

  private async connection(connectionId: string) {
    const mailbox = await this.db.query.connection.findFirst({
      where: and(eq(connection.id, connectionId), eq(connection.userId, this.userId)),
    });
    if (!mailbox) throw new Error('Mailbox connection not found');
    if (mailbox.providerId !== 'google') throw new Error('This workflow currently requires Gmail');
    return mailbox;
  }

  async getActivity() {
    return listMailboxActivity(this.env, this.userId);
  }

  async getOutbox() {
    return listOutbox(this.env, this.userId);
  }

  async forceSync(connectionId: string) {
    const mailbox = await this.connection(connectionId);
    const runner = this.env.WORKFLOW_RUNNER.get(
      this.env.WORKFLOW_RUNNER.idFromName(`gmail-poll:${mailbox.id}`),
    );
    try {
      await runner.pollMailbox(mailbox.id);
      const imported = await runner.importInbox(mailbox.id);
      await recordMailboxAction(this.env, {
        userId: this.userId,
        connectionId: mailbox.id,
        action: 'sync mailbox',
        status: 'succeeded',
      });
      return imported;
    } catch (error) {
      await recordMailboxAction(this.env, {
        userId: this.userId,
        connectionId: mailbox.id,
        action: 'sync mailbox',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async retryOutbox(messageId: string) {
    return retryOutbox(this.env, this.userId, messageId);
  }

  async cancelOutbox(messageId: string) {
    return cancelOutbox(this.env, this.userId, messageId);
  }

  async listAssets(input: ListMailboxAssetsInput) {
    return listMailboxAssets(this.env, this.userId, input);
  }

  async listSmartFolders() {
    return this.db.query.smartFolder.findMany({
      where: eq(smartFolder.userId, this.userId),
      orderBy: asc(smartFolder.name),
    });
  }

  async getSmartFolder(id: string) {
    const folder = await this.db.query.smartFolder.findFirst({
      where: and(eq(smartFolder.id, id), eq(smartFolder.userId, this.userId)),
    });
    if (!folder) throw new Error('Smart folder not found');
    return folder;
  }

  async createSmartFolder(input: {
    name: string;
    query: string;
    connectionId?: string;
    sort: SmartFolderSort;
  }) {
    if (input.connectionId) await this.connection(input.connectionId);
    const name = input.name.trim();
    const query = input.query.trim();
    if (!name || !query) throw new Error('Smart folders require a name and search query');
    const now = new Date();
    const [folder] = await this.db.insert(smartFolder).values({
      id: crypto.randomUUID(),
      userId: this.userId,
      name,
      query,
      connectionId: input.connectionId ?? null,
      sort: input.sort,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return folder;
  }

  async updateSmartFolder(
    id: string,
    input: {
      name?: string;
      query?: string;
      connectionId?: string | null;
      sort?: SmartFolderSort;
    },
  ) {
    await this.getSmartFolder(id);
    if (input.connectionId) await this.connection(input.connectionId);
    const name = input.name?.trim();
    const query = input.query?.trim();
    if (input.name !== undefined && !name) throw new Error('Smart folder name is required');
    if (input.query !== undefined && !query) throw new Error('Smart folder query is required');
    const [folder] = await this.db.update(smartFolder).set({
      ...(name !== undefined ? { name } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      updatedAt: new Date(),
    }).where(and(eq(smartFolder.id, id), eq(smartFolder.userId, this.userId))).returning();
    if (!folder) throw new Error('Smart folder not found');
    return folder;
  }

  async deleteSmartFolder(id: string) {
    const rows = await this.db
      .delete(smartFolder)
      .where(and(eq(smartFolder.id, id), eq(smartFolder.userId, this.userId)))
      .returning({ id: smartFolder.id });
    return rows.length > 0;
  }

  async listCleanupCandidates(connectionId?: string) {
    if (connectionId) await this.connection(connectionId);
    const mailboxes = await this.db.query.connection.findMany({
      where: connectionId
        ? and(eq(connection.userId, this.userId), eq(connection.id, connectionId))
        : and(eq(connection.userId, this.userId), eq(connection.providerId, 'google')),
      columns: { id: true, email: true },
    });
    const candidates = new Map<
      string,
      {
        connectionId: string;
        accountEmail: string;
        senderEmail: string;
        senderName?: string;
        count: number;
        oldestAt: string;
        latestAt: string;
      }
    >();

    const objects = (
      await Promise.all(
        mailboxes.map(async (mailbox, mailboxIndex) => {
          const maxResults = cleanupCandidateSampleLimit(mailboxIndex, mailboxes.length);
          if (!maxResults) return [];
          const page = await getThreadsFromDB(mailbox.id, {
            folder: 'inbox',
            maxResults,
            pageToken: '',
          });
          return page.threads.map(({ id }) => ({ threadId: id, mailbox }));
        }),
      )
    ).flat();
    for (let offset = 0; offset < objects.length; offset += 10) {
      const rows = await Promise.all(
        objects
          .slice(offset, offset + 10)
          .map(async ({ threadId, mailbox }) => ({
            mailbox,
            thread: await readCachedThread(this.env, mailbox.id, threadId).catch(() => undefined),
          })),
      );
      for (const { mailbox, thread } of rows) {
        if (!thread) continue;
        const message = findLatestIncomingMessage(thread.messages, mailbox.email);
        if (!message) continue;
        const senderEmail = normalizeSenderEmail(message.sender.email);
        if (!senderEmail) continue;
        const key = `${mailbox.id}:${senderEmail}`;
        const current = candidates.get(key);
        const receivedAt = message.receivedOn;
        candidates.set(key, {
          connectionId: mailbox.id,
          accountEmail: mailbox.email,
          senderEmail,
          senderName: message.sender.name || current?.senderName,
          count: (current?.count ?? 0) + 1,
          oldestAt:
            current && new Date(current.oldestAt) < new Date(receivedAt)
              ? current.oldestAt
              : receivedAt,
          latestAt:
            current && new Date(current.latestAt) > new Date(receivedAt)
              ? current.latestAt
              : receivedAt,
        });
      }
    }

    return [...candidates.values()]
      .sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt))
      .slice(0, 100);
  }

  async listCleanupRules(connectionId?: string) {
    if (connectionId) await this.connection(connectionId);
    return this.db.query.cleanupRule.findMany({
      where: connectionId
        ? and(eq(cleanupRule.userId, this.userId), eq(cleanupRule.connectionId, connectionId))
        : eq(cleanupRule.userId, this.userId),
      orderBy: desc(cleanupRule.createdAt),
    });
  }

  async createCleanupRule(
    connectionId: string,
    senderEmail: string,
    action: 'archive' | 'trash',
    ageDays: number,
  ) {
    await this.connection(connectionId);
    const email = normalizeSenderEmail(senderEmail);
    if (!email || !email.includes('@')) throw new Error('Enter a valid sender email');
    const now = new Date();
    const [rule] = await this.db
      .insert(cleanupRule)
      .values({
        id: crypto.randomUUID(),
        userId: this.userId,
        connectionId,
        senderEmail: email,
        action,
        ageDays,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [cleanupRule.connectionId, cleanupRule.senderEmail, cleanupRule.action],
        set: { ageDays, enabled: true, updatedAt: now },
      })
      .returning();
    return rule;
  }

  async setCleanupRuleEnabled(id: string, enabled: boolean) {
    const [rule] = await this.db
      .update(cleanupRule)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(cleanupRule.id, id), eq(cleanupRule.userId, this.userId)))
      .returning();
    if (!rule) throw new Error('Cleanup rule not found');
    return rule;
  }

  async deleteCleanupRule(id: string) {
    const rows = await this.db
      .delete(cleanupRule)
      .where(and(eq(cleanupRule.id, id), eq(cleanupRule.userId, this.userId)))
      .returning({ id: cleanupRule.id });
    return rows.length > 0;
  }

  async runCleanupRule(id: string) {
    const rule = await this.db.query.cleanupRule.findFirst({
      where: and(eq(cleanupRule.id, id), eq(cleanupRule.userId, this.userId)),
    });
    if (!rule) throw new Error('Cleanup rule not found');
    const mailbox = await this.connection(rule.connectionId);
    const driver = connectionToDriver(mailbox);
    const sender = rule.senderEmail.replace(/["\\]/g, '');
    const query = `from:"${sender}"${rule.ageDays ? ` older_than:${rule.ageDays}d` : ''}`;
    const cutoff = new Date(Date.now() - rule.ageDays * 86_400_000);
    try {
      const page = await driver.list({ folder: 'inbox', query, maxResults: CLEANUP_RUN_BATCH_SIZE });
      const ids = takeCleanupRunBatch(page.threads.map(({ id }) => id));

      const change =
        rule.action === 'trash'
          ? { addLabels: ['TRASH'], removeLabels: ['INBOX'] }
          : { addLabels: [], removeLabels: ['INBOX'] };
      let changed = 0;
      for (let offset = 0; offset < ids.length; offset += 4) {
        const results = await Promise.allSettled(
          ids.slice(offset, offset + 4).map(async (threadId) => {
            const thread = await driver.get(threadId);
            if (!isCleanupThreadEligible(thread, cutoff)) return false;
            await mutateAndReconcile(this.env, mailbox, threadId, change);
            return true;
          }),
        );
        changed += results.filter((result) => result.status === 'fulfilled' && result.value).length;
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
      await recordMailboxAction(this.env, {
        userId: this.userId,
        connectionId: mailbox.id,
        action: rule.action === 'trash' ? 'cleanup trash' : 'cleanup archive',
        status: 'succeeded',
        detail: `${changed} thread${changed === 1 ? '' : 's'} from ${rule.senderEmail}`,
      });
      return { changed };
    } catch (error) {
      await recordMailboxAction(this.env, {
        userId: this.userId,
        connectionId: mailbox.id,
        action: rule.action === 'trash' ? 'cleanup trash' : 'cleanup archive',
        status: 'failed',
        detail: errorText(error),
      });
      throw error;
    } finally {
      await this.db
        .update(cleanupRule)
        .set({ lastRunAt: new Date(), updatedAt: new Date() })
        .where(eq(cleanupRule.id, rule.id));
    }
  }

  async listReminders(connectionId?: string) {
    if (connectionId) await this.connection(connectionId);
    const states = ['pending', 'processing'] as const;
    return this.db.query.threadReminder.findMany({
      where: connectionId
        ? and(
            eq(threadReminder.userId, this.userId),
            eq(threadReminder.connectionId, connectionId),
            inArray(threadReminder.status, states),
          )
        : and(eq(threadReminder.userId, this.userId), inArray(threadReminder.status, states)),
      orderBy: asc(threadReminder.dueAt),
    });
  }

  async setReminder(input: {
    connectionId: string;
    threadId: string;
    sentMessageId: string;
    dueAt: Date;
  }) {
    if (input.dueAt.getTime() <= Date.now()) throw new Error('Reminder time must be in the future');
    const mailbox = await this.connection(input.connectionId);
    const thread = await readThread(this.env, mailbox, input.threadId);
    const message = thread.messages.find(({ id }) => id === input.sentMessageId);
    const isSent =
      message &&
      (normalizeSenderEmail(message.sender.email) === normalizeSenderEmail(mailbox.email) ||
        message.tags.some(({ id, name }) => id === 'SENT' || name === 'SENT'));
    if (!isSent) throw new Error('The reminder must watch a sent message in this thread');
    const now = new Date();
    const [reminder] = await this.db
      .insert(threadReminder)
      .values({
        id: crypto.randomUUID(),
        userId: this.userId,
        connectionId: input.connectionId,
        threadId: input.threadId,
        sentMessageId: input.sentMessageId,
        dueAt: input.dueAt,
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [threadReminder.connectionId, threadReminder.threadId],
        set: {
          sentMessageId: input.sentMessageId,
          dueAt: input.dueAt,
          status: 'pending',
          attemptCount: 0,
          lastError: null,
          updatedAt: now,
        },
      })
      .returning();
    return reminder;
  }

  async cancelReminder(connectionId: string, threadId: string) {
    await this.connection(connectionId);
    const rows = await this.db
      .update(threadReminder)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(threadReminder.userId, this.userId),
          eq(threadReminder.connectionId, connectionId),
          eq(threadReminder.threadId, threadId),
          inArray(threadReminder.status, ['pending', 'processing']),
        ),
      )
      .returning({ id: threadReminder.id });
    return rows.length > 0;
  }

  async getScreeningConfig(connectionId: string) {
    await this.connection(connectionId);
    const config = await this.db.query.senderScreeningConfig.findFirst({
      where: and(
        eq(senderScreeningConfig.userId, this.userId),
        eq(senderScreeningConfig.connectionId, connectionId),
      ),
    });
    return { enabled: config?.enabled ?? false, enabledAt: config?.enabledAt ?? null };
  }

  async setScreeningEnabled(connectionId: string, enabled: boolean) {
    const mailbox = await this.connection(connectionId);
    const current = await this.db.query.senderScreeningConfig.findFirst({
      where: eq(senderScreeningConfig.connectionId, connectionId),
    });
    const now = new Date();
    const enabledAt = enabled && !current?.enabled ? now : (current?.enabledAt ?? null);
    if (!enabled && current?.enabled) {
      const pending = await this.db.query.senderDecision.findMany({
        where: and(
          eq(senderDecision.userId, this.userId),
          eq(senderDecision.connectionId, connectionId),
          eq(senderDecision.decision, 'pending'),
        ),
      });
      if (pending.length) {
        const threads = await this.db.query.senderScreenedThread.findMany({
          where: inArray(
            senderScreenedThread.senderDecisionId,
            pending.map(({ id }) => id),
          ),
        });
        for (const thread of threads) {
          await mutateAndReconcile(
            this.env,
            mailbox,
            thread.threadId,
            screeningLabelChange('allow'),
          );
        }
        await this.db
          .update(senderDecision)
          .set({ decision: 'allow', decidedAt: now, updatedAt: now })
          .where(
            and(
              eq(senderDecision.userId, this.userId),
              eq(senderDecision.connectionId, connectionId),
              eq(senderDecision.decision, 'pending'),
            ),
          );
      }
    }
    await this.db
      .insert(senderScreeningConfig)
      .values({
        connectionId,
        userId: this.userId,
        enabled,
        enabledAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: senderScreeningConfig.connectionId,
        set: { enabled, enabledAt, updatedAt: now },
      });
    return { enabled, enabledAt };
  }

  async listScreening(connectionId?: string) {
    if (connectionId) await this.connection(connectionId);
    const decisions = await this.db.query.senderDecision.findMany({
      where: connectionId
        ? and(
            eq(senderDecision.userId, this.userId),
            eq(senderDecision.connectionId, connectionId),
            eq(senderDecision.decision, 'pending'),
          )
        : and(eq(senderDecision.userId, this.userId), eq(senderDecision.decision, 'pending')),
      orderBy: desc(senderDecision.createdAt),
    });
    if (!decisions.length) return [];
    const threads = await this.db.query.senderScreenedThread.findMany({
      where: inArray(
        senderScreenedThread.senderDecisionId,
        decisions.map(({ id }) => id),
      ),
      orderBy: desc(senderScreenedThread.createdAt),
    });
    return decisions.map((decision) => ({
      ...decision,
      threadIds: threads
        .filter(({ senderDecisionId }) => senderDecisionId === decision.id)
        .map(({ threadId }) => threadId),
    }));
  }

  async decideSender(
    connectionId: string,
    email: string,
    decision: Exclude<ScreeningDecision, 'pending'>,
  ) {
    const mailbox = await this.connection(connectionId);
    const normalizedEmail = normalizeSenderEmail(email);
    const sender = await this.db.query.senderDecision.findFirst({
      where: and(
        eq(senderDecision.userId, this.userId),
        eq(senderDecision.connectionId, connectionId),
        eq(senderDecision.email, normalizedEmail),
      ),
    });
    if (!sender) throw new Error('Screened sender not found');
    const threads = await this.db.query.senderScreenedThread.findMany({
      where: eq(senderScreenedThread.senderDecisionId, sender.id),
    });
    const change = screeningLabelChange(decision);
    let syncPending = false;
    for (const thread of threads) {
      const pending = await mutateAndReconcile(this.env, mailbox, thread.threadId, change);
      syncPending = syncPending || pending;
    }
    const now = new Date();
    const [saved] = await this.db
      .update(senderDecision)
      .set({ decision, decidedAt: now, updatedAt: now })
      .where(and(eq(senderDecision.id, sender.id), eq(senderDecision.userId, this.userId)))
      .returning();
    return { decision: saved, affectedThreads: threads.length, syncPending };
  }

  private async rulePreview(
    connectionId: string,
    threadId: string,
    action: RuleAction,
    labelId?: string,
  ) {
    requireLabelInput(action, labelId);
    const mailbox = await this.connection(connectionId);
    const driver = connectionToDriver(mailbox);
    const thread = await readThread(this.env, mailbox, threadId);
    const message = findLatestIncomingMessage(thread.messages, mailbox.email);
    if (!message) throw new Error('This thread has no incoming sender to match');
    let labelName: string | undefined;
    if (labelId) {
      const label = await driver.getLabel(labelId);
      if (label.type !== 'user') throw new Error('Rules can only apply user-created Gmail labels');
      labelName = label.name;
    }
    return {
      connectionId,
      threadId,
      sender: message.sender,
      subject: message.subject ?? '',
      action,
      labelId,
      labelName,
      messageId: message.id,
    };
  }

  async previewRule(connectionId: string, threadId: string, action: RuleAction, labelId?: string) {
    const preview = await this.rulePreview(connectionId, threadId, action, labelId);
    return {
      connectionId: preview.connectionId,
      threadId: preview.threadId,
      sender: preview.sender,
      subject: preview.subject,
      action: preview.action,
      labelId: preview.labelId,
      labelName: preview.labelName,
    };
  }

  async listRuleLabels(connectionId: string) {
    const mailbox = await this.connection(connectionId);
    const labels = await connectionToDriver(mailbox).getUserLabels();
    return labels
      .filter(({ id, name, type }) => id && name && type === 'user')
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listRules(connectionId?: string) {
    if (connectionId) await this.connection(connectionId);
    return this.db.query.mailRule.findMany({
      where: connectionId
        ? and(eq(mailRule.userId, this.userId), eq(mailRule.connectionId, connectionId))
        : eq(mailRule.userId, this.userId),
      orderBy: desc(mailRule.updatedAt),
    });
  }

  async createRule(connectionId: string, threadId: string, action: RuleAction, labelId?: string) {
    const preview = await this.rulePreview(connectionId, threadId, action, labelId);
    const mailbox = await this.connection(connectionId);
    const senderEmail = normalizeSenderEmail(preview.sender.email);
    const existing = await this.db.query.mailRule.findFirst({
      where: and(
        eq(mailRule.userId, this.userId),
        eq(mailRule.connectionId, connectionId),
        eq(mailRule.senderEmail, senderEmail),
        eq(mailRule.action, action),
        labelId ? eq(mailRule.labelId, labelId) : isNull(mailRule.labelId),
      ),
    });
    const change = ruleLabelChange({ action, labelId });
    let syncPending = false;
    const now = new Date();
    const id = existing?.id ?? crypto.randomUUID();
    await runProviderFirst(
      async () => {
        syncPending = await mutateAndReconcile(this.env, mailbox, threadId, change);
      },
      async () => {
        if (existing) {
          await this.db
            .update(mailRule)
            .set({ enabled: true, updatedAt: now })
            .where(and(eq(mailRule.id, existing.id), eq(mailRule.userId, this.userId)));
        } else {
          await this.db.insert(mailRule).values({
            id,
            userId: this.userId,
            connectionId,
            senderEmail,
            action,
            labelId: labelId ?? null,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
        }
        await this.db
          .insert(mailRuleThread)
          .values({
            id: crypto.randomUUID(),
            ruleId: id,
            connectionId,
            threadId,
            lastMessageId: preview.messageId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [mailRuleThread.ruleId, mailRuleThread.connectionId, mailRuleThread.threadId],
            set: {
              lastMessageId: preview.messageId,
              updatedAt: now,
            },
          });
      },
    );
    const rule = await this.db.query.mailRule.findFirst({ where: eq(mailRule.id, id) });
    return { rule, syncPending };
  }

  async setRuleEnabled(id: string, enabled: boolean) {
    const [rule] = await this.db
      .update(mailRule)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(mailRule.id, id), eq(mailRule.userId, this.userId)))
      .returning();
    if (!rule) throw new Error('Rule not found');
    return rule;
  }

  async deleteRule(id: string) {
    const rows = await this.db
      .delete(mailRule)
      .where(and(eq(mailRule.id, id), eq(mailRule.userId, this.userId)))
      .returning({ id: mailRule.id });
    return rows.length > 0;
  }

  async listBundles() {
    const bundles = await this.db.query.mailBundle.findMany({
      where: eq(mailBundle.userId, this.userId),
      orderBy: asc(mailBundle.name),
    });
    if (!bundles.length) return [];
    const matchers = await this.db.query.bundleMatcher.findMany({
      where: inArray(
        bundleMatcher.bundleId,
        bundles.map(({ id }) => id),
      ),
      orderBy: asc(bundleMatcher.createdAt),
    });
    return bundles.map((bundle) => ({
      ...bundle,
      matchers: matchers.filter(({ bundleId }) => bundleId === bundle.id),
    }));
  }

  private async bundleTimezone(timezone?: string) {
    if (timezone) return timezone;
    const settings = await this.db.query.userSettings.findFirst({
      where: eq(userSettings.userId, this.userId),
    });
    return settings?.settings.timezone ?? 'UTC';
  }

  private async validateMatchers(matchers: BundleMatcherInput[]) {
    const normalized = matchers.map(normalizeMatcher);
    const connectionIds = [
      ...new Set(normalized.map(({ connectionId }) => connectionId).filter((id) => id !== null)),
    ];
    for (const connectionId of connectionIds) await this.connection(connectionId);
    return normalized;
  }

  async createBundle(input: BundleInput) {
    validateBundleInput(input);
    const timezone = await this.bundleTimezone(input.timezone);
    if (!isValidTimezone(timezone)) throw new Error('Invalid timezone');
    const matchers = await this.validateMatchers(input.matchers);
    const id = crypto.randomUUID();
    const now = new Date();
    const slug =
      input.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'bundle';
    await this.db.insert(mailBundle).values({
      id,
      userId: this.userId,
      name: input.name.trim(),
      labelName: `Varunsmail/Bundles/${slug}-${id.slice(0, 8)}`,
      deliveryMode: input.deliveryMode,
      deliveryTimes: [...new Set(input.deliveryTimes)].sort(),
      timezone,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.db.insert(bundleMatcher).values(
        matchers.map((matcher) => ({
          id: crypto.randomUUID(),
          bundleId: id,
          ...matcher,
          createdAt: now,
        })),
      );
    } catch (error) {
      await this.db.delete(mailBundle).where(eq(mailBundle.id, id));
      throw error;
    }
    return getBundleWithMatchers(this.env, this.userId, id);
  }

  async updateBundle(
    id: string,
    input: Partial<Omit<BundleInput, 'matchers'>> & { matchers?: BundleMatcherInput[] },
  ) {
    const current = await getBundleWithMatchers(this.env, this.userId, id);
    const next: BundleInput = {
      name: input.name ?? current.name,
      deliveryMode: input.deliveryMode ?? current.deliveryMode,
      deliveryTimes: input.deliveryTimes ?? current.deliveryTimes,
      timezone: input.timezone ?? current.timezone,
      enabled: input.enabled ?? current.enabled,
      matchers: input.matchers ?? current.matchers,
    };
    validateBundleInput(next);
    if (!isValidTimezone(next.timezone ?? '')) throw new Error('Invalid timezone');
    const matchers = input.matchers ? await this.validateMatchers(input.matchers) : undefined;
    if (shouldReleaseHeldBundle(current, next)) await this.releaseBundle(id);
    const now = new Date();
    await this.db
      .update(mailBundle)
      .set({
        name: next.name.trim(),
        deliveryMode: next.deliveryMode,
        deliveryTimes: [...new Set(next.deliveryTimes)].sort(),
        timezone: next.timezone,
        enabled: next.enabled,
        updatedAt: now,
      })
      .where(and(eq(mailBundle.id, id), eq(mailBundle.userId, this.userId)));
    if (matchers) {
      await this.db.delete(bundleMatcher).where(eq(bundleMatcher.bundleId, id));
      if (matchers.length) {
        await this.db.insert(bundleMatcher).values(
          matchers.map((matcher) => ({
            id: crypto.randomUUID(),
            bundleId: id,
            ...matcher,
            createdAt: now,
          })),
        );
      }
    }
    return getBundleWithMatchers(this.env, this.userId, id);
  }

  async deleteBundle(id: string) {
    const bundle = await getBundleWithMatchers(this.env, this.userId, id);
    const threads = await this.db.query.bundleThread.findMany({
      where: eq(bundleThread.bundleId, id),
    });
    for (const thread of threads) {
      const mailbox = await this.connection(thread.connectionId);
      await mutateAndReconcile(this.env, mailbox, thread.threadId, {
        addLabels: bundle.deliveryMode === 'scheduled' && !thread.releasedAt ? ['INBOX'] : [],
        removeLabels: [bundle.labelName],
      });
    }
    const rows = await this.db
      .delete(mailBundle)
      .where(and(eq(mailBundle.id, id), eq(mailBundle.userId, this.userId)))
      .returning({ id: mailBundle.id });
    return rows.length > 0;
  }

  async listBundleThreads(bundleId?: string) {
    const bundles = bundleId
      ? [await getBundleWithMatchers(this.env, this.userId, bundleId)]
      : await this.listBundles();
    if (!bundles.length) return [];
    const refs = await this.db.query.bundleThread.findMany({
      where: inArray(
        bundleThread.bundleId,
        bundles.map(({ id }) => id),
      ),
      orderBy: desc(bundleThread.updatedAt),
      limit: 500,
    });
    return Promise.all(
      bundles.map(async (bundle) => ({
        bundle,
        threads: await Promise.all(
          refs
            .filter(({ bundleId: id }) => id === bundle.id)
            .map(async (ref) => ({
              ...summarizeThread(
                ref.connectionId,
                ref.threadId,
                await readCachedThread(this.env, ref.connectionId, ref.threadId),
              ),
              held: !ref.releasedAt,
            })),
        ),
      })),
    );
  }

  async releaseBundle(id: string) {
    const bundle = await getBundleWithMatchers(this.env, this.userId, id);
    const threads = await this.db.query.bundleThread.findMany({
      where: and(eq(bundleThread.bundleId, id), isNull(bundleThread.releasedAt)),
    });
    let syncPending = false;
    for (const thread of threads) {
      const mailbox = await this.connection(thread.connectionId);
      await runProviderFirst(
        async () => {
          const pending = await mutateAndReconcile(this.env, mailbox, thread.threadId, {
            addLabels: ['INBOX'],
            removeLabels: [],
          });
          syncPending = syncPending || pending;
        },
        () =>
          this.db
            .update(bundleThread)
            .set({ releasedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(bundleThread.id, thread.id), isNull(bundleThread.releasedAt))),
      );
    }
    return { released: threads.length, syncPending, bundle };
  }

  async listFocus() {
    const rows = await this.db.query.focusThread.findMany({
      where: eq(focusThread.userId, this.userId),
      orderBy: asc(focusThread.position),
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        ...summarizeThread(
          row.connectionId,
          row.threadId,
          await readCachedThread(this.env, row.connectionId, row.threadId),
        ),
      })),
    );
  }

  async addFocus(connectionId: string, threadId: string) {
    const mailbox = await this.connection(connectionId);
    await readThread(this.env, mailbox, threadId);
    let syncPending = false;
    await runProviderFirst(
      async () => {
        syncPending = await mutateAndReconcile(this.env, mailbox, threadId, {
          addLabels: [FOCUS_LABEL],
          removeLabels: [],
        });
      },
      async () => {
        const last = await this.db.query.focusThread.findFirst({
          where: eq(focusThread.userId, this.userId),
          orderBy: desc(focusThread.position),
        });
        await this.db
          .insert(focusThread)
          .values({
            id: crypto.randomUUID(),
            userId: this.userId,
            connectionId,
            threadId,
            position: (last?.position ?? -1) + 1,
            createdAt: new Date(),
          })
          .onConflictDoNothing();
      },
    );
    const item = await this.db.query.focusThread.findFirst({
      where: and(eq(focusThread.connectionId, connectionId), eq(focusThread.threadId, threadId)),
    });
    return { item, syncPending };
  }

  async removeFocus(connectionId: string, threadId: string) {
    const mailbox = await this.connection(connectionId);
    let syncPending = false;
    let removed = false;
    await runProviderFirst(
      async () => {
        syncPending = await mutateAndReconcile(this.env, mailbox, threadId, {
          addLabels: [],
          removeLabels: [FOCUS_LABEL],
        });
      },
      async () => {
        const rows = await this.db
          .delete(focusThread)
          .where(
            and(
              eq(focusThread.userId, this.userId),
              eq(focusThread.connectionId, connectionId),
              eq(focusThread.threadId, threadId),
            ),
          )
          .returning({ id: focusThread.id });
        removed = rows.length > 0;
      },
    );
    return { removed, syncPending };
  }

  async reorderFocus(items: { connectionId: string; threadId: string }[]) {
    const current = await this.db.query.focusThread.findMany({
      where: eq(focusThread.userId, this.userId),
    });
    if (!validateFocusOrder(current, items))
      throw new Error('Focus order must include each queued thread once');
    const updates = items.map((item, position) =>
      this.db
        .update(focusThread)
        .set({ position })
        .where(
          and(
            eq(focusThread.userId, this.userId),
            eq(focusThread.connectionId, item.connectionId),
            eq(focusThread.threadId, item.threadId),
          ),
        ),
    );
    const [first, ...remaining] = updates;
    if (first) await this.db.batch([first, ...remaining]);
    return this.db.query.focusThread.findMany({
      where: eq(focusThread.userId, this.userId),
      orderBy: asc(focusThread.position),
    });
  }
}

async function persistScreeningState(
  env: ZeroEnv,
  mailbox: Connection,
  message: NonNullable<ReturnType<typeof findLatestIncomingMessage>>,
  threadId: string,
  plannedDecision: ScreeningDecision,
) {
  const { db } = createDb(env.DB);
  const now = new Date();
  const plannedId = crypto.randomUUID();
  await db
    .insert(senderDecision)
    .values({
      id: plannedId,
      userId: mailbox.userId,
      connectionId: mailbox.id,
      email: normalizeSenderEmail(message.sender.email),
      name: message.sender.name ?? null,
      decision: plannedDecision,
      sampleThreadId: threadId,
      decidedAt: plannedDecision === 'pending' ? null : now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const savedDecision = await db.query.senderDecision.findFirst({
    where: and(
      eq(senderDecision.connectionId, mailbox.id),
      eq(senderDecision.email, normalizeSenderEmail(message.sender.email)),
    ),
  });
  if (!savedDecision) throw new Error('Failed to save sender screening decision');
  await db
    .insert(senderScreenedThread)
    .values({
      id: crypto.randomUUID(),
      senderDecisionId: savedDecision.id,
      connectionId: mailbox.id,
      threadId,
      lastMessageId: message.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [senderScreenedThread.connectionId, senderScreenedThread.threadId],
      set: {
        senderDecisionId: savedDecision.id,
        lastMessageId: message.id,
        updatedAt: now,
      },
    });
}

async function senderSeenBefore(
  driver: ReturnType<typeof connectionToDriver>,
  email: string,
  threadId: string,
) {
  const query = `in:anywhere from:"${email.replace(/["\\]/g, '')}"`;
  const result = await driver.list({ folder: 'all', query, maxResults: 2 });
  return result.threads.some(({ id }) => id !== threadId);
}

export async function applyMailboxWorkflowPolicy(
  env: ZeroEnv,
  mailbox: Connection,
  thread: IGetThreadResponse,
) {
  if (mailbox.providerId !== 'google') return false;
  const { db } = createDb(env.DB);
  const threadId = thread.latest?.threadId ?? thread.messages[0]?.threadId;
  if (!threadId) return false;
  const driver = connectionToDriver(mailbox);

  const reminder = await db.query.threadReminder.findFirst({
    where: and(
      eq(threadReminder.connectionId, mailbox.id),
      eq(threadReminder.threadId, threadId),
      inArray(threadReminder.status, ['pending', 'processing']),
    ),
  });
  if (
    reminder &&
    shouldCancelReplyReminder(thread.messages, reminder.sentMessageId, mailbox.email)
  ) {
    await db
      .update(threadReminder)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(threadReminder.id, reminder.id),
          inArray(threadReminder.status, ['pending', 'processing']),
        ),
      );
  }

  let focused = await db.query.focusThread.findFirst({
    where: and(
      eq(focusThread.userId, mailbox.userId),
      eq(focusThread.connectionId, mailbox.id),
      eq(focusThread.threadId, threadId),
    ),
  });
  let focusLabelId = await getFocusLabelId(driver, mailbox.id);
  let hasFocusLabel = threadHasLabel(thread.messages, FOCUS_LABEL, focusLabelId);
  if (focused && !hasFocusLabel) {
    focusLabelId = await getFocusLabelId(driver, mailbox.id, true);
    hasFocusLabel = threadHasLabel(thread.messages, FOCUS_LABEL, focusLabelId);
  }
  if (!focused && hasFocusLabel) {
    const last = await db.query.focusThread.findFirst({
      where: eq(focusThread.userId, mailbox.userId),
      orderBy: desc(focusThread.position),
    });
    await db
      .insert(focusThread)
      .values({
        id: crypto.randomUUID(),
        userId: mailbox.userId,
        connectionId: mailbox.id,
        threadId,
        position: (last?.position ?? -1) + 1,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    focused = await db.query.focusThread.findFirst({
      where: and(
        eq(focusThread.userId, mailbox.userId),
        eq(focusThread.connectionId, mailbox.id),
        eq(focusThread.threadId, threadId),
      ),
    });
  } else if (focused && !hasFocusLabel) {
    await db.delete(focusThread).where(eq(focusThread.id, focused.id));
    focused = undefined;
  }
  if (focused && thread.latest && !isIncomingMessage(thread.latest, mailbox.email)) {
    const normalizedLatestLabels = new Set(
      thread.latest.tags.flatMap(({ id, name }) => [id.toUpperCase(), name.toUpperCase()]),
    );
    const receivedAt = new Date(thread.latest.receivedOn).getTime();
    const sentReply =
      !thread.latest.isDraft &&
      Number.isFinite(receivedAt) &&
      receivedAt > focused.createdAt.getTime() &&
      (normalizedLatestLabels.has('SENT') ||
        normalizeSenderEmail(thread.latest.sender.email) === normalizeSenderEmail(mailbox.email));
    if (sentReply) {
      await runProviderFirst(
        () => driver.modifyLabels([threadId], { addLabels: [], removeLabels: [FOCUS_LABEL] }),
        () => db.delete(focusThread).where(eq(focusThread.id, focused.id)),
      );
      await queueReconcile(env, mailbox.id, threadId);
      return true;
    }
  }

  const message = findLatestIncomingMessage(thread.messages, mailbox.email);
  if (!message) return false;
  const senderEmail = normalizeSenderEmail(message.sender.email);
  if (!senderEmail) return false;
  const rules = await db.query.mailRule.findMany({
    where: and(
      eq(mailRule.userId, mailbox.userId),
      eq(mailRule.connectionId, mailbox.id),
      eq(mailRule.senderEmail, senderEmail),
      eq(mailRule.enabled, true),
    ),
  });

  const writes: (() => Promise<unknown>)[] = [];
  const changes: LabelChange[] = [];
  const config = await db.query.senderScreeningConfig.findFirst({
    where: and(
      eq(senderScreeningConfig.connectionId, mailbox.id),
      eq(senderScreeningConfig.userId, mailbox.userId),
      eq(senderScreeningConfig.enabled, true),
    ),
  });
  let decision = config
    ? await db.query.senderDecision.findFirst({
        where: and(
          eq(senderDecision.connectionId, mailbox.id),
          eq(senderDecision.email, senderEmail),
        ),
      })
    : undefined;

  if (config && !decision) {
    const enabledAt = config.enabledAt;
    const receivedAt = new Date(message.receivedOn);
    const historical = !!enabledAt && receivedAt.getTime() <= enabledAt.getTime();
    const knownInThread = enabledAt
      ? senderExistedBeforeScreening(thread.messages, message, mailbox.email, enabledAt)
      : false;
    const known =
      rules.length > 0 ||
      historical ||
      knownInThread ||
      (await senderSeenBefore(driver, senderEmail, threadId));
    const plannedDecision: ScreeningDecision = known ? 'allow' : 'pending';
    decision = {
      id: crypto.randomUUID(),
      userId: mailbox.userId,
      connectionId: mailbox.id,
      email: senderEmail,
      name: message.sender.name ?? null,
      decision: plannedDecision,
      sampleThreadId: threadId,
      decidedAt: known ? new Date() : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  if (config && decision) {
    const screened = await db.query.senderScreenedThread.findFirst({
      where: and(
        eq(senderScreenedThread.connectionId, mailbox.id),
        eq(senderScreenedThread.threadId, threadId),
      ),
    });
    if (screened?.lastMessageId !== message.id) {
      if (decision.decision !== 'allow') changes.push(screeningLabelChange(decision.decision));
      writes.push(() => persistScreeningState(env, mailbox, message, threadId, decision!.decision));
    }
    if (decision.decision !== 'allow') {
      const labels = mergeLabelChanges(...changes);
      if (!labels.addLabels.length && !labels.removeLabels.length) {
        for (const write of writes) await write();
        return false;
      }
      await runProviderFirst(
        () => driver.modifyLabels([threadId], labels),
        async () => {
          for (const write of writes) await write();
        },
      );
      await queueReconcile(env, mailbox.id, threadId);
      return true;
    }
  }

  const applicableRules = rules.slice(0, 0);
  for (const rule of rules) {
    if (!isRuleApplicable(rule.createdAt, message.receivedOn)) continue;
    if (rule.action === 'label' && rule.labelId) {
      try {
        await driver.getLabel(rule.labelId);
      } catch (error) {
        if (!isDefinitiveNotFoundError(error)) throw error;
        console.error('[MAILBOX_WORKFLOWS] Disabling rule with a missing Gmail label', {
          ruleId: rule.id,
          connectionId: mailbox.id,
          error: errorText(error),
        });
        await db
          .update(mailRule)
          .set({ enabled: false, updatedAt: new Date() })
          .where(and(eq(mailRule.id, rule.id), eq(mailRule.userId, mailbox.userId)));
        continue;
      }
    }
    applicableRules.push(rule);
  }

  if (applicableRules.length) {
    const applications = await db.query.mailRuleThread.findMany({
      where: and(
        inArray(
          mailRuleThread.ruleId,
          applicableRules.map(({ id }) => id),
        ),
        eq(mailRuleThread.connectionId, mailbox.id),
        eq(mailRuleThread.threadId, threadId),
      ),
    });
    for (const rule of applicableRules) {
      if (applications.find(({ ruleId }) => ruleId === rule.id)?.lastMessageId === message.id)
        continue;
      changes.push(ruleLabelChange(rule));
      writes.push(() =>
        db
          .insert(mailRuleThread)
          .values({
            id: crypto.randomUUID(),
            ruleId: rule.id,
            connectionId: mailbox.id,
            threadId,
            lastMessageId: message.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [mailRuleThread.ruleId, mailRuleThread.connectionId, mailRuleThread.threadId],
            set: { lastMessageId: message.id, updatedAt: new Date() },
          }),
      );
    }
  }

  const bundles = await db.query.mailBundle.findMany({
    where: and(eq(mailBundle.userId, mailbox.userId), eq(mailBundle.enabled, true)),
  });
  if (bundles.length) {
    const matchers = await db.query.bundleMatcher.findMany({
      where: inArray(
        bundleMatcher.bundleId,
        bundles.map(({ id }) => id),
      ),
    });
    const applicable = matchers.filter(
      (matcher) => !matcher.connectionId || matcher.connectionId === mailbox.id,
    );
    const senderMatchers = applicable.filter(
      (matcher) =>
        matcher.kind === 'sender' && normalizeSenderEmail(matcher.value ?? '') === senderEmail,
    );
    const matching = senderMatchers.length
      ? senderMatchers
      : applicable.filter((matcher) => matchesBundleMatcher(message, mailbox.id, matcher));
    const bundleIds = [...new Set(matching.map(({ bundleId }) => bundleId))];
    if (bundleIds.length) {
      const existing = await db.query.bundleThread.findMany({
        where: and(
          inArray(bundleThread.bundleId, bundleIds),
          eq(bundleThread.connectionId, mailbox.id),
          eq(bundleThread.threadId, threadId),
        ),
      });
      for (const bundle of bundles.filter(({ id }) => bundleIds.includes(id))) {
        if (existing.find(({ bundleId }) => bundleId === bundle.id)?.lastMessageId === message.id) {
          continue;
        }
        changes.push({
          addLabels: [bundle.labelName],
          removeLabels: bundle.deliveryMode === 'scheduled' ? ['INBOX'] : [],
        });
        writes.push(() =>
          db
            .insert(bundleThread)
            .values({
              id: crypto.randomUUID(),
              bundleId: bundle.id,
              connectionId: mailbox.id,
              threadId,
              lastMessageId: message.id,
              queuedAt: new Date(),
              releasedAt: bundle.deliveryMode === 'immediate' ? new Date() : null,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [bundleThread.bundleId, bundleThread.connectionId, bundleThread.threadId],
              set: {
                lastMessageId: message.id,
                queuedAt: new Date(),
                releasedAt: bundle.deliveryMode === 'immediate' ? new Date() : null,
                updatedAt: new Date(),
              },
            }),
        );
      }
    }
  }

  const labels = mergeLabelChanges(...changes);
  if (!labels.addLabels.length && !labels.removeLabels.length) {
    for (const write of writes) await write();
    return false;
  }
  await runProviderFirst(
    () => driver.modifyLabels([threadId], labels),
    async () => {
      for (const write of writes) await write();
    },
  );
  await queueReconcile(env, mailbox.id, threadId);
  return true;
}

async function processDueReminders(env: ZeroEnv, now: Date) {
  const { db } = createDb(env.DB);
  const stale = new Date(now.getTime() - 5 * 60_000);
  const reminders = await db.query.threadReminder.findMany({
    where: or(
      and(eq(threadReminder.status, 'pending'), lte(threadReminder.dueAt, now)),
      and(eq(threadReminder.status, 'processing'), lte(threadReminder.updatedAt, stale)),
    ),
    orderBy: asc(threadReminder.dueAt),
    limit: 100,
  });
  let fired = 0;
  let cancelled = 0;
  for (const reminder of reminders) {
    const [claimed] = await db
      .update(threadReminder)
      .set({ status: 'processing', updatedAt: now })
      .where(
        and(
          eq(threadReminder.id, reminder.id),
          or(
            eq(threadReminder.status, 'pending'),
            and(eq(threadReminder.status, 'processing'), lte(threadReminder.updatedAt, stale)),
          ),
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      const mailbox = await db.query.connection.findFirst({
        where: and(
          eq(connection.id, reminder.connectionId),
          eq(connection.userId, reminder.userId),
        ),
      });
      if (!mailbox || mailbox.providerId !== 'google')
        throw new Error('Gmail connection not found');
      const driver = connectionToDriver(mailbox);
      const thread = await driver.get(reminder.threadId);
      if (shouldCancelReplyReminder(thread.messages, reminder.sentMessageId, mailbox.email)) {
        await db
          .update(threadReminder)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(threadReminder.id, reminder.id));
        cancelled++;
        continue;
      }
      await runProviderFirst(
        () =>
          driver.modifyLabels([reminder.threadId], {
            addLabels: ['INBOX', REMINDER_LABEL],
            removeLabels: [],
          }),
        async () => {
          await queueReconcile(env, reminder.connectionId, reminder.threadId);
          await db
            .update(threadReminder)
            .set({ status: 'fired', lastError: null, updatedAt: new Date() })
            .where(
              and(eq(threadReminder.id, reminder.id), eq(threadReminder.status, 'processing')),
            );
        },
      );
      fired++;
    } catch (error) {
      const attemptCount = reminder.attemptCount + 1;
      const exhausted = attemptCount >= MAX_CRON_ATTEMPTS;
      const delayMinutes = Math.min(60, 2 ** Math.min(attemptCount, 6));
      await db
        .update(threadReminder)
        .set({
          status: exhausted ? 'cancelled' : 'pending',
          attemptCount,
          dueAt: exhausted ? reminder.dueAt : new Date(now.getTime() + delayMinutes * 60_000),
          lastError: errorText(error),
          updatedAt: new Date(),
        })
        .where(eq(threadReminder.id, reminder.id));
    }
  }
  return { fired, cancelled };
}

async function processDueBundles(env: ZeroEnv, now: Date) {
  const { db } = createDb(env.DB);
  const bundles = await db.query.mailBundle.findMany({
    where: and(eq(mailBundle.enabled, true), eq(mailBundle.deliveryMode, 'scheduled')),
  });
  if (!bundles.length) return 0;
  let released = 0;
  for (const bundle of bundles) {
    const threads = await db.query.bundleThread.findMany({
      where: and(eq(bundleThread.bundleId, bundle.id), isNull(bundleThread.releasedAt)),
      orderBy: asc(bundleThread.queuedAt),
      limit: 200,
    });
    for (const thread of threads) {
      if (!isBundleReleaseDue(thread.queuedAt, bundle.deliveryTimes, bundle.timezone, now)) break;
      try {
        const mailbox = await db.query.connection.findFirst({
          where: eq(connection.id, thread.connectionId),
        });
        if (!mailbox || mailbox.userId !== bundle.userId || mailbox.providerId !== 'google') {
          throw new Error('Gmail connection not found');
        }
        const driver = connectionToDriver(mailbox);
        await runProviderFirst(
          () => driver.modifyLabels([thread.threadId], { addLabels: ['INBOX'], removeLabels: [] }),
          async () => {
            await queueReconcile(env, thread.connectionId, thread.threadId);
            const rows = await db
              .update(bundleThread)
              .set({ releasedAt: new Date(), updatedAt: new Date() })
              .where(and(eq(bundleThread.id, thread.id), isNull(bundleThread.releasedAt)))
              .returning({ id: bundleThread.id });
            if (rows.length) released++;
          },
        );
      } catch (error) {
        console.error('[MAILBOX_WORKFLOWS] Bundle release failed', {
          bundleId: bundle.id,
          connectionId: thread.connectionId,
          threadId: thread.threadId,
          error: errorText(error),
        });
      }
    }
  }
  return released;
}

async function processCleanupRules(env: ZeroEnv, now: Date) {
  const { db } = createDb(env.DB);
  const rules = await db.query.cleanupRule.findMany({
    where: and(
      eq(cleanupRule.enabled, true),
      or(isNull(cleanupRule.lastRunAt), lte(cleanupRule.lastRunAt, new Date(now.getTime() - 86_400_000))),
    ),
    orderBy: asc(cleanupRule.lastRunAt),
    limit: 50,
  });
  let changed = 0;
  for (const rule of rules) {
    try {
      const result = await new MailboxWorkflows(env, rule.userId).runCleanupRule(rule.id);
      changed += result.changed;
    } catch (error) {
      console.error('[MAILBOX_WORKFLOWS] Cleanup rule failed', {
        ruleId: rule.id,
        connectionId: rule.connectionId,
        error: errorText(error),
      });
    }
  }
  return { rules: rules.length, changed };
}

export async function processMailboxWorkflowCron(env: ZeroEnv, now = new Date()) {
  const reminders = await processDueReminders(env, now);
  const bundles = await processDueBundles(env, now);
  const cleanup = await processCleanupRules(env, now);
  return { reminders, bundles, cleanup };
}

export const mailboxWorkflowInternals = {
  classifyBundleKind,
  cleanupCandidateSampleLimit,
  isCleanupThreadEligible,
  processCleanupRules,
  processDueBundles,
  processDueReminders,
  takeCleanupRunBatch,
};
