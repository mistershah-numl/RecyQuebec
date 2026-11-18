import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { FileSpreadsheet, Loader2, Trash2, Upload } from "lucide-react";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

import { AppShell } from "@/components/AppShell";
import { ManualRowsEntry } from "@/components/ManualRowsEntry";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  appendJobRows,
  createJob,
  deleteJob,
  findAlreadyChecked,
  getSettings,
  listJobs,
  purgeCheckedKeys,
  startJob,
} from "@/lib/jobs.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AI_FALLBACK_THRESHOLDS, EMPLOYEE_BANDS, OSINT_SOURCES, availableModels, mapRecord, sourceHeaders, type ReqRow, type SavedAiService } from "@/lib/req";
import { listAiServices } from "@/lib/ai-services.functions";

export const Route = createFileRoute("/_authenticated/jobs/")({
  head: () => ({
    meta: [
      { title: "Batch Jobs — RECYC Contact OSINT" },
      { name: "description", content: "Upload REQ CSV or Excel files and run enrichment batches at scale." },
      { property: "og:title", content: "Batch Jobs — RECYC Contact OSINT" },
      { property: "og:description", content: "Upload, slice and execute large REQ enrichment batches." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: JobsPage,
});

const CHUNK = 500;

function JobsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchJobs = useServerFn(listJobs);
  const create = useServerFn(createJob);
  const append = useServerFn(appendJobRows);
  const start = useServerFn(startJob);
  const remove = useServerFn(deleteJob);
  const checkDuplicates = useServerFn(findAlreadyChecked);
  const purgeDuplicates = useServerFn(purgeCheckedKeys);

  const [rows, setRows] = useState<ReqRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [startRow, setStartRow] = useState(0);
  const [endRow, setEndRow] = useState(0);
  const [model, setModel] = useState<string>("google/gemini-3.6-flash");
  const [targets, setTargets] = useState({
    email: true,
    phone: true,
    domain: true,
    registry: true,
    directories: true,
    address: true,
    linkedin: true,
    facebook: true,
    domainGuess: true,
    deepCrawl: true,
    patternEmails: true,
    companyStatus: true,
    useAiFallback: true,
    skipOsint: false,
    aiFallbackMinScore: 0,

    allowGenericEmail: true,
    countryLock: true,
  });

  const [keywords, setKeywords] = useState("");
  const [region, setRegion] = useState("Canada");
  const [customSites, setCustomSites] = useState("");

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dupes, setDupes] = useState<null | { items: { key: string; label: string }[]; count: number }>(
    null,
  );
  const [skipSet, setSkipSet] = useState<Set<string>>(new Set());
  const matchedKeysRef = useRef<string[]>([]);


  const [skipBands, setSkipBands] = useState<Set<string>>(new Set());
  const [skipUnknownBand, setSkipUnknownBand] = useState(false);

  const [checkingDupes, setCheckingDupes] = useState(false);
  const [dragging, setDragging] = useState(false);

  const fetchSettings = useServerFn(getSettings);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });
  const fetchAiServices = useServerFn(listAiServices);
  const { data: aiServices } = useQuery({ queryKey: ["ai-services"], queryFn: () => fetchAiServices() });
  const models = availableModels(
    (settings ?? {}) as Record<string, unknown>,
    (aiServices ?? []) as SavedAiService[],
  );

  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => fetchJobs(),
    refetchInterval: 5000,
  });

  async function handleFile(file: File) {
    setFileName(file.name);
    const parsed: ReqRow[] = [];
    let headers: string[] = [];
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]!]!;
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      headers = sourceHeaders(records);
      records.forEach((rec, i) => {
        const mapped = mapRecord(rec, i);
        if (mapped) parsed.push(mapped);
      });
    } else {
      const text = await file.text();
      const result = Papa.parse<Record<string, unknown>>(text, {
        header: true,
        skipEmptyLines: true,
      });
      headers = sourceHeaders(result.data);
      result.data.forEach((rec, i) => {
        const mapped = mapRecord(rec, i);
        if (mapped) parsed.push(mapped);
      });
    }
    if (parsed.length === 0) {
      toast.error("No usable rows found. Expected columns such as NEQ, Company Name, Postal Code, City.");
      return;
    }
    setRows(parsed);
    setFileHeaders(headers);
    setStartRow(0);
    setEndRow(Math.min(parsed.length, 500));
    toast.success(
      `${parsed.length.toLocaleString()} rows loaded from ${file.name} · ${headers.length} original column(s) preserved for export`,
    );
  }

  /** Rows left after the employee-count filter — everything downstream uses these. */
  const eligibleRows = useMemo(
    () =>
      rows.filter((r) => {
        const band = r.employee_band;
        if (!band) return !skipUnknownBand;
        return !skipBands.has(band);
      }),
    [rows, skipBands, skipUnknownBand],
  );
  const excludedCount = rows.length - eligibleRows.length;
  const bandCounts = useMemo(() => {
    const map: Record<string, number> = {};
    let unknown = 0;
    for (const r of rows) {
      if (r.employee_band) map[r.employee_band] = (map[r.employee_band] ?? 0) + 1;
      else unknown += 1;
    }
    return { map, unknown };
  }, [rows]);
  const hasBandData = Object.keys(bandCounts.map).length > 0;

  const rowKey = (r: { neq?: string | null; company_name: string }) =>
    (r.neq && String(r.neq).trim()) || r.company_name.trim().toLowerCase();

  /** Warn before re-processing companies that were already enriched. */
  async function preflight() {
    const slice = eligibleRows.slice(startRow, endRow);
    if (!slice.length) {
      toast.error("Selected range is empty.");
      return;
    }
    setCheckingDupes(true);
    try {
      const res: any = await checkDuplicates({
        data: { keys: slice.map((r) => ({ neq: r.neq ?? null, company_name: r.company_name })) },
      });
      const matched: string[] = res?.matched ?? [];
      const set = new Set(matched);
      const hit = slice.filter((r) => set.has(rowKey(r as any)));
      matchedKeysRef.current = matched;
      if (hit.length) {
        const seen = new Set<string>();
        const items: { key: string; label: string }[] = [];
        for (const r of hit) {
          const k = rowKey(r as any);
          if (seen.has(k)) continue;
          seen.add(k);
          items.push({ key: k, label: r.company_name + (r.neq ? ` · NEQ ${r.neq}` : "") });
        }
        setSkipSet(new Set(items.map((i) => i.key)));
        setDupes({ items, count: hit.length });
        return;
      }

      launch.mutate({ skip: [] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check for previous results.");
    } finally {
      setCheckingDupes(false);
    }
  }

  const launch = useMutation({
    mutationFn: async ({ skip }: { skip: string[] }) => {
      const matched = new Set(matchedKeysRef.current);
      const skipKeys = new Set(skip);
      let base = eligibleRows.slice(startRow, endRow);
      if (skipKeys.size) {
        base = base.filter((r) => !skipKeys.has(rowKey(r as any)));
        if (base.length === 0)
          throw new Error("All rows in this range were already checked — nothing left to process.");
      }
      if (matched.size) {
        const dup = base.filter((r) => matched.has(rowKey(r as any)));
        if (dup.length) {
          await purgeDuplicates({
            data: { keys: dup.map((r) => ({ neq: r.neq ?? null, company_name: r.company_name })) },
          });
        }
      }

      const slice = base.map((r, i) => ({
        row_index: startRow + i,
        neq: r.neq,
        company_name: r.company_name,
        postal_code: r.postal_code,
        city: r.city,
        source_row: r.source_row,
      }));
      if (slice.length === 0) throw new Error("Selected range is empty.");

      const { id } = await create({
        data: {
          name: `${fileName || "REQ batch"} · rows ${startRow}–${endRow}`,
          file_name: fileName,
          model,
          source_headers: fileHeaders,
          targets: {
            ...targets,
            skippedEmployeeBands: [...skipBands],
            skipUnknownEmployeeBand: skipUnknownBand,
            keywords,
            region,
            customSites: customSites
              .split(/[\s,;]+/)
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 12),
          },
          start_row: startRow,
          end_row: endRow,
        },
      });

      for (let i = 0; i < slice.length; i += CHUNK) {
        await append({ data: { job_id: id, rows: slice.slice(i, i + CHUNK) } });
        setUploadPct(Math.round(Math.min(100, ((i + CHUNK) / slice.length) * 100)));
      }
      await start({ data: { job_id: id } });
      return id;
    },
    onSuccess: (id) => {
      setUploadPct(null);
      setDupes(null);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      navigate({ to: "/jobs/$jobId", params: { jobId: id } });
    },
    onError: (e: Error) => {
      setUploadPct(null);
      toast.error(e.message);
    },
  });

  const selected = Math.max(0, Math.min(endRow, eligibleRows.length) - startRow);

  return (
    <AppShell title="Batch Jobs" description="Upload a Quebec REQ file and execute a range of rows">
      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1 · Upload REQ file</CardTitle>
            <CardDescription>CSV or Excel with NEQ, Company Name, Postal Code, City.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Tabs defaultValue="file">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="file">Upload a file</TabsTrigger>
                <TabsTrigger value="manual">Enter manually</TabsTrigger>
              </TabsList>
              <TabsContent value="file" className="mt-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFile(file);
              }}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                dragging ? "border-primary bg-accent/50" : "border-border hover:bg-accent/30"
              }`}
            >
              <FileSpreadsheet className="mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">Drag & drop your REQ file here</p>
              <p className="text-xs text-muted-foreground">or click to browse · .csv .xlsx .xls</p>
              {rows.length > 0 ? (
                <Badge className="mt-3" variant="secondary">
                  {fileName} · {rows.length.toLocaleString()} rows
                </Badge>
              ) : null}
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </div>
              </TabsContent>
              <TabsContent value="manual" className="mt-4">
                <ManualRowsEntry
                  onApply={(manualRows, headers) => {
                    setRows(manualRows);
                    setFileHeaders(headers);
                    setFileName("Manual entry");
                    setStartRow(0);
                    setEndRow(manualRows.length);
                  }}
                />
              </TabsContent>
            </Tabs>


            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm">Employee-count filter (sampling)</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSkipBands(new Set(EMPLOYEE_BANDS.filter((b) => b.tiny).map((b) => b.code)));
                      setStartRow(0);
                    }}
                  >
                    Skip 1-man shops (O, A, B)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSkipBands(new Set());
                      setSkipUnknownBand(false);
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Tick a range to leave those companies out of this batch. They stay in your file, so you can
                run them later as their own batch.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {EMPLOYEE_BANDS.map((b) => (
                  <label key={b.code} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={skipBands.has(b.code)}
                      onCheckedChange={(v) => {
                        setSkipBands((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(b.code);
                          else next.delete(b.code);
                          return next;
                        });
                        setStartRow(0);
                      }}
                    />
                    <span>
                      Skip {b.label}
                      {bandCounts.map[b.code] ? (
                        <span className="text-muted-foreground"> · {bandCounts.map[b.code]} rows</span>
                      ) : null}
                    </span>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={skipUnknownBand}
                    onCheckedChange={(v) => {
                      setSkipUnknownBand(Boolean(v));
                      setStartRow(0);
                    }}
                  />
                  <span>
                    Skip rows with no employee-count value
                    {bandCounts.unknown ? (
                      <span className="text-muted-foreground"> · {bandCounts.unknown} rows</span>
                    ) : null}
                  </span>
                </label>
              </div>
              {rows.length ? (
                <p className="text-xs">
                  {hasBandData
                    ? `${eligibleRows.length.toLocaleString()} of ${rows.length.toLocaleString()} rows kept · ${excludedCount.toLocaleString()} skipped`
                    : "No employee-count column detected in this file — add a column such as \"Employee count\", \"Nb employés\" or \"CD_NB_EMPL\" to use this filter."}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="start">Start row</Label>
                <Input
                  id="start"
                  type="number"
                  min={0}
                  value={startRow}
                  onChange={(e) => setStartRow(Math.max(0, Number(e.target.value)))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end">End row</Label>
                <Input
                  id="end"
                  type="number"
                  min={0}
                  value={endRow}
                  onChange={(e) => setEndRow(Math.max(0, Number(e.target.value)))}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {[500, 1000, 5000].map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEndRow(Math.min(eligibleRows.length || n, startRow + n))}
                >
                  +{n.toLocaleString()}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEndRow(eligibleRows.length)}
                disabled={!eligibleRows.length}
              >
                All ({eligibleRows.length.toLocaleString()})
              </Button>
            </div>

            <div className="space-y-2">
              <Label>AI model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Built-in models are always available. Models needing your own key appear
                here once you save that key in API Settings.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="keywords">Extra search keywords (optional)</Label>
              <Input
                id="keywords"
                placeholder="e.g. recyclage, propriétaire, courriel direction"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                maxLength={120}
              />
              <p className="text-xs text-muted-foreground">
                Appended to every OSINT search query for this batch.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="region">Country / region scope</Label>
                <Input
                  id="region"
                  placeholder="Canada"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  maxLength={60}
                />
                <p className="text-xs text-muted-foreground">
                  Added to every query so results stay in this market.
                </p>
              </div>
              <div className="space-y-2">
                <Label className="block">Region filtering</Label>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={targets.countryLock}
                    onCheckedChange={(v) => setTargets((t) => ({ ...t, countryLock: Boolean(v) }))}
                  />
                  <span>
                    Ignore foreign companies
                    <span className="block text-xs text-muted-foreground">
                      Drops results on foreign country domains (.fr, .us, .co.uk…)
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={targets.allowGenericEmail}
                    onCheckedChange={(v) =>
                      setTargets((t) => ({ ...t, allowGenericEmail: Boolean(v) }))
                    }
                  />
                  <span>
                    Accept company main email
                    <span className="block text-xs text-muted-foreground">
                      Falls back to info@ / contact@ when no executive email exists
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sites">Specific websites to search (optional)</Label>
              <Textarea
                id="sites"
                rows={3}
                placeholder={"b2bhint.com\nopencorporates.com\npagesjaunes.ca"}
                value={customSites}
                onChange={(e) => setCustomSites(e.target.value)}
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">
                One domain per line (max 12). Each one is searched with the company name / NEQ and
                its matching pages are crawled thoroughly.
              </p>
            </div>

            <div className="space-y-3">
              <Label>OSINT sources</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {OSINT_SOURCES.map((s) => (
                  <label key={s.key} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={targets[s.key]}
                      onCheckedChange={(v) => setTargets((t) => ({ ...t, [s.key]: Boolean(v) }))}
                    />
                    <span>
                      {s.label}
                      <span className="block text-xs text-muted-foreground">{s.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="research-mode">Research mode</Label>
              <Select
                value={targets.skipOsint ? "ai_only" : targets.useAiFallback ? "osint_ai" : "osint_only"}
                onValueChange={(v) =>
                  setTargets((t) => ({
                    ...t,
                    skipOsint: v === "ai_only",
                    useAiFallback: v !== "osint_only",
                  }))
                }
              >
                <SelectTrigger id="research-mode" className="w-full sm:w-[320px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="osint_ai">OSINT first, AI when needed (recommended)</SelectItem>
                  <SelectItem value="ai_only">AI only — no crawling</SelectItem>
                  <SelectItem value="osint_only">OSINT only — never call AI</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {targets.skipOsint
                  ? "Fastest and cheapest per row: no scraping, the AI agent answers directly with a compact prompt."
                  : targets.useAiFallback
                    ? "Crawls first, then escalates to the AI agent based on the threshold below."
                    : "Pure OSINT — no AI tokens are used at all."}
              </p>
            </div>

            <div className="space-y-2">

              <Label htmlFor="ai-threshold">Call the AI agent when…</Label>
              <Select
                value={String(targets.aiFallbackMinScore)}
                onValueChange={(v) => setTargets((t) => ({ ...t, aiFallbackMinScore: Number(v) }))}
                disabled={!targets.useAiFallback}
              >
                <SelectTrigger id="ai-threshold" className="w-full sm:w-[320px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_FALLBACK_THRESHOLDS.map((o) => (
                    <SelectItem key={o.value} value={String(o.value)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {targets.useAiFallback
                  ? (AI_FALLBACK_THRESHOLDS.find((o) => o.value === targets.aiFallbackMinScore)?.hint ??
                    "")
                  : "AI fallback is turned off in OSINT sources — records stay OSINT-only."}
              </p>
            </div>

            <div className="space-y-3">
              <Label>Execution targets</Label>
              <div className="flex flex-wrap gap-5">
                {(["email", "phone", "domain"] as const).map((key) => (
                  <label key={key} className="flex items-center gap-2 text-sm capitalize">
                    <Checkbox
                      checked={targets[key]}
                      onCheckedChange={(v) => setTargets((t) => ({ ...t, [key]: Boolean(v) }))}
                    />
                    {key === "email" ? "Executive email" : key === "phone" ? "Phone" : "Domain match"}
                  </label>
                ))}
              </div>
            </div>

            {uploadPct !== null ? (
              <div className="space-y-2">
                <Progress value={uploadPct} />
                <p className="text-xs text-muted-foreground">Queueing rows… {uploadPct}%</p>
              </div>
            ) : null}

            <Button
              className="w-full"
              disabled={!rows.length || selected === 0 || launch.isPending || checkingDupes}
              onClick={() => void preflight()}
            >
              {launch.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Start batch execution ({selected.toLocaleString()} rows)
            </Button>
            <p className="text-xs text-muted-foreground">
              Large files are queued in chunks and processed in small bounded batches, so an
              18,000-row file runs safely and keeps going even if you close this tab.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent batches</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(jobs ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No batches yet.</p>
            ) : (
              (jobs as any[]).map((job) => {
                const pct = job.total_rows ? Math.round((job.processed_rows / job.total_rows) * 100) : 0;
                return (
                  <div key={job.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        to="/jobs/$jobId"
                        params={{ jobId: job.id }}
                        className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                      >
                        {job.name}
                      </Link>
                      <Badge variant={job.status === "completed" ? "secondary" : "default"}>
                        {job.status}
                      </Badge>
                      <button
                        aria-label="Delete batch"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          await remove({ data: { job_id: job.id } });
                          queryClient.invalidateQueries({ queryKey: ["jobs"] });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <Progress className="mt-2" value={pct} />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.processed_rows}/{job.total_rows} · {job.valid_emails} verified
                    </p>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
      <AlertDialog open={dupes !== null} onOpenChange={(o) => !o && setDupes(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dupes?.count === 1
                ? "This row was already checked"
                : `${dupes?.count ?? 0} of these rows were already checked`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Tick the ones you want to skip. Unticked rows will be checked again and their old data
              replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {(dupes?.items ?? []).map((item) => (
              <label
                key={item.key}
                className="flex items-start gap-2 rounded px-1 py-1 text-sm hover:bg-accent/40"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={skipSet.has(item.key)}
                  onCheckedChange={(v) =>
                    setSkipSet((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(item.key);
                      else next.delete(item.key);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{skipSet.size} selected to skip</span>
            <div className="flex gap-3">
              <button
                type="button"
                className="underline"
                onClick={() => setSkipSet(new Set((dupes?.items ?? []).map((i) => i.key)))}
              >
                Select all
              </button>
              <button type="button" className="underline" onClick={() => setSkipSet(new Set())}>
                Clear
              </button>
            </div>
          </div>

          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel disabled={launch.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={launch.isPending}
              onClick={() => {
                const keys = (dupes?.items ?? []).map((i) => i.key);
                setDupes(null);
                launch.mutate({ skip: keys });
              }}
            >
              Skip all already checked
            </Button>
            <Button
              variant="outline"
              disabled={launch.isPending || skipSet.size === 0}
              onClick={() => {
                const keys = [...skipSet];
                setDupes(null);
                launch.mutate({ skip: keys });
              }}
            >
              Skip selected ({skipSet.size})
            </Button>
            <AlertDialogAction
              disabled={launch.isPending}
              onClick={(e) => {
                e.preventDefault();
                setDupes(null);
                launch.mutate({ skip: [] });
              }}
            >
              Check all again & replace
            </AlertDialogAction>
          </AlertDialogFooter>

        </AlertDialogContent>
      </AlertDialog>

    </AppShell>
  );
}
