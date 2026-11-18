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
    LIMIT LEAST(GREATEST(p_limit, 1), 25)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.*;
END; $$;

REVOKE ALL ON FUNCTION public.claim_job_rows(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_rows(uuid, integer) TO service_role;