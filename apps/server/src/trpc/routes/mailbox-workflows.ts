import { MailboxWorkflows } from '../../lib/mailbox-workflows';
import { privateProcedure, router } from '../trpc';
import { env } from '../../env';
import { z } from 'zod';

const threadRef = z.object({ connectionId: z.string().min(1), threadId: z.string().min(1) });
const ruleAction = z.enum(['archive', 'label', 'important']);
const screeningDecision = z.enum(['allow', 'archive', 'block', 'spam']);
const bundleMatcher = z
  .object({
    connectionId: z.string().min(1).optional(),
    kind: z.enum(['newsletter', 'receipt', 'notification', 'sender']),
    value: z.string().optional(),
  })
  .superRefine((matcher, context) => {
    if (matcher.kind === 'sender' && !matcher.value?.trim()) {
      context.addIssue({ code: 'custom', message: 'Sender matchers require an email', path: ['value'] });
    }
  });
const deliveryTimes = z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/));

const service = (userId: string) => new MailboxWorkflows(env, userId);

const remindersRouter = router({
  list: privateProcedure
    .input(z.object({ connectionId: z.string().min(1).optional() }).optional())
    .query(async ({ ctx, input }) => ({
      reminders: await service(ctx.sessionUser.id).listReminders(input?.connectionId),
    })),
  set: privateProcedure
    .input(
      threadRef.extend({
        sentMessageId: z.string().min(1),
        dueAt: z.string().datetime({ offset: true }),
      }),
    )
    .mutation(async ({ ctx, input }) => ({
      reminder: await service(ctx.sessionUser.id).setReminder({
        ...input,
        dueAt: new Date(input.dueAt),
      }),
    })),
  cancel: privateProcedure.input(threadRef).mutation(async ({ ctx, input }) => ({
    cancelled: await service(ctx.sessionUser.id).cancelReminder(input.connectionId, input.threadId),
  })),
});

const screeningRouter = router({
  getConfig: privateProcedure.input(z.object({ connectionId: z.string().min(1) })).query(
    async ({ ctx, input }) => service(ctx.sessionUser.id).getScreeningConfig(input.connectionId),
  ),
  setEnabled: privateProcedure
    .input(z.object({ connectionId: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      service(ctx.sessionUser.id).setScreeningEnabled(input.connectionId, input.enabled),
    ),
  list: privateProcedure
    .input(z.object({ connectionId: z.string().min(1).optional() }).optional())
    .query(async ({ ctx, input }) => ({
      senders: await service(ctx.sessionUser.id).listScreening(input?.connectionId),
    })),
  decide: privateProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        email: z.string().email(),
        decision: screeningDecision,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      service(ctx.sessionUser.id).decideSender(input.connectionId, input.email, input.decision),
    ),
});

const rulesRouter = router({
  labels: privateProcedure.input(z.object({ connectionId: z.string().min(1) })).query(
    async ({ ctx, input }) => ({
      labels: await service(ctx.sessionUser.id).listRuleLabels(input.connectionId),
    }),
  ),
  preview: privateProcedure
    .input(threadRef.extend({ action: ruleAction, labelId: z.string().min(1).optional() }))
    .query(async ({ ctx, input }) =>
      service(ctx.sessionUser.id).previewRule(
        input.connectionId,
        input.threadId,
        input.action,
        input.labelId,
      ),
    ),
  list: privateProcedure
    .input(z.object({ connectionId: z.string().min(1).optional() }).optional())
    .query(async ({ ctx, input }) => ({
      rules: await service(ctx.sessionUser.id).listRules(input?.connectionId),
    })),
  create: privateProcedure
    .input(threadRef.extend({ action: ruleAction, labelId: z.string().min(1).optional() }))
    .mutation(async ({ ctx, input }) =>
      service(ctx.sessionUser.id).createRule(
        input.connectionId,
        input.threadId,
        input.action,
        input.labelId,
      ),
    ),
  setEnabled: privateProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => ({
      rule: await service(ctx.sessionUser.id).setRuleEnabled(input.id, input.enabled),
    })),
  delete: privateProcedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ ctx, input }) => ({
    deleted: await service(ctx.sessionUser.id).deleteRule(input.id),
  })),
});

const bundlesRouter = router({
  list: privateProcedure.query(async ({ ctx }) => ({
    bundles: await service(ctx.sessionUser.id).listBundles(),
  })),
  threads: privateProcedure
    .input(z.object({ bundleId: z.string().min(1).optional() }).optional())
    .query(async ({ ctx, input }) => ({
      groups: await service(ctx.sessionUser.id).listBundleThreads(input?.bundleId),
    })),
  create: privateProcedure
    .input(
      z.object({
        name: z.string().trim().min(1),
        deliveryMode: z.enum(['immediate', 'scheduled']),
        deliveryTimes,
        timezone: z.string().optional(),
        matchers: z.array(bundleMatcher).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => ({
      bundle: await service(ctx.sessionUser.id).createBundle(input),
    })),
  update: privateProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).optional(),
        deliveryMode: z.enum(['immediate', 'scheduled']).optional(),
        deliveryTimes: deliveryTimes.optional(),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
        matchers: z.array(bundleMatcher).min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input: { id, ...input } }) => ({
      bundle: await service(ctx.sessionUser.id).updateBundle(id, input),
    })),
  delete: privateProcedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ ctx, input }) => ({
    deleted: await service(ctx.sessionUser.id).deleteBundle(input.id),
  })),
  releaseNow: privateProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => service(ctx.sessionUser.id).releaseBundle(input.id)),
});

const focusRouter = router({
  list: privateProcedure.query(async ({ ctx }) => ({
    threads: await service(ctx.sessionUser.id).listFocus(),
  })),
  add: privateProcedure
    .input(threadRef)
    .mutation(async ({ ctx, input }) =>
      service(ctx.sessionUser.id).addFocus(input.connectionId, input.threadId),
    ),
  remove: privateProcedure
    .input(threadRef)
    .mutation(async ({ ctx, input }) =>
      service(ctx.sessionUser.id).removeFocus(input.connectionId, input.threadId),
    ),
  reorder: privateProcedure
    .input(z.object({ items: z.array(threadRef) }))
    .mutation(async ({ ctx, input }) => ({
      threads: await service(ctx.sessionUser.id).reorderFocus(input.items),
    })),
});

export const mailboxWorkflowsRouter = router({
  reminders: remindersRouter,
  screening: screeningRouter,
  rules: rulesRouter,
  bundles: bundlesRouter,
  focus: focusRouter,
});
