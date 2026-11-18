import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Database, Download, FileSpreadsheet, Mail, MailCheck, MailX, Plus, Search, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { SendEmailDialog, type EmailRecipient } from "@/components/SendEmailDialog";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  addCrmContacts,
  deleteCrmContacts,
  listCrmBatches,
  listCrmContacts,
} from "@/lib/outreach.functions";
import Papa from "papaparse";
import * as XLSX from "xlsx";

/** Reads a CSV / Excel file into plain records. */
async function readRecords(file: File): Promise<Record<string, unknown>[]> {
  if (/\.xlsx?$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0] as string];
    return sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }) : [];
  }
  const text = await file.text();
  return Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true }).data ?? [];
}

/** Case-insensitive lookup across the record's original headers. */
function pick(record: Record<string, unknown>, names: string[]): string | null {
  for (const [k, v] of Object.entries(record)) {
    if (names.some((n) => k.trim().toLowerCase() === n)) {
      const s = String(v ?? "").trim();
      if (s) return s;
    }
  }
  return null;
}

/** Minimal "was this contact emailed" indicator — full history lives on the Outreach page. */
function SentMark({ status, at }: { status?: string | null; at?: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">Not sent</span>;
  const failed = status === "failed";
  return (
    <span
      title={at ? new Date(at).toLocaleString() : undefined}
      className={`inline-flex items-center gap-1 text-xs ${failed ? "text-destructive" : "text-primary"}`}
    >
      {failed ? <MailX className="h-3.5 w-3.5" /> : <MailCheck className="h-3.5 w-3.5" />}
      {failed ? "Failed" : "Sent"}
    </span>
  );
}

export const Route = createFileRoute("/_authenticated/database/")({
  head: () => ({
    meta: [
      { title: "Contact Database — RECYC Contact OSINT" },
      {
        name: "description",
        content: "Your curated outreach database: saved leads from batches, manual entries and CSV imports.",
      },
      { property: "og:title", content: "Contact Database — RECYC Contact OSINT" },
      { property: "og:description", content: "Curate, import and email your verified business contacts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DatabasePage,
});

const PAGE_SIZE = 25;

/** Columns the importer understands — also used for the downloadable template. */
const TEMPLATE_HEADERS = [
  "Company Name",
  "Contact Name",
  "Title",
  "Email",
  "Phone",
  "City",
  "NEQ",
  "Notes",
];

function DatabasePage() {
  const fetchContacts = useServerFn(listCrmContacts);
  const fetchBatches = useServerFn(listCrmBatches);
  const addContacts = useServerFn(addCrmContacts);
  const removeContacts = useServerFn(deleteCrmContacts);
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<null | { kind: "selected" } | { kind: "batch"; jobId: string | null; name: string; count: number }>(null);
  const [busy, setBusy] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [manual, setManual] = useState({ company_name: "", contact_name: "", title: "", email: "", phone: "", city: "" });

  const { data } = useQuery({
    queryKey: ["crm", search, jobFilter, page],
    queryFn: () =>
      fetchContacts({ data: { search, job_id: jobFilter, limit: PAGE_SIZE, offset: page * PAGE_SIZE } }),
  });
  const { data: batches } = useQuery({ queryKey: ["crm-batches"], queryFn: () => fetchBatches() });

  const rows: any[] = data?.rows ?? [];
  const total = data?.count ?? 0;
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  async function refresh() {
    setSelected([]);
    await queryClient.invalidateQueries({ queryKey: ["crm"] });
    await queryClient.invalidateQueries({ queryKey: ["crm-batches"] });
  }

  async function addManual() {
    if (!manual.company_name.trim()) {
      toast.error("Company name is required.");
      return;
    }
    setBusy(true);
    try {
      const res: any = await addContacts({ data: { contacts: [manual], source: "manual" } });
      toast.success(res.inserted ? "Contact added." : "That email is already in your database.");
      setManual({ company_name: "", contact_name: "", title: "", email: "", phone: "", city: "" });
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    try {
      const records = await readRecords(file);
      const contacts = records
        .map((rec) => ({
          company_name: pick(rec, ["company name", "company", "nom", "entreprise", "nom de l'entreprise"]) ?? "",
          neq: pick(rec, ["neq"]),
          city: pick(rec, ["city", "ville"]),
          email: pick(rec, ["email", "courriel", "e-mail"]),
          phone: pick(rec, ["phone", "telephone", "téléphone", "tel"]),
          contact_name: pick(rec, ["contact name", "name", "contact", "executive name"]),
          title: pick(rec, ["title", "titre", "poste"]),
          extra: rec as Record<string, unknown>,
        }))
        .filter((c) => c.company_name);
      if (!contacts.length) throw new Error("No rows with a company name were found in that file.");
      const res: any = await addContacts({ data: { contacts, source: "import" } });
      toast.success(`${res.inserted} contact(s) imported${res.skipped ? `, ${res.skipped} duplicate(s) skipped` : ""}.`);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function downloadFile(name: string, csv: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadTemplate() {
    const csv = Papa.unparse({
      fields: TEMPLATE_HEADERS,
      data: [
        ["Recyc Metal Inc.", "Marie Tremblay", "Directrice", "marie@recycmetal.ca", "514-555-0134", "Montréal", "1234567890", "Met at trade show"],
      ],
    });
    downloadFile("contact-import-template.csv", csv);
  }

  async function exportContacts() {
    setBusy(true);
    try {
      const res: any = await fetchContacts({ data: { search, job_id: jobFilter, limit: 10000, offset: 0 } });
      const all: any[] = res?.rows ?? [];
      if (!all.length) throw new Error("There are no contacts to export.");
      const csv = Papa.unparse(
        all.map((r) => ({
          "Company Name": r.company_name ?? "",
          "Contact Name": r.contact_name ?? "",
          Title: r.title ?? "",
          Email: r.email ?? "",
          Phone: r.phone ?? "",
          City: r.city ?? "",
          NEQ: r.neq ?? "",
          Domain: r.domain ?? "",
          Notes: r.notes ?? "",
          Source: r.source ?? "",
          "Email Sent": r.last_send_status ?? "not sent",
          "Last Sent At": r.last_sent_at ? new Date(r.last_sent_at).toISOString() : "",
          "Added At": r.created_at ? new Date(r.created_at).toISOString() : "",
        })),
      );
      downloadFile(`contacts-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      toast.success(`${all.length} contact(s) exported.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runDelete() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "selected") await removeContacts({ data: { ids: selected } });
      else await removeContacts({ data: { job_id: confirm.jobId } });
      toast.success("Contacts removed from your database.");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const recipients: EmailRecipient[] = rows
    .filter((r) => selected.includes(r.id))
    .map((r) => ({
      email: r.email,
      company_name: r.company_name,
      contact_name: r.contact_name,
      title: r.title,
      phone: r.phone,
      city: r.city,
      domain: r.domain,
      crm_contact_id: r.id,
      job_id: r.source_job_id,
    }));

  return (
    <AppShell
      title="Contact Database"
      description={`${total.toLocaleString()} saved contacts`}
      actions={
        <div className="flex flex-wrap gap-2">
          {selected.length > 0 ? (
            <>
              <Button onClick={() => setEmailOpen(true)}>
                <Mail className="mr-2 h-4 w-4" /> Email {selected.length}
              </Button>
              <Button variant="destructive" onClick={() => setConfirm({ kind: "selected" })}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete {selected.length}
              </Button>
            </>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" /> Import
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void exportContacts()}>
            <Download className="mr-2 h-4 w-4" /> Export
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add contacts</CardTitle>
            <CardDescription>
              Type a contact by hand or import a CSV / Excel file. Duplicate email addresses are skipped
              automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="manual">
              <TabsList>
                <TabsTrigger value="manual">Enter manually</TabsTrigger>
                <TabsTrigger value="import">Import file</TabsTrigger>
              </TabsList>
              <TabsContent value="manual" className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {([
                    ["company_name", "Company name *"],
                    ["contact_name", "Contact name"],
                    ["title", "Title"],
                    ["email", "Email"],
                    ["phone", "Phone"],
                    ["city", "City"],
                  ] as const).map(([key, label]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`m_${key}`}>{label}</Label>
                      <Input
                        id={`m_${key}`}
                        value={(manual as any)[key]}
                        maxLength={200}
                        onChange={(e) => setManual((m) => ({ ...m, [key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <Button onClick={addManual} disabled={busy}>
                  <Plus className="mr-2 h-4 w-4" /> Add to database
                </Button>
              </TabsContent>
              <TabsContent value="import" className="mt-4 space-y-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importFile(f);
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                    <Upload className="mr-2 h-4 w-4" /> Choose CSV / Excel file
                  </Button>
                  <Button variant="secondary" onClick={downloadTemplate}>
                    <FileSpreadsheet className="mr-2 h-4 w-4" /> Download template
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void exportContacts()}>
                    <Download className="mr-2 h-4 w-4" /> Export contacts
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Start from the template: {TEMPLATE_HEADERS.join(", ")}. Company name is required; every other
                  column you keep in the file is stored alongside the contact. Export downloads the contacts
                  matching your current search / batch filter.
                </p>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {batches?.batches?.length ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Batch tables</CardTitle>
              <CardDescription>Contacts grouped by the execution batch they came from.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {batches.batches.map((b: any) => (
                <div
                  key={b.job_id ?? "manual"}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{b.name}</p>
                    <p className="text-xs text-muted-foreground">{b.count} contact(s)</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={jobFilter === b.job_id ? "default" : "outline"}
                      onClick={() => {
                        setPage(0);
                        setJobFilter(jobFilter === b.job_id ? null : b.job_id);
                      }}
                    >
                      {jobFilter === b.job_id ? "Clear filter" : "View"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setConfirm({ kind: "batch", jobId: b.job_id, name: b.name, count: b.count })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search company, contact or email…"
                value={search}
                onChange={(e) => {
                  setPage(0);
                  setSearch(e.target.value);
                }}
                maxLength={120}
              />
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  <Database className="mx-auto mb-2 h-6 w-6" />
                  No saved contacts yet.
                </p>
              ) : (
                rows.map((c) => (
                  <div key={c.id} className="flex gap-3 rounded-lg border border-border p-4">
                    <Checkbox
                      checked={selected.includes(c.id)}
                      onCheckedChange={(v) =>
                        setSelected((p) => (v ? [...new Set([...p, c.id])] : p.filter((x) => x !== c.id)))
                      }
                      aria-label={`Select ${c.company_name}`}
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="break-words font-medium">{c.company_name}</p>
                      <p className="text-muted-foreground">{c.contact_name || "—"}</p>
                      <p className="break-all font-mono text-xs">{c.email || "no email"}</p>
                      <p className="text-xs text-muted-foreground">{c.phone || ""}</p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) => {
                          const ids = rows.map((r) => r.id);
                          setSelected((p) => (v ? [...new Set([...p, ...ids])] : p.filter((x) => !ids.includes(x))));
                        }}
                        aria-label="Select page"
                      />
                    </TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead>Email sent</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                        No saved contacts yet. Add them from Verified Contacts, manually, or by import.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          <Checkbox
                            checked={selected.includes(c.id)}
                            onCheckedChange={(v) =>
                              setSelected((p) => (v ? [...new Set([...p, c.id])] : p.filter((x) => x !== c.id)))
                            }
                            aria-label={`Select ${c.company_name}`}
                          />
                        </TableCell>
                        <TableCell className="max-w-56 break-words">{c.company_name}</TableCell>
                        <TableCell>{c.contact_name || "—"}</TableCell>
                        <TableCell>{c.title || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{c.email || "—"}</TableCell>
                        <TableCell>{c.phone || "—"}</TableCell>
                        <TableCell>{c.city || "—"}</TableCell>
                        <TableCell>
                          <SentMark status={c.last_send_status} at={c.last_sent_at} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{c.source || "—"}</TableCell>
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
      </div>

      <SendEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        recipients={recipients}
        onSent={() => {
          void queryClient.invalidateQueries({ queryKey: ["email-sends"] });
          void queryClient.invalidateQueries({ queryKey: ["crm"] });
        }}
      />

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "batch"
                ? `Delete the “${confirm.name}” batch contacts?`
                : `Delete ${selected.length} contact(s)?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "batch"
                ? `This removes ${confirm.count} contact(s) that came from this execution batch from your main contact database. The batch's enrichment results stay on the Verified Contacts page.`
                : "This permanently removes the selected contacts from your database."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void runDelete();
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
