CREATE TABLE IF NOT EXISTS "mail0_smart_folder" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "query" text NOT NULL,
  "connection_id" text REFERENCES "mail0_connection"("id") ON DELETE CASCADE,
  "sort" text NOT NULL,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail0_smart_folder_user_name_unique" ON "mail0_smart_folder" ("user_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_smart_folder_user_idx" ON "mail0_smart_folder" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail0_smart_folder_connection_idx" ON "mail0_smart_folder" ("connection_id");
