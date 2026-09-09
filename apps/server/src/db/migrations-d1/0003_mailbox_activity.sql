CREATE TABLE IF NOT EXISTS "mail0_mailbox_sync_status" (
  "connection_id" text PRIMARY KEY NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "last_attempt_at" integer NOT NULL,
  "last_success_at" integer,
  "last_error" text,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mailbox_sync_status_user_idx" ON "mail0_mailbox_sync_status" ("user_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_mailbox_action" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "connection_id" text REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "thread_id" text,
  "message_id" text,
  "action" text NOT NULL,
  "status" text NOT NULL,
  "detail" text,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mailbox_action_user_created_idx" ON "mail0_mailbox_action" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mailbox_action_message_idx" ON "mail0_mailbox_action" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mailbox_action_connection_idx" ON "mail0_mailbox_action" ("connection_id", "created_at");
