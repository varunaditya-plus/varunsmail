import { defaultUserSettings, userSettingsSchema } from '../../lib/schemas';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TemplatesManager } from '../../lib/templates-manager';
import { MailboxWorkflows } from '../../lib/mailbox-workflows';
import { NotesManager } from '../../lib/notes-manager';
import { getZeroDB } from '../../lib/server-utils';
import { env } from '../../env';
import { z } from 'zod';

const outputSchema = { result: z.unknown() };
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const mailboxWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const localWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const connectionId = z.string().min(1).optional().describe('Mailbox connection ID');
const itemId = z.string().min(1).optional();
const threadId = z.string().min(1).optional().describe('Provider thread ID');
const threadRef = z.object({
  connectionId: z.string().min(1),
  threadId: z.string().min(1),
});
const smartFolderSort = z.enum(['newest', 'oldest', 'sender', 'domain']);
const ruleAction = z.enum(['archive', 'label', 'important']);
const bundleMatcher = z
  .object({
    connectionId: z.string().min(1).nullable().optional(),
    kind: z.enum(['newsletter', 'receipt', 'notification', 'sender']),
    value: z.string().nullable().optional(),
  })
  .superRefine((matcher, context) => {
    if (matcher.kind === 'sender' && !matcher.value?.trim()) {
      context.addIssue({
        code: 'custom',
        message: 'Sender matchers require an email',
        path: ['value'],
      });
    }
  });
const userSettingsPatchSchema = z.object({
  language: userSettingsSchema.shape.language.optional(),
  timezone: userSettingsSchema.shape.timezone.optional(),
  dynamicContent: userSettingsSchema.shape.dynamicContent.optional(),
  externalImages: userSettingsSchema.shape.externalImages.optional(),
  trackingProtection: userSettingsSchema.shape.trackingProtection.removeDefault().optional(),
  customPrompt: userSettingsSchema.shape.customPrompt.removeDefault().optional(),
  isOnboarded: userSettingsSchema.shape.isOnboarded.optional(),
  trustedSenders: userSettingsSchema.shape.trustedSenders.optional(),
  colorTheme: userSettingsSchema.shape.colorTheme.removeDefault().optional(),
  categories: userSettingsSchema.shape.categories.optional(),
  defaultEmailAlias: userSettingsSchema.shape.defaultEmailAlias.optional(),
  undoSendEnabled: userSettingsSchema.shape.undoSendEnabled.removeDefault().optional(),
  imageCompression: userSettingsSchema.shape.imageCompression.removeDefault().optional(),
  autoRead: userSettingsSchema.shape.autoRead.removeDefault().optional(),
  animations: userSettingsSchema.shape.animations.removeDefault().optional(),
  newMailNotifications: userSettingsSchema.shape.newMailNotifications.removeDefault().optional(),
  priorityNotificationSenders: userSettingsSchema.shape.priorityNotificationSenders
    .removeDefault()
    .optional(),
  quietHoursEnabled: userSettingsSchema.shape.quietHoursEnabled.removeDefault().optional(),
  quietHoursStart: userSettingsSchema.shape.quietHoursStart.removeDefault().optional(),
  quietHoursEnd: userSettingsSchema.shape.quietHoursEnd.removeDefault().optional(),
  notificationTimezone: userSettingsSchema.shape.notificationTimezone.optional(),
  hiddenSidebarItems: userSettingsSchema.shape.hiddenSidebarItems.removeDefault().optional(),
});

