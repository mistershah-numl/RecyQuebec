ALTER TABLE public.job_rows ADD COLUMN IF NOT EXISTS source_row jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS source_row jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.batch_jobs ADD COLUMN IF NOT EXISTS source_headers jsonb NOT NULL DEFAULT '[]'::jsonb;