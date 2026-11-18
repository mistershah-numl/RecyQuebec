import { formatDuration, parseDurationToSeconds } from "@/lib/duration";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getSettings, saveSettings, testWorker } from "@/lib/jobs.functions";
import { getEmailSettings, saveSmtpSettings, testAiKey, testSmtp } from "@/lib/outreach.functions";
import {
  deleteAiService,
  fetchServiceModels,
  listAiServices,
  saveAiService,
} from "@/lib/ai-services.functions";
import { availableModels, type SavedAiService } from "@/lib/req";

export const Route = createFileRoute("/_authenticated/settings/")({
  head: () => ({
    meta: [
      { title: "API Settings — RECYC Contact OSINT" },
      { name: "description", content: "Manage LLM provider keys, default model and enrichment throughput." },
      { property: "og:title", content: "API Settings — RECYC Contact OSINT" },
      { property: "og:description", content: "Configure Gemini, Perplexity, OpenAI and Anthropic keys." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

const KEYS = [
  ["gemini_key", "Google Gemini API key", "Primary enrichment provider"],
  ["perplexity_key", "Perplexity API key", "Used as fallback when Gemini finds nothing"],
  ["openai_key", "OpenAI API key", "Optional"],
  ["anthropic_key", "Anthropic API key", "Optional"],
] as const;

function SettingsPage() {
  const fetchSettings = useServerFn(getSettings);
  const save = useServerFn(saveSettings);
  const probe = useServerFn(testWorker);
  const { data, refetch } = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });

  const [form, setForm] = useState<Record<string, string>>({});
  const [model, setModel] = useState("google/gemini-3.6-flash");
  const [saving, setSaving] = useState(false);
  const [workerUrl, setWorkerUrl] = useState("");
  const [rowTimeout, setRowTimeout] = useState("2m");
  const [batchSize, setBatchSize] = useState("");
  // ---- Saved AI services (any OpenAI-compatible API) ----
  const listServices = useServerFn(listAiServices);
  const loadModels = useServerFn(fetchServiceModels);
  const storeService = useServerFn(saveAiService);
  const removeService = useServerFn(deleteAiService);
  const { data: servicesData, refetch: refetchServices } = useQuery({
    queryKey: ["ai-services"],
    queryFn: () => listServices(),
  });
  const services = (servicesData ?? []) as SavedAiService[];
  const [svcForm, setSvcForm] = useState<{ id: string | null; name: string; base_url: string; api_key: string }>({
    id: null,
    name: "",
    base_url: "https://api.mammouth.ai/v1",
    api_key: "",
  });
  const [svcModels, setSvcModels] = useState<string[]>([]);
  const [svcPicked, setSvcPicked] = useState<string[]>([]);
  const [svcBusy, setSvcBusy] = useState<"load" | "test" | "save" | null>(null);
  const [svcMsg, setSvcMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const rowTimeoutSeconds = parseDurationToSeconds(rowTimeout);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [emailDomain, setEmailDomain] = useState("");
  const [emailLocal, setEmailLocal] = useState("");
  const [emailName, setEmailName] = useState("");
  const [emailReplyTo, setEmailReplyTo] = useState("");
  const [emailCap, setEmailCap] = useState("");
  const [emailThrottle, setEmailThrottle] = useState("");
  const [emailDryRun, setEmailDryRun] = useState(true);
  const [savingEmail, setSavingEmail] = useState(false);

  // ---- SMTP delivery ----
  const fetchEmailSettings = useServerFn(getEmailSettings);
  const saveSmtp = useServerFn(saveSmtpSettings);
  const probeSmtp = useServerFn(testSmtp);
  const probeKey = useServerFn(testAiKey);
  const { data: emailSettings, refetch: refetchEmail } = useQuery({
    queryKey: ["email-settings"],
    queryFn: () => fetchEmailSettings(),
  });
  const [smtp, setSmtp] = useState({
    smtp_host: "",
    smtp_port: "",
    smtp_user: "",
    smtp_password: "",
    smtp_secure: "starttls",
    smtp_from_email: "",
  });
  const [smtpBusy, setSmtpBusy] = useState<"save" | "test" | null>(null);
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [keyResult, setKeyResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [keyTesting, setKeyTesting] = useState<string | null>(null);

  useEffect(() => {
    if (!emailSettings) return;
    const e = emailSettings as any;
    setSmtp({
      smtp_host: e.smtp_host ?? "",
      smtp_port: e.smtp_port ? String(e.smtp_port) : "",
      smtp_user: e.smtp_user ?? "",
      smtp_password: "",
      smtp_secure: e.smtp_secure ?? "starttls",
      smtp_from_email: e.smtp_from_email ?? "",
    });
  }, [emailSettings]);

  async function onSaveSmtp() {
    setSmtpBusy("save");
    try {
      await saveSmtp({ data: { ...smtp } });
      setSmtp((s) => ({ ...s, smtp_password: "" }));
      await refetchEmail();
      toast.success("SMTP settings saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSmtpBusy(null);
    }
  }

  async function onTestSmtp() {
    setSmtpBusy("test");
    setSmtpResult(null);
    try {
      await saveSmtp({ data: { ...smtp } });
      setSmtp((s) => ({ ...s, smtp_password: "" }));
      const res = (await probeSmtp()) as { ok: boolean; message: string };
      setSmtpResult(res);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      await refetchEmail();
    } catch (e) {
      setSmtpResult({ ok: false, message: (e as Error).message });
    } finally {
      setSmtpBusy(null);
    }
  }

  async function onTestKey(provider: string) {
    setKeyTesting(provider);
    try {
      const res = (await probeKey({ data: { provider, key: form[provider] ?? null } })) as {
        ok: boolean;
        message: string;
      };
      setKeyResult((r) => ({ ...r, [provider]: res }));
      if (res.ok) {
        // A working key is worth keeping — persist it right away.
        if (form[provider]?.trim()) {
          await save({ data: { [provider]: form[provider] as string } });
          setForm((f) => ({ ...f, [provider]: "" }));
          await refetch();
        }
        toast.success(`${res.message} Saved.`);
      } else {
        toast.error(res.message);
      }
    } catch (e) {
      setKeyResult((r) => ({ ...r, [provider]: { ok: false, message: (e as Error).message } }));
    } finally {
      setKeyTesting(null);
    }
  }

  async function onLoadServiceModels(mode: "load" | "test") {
    setSvcBusy(mode);
    setSvcMsg(null);
    try {
      const res = (await loadModels({
        data: { id: svcForm.id, base_url: svcForm.base_url, api_key: svcForm.api_key || null },
      })) as { ok: boolean; message: string; models: string[] };
      setSvcMsg(res);
      if (res.ok) {
        setSvcModels(res.models);
        toast.success(res.message);
      } else toast.error(res.message);
    } catch (e) {
      setSvcMsg({ ok: false, message: (e as Error).message });
    } finally {
      setSvcBusy(null);
    }
  }

  function resetServiceForm() {
    setSvcForm({ id: null, name: "", base_url: "https://api.mammouth.ai/v1", api_key: "" });
    setSvcModels([]);
    setSvcPicked([]);
    setSvcMsg(null);
  }

  async function onSaveService() {
    setSvcBusy("save");
    try {
      await storeService({
        data: {
          id: svcForm.id,
          name: svcForm.name,
          base_url: svcForm.base_url,
          api_key: svcForm.api_key || null,
          models: svcPicked,
        },
      });
      await refetchServices();
      resetServiceForm();
      toast.success("AI service saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSvcBusy(null);
    }
  }

  function onEditService(svc: SavedAiService) {
    setSvcForm({ id: svc.id, name: svc.name, base_url: svc.base_url, api_key: "" });
    setSvcModels(svc.models ?? []);
    setSvcPicked(svc.models ?? []);
    setSvcMsg(null);
  }

  async function onDeleteService(id: string) {
    try {
      await removeService({ data: { id } });
      await refetchServices();
      if (svcForm.id === id) resetServiceForm();
      toast.success("AI service removed.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  useEffect(() => {
    if (!data) return;
    const s = data as any;
    setModel(s.default_model ?? "google/gemini-3.6-flash");
    setWorkerUrl(s.osint_worker_url ?? "");
    setRowTimeout(formatDuration(Number(s.row_timeout_seconds ?? 120)));
    setBatchSize(s.batch_size ? String(s.batch_size) : "");
    setEmailDomain(s.email_sender_domain ?? "");
    setEmailLocal(s.email_from_local ?? "");
    setEmailName(s.email_sender_name ?? "");
    setEmailReplyTo(s.email_reply_to ?? "");
    setEmailCap(s.email_daily_cap ? String(s.email_daily_cap) : "");
    setEmailThrottle(
      s.email_throttle_seconds === null || s.email_throttle_seconds === undefined ? "" : String(s.email_throttle_seconds),
    );
    setEmailDryRun(s.email_dry_run ?? true);
  }, [data]);


  async function onSaveEmail() {
    setSavingEmail(true);
    try {
      await save({
        data: {
          email_sender_domain: emailDomain.trim() || null,
          email_from_local: emailLocal.trim() || null,
          email_sender_name: emailName.trim() || null,
          email_reply_to: emailReplyTo.trim() || null,
          email_daily_cap: emailCap.trim() || null,
          email_throttle_seconds: emailThrottle.trim() || null,
          email_dry_run: emailDryRun ? "true" : "false",
        },
      });
      await refetch();
      toast.success("Email settings saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingEmail(false);
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await save({ data: { ...form, default_model: model, osint_worker_url: workerUrl, row_timeout_seconds: rowTimeout, batch_size: batchSize.trim() || null } });
      setForm({});
      await refetch();
      toast.success("Settings saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    try {
      // persist first so the pipeline uses exactly what we test
      await save({ data: { ...form, default_model: model, osint_worker_url: workerUrl, row_timeout_seconds: rowTimeout, batch_size: batchSize.trim() || null } });
      const res = (await probe({
        data: { url: workerUrl, secret: form["osint_worker_secret"] ?? null },
      })) as { ok: boolean; message: string };
      setTestResult(res);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const s = (data ?? {}) as any;


  return (
    <AppShell title="API Settings" description="Provider keys and enrichment defaults">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Provider keys</CardTitle>
            <CardDescription>
              Stored securely and never shown again after saving. Leave blank to keep the existing key.
              With no key configured, enrichment falls back to the default Gemini AI models.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {KEYS.map(([key, label, hint]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key}>{label}</Label>
                <Input
                  id={key}
                  type="password"
                  autoComplete="off"
                  placeholder={s[key] ?? "Not set"}
                  value={form[key] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  maxLength={300}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={keyTesting === key}
                    onClick={() => void onTestKey(key)}
                  >
                    {keyTesting === key ? "Testing…" : "Test connection"}
                  </Button>
                  {keyResult[key] ? (
                    <span className={`text-xs ${keyResult[key]!.ok ? "text-primary" : "text-destructive"}`}>
                      {keyResult[key]!.message}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI services (OpenAI-compatible)</CardTitle>
            <CardDescription>
              Save as many services as you like (Mammouth AI, OpenRouter, a local server…). Paste the address and
              key, load the model list, tick the models you want, then save. They all appear when you start a batch.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {services.length ? (
              <div className="space-y-2">
                {services.map((svc) => (
                  <div
                    key={svc.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{svc.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {svc.base_url} · {(svc.models ?? []).length} model(s): {(svc.models ?? []).join(", ")}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => onEditService(svc)}>
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void onDeleteService(svc.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No service saved yet.</p>
            )}

            <div className="space-y-4 rounded-md border p-4">
              <p className="text-sm font-medium">{svcForm.id ? "Edit service" : "Add a service"}</p>
              <div className="space-y-2">
                <Label htmlFor="svc_name">Name</Label>
                <Input
                  id="svc_name"
                  placeholder="Mammouth AI"
                  value={svcForm.name}
                  onChange={(e) => setSvcForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={80}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="svc_url">Service address</Label>
                <Input
                  id="svc_url"
                  placeholder="https://api.mammouth.ai/v1"
                  value={svcForm.base_url}
                  onChange={(e) => setSvcForm((f) => ({ ...f, base_url: e.target.value }))}
                  maxLength={300}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="svc_key">Service key</Label>
                <Input
                  id="svc_key"
                  type="password"
                  autoComplete="off"
                  placeholder={svcForm.id ? "Saved — leave blank to keep it" : "sk-…"}
                  value={svcForm.api_key}
                  onChange={(e) => setSvcForm((f) => ({ ...f, api_key: e.target.value }))}
                  maxLength={300}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={svcBusy !== null}
                  onClick={() => void onLoadServiceModels("load")}
                >
                  {svcBusy === "load" ? "Loading…" : "Load models"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={svcBusy !== null}
                  onClick={() => void onLoadServiceModels("test")}
                >
                  {svcBusy === "test" ? "Testing…" : "Test connection"}
                </Button>
                {svcMsg ? (
                  <span className={`text-xs ${svcMsg.ok ? "text-primary" : "text-destructive"}`}>
                    {svcMsg.message}
                  </span>
                ) : null}
              </div>

              {svcModels.length ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Models to use ({svcPicked.length} selected)</Label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSvcPicked(svcPicked.length === svcModels.length ? [] : [...svcModels])}
                    >
                      {svcPicked.length === svcModels.length ? "Clear all" : "Select all"}
                    </Button>
                  </div>
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                    {svcModels.map((m) => (
                      <label key={m} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={svcPicked.includes(m)}
                          onChange={(e) =>
                            setSvcPicked((p) => (e.target.checked ? [...p, m] : p.filter((x) => x !== m)))
                          }
                        />
                        <span className="truncate">{m}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={svcBusy !== null || svcPicked.length === 0}
                  onClick={() => void onSaveService()}
                >
                  {svcBusy === "save" ? "Saving…" : svcForm.id ? "Save changes" : "Save service"}
                </Button>
                {svcForm.id || svcModels.length ? (
                  <Button type="button" size="sm" variant="ghost" onClick={resetServiceForm}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>


        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enrichment defaults</CardTitle>
            <CardDescription>Applied to new batch jobs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Default model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableModels(s as Record<string, unknown>, services).map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="row_timeout">Time allowed per company</Label>
              <Input
                id="row_timeout"
                type="text"
                inputMode="text"
                placeholder="2m"
                value={rowTimeout}
                onChange={(e) => setRowTimeout(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {rowTimeoutSeconds
                  ? `= ${formatDuration(rowTimeoutSeconds)} before a slow company is re-queued automatically.`
                  : 'Enter a duration like "120s", "2m", "1h 30m" or "2:30".'}{" "}
                Accepts seconds, minutes and hours. Range: 30s–1h; recommended: 2m (use 5m when the worker also renders
                heavy JavaScript sites).
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="batch_size">Rows processed at once</Label>
              <Input
                id="batch_size"
                type="number"
                min={1}
                max={25}
                placeholder="Automatic (system default: 2)"
                value={batchSize}
                onChange={(e) => setBatchSize(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {batchSize.trim()
                  ? `${batchSize.trim()} companies will be researched in parallel per pass.`
                  : "Leave empty to let the system choose (currently 2 at a time)."}{" "}
                Range: 1–25. Higher values finish large CSVs faster but need a stronger worker machine (keep it at or
                below your worker's MAX_BROWSER_PAGES).
              </p>
            </div>
            <Button onClick={onSave} disabled={saving} className="w-full">
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">OSINT render worker (Playwright / Scrapy)</CardTitle>
            <CardDescription>
              Optional. Paste the public URL of your own worker that exposes <code>POST /render</code>.
              Every page load in the pipeline then goes through it, so JavaScript-rendered and
              bot-protected pages become readable. Leave empty to use plain HTTP fetching.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="worker_url">Worker URL</Label>
                <Input
                  id="worker_url"
                  placeholder="https://abc123.ngrok-free.app"
                  value={workerUrl}
                  onChange={(e) => setWorkerUrl(e.target.value)}
                  maxLength={300}
                />
                <p className="text-xs text-muted-foreground">
                  Must be reachable from the internet — <code>localhost</code> won&apos;t work. Use
                  ngrok for testing or a small VPS for production.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="osint_worker_secret">Worker secret (optional)</Label>
                <Input
                  id="osint_worker_secret"
                  type="password"
                  autoComplete="off"
                  placeholder={s.osint_worker_secret ?? "Not set"}
                  value={form["osint_worker_secret"] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, osint_worker_secret: e.target.value }))}
                  maxLength={200}
                />
                <p className="text-xs text-muted-foreground">
                  Sent as the <code>x-worker-secret</code> header on every request.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={onSave} disabled={saving}>
                {saving ? "Saving…" : "Save worker settings"}
              </Button>
              <Button variant="outline" onClick={onTest} disabled={testing || !workerUrl}>
                {testing ? "Testing…" : "Test connection"}
              </Button>
            </div>
            {testResult ? (
              <p className={`text-sm ${testResult.ok ? "text-primary" : "text-destructive"}`}>
                {testResult.message}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">SMTP delivery</CardTitle>
            <CardDescription>
              Outreach emails are delivered through your own mail server. Enter the SMTP details of your provider
              (Gmail/Workspace, Microsoft 365, Zoho, Brevo, Mailgun, your host…) and test the connection before
              sending. Delivery runs through your OSINT worker, so the worker URL above must be set and running.
              {(emailSettings as any)?.smtp_verified_at ? (
                <span className="mt-1 block text-primary">
                  Last successful test: {new Date((emailSettings as any).smtp_verified_at).toLocaleString()}
                </span>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="smtp_host">SMTP host</Label>
                <Input
                  id="smtp_host"
                  placeholder="smtp.gmail.com"
                  value={smtp.smtp_host}
                  onChange={(e) => setSmtp((s) => ({ ...s, smtp_host: e.target.value }))}
                  maxLength={253}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp_port">Port</Label>
                <Input
                  id="smtp_port"
                  type="number"
                  placeholder="587"
                  value={smtp.smtp_port}
                  onChange={(e) => setSmtp((s) => ({ ...s, smtp_port: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">587 for STARTTLS, 465 for SSL.</p>
              </div>
              <div className="space-y-2">
                <Label>Security</Label>
                <Select value={smtp.smtp_secure} onValueChange={(v) => setSmtp((s) => ({ ...s, smtp_secure: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="starttls">STARTTLS (recommended)</SelectItem>
                    <SelectItem value="ssl">SSL / TLS</SelectItem>
                    <SelectItem value="none">None (unencrypted)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp_from_email">From address override</Label>
                <Input
                  id="smtp_from_email"
                  type="email"
                  placeholder="Uses the sender address below"
                  value={smtp.smtp_from_email}
                  onChange={(e) => setSmtp((s) => ({ ...s, smtp_from_email: e.target.value }))}
                  maxLength={200}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use the sender domain / address configured below.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp_user">Username</Label>
                <Input
                  id="smtp_user"
                  autoComplete="off"
                  value={smtp.smtp_user}
                  onChange={(e) => setSmtp((s) => ({ ...s, smtp_user: e.target.value }))}
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp_password">Password / app password</Label>
                <Input
                  id="smtp_password"
                  type="password"
                  autoComplete="off"
                  placeholder={(emailSettings as any)?.smtp_password ?? "Not set"}
                  value={smtp.smtp_password}
                  onChange={(e) => setSmtp((s) => ({ ...s, smtp_password: e.target.value }))}
                  maxLength={300}
                />
                <p className="text-xs text-muted-foreground">Leave blank to keep the stored password.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={onSaveSmtp} disabled={smtpBusy !== null}>
                {smtpBusy === "save" ? "Saving…" : "Save SMTP settings"}
              </Button>
              <Button variant="outline" onClick={onTestSmtp} disabled={smtpBusy !== null || !smtp.smtp_host}>
                {smtpBusy === "test" ? "Testing…" : "Test connection"}
              </Button>
            </div>
            {smtpResult ? (
              <p className={`text-sm ${smtpResult.ok ? "text-primary" : "text-destructive"}`}>{smtpResult.message}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Email sending</CardTitle>
            <CardDescription>
              Configure the domain and address your outreach emails are sent from, plus sending limits.
              The domain must be one you own and it has to be verified once in Cloud → Emails before real
              sends go out; everything else below is managed here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email_sender_domain">Sender domain</Label>
                <Input
                  id="email_sender_domain"
                  placeholder="notify.yourcompany.com"
                  value={emailDomain}
                  onChange={(e) => setEmailDomain(e.target.value)}
                  maxLength={253}
                />
                <p className="text-xs text-muted-foreground">
                  A domain you own. Subdomains like <code>notify.yourcompany.com</code> keep outreach separate
                  from your normal mail.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email_from_local">Sender address</Label>
                <Input
                  id="email_from_local"
                  placeholder="contact"
                  value={emailLocal}
                  onChange={(e) => setEmailLocal(e.target.value)}
                  maxLength={64}
                />
                <p className="text-xs text-muted-foreground">
                  Emails will come from{" "}
                  <code>{`${emailLocal.trim() || "contact"}@${emailDomain.trim() || "yourdomain.com"}`}</code>.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email_sender_name">Sender name</Label>
                <Input
                  id="email_sender_name"
                  placeholder="RECYC Outreach"
                  value={emailName}
                  onChange={(e) => setEmailName(e.target.value)}
                  maxLength={120}
                />
                <p className="text-xs text-muted-foreground">Shown as the “From” name in the inbox.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email_reply_to">Reply-to address</Label>
                <Input
                  id="email_reply_to"
                  type="email"
                  placeholder="you@yourcompany.com"
                  value={emailReplyTo}
                  onChange={(e) => setEmailReplyTo(e.target.value)}
                  maxLength={200}
                />
                <p className="text-xs text-muted-foreground">Where replies land. Leave empty to reply to the sender address.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email_daily_cap">Daily send cap</Label>
                <Input
                  id="email_daily_cap"
                  type="number"
                  min={1}
                  placeholder="No cap"
                  value={emailCap}
                  onChange={(e) => setEmailCap(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum emails per day. Start low (50–100) on a fresh domain to protect deliverability.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email_throttle">Delay between emails (seconds)</Label>
                <Input
                  id="email_throttle"
                  type="number"
                  min={0}
                  max={3600}
                  placeholder="0"
                  value={emailThrottle}
                  onChange={(e) => setEmailThrottle(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Spaces out sends so bursts don’t look automated.</p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-md border border-border p-3">
              <Switch id="email_dry_run" checked={emailDryRun} onCheckedChange={setEmailDryRun} />
              <div className="space-y-1">
                <Label htmlFor="email_dry_run">Test mode (no emails actually sent)</Label>
                <p className="text-xs text-muted-foreground">
                  Keep this on while you tune templates — sends are logged but nothing leaves the system.
                </p>
              </div>
            </div>

            <Button onClick={onSaveEmail} disabled={savingEmail}>
              {savingEmail ? "Saving…" : "Save email settings"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
