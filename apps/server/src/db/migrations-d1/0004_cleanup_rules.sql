CREATE TABLE IF NOT EXISTS "mail0_cleanup_rule" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "sender_email" text NOT NULL,
  "action" text NOT NULL,
  "age_days" integer NOT NULL,
  "enabled" integer DEFAULT 1 NOT NULL,
  "last_run_at" integer,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_cleanup_rule_connection_sender_unique" ON "mail0_cleanup_rule" ("connection_id", "sender_email", "action");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_cleanup_rule_due_idx" ON "mail0_cleanup_rule" ("enabled", "last_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_cleanup_rule_user_idx" ON "mail0_cleanup_rule" ("user_id", "connection_id");
