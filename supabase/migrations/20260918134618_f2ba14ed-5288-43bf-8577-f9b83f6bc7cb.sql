CREATE TABLE public.ai_services (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name text NOT NULL,
  base_url text NOT NULL,
  api_key text NOT NULL,
  models text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_services TO authenticated;
GRANT ALL ON public.ai_services TO service_role;
ALTER TABLE public.ai_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own AI services" ON public.ai_services FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ai_services_user_idx ON public.ai_services (user_id);