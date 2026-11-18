ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS osint_worker_url TEXT,
  ADD COLUMN IF NOT EXISTS osint_worker_secret TEXT;