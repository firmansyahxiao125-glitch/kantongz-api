CREATE TABLE "transaction_splits" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"category_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_splits_transaction" ON "transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_category" ON "transaction_splits" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_splits_once" ON "transaction_splits" USING btree ("transaction_id","category_id");
