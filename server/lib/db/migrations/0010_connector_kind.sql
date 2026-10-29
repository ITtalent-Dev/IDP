ALTER TABLE "connector" ADD COLUMN "kind" text DEFAULT 'import' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_pairing" ADD COLUMN "requested_kind" text DEFAULT 'import' NOT NULL;