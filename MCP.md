# Varunsmail MCP

Varunsmail exposes its private mailbox controls as a remote MCP server at:

```text
https://mail.varunaditya.space/mcp
```

Use standard MCP OAuth discovery and authorization. The server publishes protected-resource metadata at `/.well-known/oauth-protected-resource` and authorization-server metadata at `/.well-known/oauth-authorization-server`. Browser session cookies are not MCP credentials.

## Accounts

Call `accounts_manage` first. Every mailbox tool accepts an `account` value using either the returned mailbox ID or email address. If it is omitted, Varunsmail uses the default physical mailbox.

The Barcelona Hackathon mailbox is exposed as `alias:barcelonahackathon`. It sends through its Gmail send-as identity and reads the dedicated `barcelonahackathon` Gmail label on the source account. Unified results omit that alias by default so the same provider thread is not returned twice.

## Tools

- `accounts_manage`: list, inspect, connect, disconnect, or select the default mailbox.
- `threads_list`, `threads_search`, `thread_get`: page, search, and read full account-scoped threads.
- `threads_modify`: read/unread, star, important, labels, archive, inbox, spam, trash, delete, and snooze actions synchronized with Gmail.
- `email_send`: new mail, replies, reply-all, forwards, drafts, attachments, aliases, undo-send, and scheduled sends. An idempotency key makes an exact retry safe.
- `drafts_manage` and `labels_manage`: full draft and label management.
- `mail_content`: aliases, recipient suggestions, attachments, raw messages, and email-authentication verification.
- `mail_unsubscribe`: inspect one message's List-Unsubscribe metadata, send mailto requests once, or return the exact browser action for HTTP requests.
- `spam_empty`: permanently clear one physical mailbox's Spam folder.
- `mail_ai_search`, `mail_ai_compose`, `mail_ai_subject`, `mail_ai_prompts`, and `thread_summarize`: mailbox-grounded AI features, subject generation, prompt controls, and account/thread provenance.
- `mail_web_research` and `sender_brand`: sender/topic research and BIMI brand metadata.
- `mail_activity`: sync, activity history, outbox inspection, retry, and cancellation.
- `mail_assets`, `mail_smart_folders`, and `mail_cleanup`: file/link search, saved searches, and sender cleanup.
- `mail_reminders`, `mail_screening`, and `mail_rules`: reply reminders, first-sender decisions, and Gmail-backed rules.
- `mail_bundles` and `mail_focus`: scheduled bundles and the Focus and Reply queue.
- `mail_notes` and `mail_templates`: private thread notes, templates, and snippets.
- `mail_settings`: owner mail, privacy, appearance, and notification settings.
- `current_date`: the date and time context used by Varunsmail.

Thread IDs are provider IDs and must be paired with the returned mailbox or connection ID. Multi-account list and search calls return per-mailbox failures without discarding successful mailboxes.
