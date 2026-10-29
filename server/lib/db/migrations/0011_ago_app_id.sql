UPDATE "organization" SET "apps" = array_replace("apps", 'app', 'ago') WHERE 'app' = any("apps");--> statement-breakpoint
UPDATE "organization_role" SET "permission" = ((("permission"::jsonb) - 'app') || jsonb_build_object('ago', ("permission"::jsonb) -> 'app'))::text WHERE ("permission"::jsonb) ? 'app';--> statement-breakpoint
UPDATE "oauth_client" SET "software_id" = 'auth-service:ago', "name" = 'AGO' WHERE "software_id" = 'auth-service:app';
