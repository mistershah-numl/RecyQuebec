ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS custom_ai_key text,
  ADD COLUMN IF NOT EXISTS custom_ai_base_url text,
  ADD COLUMN IF NOT EXISTS custom_ai_models text;