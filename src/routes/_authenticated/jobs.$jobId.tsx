import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode,
  Globe,
  Mail,
  Pause,
  Phone,
  Play,
  ShieldCheck,
  Square,
  UserCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { getEvidenceRubric } from "@/lib/domain-authority";
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
  const contacts: any[] = data?.contacts ?? [];
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
          <CardTitle className="text-base">Per-record activity &amp; Extracted Evidence</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records processed yet.</p>
          ) : (
            records.map((rec) => {
              const compClean = rec.key.replace(/^\[\d+\]\s*/, "").trim().toLowerCase();
              const matchingContacts = contacts.filter((c: any) => {
                if (!c?.company_name) return false;
                const cn = c.company_name.toLowerCase();
                return compClean === cn || compClean.includes(cn) || cn.includes(compClean);
              });
              const contact = matchingContacts[0] ?? null;
              const additionalContacts = matchingContacts.slice(1);

              const score = contact
                ? Number(contact.confidence ?? 0)
                : (/score (\d)\/5/.test(rec.summary)
                  ? parseInt(rec.summary.match(/score (\d)\/5/)![1]!)
                  : (rec.outcome === "success" ? 4 : 0));
              const rubric = getEvidenceRubric(score);

              // Gather extracted proof sources from contact details and step logs
              const rawSources: Array<{ url: string; selector: string; points: string[]; htmlPreview: string }> = [];
              const seenUrls = new Set<string>();

              if (contact?.verification_details?.extracted_sources) {
                for (const src of contact.verification_details.extracted_sources) {
                  if (src?.url && !seenUrls.has(src.url)) {
                    seenUrls.add(src.url);
                    rawSources.push({
                      url: src.url,
                      selector: src.selector || "Web Source",
                      points: src.extraction_points || [],
                      htmlPreview: src.html_preview || "",
                    });
                  }
                }
              }

              for (const s of rec.steps) {
                const text = String(s.text || "");
                if (text.includes("[RAW SOURCE]") || text.includes("[RAW EXECUTION]")) {
                  const urlMatch = text.match(/(https?:\/\/[^\s|]+)/);
                  const url = urlMatch ? urlMatch[1] : "";
                  const typeMatch = text.match(/Type:\s*([^|]+)/);
                  const type = typeMatch ? typeMatch[1].trim() : "Extraction Source";
                  const ptsMatch = text.match(/Points:\s*([^|(]+)/);
                  const points = ptsMatch ? ptsMatch[1].trim().split(", ") : [];
                  const htmlMatch = text.match(/\(HTML:\s*([\s\S]*?)\)$/);
                  if (url && !seenUrls.has(url)) {
                    seenUrls.add(url);
                    rawSources.push({
                      url,
                      selector: type,
                      points,
                      htmlPreview: htmlMatch ? htmlMatch[1] : "",
                    });
                  }
                }
              }

              const scoreBadgeClass =
                score >= 5
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : score === 4
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : score === 3
                      ? "bg-indigo-600 text-white hover:bg-indigo-700"
                      : score === 2
                        ? "bg-amber-600 text-white hover:bg-amber-700"
                        : score === 1
                          ? "bg-zinc-600 text-white hover:bg-zinc-700"
                          : "bg-zinc-800 text-zinc-300";

              return (
                <details
                  key={rec.key}
                  open={rec === records[0]}
                  className="group rounded-lg border border-border bg-card/60 p-4 transition-all"
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium select-none">
                    <div className="flex min-w-0 items-center gap-2">
                      <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 text-muted-foreground" />
                      <span className="font-semibold truncate">{rec.key}</span>
                      <span className="text-xs text-muted-foreground hidden sm:inline">
                        {contact?.email ? `· ${contact.email}` : ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge className={`text-[11px] font-mono px-2 py-0.5 ${scoreBadgeClass}`}>
                        Score {score}/5 · {rubric.label}
                      </Badge>
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
                    </div>
                  </summary>

                  <div className="mt-4 space-y-4 border-t border-border pt-4">
                    {/* Discovered Contact Card & Rubric Criteria */}
                    <div className="rounded-md border border-border/80 bg-muted/40 p-3 text-xs space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
                        <div>
                          <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-semibold">Executive</span>
                          <span className="font-medium text-foreground">
                            {contact?.executive_name || "—"} {contact?.title ? `(${contact.title})` : ""}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-semibold">Email</span>
                          <span className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                            {contact?.email || "No email discovered"}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-semibold">Phone</span>
                          <span className="font-mono text-foreground">{contact?.phone || "—"}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block text-[10px] uppercase tracking-wider font-semibold">Domain</span>
                          {contact?.domain ? (
                            <a
                              href={`https://${contact.domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                            >
                              {contact.domain} <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 border-t border-border/60 pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px]">
                        <div>
                          <span className="font-semibold text-muted-foreground">Evidence Criteria: </span>
                          <span className="text-foreground">{rubric.criteria}</span>
                        </div>
                        <div className="shrink-0">
                          <span className="font-semibold text-muted-foreground">Action: </span>
                          <span className="font-medium text-primary">{rubric.action}</span>
                        </div>
                      </div>
                    </div>

                    {/* Discovered Additional Leadership Executives */}
                    {additionalContacts.length > 0 && (
                      <div className="rounded-md border border-border/80 bg-muted/20 p-3 text-xs space-y-2">
                        <div className="flex items-center gap-1.5 font-semibold text-foreground text-[11px]">
                          <span>Additional Leadership Executives ({additionalContacts.length})</span>
                        </div>
                        <div className="divide-y divide-border/40">
                          {additionalContacts.map((ac: any, aIdx: number) => (
                            <div key={ac.id || aIdx} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 py-1.5 first:pt-0 last:pb-0">
                              <div>
                                <span className="font-medium text-foreground">{ac.executive_name || "—"}</span>
                                {ac.title && <span className="text-[10px] text-muted-foreground block truncate">{ac.title}</span>}
                              </div>
                              <div className="font-mono text-emerald-600 dark:text-emerald-400">
                                {ac.email || <span className="text-muted-foreground font-sans">No email</span>}
                              </div>
                              <div className="font-mono text-muted-foreground">
                                {ac.phone || "—"}
                              </div>
                              <div className="flex items-center gap-1">
                                <Badge variant="outline" className="text-[10px] font-mono">
                                  {ac.verification_status || "Unverified"}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">Score {ac.confidence ?? 0}/5</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Extracted Evidence & Proof (HTML / Live Pages) */}
                    {rawSources.length > 0 && (
                      <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-950/10 p-3">
                        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                          <FileCode className="h-4 w-4" />
                          <span>Extracted Proof &amp; Live Sources ({rawSources.length})</span>
                        </div>
                        <div className="space-y-2.5">
                          {rawSources.map((src, idx) => (
                            <div key={idx} className="rounded border border-border/80 bg-background/80 p-2.5 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <a
                                  href={src.url.startsWith("http") ? src.url : undefined}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 font-mono font-medium text-primary hover:underline truncate max-w-md"
                                >
                                  {src.url} <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <Badge variant="outline" className="text-[10px] uppercase font-mono">
                                    {src.selector}
                                  </Badge>
                                  {src.points.map((pt, pIdx) => (
                                    <Badge key={pIdx} variant="secondary" className="text-[10px] font-mono">
                                      {pt}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                              {src.htmlPreview && (
                                <details className="mt-2 text-xs">
                                  <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
                                    Show extracted HTML / Text preview
                                  </summary>
                                  <pre className="mt-1.5 max-h-36 overflow-y-auto rounded bg-zinc-950 p-2 text-[11px] font-mono leading-relaxed text-zinc-300 border border-zinc-800 whitespace-pre-wrap break-all">
                                    {src.htmlPreview}
                                  </pre>
                                </details>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Step-by-step Audit Logs */}
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground font-medium">
                        View step-by-step audit logs ({rec.steps.length} entries)
                      </summary>
                      <ol className="mt-2 space-y-1 border-l border-border pl-4 font-mono text-[11px]">
                        {rec.steps.map((s: any) => (
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
                  </div>
                </details>
              );
            })
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
