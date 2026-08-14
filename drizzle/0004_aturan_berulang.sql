CREATE TYPE "public"."recurring_cadence" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TABLE "recurring_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"counter_account_id" text,
	"category_id" text,
	"kind" "transaction_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"merchant" text,
	"note" text,
	"cadence" "recurring_cadence" NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"anchor_day" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"next_run_on" date NOT NULL,
	"last_run_on" date,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_rules_amount_positive" CHECK ("recurring_rules"."amount" > 0),
	CONSTRAINT "recurring_rules_interval_positive" CHECK ("recurring_rules"."interval" >= 1),
	CONSTRAINT "recurring_rules_anchor_range" CHECK ("recurring_rules"."anchor_day" BETWEEN 1 AND 31),
	CONSTRAINT "recurring_rules_transfer_shape" CHECK (("recurring_rules"."kind" = 'transfer' AND "recurring_rules"."counter_account_id" IS NOT NULL AND "recurring_rules"."counter_account_id" <> "recurring_rules"."account_id")
          OR ("recurring_rules"."kind" <> 'transfer' AND "recurring_rules"."counter_account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "recurring_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"occurred_on" date NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_counter_account_id_wallet_accounts_id_fk" FOREIGN KEY ("counter_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_rule_id_recurring_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."recurring_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_rules_due" ON "recurring_rules" USING btree ("next_run_on") WHERE "recurring_rules"."paused_at" IS NULL;--> statement-breakpoint
CREATE INDEX "recurring_rules_user" ON "recurring_rules" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_runs_once" ON "recurring_runs" USING btree ("rule_id","occurred_on");