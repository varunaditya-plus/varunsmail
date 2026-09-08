CREATE TABLE IF NOT EXISTS "mail0_thread_reminder" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "sent_message_id" text NOT NULL,
  "due_at" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_thread_reminder_connection_thread_unique" ON "mail0_thread_reminder" ("connection_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_thread_reminder_due_idx" ON "mail0_thread_reminder" ("status", "due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_thread_reminder_user_idx" ON "mail0_thread_reminder" ("user_id", "connection_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_sender_screening_config" (
  "connection_id" text PRIMARY KEY NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "enabled" integer DEFAULT 0 NOT NULL,
  "enabled_at" integer,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_sender_screening_config_user_idx" ON "mail0_sender_screening_config" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_sender_decision" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "name" text,
  "decision" text NOT NULL,
  "sample_thread_id" text NOT NULL,
  "decided_at" integer,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_sender_decision_connection_email_unique" ON "mail0_sender_decision" ("connection_id", "email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_sender_decision_user_status_idx" ON "mail0_sender_decision" ("user_id", "decision");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_sender_screened_thread" (
  "id" text PRIMARY KEY NOT NULL,
  "sender_decision_id" text NOT NULL REFERENCES "mail0_sender_decision"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "last_message_id" text NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_sender_screened_thread_connection_thread_unique" ON "mail0_sender_screened_thread" ("connection_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_sender_screened_thread_decision_idx" ON "mail0_sender_screened_thread" ("sender_decision_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_mail_rule" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "sender_email" text NOT NULL,
  "action" text NOT NULL,
  "label_id" text,
  "enabled" integer DEFAULT 1 NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mail_rule_sender_idx" ON "mail0_mail_rule" ("connection_id", "sender_email", "enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mail_rule_user_idx" ON "mail0_mail_rule" ("user_id", "enabled");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_mail_rule_thread" (
  "id" text PRIMARY KEY NOT NULL,
  "rule_id" text NOT NULL REFERENCES "mail0_mail_rule"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "last_message_id" text NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_mail_rule_thread_unique" ON "mail0_mail_rule_thread" ("rule_id", "connection_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mail_rule_thread_connection_idx" ON "mail0_mail_rule_thread" ("connection_id", "thread_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_mail_bundle" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "label_name" text NOT NULL,
  "delivery_mode" text NOT NULL,
  "delivery_times" text NOT NULL,
  "timezone" text NOT NULL,
  "enabled" integer DEFAULT 1 NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_mail_bundle_user_name_unique" ON "mail0_mail_bundle" ("user_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_mail_bundle_user_idx" ON "mail0_mail_bundle" ("user_id", "enabled");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_bundle_matcher" (
  "id" text PRIMARY KEY NOT NULL,
  "bundle_id" text NOT NULL REFERENCES "mail0_mail_bundle"("id") ON DELETE CASCADE,
  "connection_id" text REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "value" text,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_bundle_matcher_bundle_idx" ON "mail0_bundle_matcher" ("bundle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_bundle_matcher_match_idx" ON "mail0_bundle_matcher" ("connection_id", "kind", "value");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_bundle_thread" (
  "id" text PRIMARY KEY NOT NULL,
  "bundle_id" text NOT NULL REFERENCES "mail0_mail_bundle"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "last_message_id" text NOT NULL,
  "queued_at" integer NOT NULL,
  "released_at" integer,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_bundle_thread_unique" ON "mail0_bundle_thread" ("bundle_id", "connection_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_bundle_thread_release_idx" ON "mail0_bundle_thread" ("released_at", "queued_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_bundle_thread_connection_idx" ON "mail0_bundle_thread" ("connection_id", "thread_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mail0_focus_thread" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "position" integer NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_focus_thread_connection_thread_unique" ON "mail0_focus_thread" ("connection_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_focus_thread_user_position_idx" ON "mail0_focus_thread" ("user_id", "position");
