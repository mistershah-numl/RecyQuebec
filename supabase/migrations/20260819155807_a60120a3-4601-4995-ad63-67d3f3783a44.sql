ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS row_timeout_seconds integer NOT NULL DEFAULT 120
  CHECK (row_timeout_seconds BETWEEN 30 AND 600);

ALTER TABLE public.job_rows
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS job_rows_recovery_idx
  ON public.job_rows(job_id, status, heartbeat_at);

CREATE OR REPLACE FUNCTION public.claim_job_rows(p_job_id uuid, p_limit integer)
RETURNS SETOF public.job_rows
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.job_rows r
  SET status = 'processing',
      attempts = r.attempts + 1,
      claimed_at = now(),
      heartbeat_at = now(),
      error = NULL
  WHERE r.id IN (
    SELECT r2.id FROM public.job_rows r2
    WHERE r2.job_id = p_job_id AND r2.status = 'queued'
    ORDER BY r2.row_index
    LIMIT LEAST(GREATEST(p_limit, 1), 8)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.*;
END; $$;
REVOKE ALL ON FUNCTION public.claim_job_rows(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_rows(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.recover_stale_job_rows(
  p_job_id uuid,
  p_stale_before timestamptz,
  p_max_attempts integer DEFAULT 5
)
RETURNS TABLE(requeued integer, failed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_requeued integer := 0;
  v_failed integer := 0;
BEGIN
  WITH recovered AS (
    UPDATE public.job_rows
    SET status = CASE WHEN attempts >= p_max_attempts THEN 'failed' ELSE 'queued' END,
        error = CASE
          WHEN attempts >= p_max_attempts THEN 'Timed out repeatedly; stopped after retry limit'
          ELSE 'Previous worker stopped responding; automatically queued for retry'
        END,
        claimed_at = NULL,
        heartbeat_at = NULL,
        processed_at = CASE WHEN attempts >= p_max_attempts THEN now() ELSE processed_at END
    WHERE job_id = p_job_id
      AND status = 'processing'
      AND COALESCE(heartbeat_at, claimed_at, created_at) < p_stale_before
    RETURNING status
  )
  SELECT count(*) FILTER (WHERE status = 'queued'), count(*) FILTER (WHERE status = 'failed')
  INTO v_requeued, v_failed FROM recovered;
  RETURN QUERY SELECT v_requeued, v_failed;
END; $$;
REVOKE ALL ON FUNCTION public.recover_stale_job_rows(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_job_rows(uuid, timestamptz, integer) TO service_role;