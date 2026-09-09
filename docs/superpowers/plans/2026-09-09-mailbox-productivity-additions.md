# Mailbox Productivity Additions Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sync center, sender cleanup, smart folders and sorting, tracking protection, an attachment/link hub, and smart notifications with quiet hours.

**Architecture:** Extend the existing connection-scoped Gmail workflow service and D1 schema. Gmail remains the source of truth for mailbox mutations, while D1 stores user configuration and operational history. Reuse the existing mail shell, TRPC client, settings store, and Cloudflare queues.

**Tech Stack:** React Router, React 19, TanStack Query, TRPC, TypeScript, Drizzle ORM, Cloudflare Workers/D1/KV/R2/Queues, Gmail API.

**Spec:** User request in the active task.

## Global Constraints

- Implement only the six requested additions.
- Keep Gmail as the source of truth for messages and provider-backed actions.
- Isolate state by Gmail connection and preserve every Cloudflare binding.
- Use compact TypeScript and existing UI primitives.
- Commit each addition separately on `main` with a short Conventional Commit subject.

---

### Task 1: Sync center, outbox, and action history

**Files:**
- Create: `apps/server/src/db/migrations-d1/0003_mailbox_activity.sql`
- Create: `apps/server/src/lib/mailbox-activity.ts`
- Create: `apps/mail/components/mail/mailbox-activity.tsx`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/lib/gmail-polling.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/trpc/routes/mail.ts`
- Modify: `apps/server/src/trpc/routes/mailbox-workflows.ts`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Modify: `apps/mail/config/navigation.ts`

**Interfaces:**
- Produces `mailboxWorkflows.activity.list`, `forceSync`, `listOutbox`, `retryOutbox`, and `cancelOutbox`.
- Records connection-scoped sync attempts and user-visible mailbox actions.

- [ ] Add D1 sync-status and action-log tables with connection and user indexes.
- [ ] Record successful and failed Gmail polling without mixing account state.
- [ ] Preserve failed queued-mail payloads, retry transient failures three times, and expose explicit retry/cancel actions.
- [ ] Log sends and common provider-backed mailbox mutations after their result is known.
- [ ] Build the Activity page with per-account health, outbox, retry/cancel controls, and recent history.
- [ ] Run focused lint, TypeScript/build checks, `git diff --check`, then commit `feat: add mailbox activity center`.

### Task 2: Sender cleanup and retention

**Files:**
- Create: `apps/server/src/db/migrations-d1/0004_cleanup_rules.sql`
- Create: `apps/mail/components/mail/sender-cleanup.tsx`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/lib/mailbox-workflows.ts`
- Modify: `apps/server/src/trpc/routes/mailbox-workflows.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Modify: `apps/mail/config/navigation.ts`

**Interfaces:**
- Produces `mailboxWorkflows.cleanup.candidates`, `list`, `create`, `setEnabled`, `run`, and `delete`.
- Cleanup rules archive or trash matching Gmail threads only after the configured retention age.

- [ ] Add the cleanup-rule table with sender, action, age, enabled, and last-run fields.
- [ ] Aggregate frequent senders from cached connection-scoped Gmail threads.
- [ ] Execute one rule idempotently using Gmail search and provider label mutations, following every page.
- [ ] Run enabled cleanup rules from the existing scheduled workflow.
- [ ] Build the Cleanup page for candidates, rule creation, run-now, enable/disable, and deletion.
- [ ] Run focused checks and commit `feat: add sender cleanup rules`.

### Task 3: Saved searches, smart folders, and sorting

**Files:**
- Create: `apps/server/src/db/migrations-d1/0005_smart_folders.sql`
- Create: `apps/mail/components/mail/smart-folders.tsx`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/lib/mailbox-workflows.ts`
- Modify: `apps/server/src/trpc/routes/mailbox-workflows.ts`
- Modify: `apps/server/src/lib/driver/types.ts`
- Modify: `apps/server/src/trpc/routes/mail.ts`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/components/mail/mail.tsx`
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Modify: `apps/mail/config/navigation.ts`

**Interfaces:**
- Produces smart-folder CRUD with Gmail query, optional connection, and default sort.
- Adds URL-driven `smart` and `sort` filters to the existing inbox.

- [ ] Store user-owned smart folders in D1.
- [ ] Enrich thread-list items from the R2 cache with sender, subject, labels, and received time.
- [ ] Resolve saved Gmail queries in `useThreads` and keep multi-account folders unified.
- [ ] Sort loaded results by newest, oldest, sender, or sender domain.
- [ ] Build smart-folder management and add saved folders to the mail sidebar.
- [ ] Run focused checks and commit `feat: add smart mail folders`.

### Task 4: Tracking protection

**Files:**
- Modify: `apps/server/src/lib/schemas.ts`
- Modify: `apps/server/src/lib/email-processor.ts`
- Modify: `apps/server/src/trpc/routes/mail.ts`
- Modify: `apps/mail/components/mail/mail-content.tsx`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/app/(routes)/settings/privacy/page.tsx`

