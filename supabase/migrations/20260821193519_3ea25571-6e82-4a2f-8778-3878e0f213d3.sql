CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'recyc-process-batches') THEN
    PERFORM cron.unschedule('recyc-process-batches');
  END IF;
END $$;

SELECT cron.schedule(
  'recyc-process-batches',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://recycosint.lovable.app/api/public/hooks/process-batch',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'apikey', 'sb_publishable_Hs5S-qoHtD557y8zs89SOA_8kCT7xA-'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $cron$
);