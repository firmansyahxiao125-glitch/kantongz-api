CREATE TYPE "public"."wallet_share_role" AS ENUM('lihat', 'catat');--> statement-breakpoint
CREATE TABLE "wallet_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" "wallet_share_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_shares" ADD CONSTRAINT "wallet_shares_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_shares_member" ON "wallet_shares" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_shares_once" ON "wallet_shares" USING btree ("account_id","member_id");
