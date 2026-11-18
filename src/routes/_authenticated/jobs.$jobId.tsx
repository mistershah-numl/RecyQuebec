import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { getJob, pumpJob, setJobStatus, startJob } from "@/lib/jobs.functions";
import { formatEta } from "@/lib/req";

export const Route = createFileRoute("/_authenticated/jobs/$jobId")({
  head: () => ({
    meta: [
      { title: "Batch execution — RECYC Contact OSINT" },
      { name: "description", content: "Live progress, counters, ETA and streaming logs for a running enrichment batch." },
      { property: "og:title", content: "Batch execution — RECYC Contact OSINT" },
      { property: "og:description", content: "Monitor enrichment progress in real time." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: JobDetail,
});

function JobDetail() {
  const { jobId } = Route.useParams();
  const queryClient = useQueryClient();
  const fetchJob = useServerFn(getJob);
  const pump = useServerFn(pumpJob);
  const setStatus = useServerFn(setJobStatus);
  const resume = useServerFn(startJob);
  const logRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJob({ data: { job_id: jobId } }),
    refetchInterval: 2000,
  });

  const job: any = data?.job;
  const logs: any[] = data?.logs ?? [];
  const activeRows: any[] = data?.activeRows ?? [];
  const running = job?.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Client-side pump keeps the queue moving while the dashboard is open.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await pump({ data: { job_id: jobId } });
      } catch {
        /* transient — the scheduled worker also pumps this job */
      }
      queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, jobId, pump, queryClient]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  const act = useMutation({
    mutationFn: async (kind: "pause" | "resume" | "stop") => {
      if (kind === "pause") await setStatus({ data: { job_id: jobId, status: "paused" } });
      if (kind === "resume") await resume({ data: { job_id: jobId } });
      if (kind === "stop") await setStatus({ data: { job_id: jobId, status: "stopped" } });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  // Group the flat log stream into one collapsible block per queued record.
  const records = (() => {
    const map = new Map<string, { key: string; steps: any[]; outcome: string; summary: string }>();
    for (const l of logs) {
      const split = String(l.message).split(" \u00b7 ");
      const head = split[0] ?? "";
      const isRecord = /^\[\d+\]/.test(head);
      const key = isRecord ? head : "Batch";
      const text = isRecord ? split.slice(1).join(" \u00b7 ") || head : String(l.message);
      const entry = map.get(key) ?? { key, steps: [], outcome: "running", summary: "in progress" };
      entry.steps.push({ id: l.id, created_at: l.created_at, level: l.level, text });
      if (text.startsWith("Saved")) {
        entry.outcome = l.level === "success" ? "success" : "warn";
        entry.summary = text.replace(/^Saved → /, "");
      } else if (l.level === "error") {
        entry.outcome = "error";
        entry.summary = "failed";
      }
      map.set(key, entry);
    }
    return [...map.values()].reverse();
  })();

  const total = job?.total_rows ?? 0;
  const processed = job?.processed_rows ?? 0;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  const started = job?.started_at ? new Date(job.started_at).getTime() : null;
  const elapsed = started ? Math.max(0, now - started) : 0;
  const eta =
    started && processed > 0 && processed < total
      ? (elapsed / processed) * (total - processed)
      : null;
  const latestLogAt = logs.length ? new Date(logs[logs.length - 1]?.created_at).getTime() : started;
  const silentFor = latestLogAt ? now - latestLogAt : 0;
  const stalled = running && activeRows.length > 0 && silentFor > 90_000;

  return (
    <AppShell
      title={job?.name ?? "Batch execution"}
      description={job ? `${job.model} · ${job.file_name || "uploaded file"}` : "Loading batch…"}
      actions={
        <div className="flex gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={() => act.mutate("pause")}>
              <Pause className="mr-2 h-4 w-4" /> Pause
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => act.mutate("resume")}
              disabled={job?.status === "completed" || job?.status === "stopped"}
            >
              <Play className="mr-2 h-4 w-4" /> Resume
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={() => act.mutate("stop")}>
            <Square className="mr-2 h-4 w-4" /> Stop
          </Button>
        </div>
      }
    >
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Live progress</CardTitle>
          <Badge variant={running ? "default" : "secondary"}>{job?.status ?? "…"}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={pct} />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              ["Progress", `${pct}%`],
              ["Processed", `${processed.toLocaleString()} / ${total.toLocaleString()}`],
              ["Verified emails", (job?.valid_emails ?? 0).toLocaleString()],
              ["Failed", (job?.invalid_count ?? 0).toLocaleString()],
              ["ETA", eta ? formatEta(eta / 1000) : running ? "Calibrating…" : "—"],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>Elapsed: {formatEta(elapsed / 1000)}</span>
            <span>Active companies: {activeRows.length}</span>
            {activeRows.length ? <span>Retries happen automatically after the per-company deadline.</span> : null}
          </div>
          {stalled ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              No worker heartbeat for {formatEta(silentFor / 1000)}. The current rows will be reclaimed and retried automatically; other queued rows can continue.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Per-record activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records processed yet.</p>
          ) : (
            records.map((rec) => (
              <details key={rec.key} open={rec === records[0]} className="rounded-lg border border-border p-3">
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
                  <span className="min-w-0 truncate">{rec.key}</span>
                  <Badge
                    variant={
                      rec.outcome === "success"
                        ? "default"
                        : rec.outcome === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {rec.outcome === "running" ? "searching…" : rec.summary}
                  </Badge>
                </summary>
                <ol className="mt-3 space-y-1 border-l border-border pl-4 font-mono text-xs">
                  {rec.steps.map((s) => (
                    <li
                      key={s.id}
                      className={
                        s.level === "error"
                          ? "text-destructive"
                          : s.level === "warn"
                            ? "text-amber-600 dark:text-amber-400"
                            : s.level === "success"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-muted-foreground"
                      }
                    >
                      <span className="opacity-60">
                        {new Date(s.created_at).toLocaleTimeString()}
                      </span>{" "}
                      {s.text}
                    </li>
                  ))}
                </ol>
              </details>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Raw execution log</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            ref={logRef}
            className="h-80 overflow-y-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-emerald-300"
          >
            {logs.length === 0 ? (
              <p className="text-zinc-500">Waiting for output…</p>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="whitespace-pre-wrap break-words">
                  <span className="text-zinc-500">
                    [{new Date(log.created_at).toLocaleTimeString()}]
                  </span>{" "}
                  <span
                    className={
                      log.level === "error"
                        ? "text-red-400"
                        : log.level === "warn"
                          ? "text-amber-300"
                          : "text-emerald-300"
                    }
                  >
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
