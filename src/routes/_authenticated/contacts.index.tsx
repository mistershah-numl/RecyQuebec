import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Database as DatabaseIcon, Download, Loader2, Mail, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { collectiveScore, scoreLabel } from "@/lib/domain-authority";
import { cleanupContactWebsites, deleteContacts, exportContacts, listContacts, recheckContacts } from "@/lib/jobs.functions";
import { addVerifiedToCrm } from "@/lib/outreach.functions";
import { SendEmailDialog, type EmailRecipient } from "@/components/SendEmailDialog";

type ContactReference = { url: string; host: string; score: number; tier?: string };

/** Reads the reference links stored on a contact during enrichment. */
function referencesOf(c: any): ContactReference[] {
  const refs = c?.verification_details?.references;
  return Array.isArray(refs) ? refs.filter((r: any) => r && typeof r.url === "string") : [];
}

function sourceScoreOf(c: any): number {
  const stored = Number(c?.verification_details?.source_score ?? 0);
  if (stored > 0) return Math.round(stored);
  return collectiveScore(referencesOf(c).map((r) => ({ host: r.host, score: r.score, tier: r.tier ?? "" })));
}

export const Route = createFileRoute("/_authenticated/contacts/")({
  head: () => ({
    meta: [
      { title: "Verified Contacts — RECYC Contact OSINT" },
      { name: "description", content: "Browse, filter and export MX-verified executive contacts discovered from REQ data." },
      { property: "og:title", content: "Verified Contacts — RECYC Contact OSINT" },
      { property: "og:description", content: "Filterable table of enriched, verified leads with CSV export." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ContactsPage,
});

const PAGE_SIZE = 25;

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 flex-1 break-words ${mono ? "font-mono" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

function ContactsPage() {
  const fetchContacts = useServerFn(listContacts);
  const doExport = useServerFn(exportContacts);
  const doDelete = useServerFn(deleteContacts);
  const doRecheck = useServerFn(recheckContacts);
  const doCleanup = useServerFn(cleanupContactWebsites);
  const [cleaning, setCleaning] = useState(false);
  const queryClient = useQueryClient();

  async function cleanupWebsites() {
    setCleaning(true);
    try {
      const r = await doCleanup();
      toast.success(`Checked ${r.scanned} contacts: ${r.websites} wrong website(s) and ${r.emails} wrong email(s) fixed.`);
      await queryClient.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cleanup failed.");
    } finally {
      setCleaning(false);
    }
  }
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [minScore, setMinScore] = useState("0");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<null | "selected" | "all">(null);
  const [deleting, setDeleting] = useState(false);
  const [recheck, setRecheck] = useState<null | {
    ids: string[];
    already_checked: number;
    sample: { company_name: string; neq: string | null; checked_at: string; verification_status: string }[];
  }>(null);
  const [rechecking, setRechecking] = useState(false);
  const [savingToDb, setSavingToDb] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const saveToDb = useServerFn(addVerifiedToCrm);

  /** Copies the selected enrichment results into the curated contact database. */
  async function addToDatabase() {
    setSavingToDb(true);
    try {
      const res: any = await saveToDb({ data: { ids: selected } });
      toast.success(
        `${res.inserted} contact(s) added to your database${res.skipped ? `, ${res.skipped} already there` : ""}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["crm"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add these contacts.");
    } finally {
      setSavingToDb(false);
    }
  }

  const { data } = useQuery({
    queryKey: ["contacts", search, status, minScore, page],
    queryFn: () =>
      fetchContacts({
        data: {
          search,
          status,
          min_score: Number(minScore),
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
      }),
  });

  const rows: any[] = data?.rows ?? [];
  const total = data?.count ?? 0;
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  function toggleRow(id: string, on: boolean) {
    setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }

  function togglePage(on: boolean) {
    const ids = rows.map((r) => r.id);
    setSelected((prev) =>
      on ? [...new Set([...prev, ...ids])] : prev.filter((x) => !ids.includes(x)),
    );
  }

  async function runDelete(mode: "selected" | "all") {
    setDeleting(true);
    try {
      await doDelete({
        data:
          mode === "all"
            ? { all: true, search, status, min_score: Number(minScore) }
            : { ids: selected },
      });
      toast.success(mode === "all" ? "All matching contacts deleted." : `${selected.length} contact(s) deleted.`);
      setSelected([]);
      setPage(0);
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
  }

  /** Step 1: ask the server what would be overwritten, then confirm with the user. */
  async function askRecheck(ids: string[]) {
    if (!ids.length) return;
    setRechecking(true);
    try {
      const res: any = await doRecheck({ data: { ids } });
      if (res?.requires_confirmation) {
        setRecheck({ ids, already_checked: res.already_checked, sample: res.sample ?? [] });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not prepare the re-check.");
    } finally {
      setRechecking(false);
    }
  }

  /** Step 2: user accepted — run the pipeline again and replace the old data. */
  async function confirmRecheck() {
    if (!recheck) return;
    setRechecking(true);
    try {
      const res: any = await doRecheck({ data: { ids: recheck.ids, replace: true } });
      toast.success(`Re-checking ${res.rows} row(s). Old results were replaced.`);
      setSelected([]);
      setRecheck(null);
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
      navigate({ to: "/jobs/$jobId", params: { jobId: res.job_id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-check failed.");
    } finally {
      setRechecking(false);
    }
  }

  async function exportCsv() {
    const res: any = await doExport({ data: { search, status, min_score: Number(minScore) } });
    if (!res?.csv) {
      toast.error("Nothing to export yet.");
      return;
    }
    const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "verified-leads.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AppShell
      title="Verified Contacts"
      description={`${total.toLocaleString()} contacts matching current filters`}
      actions={
        <div className="flex flex-wrap gap-2">
          {selected.length > 0 && (
            <Button variant="outline" disabled={savingToDb} onClick={() => void addToDatabase()}>
              <DatabaseIcon className="mr-2 h-4 w-4" /> Add {selected.length} to database
            </Button>
          )}
          {selected.length > 0 && (
            <Button onClick={() => setEmailOpen(true)}>
              <Mail className="mr-2 h-4 w-4" /> Email {selected.length}
            </Button>
          )}
          {selected.length > 0 && (
            <Button variant="outline" disabled={rechecking} onClick={() => askRecheck(selected)}>
              <RefreshCw className="mr-2 h-4 w-4" /> Re-check {selected.length} selected
            </Button>
          )}
          {selected.length > 0 && (
            <Button variant="destructive" onClick={() => setConfirm("selected")}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete {selected.length} selected
            </Button>
          )}
          <Button variant="outline" disabled={total === 0} onClick={() => setConfirm("all")}>
            <Trash2 className="mr-2 h-4 w-4" /> Delete all matching
          </Button>
          <Button variant="outline" disabled={cleaning || total === 0} onClick={() => void cleanupWebsites()}>
            {cleaning ? "Cleaning…" : "Clean up wrong websites"}
          </Button>
          <Button onClick={exportCsv}>
            <Download className="mr-2 h-4 w-4" /> Export verified leads (CSV)
          </Button>
        </div>
      }
    >
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-3">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search company, NEQ, executive or email…"
                value={search}
                onChange={(e) => {
                  setPage(0);
                  setSearch(e.target.value);
                }}
                maxLength={120}
              />
            </div>
            <Select
              value={status}
              onValueChange={(v) => {
                setPage(0);
                setStatus(v);
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="verified">Verified (cross-checked)</SelectItem>
                <SelectItem value="mx_verified">MX Verified</SelectItem>
                <SelectItem value="unverified">Unverified</SelectItem>
                <SelectItem value="invalid">Invalid</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={minScore}
              onValueChange={(v) => {
                setPage(0);
                setMinScore(v);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    Confidence ≥ {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Mobile: card layout so every field stays readable */}
          <div className="space-y-3 md:hidden">
            {rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No contacts yet. Run a batch to populate this table.
              </p>
            ) : (
              rows.map((c) => (
                <div key={c.id} className="rounded-lg border border-border p-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selected.includes(c.id)}
                      onCheckedChange={(v) => toggleRow(c.id, Boolean(v))}
                      aria-label={`Select ${c.company_name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">{c.company_name}</p>
                      <p className="font-mono text-xs text-muted-foreground">NEQ {c.neq || "—"}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge
                          variant={
                            c.verification_status === "Verified"
                              ? "default"
                              : c.verification_status === "Invalid"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {c.verification_status}
                        </Badge>
                        {c.company_status ? (
                          <Badge variant={/dissol|radi|struck|inactive/i.test(c.company_status) ? "destructive" : "outline"}>
                            {c.company_status}
                          </Badge>
                        ) : null}
                        <Badge variant="outline">Score {c.confidence_score}/5</Badge>
                      </div>
                      <dl className="mt-3 space-y-1 text-xs">
                        <Field label="Executive" value={c.executive_name} />
                        <Field label="Title" value={c.title} />
                        <Field label="Email" value={c.found_email} mono />
                        <Field label="Phone" value={c.phone} />
                        <Field label="Address" value={c.address} />
                      </dl>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs">
                        {c.linkedin_url ? (
                          <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="underline">
                            LinkedIn
                          </a>
                        ) : null}
                        {c.facebook_url ? (
                          <a href={c.facebook_url} target="_blank" rel="noreferrer" className="underline">
                            Facebook
                          </a>
                        ) : null}
                        {c.registry_url ? (
                          <a href={c.registry_url} target="_blank" rel="noreferrer" className="underline">
                            Registry
                          </a>
                        ) : null}
                      </div>
                      <Button
                        className="mt-3"
                        variant="outline"
                        size="sm"
                        disabled={rechecking}
                        onClick={() => askRecheck([c.id])}
                      >
                        <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-check
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hidden overflow-x-auto rounded-md border border-border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allOnPageSelected}
                      onCheckedChange={(v) => togglePage(Boolean(v))}
                      aria-label="Select all rows on this page"
                    />
                  </TableHead>
                  <TableHead>NEQ</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Legal status</TableHead>
                  <TableHead>Executive</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Source trust</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Actions</TableHead>

                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={14} className="py-10 text-center text-sm text-muted-foreground">
                      No contacts yet. Run a batch to populate this table.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((c) => (
                    <TableRow key={c.id} data-state={selected.includes(c.id) ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={selected.includes(c.id)}
                          onCheckedChange={(v) => toggleRow(c.id, Boolean(v))}
                          aria-label={`Select ${c.company_name}`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.neq || "—"}</TableCell>
                      <TableCell className="max-w-56">
                        <span className="block break-words">{c.company_name}</span>
                      </TableCell>
                      <TableCell>
                        {c.company_status ? (
                          <Badge
                            variant={
                              /dissol|radi|struck|inactive/i.test(c.company_status)
                                ? "destructive"
                                : "outline"
                            }
                            className="whitespace-normal text-[10px] leading-tight"
                          >
                            {c.company_status}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>{c.executive_name || "—"}</TableCell>
                      <TableCell>{c.title || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.found_email || "—"}
                        {Array.isArray(c.verification_details?.alternate_emails) &&
                        c.verification_details.alternate_emails.length ? (
                          <details className="mt-1 font-sans">
                            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:underline">
                              +{c.verification_details.alternate_emails.length} other trusted email(s)
                            </summary>
                            <ul className="mt-1 space-y-1 font-mono text-[10px]">
                              {c.verification_details.alternate_emails.map(
                                (item: { email: string; status: string; confidence: number }) => (
                                  <li key={item.email} className="break-all">
                                    {item.email}{" "}
                                    <span className="font-sans text-muted-foreground">
                                      {item.status} · {item.confidence}/5
                                    </span>
                                  </li>
                                ),
                              )}
                            </ul>
                          </details>
                        ) : null}
                      </TableCell>
                      <TableCell>{c.phone || "—"}</TableCell>
                      <TableCell className="max-w-64 text-xs">
                        <span className="block break-words">{c.address || "—"}</span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          title={
                            Array.isArray(c.verification_details?.reasons)
                              ? c.verification_details.reasons.join(" • ")
                              : "No verification detail recorded"
                          }
                          variant={
                            c.verification_status === "Verified"
                              ? "default"
                              : c.verification_status === "Invalid"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {c.verification_status}
                        </Badge>
                        {c.email_type && c.email_type !== "unknown" ? (
                          <span className="mt-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
                            {c.email_type} mailbox
                          </span>
                        ) : null}
                        {Array.isArray(c.verification_details?.reasons) ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:underline">
                              why?
                            </summary>
                            <ul className="mt-1 max-w-56 list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
                              {c.verification_details.reasons.map((r: string) => (
                                <li key={r}>{r}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={c.confidence_score >= 3 ? "default" : "secondary"}>
                          {c.confidence_score ?? 0}/5
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {(() => {
                          const refs = referencesOf(c);
                          const score = sourceScoreOf(c);
                          if (!refs.length) return <span className="text-xs text-muted-foreground">—</span>;
                          return (
                            <details className="text-right">
                              <summary className="cursor-pointer list-none text-xs tabular-nums">
                                <Badge variant={score >= 70 ? "default" : "secondary"}>
                                  {score}/100
                                </Badge>
                                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                                  {scoreLabel(score)} · {refs.length} ref
                                </span>
                              </summary>
                              <ul className="mt-1 max-w-64 space-y-0.5 text-left text-[10px]">
                                {refs.slice(0, 8).map((r) => (
                                  <li key={r.url}>
                                    <a
                                      href={r.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="underline"
                                      title={r.url}
                                    >
                                      {r.host}
                                    </a>{" "}
                                    <span className="text-muted-foreground">{r.score}/100</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <span className="line-clamp-2 max-w-64">{c.discovery_source || "—"}</span>
                        <span className="mt-1 flex gap-2">
                          {c.linkedin_url ? (
                            <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="underline">
                              LinkedIn
                            </a>
                          ) : null}
                          {c.facebook_url ? (
                            <a title={c.facebook_url} href={c.facebook_url} target="_blank" rel="noreferrer" className="underline">
                              Facebook
                            </a>
                          ) : null}
                          {c.registry_url ? (
                            <a href={c.registry_url} target="_blank" rel="noreferrer" className="underline">
                              Registry
                            </a>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={rechecking}
                          onClick={() => askRecheck([c.id])}
                        >
                          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-check
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              {selected.length > 0 && ` · ${selected.length} selected`}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "all" ? "Delete all matching contacts?" : `Delete ${selected.length} contact(s)?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "all"
                ? `This permanently removes every contact matching the current filters (${total.toLocaleString()} rows).`
                : "This permanently removes the selected contacts."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void runDelete(confirm === "all" ? "all" : "selected");
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={recheck !== null} onOpenChange={(o) => !o && setRecheck(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {recheck && recheck.already_checked > 1
                ? `${recheck.already_checked} rows were already checked`
                : "This row was already checked"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Do you want to check again and replace the existing data with the new results? The previous
              result is deleted and the full OSINT pipeline runs from scratch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {recheck?.sample?.length ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-3 text-xs text-muted-foreground">
              {recheck.sample.map((s) => (
                <li key={`${s.neq}-${s.company_name}`} className="break-words">
                  <span className="text-foreground">{s.company_name}</span> · {s.verification_status} ·
                  checked {new Date(s.checked_at).toLocaleString()}
                </li>
              ))}
              {recheck.already_checked > recheck.sample.length ? (
                <li>+ {recheck.already_checked - recheck.sample.length} more…</li>
              ) : null}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rechecking}>Keep existing data</AlertDialogCancel>
            <AlertDialogAction
              disabled={rechecking}
              onClick={(e) => {
                e.preventDefault();
                void confirmRecheck();
              }}
            >
              {rechecking ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
                </>
              ) : (
                "Check again & replace"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SendEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        recipients={
          rows
            .filter((r) => selected.includes(r.id))
            .map((r) => ({
              email: r.email,
              company_name: r.company_name,
              contact_name: r.executive_name,
              title: r.title,
              phone: r.phone,
              city: r.city,
              domain: r.domain,
              job_id: r.job_id,
            })) as EmailRecipient[]
        }
      />
    </AppShell>
  );
}