function required<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is required for this action`);
  }
  return value;
}

function result(value: unknown) {
  const text = JSON.stringify(
    { result: value ?? null },
    (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested),
    2,
  );
  const structuredContent = JSON.parse(text) as { result: unknown };
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
  };
}

async function ownedThreadKey(userId: string, mailboxId: string, messageThreadId: string) {
  const db = await getZeroDB(userId);
  if (!(await db.findUserConnection(mailboxId))) throw new Error('Mailbox connection not found');
  return `${mailboxId}:${messageThreadId}`;
}

async function getSettings(userId: string) {
  const db = await getZeroDB(userId);
  const stored = await db.findUserSettings();
  const parsed = userSettingsSchema.safeParse(stored?.settings);
  return parsed.success ? parsed.data : defaultUserSettings;
}

function publicSettings(settings: typeof defaultUserSettings) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'zeroSignature'));
}

export function registerMcpWorkflowTools(server: McpServer, userId: string) {
  const workflows = new MailboxWorkflows(env, userId);
  const notes = new NotesManager();
  const templates = new TemplatesManager();

  server.registerTool(
    'mail_activity',
    {
      title: 'Mailbox activity and outbox',
      description:
        'Inspect mailbox activity or the outbox, force-sync an owned Gmail account, retry a failed queued send, or cancel a queued send.',
      inputSchema: {
        action: z.enum(['list', 'outbox', 'sync', 'retry_outbox', 'cancel_outbox']),
        connectionId,
        messageId: z.string().min(1).optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list':
          return result({ activity: await workflows.getActivity() });
        case 'outbox':
          return result({ messages: await workflows.getOutbox() });
        case 'sync':
          return result(await workflows.forceSync(required(input.connectionId, 'connectionId')));
        case 'retry_outbox':
          return result(await workflows.retryOutbox(required(input.messageId, 'messageId')));
        case 'cancel_outbox':
          return result(await workflows.cancelOutbox(required(input.messageId, 'messageId')));
      }
    },
  );

  server.registerTool(
    'mail_assets',
    {
      title: 'Mailbox files and links',
      description:
        'List attachments and links across owned mailboxes with filtering and pagination.',
      inputSchema: {
        kind: z.enum(['all', 'attachment', 'link']).optional(),
        connectionId,
        query: z.string().max(200).optional(),
        cursor: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => result(await workflows.listAssets(input)),
  );

  server.registerTool(
    'mail_smart_folders',
    {
      title: 'Smart folders',
      description: 'List, read, create, update, or delete saved mailbox searches.',
      inputSchema: {
        action: z.enum(['list', 'get', 'create', 'update', 'delete']),
        id: itemId,
        name: z.string().trim().min(1).optional(),
        query: z.string().trim().min(1).optional(),
        connectionId: z.string().min(1).nullable().optional(),
        sort: smartFolderSort.optional(),
      },
      outputSchema,
      annotations: localWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list':
          return result({ folders: await workflows.listSmartFolders() });
        case 'get':
          return result({ folder: await workflows.getSmartFolder(required(input.id, 'id')) });
        case 'create':
          return result({
            folder: await workflows.createSmartFolder({
              name: required(input.name, 'name'),
              query: required(input.query, 'query'),
              connectionId: input.connectionId ?? undefined,
              sort: input.sort ?? 'newest',
            }),
          });
        case 'update':
          return result({
            folder: await workflows.updateSmartFolder(required(input.id, 'id'), {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.query !== undefined ? { query: input.query } : {}),
              ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
              ...(input.sort !== undefined ? { sort: input.sort } : {}),
            }),
          });
        case 'delete':
          return result({ deleted: await workflows.deleteSmartFolder(required(input.id, 'id')) });
      }
    },
  );

  server.registerTool(
    'mail_cleanup',
    {
      title: 'Sender cleanup',
      description:
        'List cleanup candidates and rules, create or enable a rule, run it, or delete it. Running a rule archives or trashes matching old mail.',
      inputSchema: {
        action: z.enum(['candidates', 'list', 'create', 'set_enabled', 'run', 'delete']),
        connectionId,
        id: itemId,
        senderEmail: z.string().email().optional(),
        cleanupAction: z.enum(['archive', 'trash']).optional(),
        ageDays: z.number().int().min(0).max(3650).optional(),
        enabled: z.boolean().optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'candidates':
          return result({
            senders: await workflows.listCleanupCandidates(input.connectionId),
          });
        case 'list':
          return result({ rules: await workflows.listCleanupRules(input.connectionId) });
        case 'create':
          return result({
            rule: await workflows.createCleanupRule(
              required(input.connectionId, 'connectionId'),
              required(input.senderEmail, 'senderEmail'),
              required(input.cleanupAction, 'cleanupAction'),
              required(input.ageDays, 'ageDays'),
            ),
          });
        case 'set_enabled':
          return result({
            rule: await workflows.setCleanupRuleEnabled(
              required(input.id, 'id'),
              required(input.enabled, 'enabled'),
            ),
          });
        case 'run':
          return result(await workflows.runCleanupRule(required(input.id, 'id')));
        case 'delete':
          return result({ deleted: await workflows.deleteCleanupRule(required(input.id, 'id')) });
      }
    },
  );

  server.registerTool(
    'mail_reminders',
    {
      title: 'Reply reminders',
      description: 'List, set, or cancel reminders that return sent threads when nobody replies.',
      inputSchema: {
        action: z.enum(['list', 'set', 'cancel']),
        connectionId,
        threadId,
        sentMessageId: z.string().min(1).optional(),
        dueAt: z.string().datetime({ offset: true }).optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list':
          return result({ reminders: await workflows.listReminders(input.connectionId) });
        case 'set':
          return result({
            reminder: await workflows.setReminder({
              connectionId: required(input.connectionId, 'connectionId'),
              threadId: required(input.threadId, 'threadId'),
              sentMessageId: required(input.sentMessageId, 'sentMessageId'),
              dueAt: new Date(required(input.dueAt, 'dueAt')),
            }),
          });
        case 'cancel':
          return result({
            cancelled: await workflows.cancelReminder(
              required(input.connectionId, 'connectionId'),
              required(input.threadId, 'threadId'),
            ),
          });
      }
    },
  );

  server.registerTool(
    'mail_screening',
    {
      title: 'First-time sender screening',
      description:
        'Inspect or configure sender screening and allow, archive, block, or mark a pending sender as spam.',
      inputSchema: {
        action: z.enum(['get_config', 'set_enabled', 'list', 'decide']),
        connectionId,
        enabled: z.boolean().optional(),
        email: z.string().email().optional(),
        decision: z.enum(['allow', 'archive', 'block', 'spam']).optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'get_config':
          return result(
            await workflows.getScreeningConfig(required(input.connectionId, 'connectionId')),
          );
        case 'set_enabled':
          return result(
            await workflows.setScreeningEnabled(
              required(input.connectionId, 'connectionId'),
              required(input.enabled, 'enabled'),
            ),
          );
        case 'list':
          return result({ senders: await workflows.listScreening(input.connectionId) });
        case 'decide':
          return result(
            await workflows.decideSender(
              required(input.connectionId, 'connectionId'),
              required(input.email, 'email'),
              required(input.decision, 'decision'),
            ),
          );
      }
    },
  );

  server.registerTool(
    'mail_rules',
    {
      title: 'One-click sender rules',
      description:
        'List available labels and rules, preview or create a sender rule, enable or disable it, or delete it.',
      inputSchema: {
        action: z.enum(['labels', 'preview', 'list', 'create', 'set_enabled', 'delete']),
        connectionId,
        threadId,
        id: itemId,
        ruleAction: ruleAction.optional(),
        labelId: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'labels':
          return result({
            labels: await workflows.listRuleLabels(required(input.connectionId, 'connectionId')),
          });
        case 'preview':
          return result(
            await workflows.previewRule(
              required(input.connectionId, 'connectionId'),
              required(input.threadId, 'threadId'),
              required(input.ruleAction, 'ruleAction'),
              input.labelId,
            ),
          );
        case 'list':
          return result({ rules: await workflows.listRules(input.connectionId) });
        case 'create':
          return result(
            await workflows.createRule(
              required(input.connectionId, 'connectionId'),
              required(input.threadId, 'threadId'),
              required(input.ruleAction, 'ruleAction'),
              input.labelId,
            ),
          );
        case 'set_enabled':
          return result({
            rule: await workflows.setRuleEnabled(
              required(input.id, 'id'),
              required(input.enabled, 'enabled'),
            ),
          });
        case 'delete':
          return result({ deleted: await workflows.deleteRule(required(input.id, 'id')) });
      }
    },
  );

  server.registerTool(
    'mail_bundles',
    {
      title: 'Mail bundles and digests',
      description:
        'List bundles or held threads, create or update a bundle, release held mail now, or delete a bundle.',
      inputSchema: {
        action: z.enum(['list', 'threads', 'create', 'update', 'release_now', 'delete']),
        id: itemId,
        name: z.string().trim().min(1).optional(),
        deliveryMode: z.enum(['immediate', 'scheduled']).optional(),
        deliveryTimes: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).optional(),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
        matchers: z.array(bundleMatcher).min(1).optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list':
          return result({ bundles: await workflows.listBundles() });
        case 'threads':
          return result({ groups: await workflows.listBundleThreads(input.id) });
        case 'create':
          return result({
            bundle: await workflows.createBundle({
              name: required(input.name, 'name'),
              deliveryMode: input.deliveryMode ?? 'immediate',
              deliveryTimes: input.deliveryTimes ?? [],
              timezone: input.timezone,
              enabled: input.enabled,
              matchers: required(input.matchers, 'matchers'),
            }),
          });
        case 'update':
          return result({
            bundle: await workflows.updateBundle(required(input.id, 'id'), {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.deliveryMode !== undefined ? { deliveryMode: input.deliveryMode } : {}),
              ...(input.deliveryTimes !== undefined ? { deliveryTimes: input.deliveryTimes } : {}),
              ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
              ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
              ...(input.matchers !== undefined ? { matchers: input.matchers } : {}),
            }),
          });
        case 'release_now':
          return result(await workflows.releaseBundle(required(input.id, 'id')));
        case 'delete':
          return result({ deleted: await workflows.deleteBundle(required(input.id, 'id')) });
      }
    },
  );

  server.registerTool(
    'mail_focus',
    {
      title: 'Focus and Reply queue',
      description: 'List, add, remove, or reorder threads in the Focus and Reply queue.',
      inputSchema: {
        action: z.enum(['list', 'add', 'remove', 'reorder']),
        connectionId,
        threadId,
        items: z.array(threadRef).optional(),
      },
      outputSchema,
      annotations: mailboxWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list':
          return result({ threads: await workflows.listFocus() });
        case 'add':
          return result(
            await workflows.addFocus(
              required(input.connectionId, 'connectionId'),
              required(input.threadId, 'threadId'),
            ),
          );
        case 'remove':
          return result(
            await workflows.removeFocus(
              required(input.connectionId, 'connectionId'),
              required(input.threadId, 'threadId'),
            ),
          );
        case 'reorder':
          return result({ threads: await workflows.reorderFocus(required(input.items, 'items')) });
      }
    },
  );

  server.registerTool(
    'mail_notes',
    {
      title: 'Private thread notes',
      description:
        'List, create, update, delete, or reorder private notes attached to email threads.',
      inputSchema: {
        action: z.enum(['list', 'create', 'update', 'delete', 'reorder']),
        connectionId,
        threadId,
        noteId: z.string().min(1).optional(),
        content: z.string().optional(),
        color: z.string().optional(),
        isPinned: z.boolean().optional(),
        order: z.number().int().optional(),
        notes: z
          .array(
            z.object({
              id: z.string().min(1),
              order: z.number(),
              isPinned: z.boolean().nullable().optional(),
            }),
          )
          .optional(),
      },
      outputSchema,
      annotations: localWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list': {
          const key = await ownedThreadKey(
            userId,
            required(input.connectionId, 'connectionId'),
            required(input.threadId, 'threadId'),
          );
          return result({ notes: await notes.getThreadNotes(userId, key) });
        }
        case 'create': {
          const key = await ownedThreadKey(
            userId,
            required(input.connectionId, 'connectionId'),
            required(input.threadId, 'threadId'),
          );
          return result({
            note: await notes.createNote(
              userId,
              key,
              required(input.content, 'content'),
              input.color ?? 'default',
              input.isPinned ?? false,
            ),
          });
        }
        case 'update':
          return result({
            note: await notes.updateNote(userId, required(input.noteId, 'noteId'), {
              ...(input.content !== undefined ? { content: input.content } : {}),
              ...(input.color !== undefined ? { color: input.color } : {}),
              ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
              ...(input.order !== undefined ? { order: input.order } : {}),
            }),
          });
        case 'delete':
          return result({
            deleted: await notes.deleteNote(userId, required(input.noteId, 'noteId')),
          });
        case 'reorder':
          return result({
            reordered: await notes.reorderNotes(userId, required(input.notes, 'notes')),
          });
      }
    },
  );

  server.registerTool(
    'mail_templates',
    {
      title: 'Email templates and snippets',
      description: 'List, create, or delete reusable email templates and variable snippets.',
      inputSchema: {
        action: z.enum(['list', 'create', 'delete']),
        id: itemId,
        name: z.string().min(1).max(100).optional(),
        kind: z.enum(['template', 'snippet']).optional(),
        subject: z.string().max(500).optional(),
        body: z.string().max(50_000).optional(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
      },
      outputSchema,
      annotations: localWriteAnnotations,
    },
    async (input) => {
      switch (input.action) {
        case 'list':
          return result({ templates: await templates.listTemplates(userId) });
        case 'create':
          return result({
            template: await templates.createTemplate(userId, {
              name: required(input.name, 'name'),
              kind: input.kind ?? 'template',
              subject: input.subject ?? '',
              body: input.body ?? '',
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
            }),
          });
        case 'delete':
          return result({
            deleted: await templates.deleteTemplate(userId, required(input.id, 'id')),
          });
      }
    },
  );

  server.registerTool(
    'mail_settings',
    {
      title: 'Owner mail settings',
      description:
        'Read or update the owner’s mail, privacy, appearance, notification, and sidebar settings.',
      inputSchema: {
        action: z.enum(['get', 'save']),
        settings: userSettingsPatchSchema.optional(),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (input.action === 'get') {
        return result({ settings: publicSettings(await getSettings(userId)) });
      }

      const db = await getZeroDB(userId);
      const stored = await db.findUserSettings();
      const settings = userSettingsSchema.parse({
        ...(await getSettings(userId)),
        ...required(input.settings, 'settings'),
      });
      if (stored) await db.updateUserSettings(settings);
      else await db.insertUserSettings(settings);
      return result({ settings: publicSettings(settings) });
    },
  );
}
