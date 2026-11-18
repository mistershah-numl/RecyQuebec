import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Database, FileSpreadsheet, ListChecks, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";


import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { bandFunnelStats, contactStats, dashboardSnapshot, dashboardStats } from "@/lib/jobs.functions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — RECYC Contact OSINT" },
      { name: "description", content: "Overview of enrichment batches, verified contacts and live progress." },
      { property: "og:title", content: "Dashboard — RECYC Contact OSINT" },
      { property: "og:description", content: "Track your REQ enrichment pipeline." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const fetchStats = useServerFn(dashboardStats);
  const fetchContactStats = useServerFn(contactStats);
  const fetchBandFunnel = useServerFn(bandFunnelStats);
  const fetchSnapshot = useServerFn(dashboardSnapshot);
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const { data } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => fetchStats(),
    refetchInterval: 5000,
  });
  const { data: stats } = useQuery({
    queryKey: ["contact-stats"],
    queryFn: () => fetchContactStats(),
    refetchInterval: 15000,
  });
  const { data: funnel } = useQuery({
    queryKey: ["band-funnel-stats"],
    queryFn: () => fetchBandFunnel(),
    refetchInterval: 15000,
  });

  async function saveSnapshot() {
    setSavingSnapshot(true);
    try {
      const snap = await fetchSnapshot();
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();

      const dashRows: Record<string, unknown>[] = [
        { Metric: "Snapshot taken at", Value: new Date(snap.generatedAt).toLocaleString() },
        { Metric: "Total contacts", Value: snap.totals.contacts },
        { Metric: "Contact found", Value: snap.totals.found },
        { Metric: "MX-Verified", Value: snap.totals.verified },
        { Metric: "High confidence (4–5)", Value: snap.totals.highConfidence },
        { Metric: "Batch jobs", Value: snap.totals.jobs },
        {},
        { Metric: "Employee-size funnel", Value: "" },
        {
          Metric: "Size Code / Group",
          "Total Records": "",
          "Contact Found": "",
          "MX-Verified": "",
          "High Confidence (4–5)": "",
        },
        ...snap.funnel.groups.map((g) => ({
          Metric: g.label,
          "Total Records": g.total,
          "Contact Found": g.found,
          "MX-Verified": g.mxVerified,
          "High Confidence (4–5)": g.highConfidence,
        })),
        {
          Metric: "Total",
          "Total Records": snap.funnel.totals.total,
          "Contact Found": snap.funnel.totals.found,
          "MX-Verified": snap.funnel.totals.mxVerified,
          "High Confidence (4–5)": snap.funnel.totals.highConfidence,
        },
        {},
        { Metric: "Code O vs all other codes", Value: "" },
        {
          Metric: "Code O (0 employees)",
          "Total Records": snap.funnel.oVsOthers.o.total,
          "Contact Found": snap.funnel.oVsOthers.o.found,
          "MX-Verified": snap.funnel.oVsOthers.o.mxVerified,
          "High Confidence (4–5)": snap.funnel.oVsOthers.o.highConfidence,
        },
        {
          Metric: "All other codes (A–H / Unknown)",
          "Total Records": snap.funnel.oVsOthers.others.total,
          "Contact Found": snap.funnel.oVsOthers.others.found,
          "MX-Verified": snap.funnel.oVsOthers.others.mxVerified,
          "High Confidence (4–5)": snap.funnel.oVsOthers.others.highConfidence,
        },
      ];
      const dashSheet = XLSX.utils.json_to_sheet(dashRows, { skipHeader: true });
      dashSheet["!cols"] = [{ wch: 34 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, dashSheet, "Dashboard");

      const contactsSheet = XLSX.utils.json_to_sheet(snap.contacts);
      contactsSheet["!cols"] = [
        { wch: 32 }, { wch: 12 }, { wch: 8 }, { wch: 24 }, { wch: 20 }, { wch: 28 },
        { wch: 16 }, { wch: 22 }, { wch: 30 }, { wch: 16 }, { wch: 10 }, { wch: 14 },
        { wch: 10 }, { wch: 14 }, { wch: 24 }, { wch: 20 },
      ];
      XLSX.utils.book_append_sheet(wb, contactsSheet, "All contacts");

      const stamp = snap.generatedAt.slice(0, 19).replace(/[:T]/g, "-");
      XLSX.writeFile(wb, `recyc-dashboard-snapshot-${stamp}.xlsx`);
      toast.success(`Snapshot saved — ${snap.contacts.length} contact(s) included.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the snapshot.");
    } finally {
      setSavingSnapshot(false);
    }
  }

  const cards = [
    { label: "Total contacts", value: data?.contacts ?? 0, icon: Database },
    { label: "MX verified", value: data?.verified ?? 0, icon: CheckCircle2 },
    { label: "Batch jobs", value: data?.jobs ?? 0, icon: ListChecks },
  ];

  return (
    <AppShell
      title="Dashboard"
      description="REQ contact enrichment pipeline"
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={saveSnapshot} disabled={savingSnapshot}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            {savingSnapshot ? "Preparing…" : "Excel snapshot"}
          </Button>
          <Button asChild>
            <Link to="/jobs">
              <Upload className="mr-2 h-4 w-4" /> New batch
            </Link>
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">{value.toLocaleString()}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Discovery performance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Details found", value: `${stats?.successRate ?? 0}%`, sub: `${stats?.found ?? 0} of ${stats?.total ?? 0} records` },
              { label: "Verified rate", value: `${stats?.verifiedRate ?? 0}%`, sub: `${stats?.verified ?? 0} deliverable` },
              { label: "High confidence (4-5)", value: stats?.strong ?? 0, sub: "strongly corroborated" },
              { label: "Nothing found", value: stats?.notFound ?? 0, sub: "no contact detail" },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { label: "Last 24 hours", total: stats?.day ?? 0, ok: stats?.dayVerified ?? 0 },
              { label: "Last 7 days", total: stats?.week ?? 0, ok: stats?.weekVerified ?? 0 },
              { label: "Last 30 days", total: stats?.month ?? 0, ok: stats?.monthVerified ?? 0 },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{s.total.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">
                  {s.ok.toLocaleString()} with details ·{" "}
                  {s.total ? Math.round((s.ok / s.total) * 100) : 0}% success
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="default">Active: {stats?.active ?? 0}</Badge>
            <Badge variant="destructive">Dissolved / struck off: {stats?.dissolved ?? 0}</Badge>
            <Badge variant="secondary">Status unknown: {stats?.unknownStatus ?? 0}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Results by employee-size code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Size Code / Group</th>
                  <th className="py-2 pr-4 text-right font-medium">Total Records</th>
                  <th className="py-2 pr-4 text-right font-medium">Contact Found</th>
                  <th className="py-2 pr-4 text-right font-medium">MX-Verified</th>
                  <th className="py-2 text-right font-medium">High Confidence (4–5)</th>
                </tr>
              </thead>
              <tbody>
                {(funnel?.groups ?? []).map((g) => (
                  <tr key={g.key} className="border-b border-border/60">
                    <td className="py-2 pr-4">{g.label}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{g.total.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{g.found.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{g.mxVerified.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{g.highConfidence.toLocaleString()}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-4">Total</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{(funnel?.totals.total ?? 0).toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{(funnel?.totals.found ?? 0).toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{(funnel?.totals.mxVerified ?? 0).toLocaleString()}</td>
                  <td className="py-2 text-right tabular-nums">{(funnel?.totals.highConfidence ?? 0).toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Code O vs all other codes</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { label: "Code O (0 employees)", b: funnel?.oVsOthers.o },
                { label: "All other codes (A–H / Unknown)", b: funnel?.oVsOthers.others },
              ].map(({ label, b }) => (
                <div key={label} className="rounded-lg border border-border p-4">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{(b?.total ?? 0).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">
                    {(b?.found ?? 0).toLocaleString()} found · {(b?.mxVerified ?? 0).toLocaleString()} MX-verified ·{" "}
                    {(b?.highConfidence ?? 0).toLocaleString()} high confidence
                  </p>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Records processed — last 14 days</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats?.daily ?? []} margin={{ left: -20, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gFound" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-2, var(--primary)))" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(var(--chart-2, var(--primary)))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="total" name="Processed" stroke="hsl(var(--primary))" fill="url(#gTotal)" strokeWidth={2} />
                <Area type="monotone" dataKey="found" name="Details found" stroke="hsl(var(--chart-2, var(--primary)))" fill="url(#gFound)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Confidence distribution (0–5)</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.confidence ?? []} margin={{ left: -20, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="score" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                />
                <Bar dataKey="count" name="Contacts" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Verification outcome mix</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart layout="vertical" data={stats?.statuses ?? []} margin={{ left: 24, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={110} stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                />
                <Bar dataKey="count" name="Contacts" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>


      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Active batches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(data?.active ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No running batches. Upload a REQ file to start enrichment.
            </p>
          ) : (
            data!.active.map((job: any) => {
              const pct = job.total_rows ? Math.round((job.processed_rows / job.total_rows) * 100) : 0;
              return (
                <Link key={job.id} to="/jobs/$jobId" params={{ jobId: job.id }} className="block">
                  <div className="rounded-lg border border-border p-4 transition-colors hover:bg-accent/40">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium">{job.name}</span>
                      <Badge variant={job.status === "running" ? "default" : "secondary"}>{job.status}</Badge>
                    </div>
                    <Progress value={pct} />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {job.processed_rows}/{job.total_rows} rows · {pct}% · {job.valid_emails} verified
                    </p>
                  </div>
                </Link>
              );
            })
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
