ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS facebook_url text,
  ADD COLUMN IF NOT EXISTS registry_url text;