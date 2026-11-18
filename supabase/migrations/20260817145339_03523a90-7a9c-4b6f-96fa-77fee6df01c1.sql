-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile" ON public.profiles FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- USER SETTINGS
CREATE TABLE public.user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gemini_key text,
  perplexity_key text,
  openai_key text,
  anthropic_key text,
  default_model text NOT NULL DEFAULT 'google/gemini-3.1-flash-lite',
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_settings TO authenticated;
GRANT ALL ON public.user_settings TO service_role;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own settings" ON public.user_settings FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- BATCH JOBS
CREATE TABLE public.batch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  file_name text,
  model text NOT NULL DEFAULT 'google/gemini-3.1-flash-lite',
  targets jsonb NOT NULL DEFAULT '{"email":true,"phone":true,"domain":true}'::jsonb,
  start_row integer NOT NULL DEFAULT 0,
  end_row integer NOT NULL DEFAULT 0,
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  valid_emails integer NOT NULL DEFAULT 0,
  invalid_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  paused_reason text,
  error text,
  lease_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX batch_jobs_user_idx ON public.batch_jobs(user_id, created_at DESC);
CREATE INDEX batch_jobs_status_idx ON public.batch_jobs(status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.batch_jobs TO authenticated;
GRANT ALL ON public.batch_jobs TO service_role;
ALTER TABLE public.batch_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own jobs" ON public.batch_jobs FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- JOB ROWS (queue)
CREATE TABLE public.job_rows (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.batch_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  neq text,
  company_name text NOT NULL,
  postal_code text,
  city text,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, row_index)
);
CREATE INDEX job_rows_claim_idx ON public.job_rows(job_id, status, row_index);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_rows TO authenticated;
GRANT ALL ON public.job_rows TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.job_rows_id_seq TO authenticated, service_role;
ALTER TABLE public.job_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own job rows" ON public.job_rows FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- JOB LOGS
CREATE TABLE public.job_logs (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.batch_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_logs_job_idx ON public.job_logs(job_id, id DESC);
GRANT SELECT, INSERT, DELETE ON public.job_logs TO authenticated;
GRANT ALL ON public.job_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.job_logs_id_seq TO authenticated, service_role;
ALTER TABLE public.job_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own job logs" ON public.job_logs FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- CONTACTS
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.batch_jobs(id) ON DELETE SET NULL,
  neq text,
  company_name text NOT NULL,
  executive_name text,
  title text,
  email text,
  phone text,
  domain text,
  city text,
  postal_code text,
  verification_status text NOT NULL DEFAULT 'Unverified',
  confidence smallint NOT NULL DEFAULT 0,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_user_idx ON public.contacts(user_id, created_at DESC);
CREATE INDEX contacts_job_idx ON public.contacts(job_id);
CREATE INDEX contacts_search_idx ON public.contacts USING gin (to_tsvector('simple', coalesce(company_name,'') || ' ' || coalesce(executive_name,'') || ' ' || coalesce(email,'')));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own contacts" ON public.contacts FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER t_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER t_settings_updated BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER t_jobs_updated BEFORE UPDATE ON public.batch_jobs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- new user handler
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_settings (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- queue claim (bounded, skip locked, lease based)
CREATE OR REPLACE FUNCTION public.claim_job_rows(p_job_id uuid, p_limit integer)
RETURNS SETOF public.job_rows
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.job_rows r
  SET status = 'processing', attempts = r.attempts + 1
  WHERE r.id IN (
    SELECT r2.id FROM public.job_rows r2
    WHERE r2.job_id = p_job_id AND r2.status = 'queued'
    ORDER BY r2.row_index
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.*;
END; $$;
REVOKE ALL ON FUNCTION public.claim_job_rows(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_rows(uuid, integer) TO service_role;

-- realtime
ALTER TABLE public.batch_jobs REPLICA IDENTITY FULL;
ALTER TABLE public.job_logs REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.batch_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.job_logs;