**Interfaces:**
- Adds the persisted `trackingProtection` setting.
- `processEmailContent` returns the number of blocked trackers and rewrites safe embedded redirect targets.

- [ ] Detect and remove remote tracking pixels by dimensions, hidden styles, and tracker URL signals.
- [ ] Unwrap safe HTTP(S) destinations embedded in common tracking redirects.
- [ ] Apply protection independently of the external-image preference.
- [ ] Add a Privacy setting and show a small blocked-tracker notice in messages.
- [ ] Run processor tests and focused checks, then commit `feat: add email tracking protection`.

### Task 5: Attachment and link hub

**Files:**
- Create: `apps/mail/components/mail/mail-assets.tsx`
- Modify: `apps/server/src/lib/mailbox-workflows.ts`
- Modify: `apps/server/src/trpc/routes/mailbox-workflows.ts`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Modify: `apps/mail/config/navigation.ts`

**Interfaces:**
- Produces `mailboxWorkflows.assets.list` with account, thread, message, sender, date, attachment metadata, and safe links.

- [ ] Scan cached user-owned threads by connection and extract attachment metadata and HTTP(S) links.
- [ ] Add pagination, search, account filters, and attachment/link type filters.
- [ ] Build the Files & Links page with open-thread and open-link actions.
- [ ] Run focused checks and commit `feat: add mail attachment hub`.

### Task 6: Smart notifications and quiet hours

**Files:**
- Create: `apps/mail/components/mail/mail-notifications.tsx`
- Modify: `apps/server/src/lib/schemas.ts`
- Modify: `apps/mail/app/(routes)/settings/notifications/page.tsx`
- Modify: `apps/mail/app/(routes)/mail/layout.tsx`
- Modify: `apps/mail/config/navigation.ts`

**Interfaces:**
- Adds persisted notification level, priority senders/domains, quiet-hours enablement, start/end, and timezone.
- Polls the unified inbox and emits browser notifications once per new provider thread.

- [ ] Replace placeholder notification settings with persisted mailbox settings.
- [ ] Add browser-permission controls and validate HH:mm quiet-hour values.
- [ ] Filter new-mail notifications by level, Gmail importance, priority sender/domain, and timezone-aware quiet hours.
- [ ] Deduplicate notifications by connection and provider thread ID.
- [ ] Run focused checks and commit `feat: add smart mail notifications`.

### Task 7: Production migration, deployment, and exact-flow verification

**Files:**
- Verify only; no new source files.

- [ ] Apply D1 migrations 0003 through 0005 to the production database.
- [ ] Build the frontend and dry-run the Worker bindings.
- [ ] Deploy the full Worker and static assets without removing bindings.
- [ ] Verify `/health`, root, login, authenticated inbox, all six pages/settings, and one safe provider-backed test per mutating feature.
- [ ] Confirm the active Worker version and inspect the focused git status.
