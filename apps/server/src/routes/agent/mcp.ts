/*
 * Licensed to Zero Email Inc. under one or more contributor license agreements.
 * You may not use this file except in compliance with the Apache License, Version 2.0 (the "License").
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations.
 *
 * Reuse or distribution of this file requires a license from Zero Email Inc.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { eq } from 'drizzle-orm';
import z from 'zod';

import {
  type McpMailboxAccount,
  listMcpMailboxAccounts,
  resolveMcpMailboxAccount,
} from './mcp-accounts';
import { composeEmail, generateEmailSubjectForConnection } from '../../trpc/routes/ai/compose';
import { getThread, getZeroAgent, getZeroDB } from '../../lib/server-utils';
import type { IGetThreadsResponse } from '../../lib/driver/types';
import { getListUnsubscribeAction } from '../../lib/email-utils';
import { registerMcpWorkflowTools } from './mcp-workflow-tools';
import { searchAcrossAccounts } from './cross-account-search';
import { researchWeb } from '../../trpc/routes/ai/webSearch';
import { getCurrentDateContext } from '../../lib/prompts';
import { getBimiMetadata } from '../../trpc/routes/bimi';
import { sendMailboxEmail } from '../../lib/send-mail';
import { summarizeText } from '../../lib/ai-model';
import { connection, user } from '../../db/schema';
import { getPrompts } from '../../lib/brain';
import { EPrompts } from '../../types';
import { createDb } from '../../db';
import { env } from '../../env';

const accountSelector = z
  .string()
  .optional()
  .describe('Mailbox ID or email from accounts_manage. Omit to use the default mailbox.');
const senderSchema = z.object({ email: z.string().email(), name: z.string().optional() });
const attachmentSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number().nonnegative(),
  lastModified: z.number(),
  base64: z.string(),
});
const outputSchema = { result: z.unknown() };

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function result(value: unknown) {
  const text = JSON.stringify(
    { result: value ?? null },
    (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested),
    2,
  );
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: JSON.parse(text) as { result: unknown },
  };
}

async function hashRequest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function runIdempotentOperation<T>(
  userId: string,
  key: string,
  operation: string,
  input: unknown,
  perform: () => Promise<T>,
) {
  const requestHash = await hashRequest(input);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO mail0_mcp_idempotency
      (user_id, idempotency_key, operation, request_hash, result, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)`,
  )
    .bind(userId, key, operation, requestHash, Date.now())
    .run();

  if (!inserted.meta.changes) {
    const existing = await env.DB.prepare(
      `SELECT request_hash AS requestHash, result FROM mail0_mcp_idempotency
       WHERE user_id = ? AND idempotency_key = ? AND operation = ?`,
    )
      .bind(userId, key, operation)
      .first<{ requestHash: string; result: string | null }>();
    if (!existing || existing.requestHash !== requestHash) {
      throw new Error('Idempotency key was already used with a different message');
    }
    if (!existing.result) throw new Error('A send with this idempotency key is still in progress');
    return JSON.parse(existing.result) as T;
  }

  try {
    const operationResult = await perform();
    await env.DB.prepare(
      `UPDATE mail0_mcp_idempotency SET result = ?
       WHERE user_id = ? AND idempotency_key = ? AND operation = ?`,
    )
      .bind(JSON.stringify(operationResult), userId, key, operation)
      .run();
    return operationResult;
  } catch (error) {
    await env.DB.prepare(
      `DELETE FROM mail0_mcp_idempotency
       WHERE user_id = ? AND idempotency_key = ? AND operation = ?`,
    )
      .bind(userId, key, operation)
      .run();
    throw error;
  }
}

function extractEmail(value: string) {
  return (
    value
      .match(/<([^>]+)>/)?.[1]
      ?.trim()
      .toLowerCase() ?? value.trim().toLowerCase()
  );
}

function publicAccount(account: McpMailboxAccount) {
  return {
    mailboxId: account.id,
    connectionId: account.connectionId,
    email: account.email,
    name: account.name,
    provider: account.providerId,
    kind: account.kind,
    isDefault: account.isDefault,
    isConnected: account.isConnected,
    sourceConnectionId: account.kind === 'alias' ? account.connectionId : undefined,
    inboxLabel: account.labelName,
    capabilities: {
      read: account.isConnected,
      send: account.isConnected,
      drafts: account.isConnected,
      labels: account.isConnected,
      providerSync: account.isConnected,
    },
  };
}

function parsePageTokens(value?: string) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return { default: value };
  }
}

async function mapInBatches<T, U>(values: T[], size: number, mapper: (value: T) => Promise<U>) {
  const mapped: U[] = [];
  for (let index = 0; index < values.length; index += size) {
    mapped.push(...(await Promise.all(values.slice(index, index + size).map(mapper))));
  }
  return mapped;
}

function threadPreview(
  account: McpMailboxAccount,
  threadId: string,
  thread: Awaited<ReturnType<typeof getThread>>['result'],
) {
  const latest = thread.latest ?? thread.messages.at(-1);
  return {
    mailboxId: account.id,
    connectionId: account.connectionId,
    accountEmail: account.email,
    threadId,
    key: `${account.id}:${threadId}`,
    subject: latest?.subject ?? '',
    sender: latest?.sender,
    receivedOn: latest?.receivedOn,
    unread: thread.hasUnread,
    labels: thread.labels,
    messageCount: thread.messages.length,
    latestMessageId: latest?.id,
  };
}

export class ZeroMCP extends McpAgent<typeof env, Record<string, unknown>, { userId: string }> {
  server = new McpServer({
    name: 'varunsmail',
    version: '2.0.0',
    description: 'Private, account-aware access to Varunsmail',
  });

  async init(): Promise<void> {
    if (!this.props.userId) return;

    const userId = this.props.userId;
    const { db } = createDb(env.DB);
    const loadAccounts = async () => {
      const [owner, connections] = await Promise.all([
        db.query.user.findFirst({ where: eq(user.id, userId) }),
        db.query.connection.findMany({ where: eq(connection.userId, userId) }),
      ]);
      if (!owner) throw new Error('Unauthorized');
      return {
        owner,
        connections,
        accounts: listMcpMailboxAccounts(connections, owner.defaultConnectionId),
      };
    };
    const resolveAccount = async (selector?: string) => {
      const { owner, connections } = await loadAccounts();
      return resolveMcpMailboxAccount(connections, owner.defaultConnectionId, selector);
    };
    const resolveConnectedAccount = async (selector?: string) => {
      const account = await resolveAccount(selector);
      if (!account.isConnected) throw new Error('Mailbox account is disconnected');
      return account;
    };
    const getAccountAgent = async (account: McpMailboxAccount) =>
      (await getZeroAgent(account.connectionId)).stub;
    const getAliasLabelId = async (account: McpMailboxAccount) => {
      if (!account.labelName) return;
      const labels = await (await getAccountAgent(account)).getUserLabels();
      const label = labels.find(
        ({ name }) => name.toLowerCase() === account.labelName!.toLowerCase(),
      );
      if (!label?.id) throw new Error(`Mailbox label "${account.labelName}" is unavailable`);
      return label.id;
    };
    const loadThread = async (
      account: McpMailboxAccount,
      threadId: string,
      knownAliasLabelId?: string,
    ) => {
      const { result: thread } = await getThread(account.connectionId, threadId);
      const aliasLabelId = account.labelName
        ? (knownAliasLabelId ?? (await getAliasLabelId(account)))
        : undefined;
      if (
        aliasLabelId &&
        !thread.labels.some(({ id }) => id === aliasLabelId) &&
        !thread.messages.some(({ tags }) => tags.some(({ id }) => id === aliasLabelId))
      ) {
        throw new Error('Thread is outside this alias mailbox');
      }
      return thread;
    };

    this.server.registerTool(
      'accounts_manage',
      {
        description:
          'List the owner mailboxes, inspect one, set the default, disconnect one, or return the interactive connection page. Every other tool accepts mailboxId or email as account.',
        inputSchema: {
          action: z.enum(['list', 'get', 'set_default', 'disconnect', 'connect']).default('list'),
          account: accountSelector,
        },
        outputSchema,
        annotations: destructive,
      },
      async ({ action, account: selector }) => {
        if (action === 'list') {
          const { accounts } = await loadAccounts();
          return result({ accounts: accounts.map(publicAccount) });
        }
        if (action === 'connect') {
          return result({
            interactive: true,
            url: `${env.VITE_PUBLIC_APP_URL}/settings/connections`,
            reason: 'Google requires the owner to complete OAuth in a browser.',
          });
        }
        const account = await resolveAccount(selector);
        if (action === 'get') return result({ account: publicAccount(account) });
        if (account.kind === 'alias') {
          throw new Error('Alias mailboxes cannot be made default or disconnected independently');
        }
        const zeroDb = await getZeroDB(userId);
        if (action === 'set_default') {
          await zeroDb.updateUser({ defaultConnectionId: account.connectionId });
          return result({ success: true, account: publicAccount(account) });
        }
        await zeroDb.deleteConnection(account.connectionId);
        return result({ success: true, disconnected: publicAccount(account) });
      },
    );

    this.server.registerTool(
      'threads_list',
      {
        description:
          'List one or several mailboxes with account-scoped thread IDs. maxResults applies per mailbox. Pass the returned pageToken unchanged to continue.',
        inputSchema: {
          account: accountSelector,
          accounts: z.array(z.string()).optional(),
          unified: z.boolean().optional().default(false),
          folder: z.string().optional().default('inbox'),
          query: z.string().optional().default(''),
          labelIds: z.array(z.string()).optional().default([]),
          maxResults: z.number().int().min(1).max(100).optional().default(25),
          pageToken: z.string().optional(),
        },
        outputSchema,
        annotations: readOnly,
      },
      async (input) => {
        const state = await loadAccounts();
        const selected = input.accounts?.length
          ? input.accounts.map((selector) =>
              resolveMcpMailboxAccount(
                state.connections,
                state.owner.defaultConnectionId,
                selector,
              ),
            )
          : input.unified
            ? state.accounts.filter(({ kind }) => kind === 'connection')
            : [
                resolveMcpMailboxAccount(
                  state.connections,
                  state.owner.defaultConnectionId,
                  input.account,
                ),
              ];
        const unique = selected.filter(
          (account, index) => selected.findIndex(({ id }) => id === account.id) === index,
        );
        const cursors = parsePageTokens(input.pageToken);
        const pages = await Promise.allSettled(
          unique.map(async (account) => {
            const agent = await getAccountAgent(account);
            const aliasLabelId = await getAliasLabelId(account);
            const page = (await agent.rawListThreads({
              folder: input.folder,
              query: input.query,
              maxResults: input.maxResults,
              labelIds: [...new Set([...input.labelIds, ...(aliasLabelId ? [aliasLabelId] : [])])],
              pageToken: cursors[account.id] ?? (unique.length === 1 ? cursors.default : undefined),
            })) as unknown as IGetThreadsResponse;
            const threads = await mapInBatches(page.threads, 10, async ({ id }) => {
              try {
                return threadPreview(account, id, await loadThread(account, id, aliasLabelId));
              } catch (error) {
                return {
                  mailboxId: account.id,
                  connectionId: account.connectionId,
                  accountEmail: account.email,
                  threadId: id,
                  key: `${account.id}:${id}`,
                  unavailable: true,
                  error: error instanceof Error ? error.message : 'Thread unavailable',
                };
              }
            });
            return { account, threads, nextPageToken: page.nextPageToken };
          }),
        );
        const successful = pages.flatMap((page) =>
          page.status === 'fulfilled' ? [page.value] : [],
        );
        const nextTokens = Object.fromEntries(
          successful.flatMap(({ account, nextPageToken }) =>
            nextPageToken ? [[account.id, nextPageToken]] : [],
          ),
        );
        return result({
          mailboxes: successful.map(({ account, threads }) => ({
            account: publicAccount(account),
            threads,
          })),
          pageToken: Object.keys(nextTokens).length ? JSON.stringify(nextTokens) : null,
          failures: pages.flatMap((page, index) => {
            const account = unique[index];
            return page.status === 'rejected' && account
              ? [{ mailboxId: account.id, message: 'Mailbox could not be loaded' }]
              : [];
          }),
        });
      },
    );

    this.server.registerTool(
      'thread_get',
      {
        description:
          'Get every message in one account-scoped thread, including recipients, reply headers, labels, bodies, and attachment metadata.',
        inputSchema: {
          account: accountSelector,
          threadId: z.string().min(1),
          includeBodies: z.boolean().optional().default(true),
        },
        outputSchema,
        annotations: readOnly,
      },
      async ({ account: selector, threadId, includeBodies }) => {
        const account = await resolveConnectedAccount(selector);
        const thread = await loadThread(account, threadId);
        return result({
          account: publicAccount(account),
          threadId,
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            connectionId: account.connectionId,
            ...(includeBodies ? {} : { body: '', processedHtml: '', decodedBody: undefined }),
            attachments: message.attachments?.map((attachment) => ({ ...attachment, body: '' })),
          })),
        });
      },
    );

    this.server.registerTool(
      'threads_search',
      {
        description:
          'Search mailboxes with Gmail/provider query syntax and return exact account-scoped matching threads. Omit accounts to search every physical mailbox.',
        inputSchema: {
          query: z.string().min(1),
          accounts: z.array(z.string()).optional(),
          folder: z.string().optional().default('all'),
          maxResults: z.number().int().min(1).max(50).optional().default(10),
        },
        outputSchema,
        annotations: readOnly,
      },
      async ({ query, accounts: selectors, folder, maxResults }) => {
        const state = await loadAccounts();
        const selected = selectors?.length
          ? selectors.map((selector) =>
              resolveMcpMailboxAccount(
                state.connections,
                state.owner.defaultConnectionId,
                selector,
              ),
            )
          : state.accounts.filter(({ kind }) => kind === 'connection');
        const pages = await Promise.allSettled(
          selected.map(async (account) => {
            if (!account.isConnected) throw new Error('Mailbox account is disconnected');
            const agent = await getAccountAgent(account);
            const aliasLabelId = await getAliasLabelId(account);
            const page = (await agent.rawListThreads({
              folder,
              query,
              maxResults,
              labelIds: aliasLabelId ? [aliasLabelId] : [],
            })) as unknown as IGetThreadsResponse;
            const threads = await mapInBatches(page.threads, 10, async ({ id }) =>
              threadPreview(account, id, await loadThread(account, id, aliasLabelId)),
            );
            return { account: publicAccount(account), threads };
          }),
        );
        return result({
          query,
          mailboxes: pages.flatMap((page) => (page.status === 'fulfilled' ? [page.value] : [])),
          failures: pages.flatMap((page, index) => {
            const account = selected[index];
            return page.status === 'rejected' && account
              ? [{ mailboxId: account.id, message: 'Mailbox could not be searched' }]
              : [];
          }),
        });
      },
    );

    this.server.registerTool(
      'mail_ai_search',
      {
        description:
          'Search every physical mailbox semantically and return exact matching thread references, account provenance, and excerpts.',
        inputSchema: {
          query: z.string().min(1),
          folder: z.string().optional().default('all'),
          maxResults: z.number().int().min(1).max(20).optional().default(10),
        },
        outputSchema,
        annotations: readOnly,
      },
      async ({ query, folder, maxResults }) => {
        const { accounts } = await loadAccounts();
        const physical = accounts.filter(({ kind }) => kind === 'connection');
        const searchResult = await searchAcrossAccounts(
          physical.map(({ connectionId: id, email, name }) => ({ id, email, name })),
          { query, folder, maxResults },
          {
            search: async (connectionId, params) => {
              const agent = (await getZeroAgent(connectionId)).stub;
              const response = await agent.searchThreads(params);
              return {
                threadIds: response.threadIds.filter(
                  (threadId): threadId is string => typeof threadId === 'string',
                ),
                source: response.source === 'autorag' ? 'autorag' : 'raw',
                ...('error' in response && typeof response.error === 'string'
                  ? { error: response.error }
                  : {}),
              };
            },
            loadThread: async (connectionId, threadId) =>
              (await getThread(connectionId, threadId)).result,
          },
        );
        return result(searchResult);
      },
    );

    this.server.registerTool(
      'threads_modify',
      {
        description:
          'Apply a Gmail-backed action to account-scoped threads. Actions reconcile the local cache and report per-thread sync state.',
        inputSchema: {
          account: accountSelector,
          threadIds: z.array(z.string().min(1)).min(1),
          action: z.enum([
            'read',
            'unread',
            'star',
            'unstar',
            'important',
            'unimportant',
            'archive',
            'inbox',
            'spam',
            'not_spam',
            'trash',
            'restore',
            'permanent_delete',
            'snooze',
            'unsnooze',
            'labels',
          ]),
          addLabelIds: z.array(z.string()).optional().default([]),
          removeLabelIds: z.array(z.string()).optional().default([]),
          wakeAt: z.string().datetime({ offset: true }).optional(),
        },
        outputSchema,
        annotations: destructive,
      },
      async ({ account: selector, threadIds, action, addLabelIds, removeLabelIds, wakeAt }) => {
        const account = await resolveConnectedAccount(selector);
        const agent = await getAccountAgent(account);
        if (account.kind === 'alias') {
          await mapInBatches(threadIds, 10, (threadId) => loadThread(account, threadId));
        }
        if (action === 'permanent_delete') {
          const changes = await mapInBatches(threadIds, 5, async (threadId) => {
            await agent.delete(threadId);
            return { success: true, threadId, deleted: true };
          });
          return result({ account: publicAccount(account), action, changes });
        }

        const labelChanges: Record<string, { add: string[]; remove: string[] }> = {
          read: { add: [], remove: ['UNREAD'] },
          unread: { add: ['UNREAD'], remove: [] },
          star: { add: ['STARRED'], remove: [] },
          unstar: { add: [], remove: ['STARRED'] },
          important: { add: ['IMPORTANT'], remove: [] },
          unimportant: { add: [], remove: ['IMPORTANT'] },
          archive: { add: [], remove: ['INBOX'] },
          inbox: { add: ['INBOX'], remove: ['TRASH', 'SPAM', 'SNOOZED'] },
          spam: { add: ['SPAM'], remove: ['INBOX'] },
          not_spam: { add: ['INBOX'], remove: ['SPAM'] },
          trash: { add: ['TRASH'], remove: ['INBOX', 'SPAM'] },
          restore: { add: ['INBOX'], remove: ['TRASH'] },
          snooze: { add: ['SNOOZED'], remove: ['INBOX'] },
          unsnooze: { add: ['INBOX'], remove: ['SNOOZED'] },
          labels: { add: addLabelIds, remove: removeLabelIds },
        };
        const labels = labelChanges[action];
        if (!labels) throw new Error('Unsupported thread action');
        if (action === 'snooze') {
          const timestamp = wakeAt ? Date.parse(wakeAt) : NaN;
          if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
            throw new Error('wakeAt must be a future ISO date');
          }
        }
        const changes = await mapInBatches(threadIds, 5, (threadId) =>
          agent.modifyThreadLabelsInDB(threadId, labels.add, labels.remove),
        );
        if (action === 'snooze' && wakeAt) {
          await Promise.all(
            threadIds.map((threadId) =>
              env.snoozed_emails.put(`${threadId}__${account.connectionId}`, wakeAt, {
                metadata: { wakeAt },
              }),
            ),
          );
        }
        if (action === 'unsnooze' || action === 'inbox' || action === 'restore') {
          await Promise.all(
            threadIds.map((threadId) =>
              env.snoozed_emails.delete(`${threadId}__${account.connectionId}`),
            ),
          );
        }
        return result({ account: publicAccount(account), action, changes });
      },
    );

    this.server.registerTool(
      'email_send',
      {
        description:
          'Send, reply, reply-all, forward, schedule, or send an existing draft from an explicit mailbox. Reuse the same idempotencyKey only when retrying the exact same send.',
        inputSchema: {
          account: accountSelector,
          idempotencyKey: z.string().trim().min(8).max(200),
          to: z.array(senderSchema).min(1),
          subject: z.string(),
          message: z.string(),
          attachments: z.array(attachmentSchema).optional().default([]),
          headers: z.record(z.string()).optional().default({}),
          cc: z.array(senderSchema).optional(),
          bcc: z.array(senderSchema).optional(),
          threadId: z.string().optional(),
          fromEmail: z.string().optional(),
          draftId: z.string().optional(),
          isForward: z.boolean().optional(),
          originalMessage: z.string().optional(),
          scheduleAt: z.string().datetime({ offset: true }).optional(),
        },
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ account: selector, idempotencyKey, ...input }) => {
        const account = await resolveConnectedAccount(selector);
        const agent = await getAccountAgent(account);
        if (input.threadId && account.kind === 'alias') {
          await loadThread(account, input.threadId);
        }

        const requestedFrom = account.fromEmail ?? input.fromEmail ?? account.email;
        const allowed = new Set(
          [account.email, ...(await agent.getEmailAliases()).map(({ email }) => email)].map(
            (email) => email.toLowerCase(),
          ),
        );
        if (!allowed.has(extractEmail(requestedFrom))) {
          throw new Error('The selected mailbox is not authorized to send from that address');
        }

        const mail = { ...input, fromEmail: requestedFrom };
        const sendResult = await runIdempotentOperation(
          userId,
          idempotencyKey,
          'email_send',
          {
            mailboxId: account.id,
            connectionId: account.connectionId,
            ...mail,
          },
          () =>
            sendMailboxEmail({
              env,
              userId,
              connectionId: account.connectionId,
              input: mail,
              waitUntil: (promise) => this.ctx.waitUntil(promise),
            }),
        );
        return result({ account: publicAccount(account), ...sendResult });
      },
    );

    this.server.registerTool(
      'drafts_manage',
      {
        description: 'List, get, save/update, or delete Gmail drafts in an explicit mailbox.',
        inputSchema: {
          action: z.enum(['list', 'get', 'save', 'delete']),
          account: accountSelector,
          id: z.string().optional(),
          query: z.string().optional(),
          maxResults: z.number().int().min(1).max(100).optional().default(20),
          pageToken: z.string().optional(),
          to: z.string().optional(),
          cc: z.string().optional(),
          bcc: z.string().optional(),
          subject: z.string().optional(),
          message: z.string().optional(),
          threadId: z.string().nullable().optional(),
          fromEmail: z.string().nullable().optional(),
          attachments: z.array(attachmentSchema).optional().default([]),
        },
        outputSchema,
        annotations: destructive,
      },
      async (input) => {
        const account = await resolveConnectedAccount(input.account);
        const agent = await getAccountAgent(account);
        if (input.action === 'list') {
          const drafts = (await agent.listDrafts({
            q: input.query,
            maxResults: input.maxResults,
            pageToken: input.pageToken,
          })) as unknown as IGetThreadsResponse;
          return result({
            account: publicAccount(account),
            ...drafts,
          });
        }
        if (!input.id && input.action !== 'save') throw new Error('id is required');
        if (input.action === 'get') {
          return result({
            account: publicAccount(account),
            draft: await agent.getDraft(input.id!),
          });
        }
        if (input.action === 'delete') {
          await agent.deleteDraft(input.id!);
          return result({ success: true, account: publicAccount(account), id: input.id });
        }
        const fromEmail = account.fromEmail ?? input.fromEmail ?? account.email;
        const draft = await agent.createDraft({
          id: input.id ?? null,
          to: input.to ?? '',
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject ?? '',
          message: input.message ?? '',
          attachments: input.attachments,
          threadId: input.threadId ?? null,
          fromEmail,
        });
        return result({ success: true, account: publicAccount(account), draft });
      },
    );

    this.server.registerTool(
      'labels_manage',
      {
        description: 'List, get, create, update, or delete provider labels in an explicit mailbox.',
        inputSchema: {
          action: z.enum(['list', 'get', 'create', 'update', 'delete']).default('list'),
          account: accountSelector,
          id: z.string().optional(),
          name: z.string().optional(),
          backgroundColor: z.string().optional(),
          textColor: z.string().optional(),
        },
        outputSchema,
        annotations: destructive,
      },
      async ({ action, account: selector, id, name, backgroundColor, textColor }) => {
        const account = await resolveConnectedAccount(selector);
        const agent = await getAccountAgent(account);
        if (action === 'list') {
          return result({ account: publicAccount(account), labels: await agent.getUserLabels() });
        }
        if (action === 'get') {
          if (!id) throw new Error('id is required');
          return result({ account: publicAccount(account), label: await agent.getLabel(id) });
        }
        if (action === 'delete') {
          if (!id) throw new Error('id is required');
          await agent.deleteLabel(id);
          return result({ success: true, account: publicAccount(account), id });
        }
        if (!name) throw new Error('name is required');
        const color = backgroundColor && textColor ? { backgroundColor, textColor } : undefined;
        if (action === 'update') {
          if (!id) throw new Error('id is required');
          await agent.updateLabel(id, { name, color });
          return result({ success: true, account: publicAccount(account), id, name, color });
        }
        await agent.createLabel({ name, color });
        const label = (await agent.getUserLabels()).find(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        );
        return result({ success: true, account: publicAccount(account), label });
      },
    );

    this.server.registerTool(
      'mail_content',
      {
        description:
          'List send-as aliases, suggest recipients, inspect or download attachments, get RFC 822 source, or verify message authentication for an explicit mailbox.',
        inputSchema: {
          action: z.enum(['aliases', 'recipients', 'attachments', 'attachment', 'raw', 'verify']),
          account: accountSelector,
          messageId: z.string().optional(),
          attachmentId: z.string().optional(),
          query: z.string().optional().default(''),
          limit: z.number().int().min(1).max(100).optional().default(10),
        },
        outputSchema,
        annotations: readOnly,
      },
      async ({ action, account: selector, messageId, attachmentId, query, limit }) => {
        const account = await resolveConnectedAccount(selector);
        const agent = await getAccountAgent(account);
        if (action === 'aliases') {
          return result({
            account: publicAccount(account),
            aliases: await agent.getEmailAliases(),
          });
        }
        if (action === 'recipients') {
          return result({
            account: publicAccount(account),
            recipients: await agent.suggestRecipients(query, limit),
          });
        }
        if (!messageId) throw new Error('messageId is required');
        if (action === 'raw') {
          return result({
            account: publicAccount(account),
            messageId,
            raw: await agent.getRawEmail(messageId),
          });
        }
        if (action === 'verify') {
          const { verify } = await import('../../lib/email-verification');
          return result({
            account: publicAccount(account),
            messageId,
            verification: await verify(await agent.getRawEmail(messageId)),
          });
        }
        const attachments = await agent.getMessageAttachments(messageId);
        if (action === 'attachments') {
          return result({
            account: publicAccount(account),
            messageId,
            attachments: attachments.map(
              ({ filename, mimeType, size, attachmentId: id, headers }) => ({
                filename,
                mimeType,
                size,
                attachmentId: id,
                headers,
              }),
            ),
          });
        }
        if (!attachmentId) throw new Error('attachmentId is required');
        const attachment = attachments.find((candidate) => candidate.attachmentId === attachmentId);
        if (!attachment) throw new Error('Attachment not found');
        return result({ account: publicAccount(account), messageId, attachment });
      },
    );

    this.server.registerTool(
      'spam_empty',
      {
        description: 'Permanently delete every message in the Spam folder of one physical mailbox.',
        inputSchema: { account: accountSelector },
        outputSchema,
        annotations: destructive,
      },
      async ({ account: selector }) => {
        const account = await resolveConnectedAccount(selector);
        if (account.kind === 'alias') throw new Error('Select a physical mailbox to empty spam');
        const deleted = await (await getAccountAgent(account)).deleteAllSpam();
        return result({ account: publicAccount(account), ...deleted });
      },
    );

    this.server.registerTool(
      'mail_unsubscribe',
      {
        description:
          'Inspect or use the List-Unsubscribe action on a specific account-scoped provider message. HTTP actions are returned for the MCP host to perform.',
        inputSchema: {
          action: z.enum(['inspect', 'unsubscribe']).optional().default('inspect'),
          account: accountSelector,
          threadId: z.string().min(1),
          providerMessageId: z.string().min(1),
        },
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ action, account: selector, threadId, providerMessageId }) => {
        const account = await resolveConnectedAccount(selector);
        const thread = await loadThread(account, threadId);
        const message = thread.messages.find(({ id }) => id === providerMessageId);
        if (!message) throw new Error('Message was not found in the selected mailbox thread');

        const unsubscribe = message.listUnsubscribe
          ? getListUnsubscribeAction({
              listUnsubscribe: message.listUnsubscribe,
              listUnsubscribePost: message.listUnsubscribePost,
            })
          : null;
        if (action === 'inspect') {
          return result({
            account: publicAccount(account),
            threadId,
            providerMessageId,
            sender: message.sender,
            subject: message.subject,
            unsubscribe,
          });
        }
        if (!unsubscribe) throw new Error('This message has no supported List-Unsubscribe action');

        if (unsubscribe.type !== 'email') {
          return result({
            completed: false,
            status: 'external_action_required',
            account: publicAccount(account),
            action:
              unsubscribe.type === 'get'
                ? { type: 'navigate', url: unsubscribe.url }
                : {
                    type: 'post',
                    url: unsubscribe.url,
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: unsubscribe.body,
                  },
          });
        }

        const email = z.string().email().parse(unsubscribe.emailAddress);
        const sendResult = await runIdempotentOperation(
          userId,
          `${account.id}:${providerMessageId}`,
          'list_unsubscribe_email',
          {
            mailboxId: account.id,
            threadId,
            providerMessageId,
            email,
            subject: unsubscribe.subject,
          },
          () =>
            sendMailboxEmail({
              env,
              userId,
              connectionId: account.connectionId,
              input: {
                to: [{ email, name: email }],
                subject: unsubscribe.subject || 'Unsubscribe Request',
                message: 'This message is a request to unsubscribe from this mailing list.',
                attachments: [],
                headers: {},
                fromEmail: account.fromEmail ?? account.email,
              },
              waitUntil: (promise) => this.ctx.waitUntil(promise),
            }),
        );
        return result({ completed: true, account: publicAccount(account), ...sendResult });
      },
    );

    this.server.registerTool(
      'mail_ai_compose',
      {
        description: 'Draft or rewrite an email body with the selected mailbox writing context.',
        inputSchema: {
          account: accountSelector,
          prompt: z.string().min(1),
          emailSubject: z.string().optional(),
          to: z.array(z.string()).optional(),
          cc: z.array(z.string()).optional(),
          threadMessages: z
            .array(
              z.object({
                from: z.string(),
                to: z.array(z.string()),
                cc: z.array(z.string()).optional(),
                subject: z.string(),
                body: z.string(),
              }),
            )
            .optional(),
        },
        outputSchema,
        annotations: readOnly,
      },
      async ({ account: selector, ...input }) => {
        const account = await resolveConnectedAccount(selector);
        const body = await composeEmail({
          ...input,
          username: 'Varun',
          connectionId: account.connectionId,
        });
        return result({ account: publicAccount(account), body });
      },
    );

    this.server.registerTool(
      'mail_ai_prompts',
      {
        description: 'Read or update the AI writing prompts for one physical mailbox.',
        inputSchema: {
          action: z.enum(['get', 'update']),
          account: accountSelector,
          promptType: z.nativeEnum(EPrompts).optional(),
          content: z.string().optional(),
        },
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ action, account: selector, promptType, content }) => {
        const account = await resolveConnectedAccount(selector);
        if (account.kind === 'alias') {
          throw new Error('Select the physical source mailbox to configure its AI prompts');
        }
        if (action === 'get') {
          return result({
            account: publicAccount(account),
            prompts: await getPrompts({ connectionId: account.connectionId }),
          });
        }
        if (!promptType || content === undefined) {
          throw new Error('promptType and content are required');
        }
        await env.prompts_storage.put(`${account.connectionId}-${promptType}`, content);
        return result({ success: true, account: publicAccount(account), promptType });
      },
    );

    this.server.registerTool(
      'mail_ai_subject',
      {
        description: 'Generate a concise subject using the writing style of an explicit mailbox.',
        inputSchema: {
          account: accountSelector,
          message: z.string().min(1),
        },
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ account: selector, message }) => {
        const account = await resolveConnectedAccount(selector);
        const subject = await generateEmailSubjectForConnection(message, account.connectionId);
        return result({ account: publicAccount(account), subject });
      },
    );

    this.server.registerTool(
      'mail_web_research',
      {
        description: 'Research a sender or email topic on the web and return an answer with links.',
        inputSchema: { query: z.string().min(1) },
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ query }) => {
        const research = await researchWeb(query);
        return result({ text: research.text, sources: research.sources });
      },
    );

    this.server.registerTool(
      'sender_brand',
      {
        description: 'Look up the BIMI brand record and verified SVG logo for an email or domain.',
        inputSchema: {
          email: z.string().email().optional(),
          domain: z.string().min(1).optional(),
        },
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ email, domain }) => {
        if (email) return result(await getBimiMetadata({ email }));
        if (domain) return result(await getBimiMetadata({ domain }));
        throw new Error('email or domain is required');
      },
    );

    this.server.registerTool(
      'thread_summarize',
      {
        description:
          'Return a short AI summary and exact source metadata for one account-scoped thread.',
        inputSchema: { account: accountSelector, threadId: z.string().min(1) },
        outputSchema,
        annotations: readOnly,
      },
      async ({ account: selector, threadId }) => {
        const account = await resolveConnectedAccount(selector);
        const thread = await loadThread(account, threadId);
        const vector = await env.VECTORIZE.getByIds([threadId]);
        const metadata = vector[0]?.metadata as
          | { summary?: string; connection?: string }
          | undefined;
        const summary =
          metadata?.connection === account.connectionId && metadata.summary
            ? await summarizeText(metadata.summary, env)
            : await summarizeText(
                thread.messages
                  .map(({ decodedBody }) => decodedBody ?? '')
                  .join('\n\n')
                  .slice(0, 50_000),
                env,
              );
        return result({ account: publicAccount(account), threadId, summary });
      },
    );

    this.server.registerTool(
      'current_date',
      {
        description: 'Get the current date and time context used by Varunsmail.',
        inputSchema: {},
        outputSchema,
        annotations: readOnly,
      },
      async () => result({ currentDate: getCurrentDateContext() }),
    );

    registerMcpWorkflowTools(this.server, userId);
  }
}
