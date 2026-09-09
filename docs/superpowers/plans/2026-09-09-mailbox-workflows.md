# Mailbox Workflows Implementation Plan

**Goal:** Add a reliable four-account unified inbox, reply reminders, sender screening, bundles and digests, a Focus & Reply queue, one-click mail rules, variable snippets, and explainable cross-account AI search.

**Architecture:** Restore the source-mapped D1 production worker as the repository baseline, then keep Gmail as the message and label source of truth. Store only owner preferences, workflow checkpoints, and cross-account ordering in D1. Identify every thread by `(connectionId, threadId)`, apply provider changes before committing local workflow state, and reconcile R2, Vectorize, and sharded Durable Object caches through the existing Gmail polling queues.

**Tech Stack:** React Router, React Query, tRPC, Hono, Drizzle SQLite/D1, Gmail API, Cloudflare Workers, Queues, Durable Objects, R2, Vectorize, Workers AI, and OpenAI.

**Spec:** User request in this task, dated 2026-09-08 and continued on 2026-09-09.

## Constraints

- Preserve all live Cloudflare bindings, Durable Object class names, queue names, migrations, secrets, and the owner-only login at `mail.varunaditya.space`.
- Treat Gmail as the source of truth for thread content, labels, read state, importance, spam, trash, archive, sends, and replies.
- Namespace cached and UI identities by connection so equal Gmail thread or message IDs in different accounts never collide.
- Keep partial results when one account is temporarily unavailable and show which account failed.
- Do not add public registration, billing, marketing, Zero branding, or a second message store.
- Commit each requested feature as a short Conventional Commit after focused verification.

## Tasks

- [x] Restore the latest deployed D1 and Gmail polling source from `/private/tmp/varunsmail-worker-verify/main.js.map`, replace the stale Hyperdrive configuration with the complete live `varunsmail` Wrangler bindings, and verify a Worker dry run without deploying; commit `fix: restore Cloudflare production source`.
- [x] Add connection-scoped thread references, deterministic account colors, a four-way keyset merge with per-account cursors, account filters, partial failure reporting, and explicit `connectionId` handling when opening or mutating a unified thread; test interleaved timestamps, raw-ID collisions, filters, pagination, and account failure; commit `feat: add unified inbox`.
- [x] Add D1 reply-reminder state, create/cancel/list routes, a thread action and date picker, reply detection from Gmail polling, and idempotent minute-cron delivery that adds `INBOX` only when no later external reply exists; test late replies, drafts, self messages, collisions, retries, and duplicate cron claims; commit `feat: add reply reminders`.
- [x] Add connection-scoped sender decisions, an enable-time historical sender baseline, Gmail-backed allow/archive/block/spam actions, a screening queue, and an incoming-thread policy hook guarded by message ID and enable time; test historical mail, first-time senders, grouped pending threads, all decisions, and retry safety; commit `feat: add sender screening`.
- [x] Add exact-sender rules for archive, Gmail label, and important actions, including a read-only preview and a save flow that applies to the current thread and future Gmail sync events; test ownership, preview purity, rule precedence, duplicate events, and account isolation; commit `feat: add one-click mail rules`.
- [x] Add newsletter, receipt, notification, and exact-sender bundle matchers, Gmail labels, collapsible bundle groups, optional local-time digest schedules, D1 hold state, and idempotent cron release; test classifier precedence, Europe/Madrid time boundaries, immediate versus scheduled delivery, requeue on new mail, and multi-account grouping; commit `feat: add mail bundles and digests`.
- [x] Add a D1 ordered Focus & Reply queue mirrored by a Gmail label, thread actions, a distraction-free queue page, previous/next controls, removal after a successful reply, and a Done action; test ordering, account-scoped collisions, send success/failure, and idempotent add/remove; commit `feat: add focus reply queue`.
- [x] Extend existing templates with snippet kind and safe variables for recipient, sender, date, and day; insert snippets at the editor selection while preserving legacy full-template behavior and unresolved tokens; test HTML escaping, resolution, insertion, and legacy templates; commit `feat: add variable snippets`.
- [x] Add a server-owned cross-account search helper that combines exact Gmail search and namespaced Vectorize evidence, deduplicates by connection and thread, hydrates exact source cards, and generates an answer only from those cards; render the matching threads beneath each answer with account color and email; test namespaced IDs, result provenance, partial failure, and source navigation; commit `feat: add explainable AI search`.
- [x] Apply the D1 migration, build and dry-run the complete Worker, deploy with every existing binding, then verify `/health`, root, login, four-account unified loading, account filters, Gmail-backed read/archive/spam actions, reminders, screening, rules, bundles, Focus & Reply, snippets, and AI evidence in production.

## Verification commands

- `git diff --check`
- `pnpm --filter @zero/server exec vitest run tests/mailbox-workflows.test.ts tests/unified-inbox.test.ts tests/template-variables.test.ts src/routes/agent/cross-account-search.test.ts`
- `pnpm --dir apps/server exec tsc --noEmit --pretty false`
- `pnpm --filter @zero/mail exec oxlint components/mail/account-filter.tsx components/mail/reminder-dialog.tsx components/mail/sender-screening.tsx components/mail/mail-bundles.tsx components/mail/focus-reply.tsx components/mail/rule-dialog.tsx components/mail/mail-rules.tsx components/create/template-button.tsx components/create/ai-chat.tsx`
- `pnpm --filter @zero/mail build`
- `pnpm dlx wrangler@4.130.0 deploy --dry-run --config apps/server/wrangler.jsonc`
- `pnpm dlx wrangler@4.130.0 d1 execute varunsmail-db --remote --config apps/server/wrangler.jsonc --file apps/server/src/db/migrations-d1/0001_mailbox_workflows.sql`
- `pnpm dlx wrangler@4.130.0 d1 execute varunsmail-db --remote --config apps/server/wrangler.jsonc --file apps/server/src/db/migrations-d1/0002_template_kind.sql`
- `pnpm dlx wrangler@4.130.0 deploy --config apps/server/wrangler.jsonc`
