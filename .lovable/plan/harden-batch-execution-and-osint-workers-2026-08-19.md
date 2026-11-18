# Harden batch execution and OSINT workers

## What will change

- Bound every company and URL operation with explicit deadlines so one slow site cannot block a row or batch indefinitely.
- Process a small number of rows concurrently, while keeping database claims idempotent and preventing duplicate work.
- Add stale-row recovery: timed- queout `processing` rows return to theue, retry up to a fixed limit, then fail cleanly without stopping other rows.
- Replace the short job-wide lease with safe per-row claims and heartbeat/progress updates suitable for long-running local or VPS workers.
- Add live stage/heartbeat logs, active-row counts, elapsed time, early ETA (“calibrating” before the first completion), and stalled-worker warnings in the job screen.
- Harden the Python worker with bounded browser concurrency, total request deadlines, reusable browser contexts, automatic browser restart after failures, and `/health` runtime counters.
- Update the Windows/VPS instructions with the exact restart commands and recommended worker settings.
- make sure user can modify the time or deadline spent on each row , 
- if a row is skipped cz not fulfilling deadline , make sure to re-compute that again as well , so that it never left behind , please , 

## Technical details

- Keep batches bounded and use database `SKIP LOCKED` claims; add claim timestamps so abandoned rows can be reclaimed safely.
- Run rows with a small configurable concurrency (default 2), not an unbounded fan-out.
- Apply nested deadlines: URL render, full worker request, company enrichment, and server invocation.
- Ensure all timeout/error paths close Playwright pages/contexts and mark row progress before continuing.
- Preserve the existing OSINT-first and AI-fallback behavior; this work changes execution reliability and observability only.

## Verification

- Run focused tests/type checks supplied by the harness.
- Exercise the live job UI and worker health endpoint locally.
- Confirm a deliberately slow/broken URL times out while another row continues and progress/ETA remains visible.
- i just need information do whatever suits best to you , 
  &nbsp;