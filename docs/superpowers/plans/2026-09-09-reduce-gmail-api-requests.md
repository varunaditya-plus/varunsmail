# Reduce Gmail API Requests

**Goal:** Reduce repeated Gmail API traffic while keeping each mailbox current and fully synchronized.

## Findings

- Google Cloud reports 57,708 Gmail API requests in the last day.
- The main methods are `GetThread`, `ListLabels`, `ListHistory`, `GetProfile`, and `ListSendAs`.
- Initial sync fetches each uncached thread twice: once as minimal metadata and again as the full thread.
- Every synchronized thread can reload Gmail labels because the current label cache lives only inside one Worker isolate.
- The browser discards its in-memory query client when switching accounts and revalidates thread lists after restoring IndexedDB.
- Normal mailbox lists still call Gmail directly even after the sync engine has cached the same data in D1 and R2.

## Changes

1. Add account-isolated, two-tier server caching for labels, label details, aliases, and counts. Coalesce concurrent cache misses and invalidate label data after mutations.
2. Use the synchronized D1/R2 mailbox cache for normal list views, falling back to Gmail only when the local first page is empty.
3. Skip the metadata request for a thread that has never been cached, so initial sync performs one Gmail thread fetch instead of two.
4. Poll Gmail history at a bounded interval while allowing the existing minute cron to continue scheduled mail and workflow processing.
5. Retain one browser query client per account, preserve hydrated IndexedDB results, use a default freshness window, and stop polling while the app is in the background.
6. Increase tRPC batching so simultaneous reads share an HTTP request.

## Verification

- Add focused tests for cache-first list behavior and history polling intervals.
- Run focused lint, TypeScript/build checks, and `git diff --check`.
- Deploy with Wrangler, verify production health, load multiple mailboxes, and confirm no repeated Gmail-backed requests are triggered by account switching.
