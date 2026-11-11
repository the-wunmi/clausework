CREATE TABLE "rate_windows" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"uses" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_windows_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
