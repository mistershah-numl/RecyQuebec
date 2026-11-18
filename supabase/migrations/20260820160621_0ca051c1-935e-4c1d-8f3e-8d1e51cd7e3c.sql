ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS email_sender_domain text,
  ADD COLUMN IF NOT EXISTS email_from_local text,
  ADD COLUMN IF NOT EXISTS email_sender_name text,
  ADD COLUMN IF NOT EXISTS email_reply_to text,
  ADD COLUMN IF NOT EXISTS email_daily_cap integer,
  ADD COLUMN IF NOT EXISTS email_throttle_seconds integer,
  ADD COLUMN IF NOT EXISTS email_dry_run boolean NOT NULL DEFAULT true;