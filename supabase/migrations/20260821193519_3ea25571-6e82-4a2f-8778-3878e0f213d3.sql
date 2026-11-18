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
    url := coalesce(current_setting('app.settings.app_url', true), 'http://localhost:8080') || '/api/public/hooks/process-batch',
    headers := jsonb_build_object(
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $cron$
);