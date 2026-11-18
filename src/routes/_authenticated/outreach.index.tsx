import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Mail, Plus, Save, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { deleteTemplate, listEmailSends, listTemplates, saveTemplate } from "@/lib/outreach.functions";
import { DEFAULT_TEMPLATE, MERGE_FIELDS } from "@/lib/template";

export const Route = createFileRoute("/_authenticated/outreach/")({
  head: () => ({
    meta: [
      { title: "Outreach — RECYC Contact OSINT" },
      { name: "description", content: "Email templates and the full delivery history of your outreach campaigns." },
      { property: "og:title", content: "Outreach — RECYC Contact OSINT" },
      { property: "og:description", content: "Manage mass-email templates and review every sent or failed message." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OutreachPage,
});

const PAGE_SIZE = 25;

function OutreachPage() {
  const fetchTemplates = useServerFn(listTemplates);
  const persistTemplate = useServerFn(saveTemplate);
  const removeTemplate = useServerFn(deleteTemplate);
  const fetchSends = useServerFn(listEmailSends);
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<{ id: string | null; name: string; subject: string; body: string }>({
    id: null,
    ...DEFAULT_TEMPLATE,
  });
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<any | null>(null);

  const { data: templates } = useQuery({ queryKey: ["email-templates"], queryFn: () => fetchTemplates() });
  const { data: sends } = useQuery({
    queryKey: ["email-sends", search, status, page],
    queryFn: () => fetchSends({ data: { search, status, limit: PAGE_SIZE, offset: page * PAGE_SIZE } }),
  });

  const rows: any[] = sends?.rows ?? [];
  const total = sends?.count ?? 0;

  async function onSaveTemplate() {
    setSaving(true);
    try {
      await persistTemplate({ data: editing });
      toast.success("Template saved.");
      setEditing({ id: null, ...DEFAULT_TEMPLATE });
      await queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell title="Outreach" description="Templates and email delivery history">
      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">Email history</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-wrap gap-3">
                <div className="relative min-w-56 flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search recipient, company or subject…"
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
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Mobile list */}
              <div className="space-y-3 md:hidden">
                {rows.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    <Mail className="mx-auto mb-2 h-6 w-6" />
                    No emails sent yet.
                  </p>
                ) : (
                  rows.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setDetail(r)}
                      className="w-full rounded-lg border border-border p-4 text-left"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 break-words text-sm font-medium">{r.company_name || r.to_email}</p>
                        <Badge variant={r.status === "sent" ? "default" : "destructive"}>{r.status}</Badge>
                      </div>
                      <p className="break-all font-mono text-xs text-muted-foreground">{r.to_email}</p>
                      <p className="mt-1 break-words text-xs">{r.subject}</p>
                      <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</p>
                    </button>
                  ))
                )}
              </div>

              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Sent at</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                          No emails sent yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((r) => (
                        <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                          <TableCell className="max-w-56 break-words">{r.company_name || "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{r.to_email}</TableCell>
                          <TableCell className="max-w-72 break-words">{r.subject}</TableCell>
                          <TableCell>
                            <Badge variant={r.status === "sent" ? "default" : "destructive"}>{r.status}</Badge>
                            {r.dry_run ? (
                              <span className="ml-1 text-[10px] uppercase text-muted-foreground">test</span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(r.created_at).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))} · {total.toLocaleString()} email(s)
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
        </TabsContent>

        <TabsContent value="templates" className="mt-4">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{editing.id ? "Edit template" : "New template"}</CardTitle>
                <CardDescription>
                  Merge fields: {MERGE_FIELDS.map((f) => `{{${f}}}`).join(" · ")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="t_name">Template name</Label>
                  <Input
                    id="t_name"
                    value={editing.name}
                    maxLength={120}
                    onChange={(e) => setEditing((t) => ({ ...t, name: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="t_subject">Subject</Label>
                  <Input
                    id="t_subject"
                    value={editing.subject}
                    maxLength={300}
                    onChange={(e) => setEditing((t) => ({ ...t, subject: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="t_body">Body</Label>
                  <Textarea
                    id="t_body"
                    rows={12}
                    value={editing.body}
                    onChange={(e) => setEditing((t) => ({ ...t, body: e.target.value }))}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={onSaveTemplate} disabled={saving}>
                    <Save className="mr-2 h-4 w-4" /> {saving ? "Saving…" : "Save template"}
                  </Button>
                  {editing.id ? (
                    <Button variant="outline" onClick={() => setEditing({ id: null, ...DEFAULT_TEMPLATE })}>
                      <Plus className="mr-2 h-4 w-4" /> New
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Saved templates</CardTitle>
                <CardDescription>Pick one when composing a mass email.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {(templates?.rows ?? []).length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No templates yet.</p>
                ) : (
                  (templates?.rows ?? []).map((t: any) => (
                    <div
                      key={t.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">{t.name}</p>
                        <p className="break-words text-xs text-muted-foreground">{t.subject}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditing({ id: t.id, name: t.name, subject: t.subject, body: t.body })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={async () => {
                            await removeTemplate({ data: { id: t.id } });
                            await queryClient.invalidateQueries({ queryKey: ["email-templates"] });
                            toast.success("Template deleted.");
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words">{detail?.subject}</DialogTitle>
            <DialogDescription>
              {detail ? new Date(detail.created_at).toLocaleString() : ""} ·{" "}
              {detail?.dry_run ? "test mode" : "live send"}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-3 text-sm">
              <dl className="grid gap-1">
                {[
                  ["Company", detail.company_name],
                  ["Contact", detail.contact_name],
                  ["To", detail.to_email],
                  ["From", detail.from_name ? `${detail.from_name} <${detail.from_email}>` : detail.from_email],
                  ["Reply-to", detail.reply_to],
                  ["Status", detail.status],
                  ["Error", detail.error],
                ].map(([k, v]) => (
                  <div key={String(k)} className="flex gap-2">
                    <dt className="w-24 shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 flex-1 break-words">{(v as string) || "—"}</dd>
                  </div>
                ))}
              </dl>
              <div className="whitespace-pre-wrap break-words rounded-lg border border-border p-3">
                {detail.body}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
