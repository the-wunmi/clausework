CREATE TYPE "public"."agreement_status" AS ENUM('reading', 'compiling', 'review', 'active', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('scheduled', 'awaiting_approval', 'issued', 'authorized', 'paid', 'overdue', 'failed', 'cancelled', 'held', 'released', 'refunded', 'unclaimed');--> statement-breakpoint
CREATE TABLE "agent_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"trigger_key" text NOT NULL,
	"occurred_on" date NOT NULL,
	"trigger" jsonb NOT NULL,
	"view" jsonb NOT NULL,
	"proposal" jsonb,
	"outcome" jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"status" "agreement_status" DEFAULT 'reading' NOT NULL,
	"source_kind" text NOT NULL,
	"source_name" text NOT NULL,
	"source_text" text NOT NULL,
	"source_pdf" text,
	"owner_party" text,
	"current_version_id" uuid,
	"live_version_id" uuid,
	"failure" text,
	"progress" jsonb,
	"sample_key" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"party_key" text NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid,
	"status" text NOT NULL,
	"perspective" text NOT NULL,
	"source_name" text NOT NULL,
	"transactions" jsonb NOT NULL,
	"matches" jsonb,
	"report" jsonb,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"obligation_key" text NOT NULL,
	"product" text NOT NULL,
	"paypal_id" text NOT NULL,
	"role" text NOT NULL,
	"state" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"version_id" uuid,
	"charge_key" text NOT NULL,
	"obligation_key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"payer" text NOT NULL,
	"payee" text NOT NULL,
	"amount" bigint,
	"currency" text NOT NULL,
	"status" charge_status DEFAULT 'scheduled' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"paid_on" date,
	"period_index" integer,
	"period_start" date,
	"period_end" date,
	"clause_ids" jsonb NOT NULL,
	"paypal_product" text,
	"paypal_ref" text,
	"paypal_data" jsonb,
	"basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"clause_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"charge_id" uuid,
	"obligation_key" text NOT NULL,
	"kind" text NOT NULL,
	"from_party" text NOT NULL,
	"to_party" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"paypal_ref" text,
	"dedupe_key" text NOT NULL,
	"memo" text NOT NULL,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"party_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phase_dates" (
	"agreement_id" uuid NOT NULL,
	"phase_key" text NOT NULL,
	"start" date,
	"end" date,
	"completed_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phase_dates_agreement_id_phase_key_pk" PRIMARY KEY("agreement_id","phase_key")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"hash" text NOT NULL,
	"origin" text NOT NULL,
	"note" text,
	"spans" jsonb NOT NULL,
	"test_results" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"diff" jsonb,
	"evidence" jsonb,
	"effective_from" date,
	"model" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"obligation_key" text NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"occurred_on" date NOT NULL,
	"note" text,
	"idempotency_key" text NOT NULL,
	"paypal_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"resource_id" text,
	"payload" jsonb NOT NULL,
	"verified" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_version_id_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_bindings" ADD CONSTRAINT "paypal_bindings_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_links" ADD CONSTRAINT "party_links_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_dates" ADD CONSTRAINT "phase_dates_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decisions_agreement" ON "agent_decisions" USING btree ("agreement_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_decisions_trigger" ON "agent_decisions" USING btree ("agreement_id","trigger_key");--> statement-breakpoint
CREATE INDEX "approvals_agreement" ON "approvals" USING btree ("agreement_id","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_bindings_role" ON "paypal_bindings" USING btree ("agreement_id","obligation_key","role");--> statement-breakpoint
CREATE INDEX "paypal_bindings_paypal_id" ON "paypal_bindings" USING btree ("paypal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_key" ON "charges" USING btree ("agreement_id","charge_key");--> statement-breakpoint
CREATE INDEX "charges_paypal_ref" ON "charges" USING btree ("paypal_ref");--> statement-breakpoint
CREATE INDEX "charges_status" ON "charges" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "events_agreement" ON "events" USING btree ("agreement_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe" ON "jobs" USING btree ("dedupe_key") WHERE status in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_dedupe" ON "ledger_entries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ledger_entries_agreement" ON "ledger_entries" USING btree ("agreement_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "party_links_party" ON "party_links" USING btree ("agreement_id","party_key");--> statement-breakpoint
CREATE UNIQUE INDEX "party_links_token" ON "party_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_agreement_version" ON "plan_versions" USING btree ("agreement_id","version");--> statement-breakpoint
CREATE INDEX "sim_objects_type" ON "sim_objects" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idem" ON "usage_events" USING btree ("idempotency_key");