// ============================================================================
// RECYC OSINT - BATCH QUEUE & JOB MANAGEMENT SERVER FUNCTIONS
// ============================================================================
// Server functions (TanStack Start `createServerFn`):
// - `pumpJob`: Client-side reactive pump that drives row enrichment while dashboard is open.
// - `probeWorker`: Connection tester for external Google Colab / VPS OSINT workers.
// - `claim_job_rows`: Interacts with PostgreSQL queue RPC to lease rows with heartbeat tracking.
// - `exportContacts`: Formats and streams enriched contacts to CSV/JSON/XLSX.
// ============================================================================
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { collectiveScore, scoreLabel } from "./domain-authority";
import { createServerFn } from "@tanstack/react-start";
import { MAX_ROW_TIMEOUT_SECONDS, MIN_ROW_TIMEOUT_SECONDS, parseDurationToSeconds } from "@/lib/duration";
import { employeeBandFromSourceRow } from "@/lib/req";

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    const mask = (v: string | null) => (v ? `••••••${v.slice(-4)}` : null);
    const row = (data ?? {}) as Record<string, string | null>;
    return {
      default_model: data?.default_model ?? "google/gemini-3.6-flash",
      gemini_key: mask(data?.gemini_key ?? null),
      perplexity_key: mask(data?.perplexity_key ?? null),
      openai_key: mask(data?.openai_key ?? null),
      anthropic_key: mask(data?.anthropic_key ?? null),
      custom_ai_key: mask(row["custom_ai_key"] ?? null),
      custom_ai_base_url: row["custom_ai_base_url"] ?? null,
      custom_ai_models: row["custom_ai_models"] ?? null,

      osint_worker_url: row["osint_worker_url"] ?? null,
      osint_worker_secret: mask(row["osint_worker_secret"] ?? null),
      row_timeout_seconds: Number(row["row_timeout_seconds"] ?? 120),
      batch_size: row["batch_size"] === null || row["batch_size"] === undefined ? null : Number(row["batch_size"]),
      default_batch_size: 2,
      email_sender_domain: row["email_sender_domain"] ?? null,
      email_from_local: row["email_from_local"] ?? null,
      email_sender_name: row["email_sender_name"] ?? null,
      email_reply_to: row["email_reply_to"] ?? null,
      email_daily_cap:
        row["email_daily_cap"] === null || row["email_daily_cap"] === undefined ? null : Number(row["email_daily_cap"]),
      email_throttle_seconds:
        row["email_throttle_seconds"] === null || row["email_throttle_seconds"] === undefined
          ? null
          : Number(row["email_throttle_seconds"]),
      email_dry_run: (row as unknown as Record<string, boolean | null>)["email_dry_run"] ?? true,
    };
  });

export const saveSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, string | null>) => input)
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = { user_id: context.userId };
    for (const field of [
      "gemini_key",
      "perplexity_key",
      "openai_key",
      "anthropic_key",
      "custom_ai_key",
      "osint_worker_secret",
    ]) {
      const value = data[field];
      if (typeof value === "string" && value.trim() && !value.includes("•")) patch[field] = value.trim();
      if (value === null) patch[field] = null;
    }
    if ("custom_ai_base_url" in data) {
      const raw = data["custom_ai_base_url"];
      const trimmed = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
      if (trimmed && !/^https?:\/\//i.test(trimmed)) {
        throw new Error("The AI service address must start with http:// or https:// (e.g. https://api.mammouth.ai/v1)");
      }
      patch["custom_ai_base_url"] = trimmed || null;
    }
    if ("custom_ai_models" in data) {
      const raw = data["custom_ai_models"];
      const cleaned =
        typeof raw === "string"
          ? raw.split(/[\n,]+/).map((m) => m.trim()).filter(Boolean).slice(0, 40).join(", ")
          : "";
      patch["custom_ai_models"] = cleaned || null;
    }

    const workerUrl = data["osint_worker_url"];
    if (typeof workerUrl === "string") {
      const trimmed = workerUrl.trim().replace(/\/$/, "");
      if (trimmed && !/^https?:\/\//i.test(trimmed)) throw new Error("Worker URL must start with http:// or https://");
      patch["osint_worker_url"] = trimmed || null;
    }
    if (workerUrl === null) patch["osint_worker_url"] = null;
    if (data["default_model"]) patch["default_model"] = data["default_model"];
    if (data["row_timeout_seconds"]) {
      const seconds = parseDurationToSeconds(data["row_timeout_seconds"] as string);
      if (seconds === null || !Number.isFinite(seconds)) {
        throw new Error('Could not read that duration. Try formats like "120s", "2m", "1h 30m" or "2:30".');
      }
      if (seconds < MIN_ROW_TIMEOUT_SECONDS || seconds > MAX_ROW_TIMEOUT_SECONDS) {
        throw new Error("Per-company deadline must be between 30 seconds and 1 hour.");
      }
      patch["row_timeout_seconds"] = seconds;
    }
    if ("batch_size" in data) {
      const raw = data["batch_size"];
      if (raw === null || (typeof raw === "string" && !raw.trim())) {
        patch["batch_size"] = null; // fall back to the system default
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 25) {
          throw new Error("Rows processed at once must be a whole number between 1 and 25 (leave empty for automatic).");
        }
        patch["batch_size"] = n;
      }
    }
    // ---- Email sending settings (all editable from the front end) ----
    const cleanDomain = (v: string) =>
      v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^@/, "");
    if ("email_sender_domain" in data) {
      const raw = data["email_sender_domain"];
      if (raw === null || (typeof raw === "string" && !raw.trim())) patch["email_sender_domain"] = null;
      else {
        const d = cleanDomain(raw as string);
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error("Enter a valid sender domain, e.g. notify.yourcompany.com");
        patch["email_sender_domain"] = d;
      }
    }
    if ("email_from_local" in data) {
      const raw = data["email_from_local"];
      if (raw === null || (typeof raw === "string" && !raw.trim())) patch["email_from_local"] = null;
      else {
        const local = (raw as string).trim().toLowerCase().split("@")[0] ?? "";
        if (!/^[a-z0-9._-]{1,64}$/.test(local)) throw new Error("Sender address can only use letters, numbers, dots, dashes and underscores.");
        patch["email_from_local"] = local;
      }
    }
    if ("email_sender_name" in data) {
      const raw = data["email_sender_name"];
      patch["email_sender_name"] = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 120) : null;
    }
    if ("email_reply_to" in data) {
      const raw = data["email_reply_to"];
      if (raw === null || (typeof raw === "string" && !raw.trim())) patch["email_reply_to"] = null;
      else {
        const email = (raw as string).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("Reply-to must be a valid email address.");
        patch["email_reply_to"] = email;
      }
    }
    for (const [field, min, max, label] of [
      ["email_daily_cap", 1, 100000, "Daily send cap"],
      ["email_throttle_seconds", 0, 3600, "Delay between emails"],
    ] as const) {
      if (!(field in data)) continue;
      const raw = data[field];
      if (raw === null || (typeof raw === "string" && !raw.trim())) {
        patch[field] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
      patch[field] = n;
    }
    if ("email_dry_run" in data) {
      patch["email_dry_run"] = data["email_dry_run"] === "true" || (data["email_dry_run"] as unknown) === true;
    }

    const { error } = await context.supabase
      .from("user_settings")
      .upsert(patch as never, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testWorker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { url?: string | null; secret?: string | null }) => input)
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    const stored = (row ?? {}) as Record<string, string | null>;
    const base = (data.url?.trim() || stored["osint_worker_url"] || "").replace(/\/$/, "");
    const secret = data.secret?.trim() || stored["osint_worker_secret"] || null;
    if (!base) return { ok: false, message: "No worker URL configured." };
    if (!/^https?:\/\//i.test(base)) return { ok: false, message: "Worker URL must start with http:// or https://" };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      const started = Date.now();
      const res = await fetch(`${base}/render`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "ngrok-skip-browser-warning": "true",
          "user-agent": "RECYC-OSINT/1.0",
          ...(secret ? { "x-worker-secret": secret } : {}),
        },
        body: JSON.stringify({ url: "https://example.com" }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: secret
            ? `Worker rejected the secret (${res.status}). It must match WORKER_SECRET on the worker exactly — or clear both if the worker has none.`
            : `Worker requires a secret (${res.status}). Enter the same value as WORKER_SECRET on your worker and try again.`,
        };
      }
      if (res.status === 404) return { ok: false, message: "Worker reachable but /render was not found (404). Check the URL has no extra path." };
      if (!res.ok) return { ok: false, message: `Worker responded ${res.status}. Check the worker logs.` };
      const json = (await res.json()) as { html?: string; text?: string };
      const body = json.html ?? json.text ?? "";
      if (!body) return { ok: false, message: "Worker replied but returned no html/text field." };
      return {
        ok: true,
        message: `Worker OK · ${body.length.toLocaleString()} chars in ${Date.now() - started} ms`,
      };
    } catch (e) {
      return { ok: false, message: `Could not reach worker: ${(e as Error).message}` };
    }
  });

export const getProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("profiles")
      .select("*")
      .eq("id", context.userId)
      .maybeSingle();
    return data ?? { id: context.userId, full_name: null, email: null };
  });

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { full_name: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("profiles")
      .update({ full_name: data.full_name.slice(0, 120) })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      name: string;
      file_name: string;
      model: string;
      targets: Record<string, boolean | number | string | string[]>;
      start_row: number;
      end_row: number;
      /** Column names of the uploaded file, preserved for exports. */
      source_headers?: string[];
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const { data: job, error } = await context.supabase
      .from("batch_jobs")
      .insert({
        user_id: context.userId,
        name: data.name.slice(0, 160),
        file_name: data.file_name.slice(0, 200),
        model: data.model,
        targets: data.targets,
        start_row: data.start_row,
        end_row: data.end_row,
        source_headers: (data.source_headers ?? []).slice(0, 60),
        status: "draft",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: job.id as string };
  });

/** Rows are uploaded in chunks so files with tens of thousands of rows work. */
export const appendJobRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      job_id: string;
      rows: {
        row_index: number;
        neq: string | null;
        company_name: string;
        postal_code: string | null;
        city: string | null;
        source_row?: Record<string, string>;
      }[];
    }) => input,
  )
  .handler(async ({ data, context }) => {
    if (data.rows.length > 1000) throw new Error("Chunk too large (max 1000 rows).");
    const payload = data.rows.map((r) => ({
      ...r,
      company_name: r.company_name.slice(0, 300),
      source_row: r.source_row ?? {},
      job_id: data.job_id,
      user_id: context.userId,
    }));
    const { error } = await context.supabase
      .from("job_rows")
      .upsert(payload, { onConflict: "job_id,row_index", ignoreDuplicates: true });

    if (error) throw new Error(error.message);
    return { inserted: payload.length };
  });

export const startJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { job_id: string }) => input)
  .handler(async ({ data, context }) => {
    const { count } = await context.supabase
      .from("job_rows")
      .select("id", { count: "exact", head: true })
      .eq("job_id", data.job_id);
    const { error } = await context.supabase
      .from("batch_jobs")
      .update({
        status: "running",
        total_rows: count ?? 0,
        started_at: new Date().toISOString(),
        paused_reason: null,
        error: null,
        lease_until: null,
      })
      .eq("id", data.job_id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    await context.supabase.from("job_logs").insert({
      job_id: data.job_id,
      user_id: context.userId,
      message: `Batch queued with ${count ?? 0} rows.`,
    });
    return { ok: true, total: count ?? 0 };
  });

export const setJobStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { job_id: string; status: "running" | "paused" | "stopped" }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("batch_jobs")
      .update({
        status: data.status,
        lease_until: null,
        ...(data.status === "running" ? { paused_reason: null, error: null } : {}),
      })
      .eq("id", data.job_id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { job_id: string }) => input)
  .handler(async ({ data, context }) => {
    await context.supabase.from("batch_jobs").delete().eq("id", data.job_id).eq("user_id", context.userId);
    return { ok: true };
  });

export const listJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("batch_jobs")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(100);
    return data ?? [];
  });

export const getJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { job_id: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: job } = await context.supabase
      .from("batch_jobs")
      .select("*")
      .eq("id", data.job_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    const { data: logs } = await context.supabase
      .from("job_logs")
      .select("*")
      .eq("job_id", data.job_id)
      .order("id", { ascending: false })
      .limit(400);
    const { data: activeRows } = await context.supabase
      .from("job_rows")
      .select("id,row_index,company_name,claimed_at,heartbeat_at,attempts")
      .eq("job_id", data.job_id)
      .eq("status", "processing")
      .order("row_index", { ascending: true })
      .limit(8);
    return { job, logs: (logs ?? []).reverse(), activeRows: activeRows ?? [] };
  });

/** Client-side pump: processes one bounded batch while the dashboard is open. */
export const pumpJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { job_id: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("batch_jobs")
      .select("id")
      .eq("id", data.job_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!owned) throw new Error("Job not found.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processJobBatch } = await import("./enrich.server");
    return processJobBatch(supabaseAdmin as never, data.job_id);
  });

type ContactFilters = {
  search?: string;
  status?: string;
  min_score?: number;
  job_id?: string;
};

const STATUS_MAP: Record<string, string> = {
  verified: "Verified",
  mx_verified: "MX Verified",
  unverified: "Unverified",
  invalid: "Invalid",
};

function applyContactFilters(query: any, filters: ContactFilters) {
  if (filters.search) {
    const s = filters.search.replace(/[%,()]/g, "").slice(0, 120);
    if (s) {
      query = query.or(
        `company_name.ilike.%${s}%,executive_name.ilike.%${s}%,email.ilike.%${s}%,neq.ilike.%${s}%`,
      );
    }
  }
  if (filters.status && filters.status !== "all") {
    query = query.eq("verification_status", STATUS_MAP[filters.status] ?? filters.status);
  }
  if (filters.min_score && filters.min_score > 0) query = query.gte("confidence", filters.min_score);
  if (filters.job_id) query = query.eq("job_id", filters.job_id);
  return query;
}

export const listContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ContactFilters & { limit?: number; offset?: number }) => input)
  .handler(async ({ data, context }) => {
    const limit = Math.min(100, Math.max(1, data.limit ?? 25));
    const offset = Math.max(0, data.offset ?? 0);
    let query = context.supabase
      .from("contacts")
      .select("*", { count: "exact" })
      .eq("user_id", context.userId);
    query = applyContactFilters(query, data);
    const { data: rows, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    return {
      rows: (rows ?? []).map((r: any) => ({
        ...r,
        found_email: r.email,
        confidence_score: r.confidence,
        discovery_source: r.source,
        employee_code:
          employeeBandFromSourceRow(
            r.source_row && typeof r.source_row === "object"
              ? (r.source_row as Record<string, unknown>)
              : {},
          ) ?? "N",
      })),
      count: count ?? 0,
    };
  });

const CSV_HEADERS = [
  "NEQ",
  "Company Name",
  "Employee Code",
  "Executive Name",
  "Title",
  "Email",
  "Phone",
  "Domain",
  "Address",
  "City",
  "Postal Code",
  "Verification Status",
  "Confidence Score",
  "Discovery Source",
  "Email Type",
  "Verification Checks",
  "LinkedIn",
  "Facebook",
  "Registry Record",
  "Company Status",
  "Source Trust Score",
  "Source Trust Rating",
  "Top Source",
  "References (link — domain score)",
];


type ContactReference = { url: string; host: string; score: number; tier?: string };

/** Reference links captured while enriching, sorted strongest domain first. */
function referencesOf(row: { verification_details?: unknown }): ContactReference[] {
  const details = (row.verification_details ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(details["references"]) ? (details["references"] as ContactReference[]) : [];
  return refs.filter((r) => r && typeof r.url === "string");
}

function sourceScoreOf(row: { verification_details?: unknown }): number {
  const details = (row.verification_details ?? {}) as Record<string, unknown>;
  const stored = Number(details["source_score"] ?? 0);
  if (stored > 0) return Math.round(stored);
  return collectiveScore(referencesOf(row).map((r) => ({ host: r.host, score: r.score, tier: r.tier ?? "" })));
}

function csvCell(value: unknown) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const deleteContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ids?: string[]; all?: boolean } & ContactFilters) => input)
  .handler(async ({ data, context }) => {
    if (data.all) {
      let query = context.supabase.from("contacts").delete().eq("user_id", context.userId);
      query = applyContactFilters(query, data);
      const { error } = await query;
      if (error) throw new Error(error.message);
      return { ok: true };
    }
    const ids = (data.ids ?? []).slice(0, 5000);
    if (!ids.length) return { ok: true, deleted: 0 };
    const { error } = await context.supabase
      .from("contacts")
      .delete()
      .eq("user_id", context.userId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    return { ok: true, deleted: ids.length };
  });

/** One-off cleanup: applies the website/email guard to every saved contact. */
export const cleanupContactWebsites = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { guardRow, sharedDomainAllowed } = await import("./domain-guard");
    const { data, error } = await context.supabase
      .from("contacts")
      .select("id, company_name, domain, email, phone, confidence, verification_status, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true })
      .limit(50000);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const kept = new Map<string, { company_name: string; phone: string | null }[]>();
    let websites = 0;
    let emails = 0;
    for (const r of rows) {
      const g = guardRow({ company_name: r.company_name, domain: r.domain, email: r.email });
      let domain = g.domain;
      let email = g.email;
      if (domain) {
        const others = (kept.get(domain) ?? []).filter((o) => o.company_name !== r.company_name);
        if (others.length && !sharedDomainAllowed(domain, r.company_name, others, r.phone)) {
          if (email?.endsWith(`@${domain}`)) email = null;
          domain = null;
        } else {
          kept.set(domain, [...(kept.get(domain) ?? []), { company_name: r.company_name, phone: r.phone }]);
        }
      }
      if (domain === r.domain && email === r.email) continue;
      if (domain !== r.domain) websites++;
      if (email !== r.email) emails++;
      const patch: { domain: string | null; email: string | null; confidence?: number; verification_status?: string } = { domain, email };
      if (r.email && !email) {
        patch.confidence = Math.min(r.confidence ?? 0, 1);
        patch.verification_status = "Unverified";
      }
      const { error: upErr } = await context.supabase.from("contacts").update(patch).eq("id", r.id).eq("user_id", context.userId);
      if (upErr) throw new Error(upErr.message);
    }
    return { scanned: rows.length, websites, emails };
  });

type RowKey = { neq?: string | null; company_name: string };

const keyOf = (r: { neq?: string | null; company_name?: string | null }) =>
  (r.neq && String(r.neq).trim()) || String(r.company_name ?? "").trim().toLowerCase();

/** Tells the UI which of the incoming rows were already enriched before. */
export const findAlreadyChecked = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { keys: RowKey[] }) => input)
  .handler(async ({ data, context }) => {
    const keys = (data.keys ?? []).slice(0, 20000);
    if (!keys.length) return { matched: [] as string[] };
    const neqs = [...new Set(keys.map((k) => (k.neq ?? "").trim()).filter(Boolean))];
    const names = [...new Set(keys.map((k) => k.company_name.trim()).filter(Boolean))];
    const matched = new Set<string>();
    const CH = 200;
    for (let i = 0; i < neqs.length; i += CH) {
      const { data: rows } = await context.supabase
        .from("contacts")
        .select("neq,company_name")
        .eq("user_id", context.userId)
        .in("neq", neqs.slice(i, i + CH));
      for (const r of rows ?? []) matched.add(keyOf(r as any));
    }
    for (let i = 0; i < names.length; i += CH) {
      const { data: rows } = await context.supabase
        .from("contacts")
        .select("neq,company_name")
        .eq("user_id", context.userId)
        .in("company_name", names.slice(i, i + CH));
      for (const r of rows ?? []) {
        matched.add(keyOf(r as any));
        matched.add(String((r as any).company_name ?? "").trim().toLowerCase());
      }
    }
    return { matched: [...matched] };
  });

/** Removes the previous results for these rows so a re-check replaces them. */
export const purgeCheckedKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { keys: RowKey[] }) => input)
  .handler(async ({ data, context }) => {
    const keys = (data.keys ?? []).slice(0, 20000);
    const neqs = [...new Set(keys.map((k) => (k.neq ?? "").trim()).filter(Boolean))];
    const names = [...new Set(keys.map((k) => k.company_name.trim()).filter(Boolean))];
    const CH = 200;
    for (let i = 0; i < neqs.length; i += CH) {
      await context.supabase
        .from("contacts")
        .delete()
        .eq("user_id", context.userId)
        .in("neq", neqs.slice(i, i + CH));
    }
    for (let i = 0; i < names.length; i += CH) {
      await context.supabase
        .from("contacts")
        .delete()
        .eq("user_id", context.userId)
        .in("company_name", names.slice(i, i + CH));
    }
    return { ok: true };
  });

/**
 * Re-runs the full pipeline for contacts that were already enriched.
 * Without `replace: true` it only reports what would be overwritten, so the UI
 * can ask "this row was already checked — check again and replace?".
 */
export const recheckContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ids: string[]; replace?: boolean }) => input)
  .handler(async ({ data, context }) => {
    const ids = (data.ids ?? []).slice(0, 500);
    if (!ids.length) throw new Error("Select at least one contact to re-check.");
    const { data: contacts } = await context.supabase
      .from("contacts")
      .select("*")
      .eq("user_id", context.userId)
      .in("id", ids);
    const list = (contacts ?? []) as any[];
    if (!list.length) throw new Error("Those contacts no longer exist.");

    if (!data.replace) {
      return {
        requires_confirmation: true,
        already_checked: list.length,
        sample: list.slice(0, 5).map((c) => ({
          company_name: c.company_name as string,
          neq: (c.neq ?? null) as string | null,
          checked_at: c.created_at as string,
          verification_status: c.verification_status as string,
        })),
      };
    }

    // Reuse the settings of the batch the contact came from when possible.
    const originJobId = list.find((c) => c.job_id)?.job_id as string | undefined;
    let model = "google/gemini-3.6-flash";
    let targets: Record<string, unknown> = { email: true, phone: true, domain: true };
    let headers: string[] = [];
    if (originJobId) {
      const { data: origin } = await context.supabase
        .from("batch_jobs")
        .select("model,targets,source_headers")
        .eq("id", originJobId)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (origin) {
        model = (origin as any).model ?? model;
        targets = ((origin as any).targets ?? targets) as Record<string, unknown>;
        headers = ((origin as any).source_headers ?? []) as string[];
      }
    }

    const { data: job, error: jobError } = await context.supabase
      .from("batch_jobs")
      .insert({
        user_id: context.userId,
        name: `Re-check · ${list.length} row(s)`,
        file_name: "re-check",
        model,
        targets: targets as never,
        source_headers: headers,
        start_row: 0,
        end_row: list.length,
        total_rows: list.length,
        status: "draft",
      })
      .select("id")
      .single();
    if (jobError) throw new Error(jobError.message);
    const jobId = job.id as string;

    const { error: rowError } = await context.supabase.from("job_rows").insert(
      list.map((c, i) => ({
        job_id: jobId,
        user_id: context.userId,
        row_index: i,
        neq: c.neq ?? null,
        company_name: String(c.company_name ?? "").slice(0, 300),
        postal_code: c.postal_code ?? null,
        city: c.city ?? null,
        source_row: c.source_row ?? {},
      })),
    );
    if (rowError) throw new Error(rowError.message);

    // Old results are dropped so the fresh run replaces them.
    await context.supabase.from("contacts").delete().eq("user_id", context.userId).in("id", ids);

    await context.supabase
      .from("batch_jobs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("user_id", context.userId);
    await context.supabase.from("job_logs").insert({
      job_id: jobId,
      user_id: context.userId,
      message: `Re-check queued for ${list.length} previously checked row(s); old results were replaced.`,
    });
    return { ok: true, job_id: jobId, rows: list.length };
  });

export const exportContacts = createServerFn({ method: "POST" })

  .middleware([requireSupabaseAuth])
  .inputValidator((input: ContactFilters) => input)
  .handler(async ({ data, context }) => {
    let query = context.supabase.from("contacts").select("*").eq("user_id", context.userId);
    query = applyContactFilters(query, data);
    const { data: rows } = await query.order("created_at", { ascending: false }).limit(50000);
    const list = (rows ?? []) as any[];

    // Replay the original uploaded columns first, so the export is the user's
    // own file plus everything the pipeline discovered.
    const original: string[] = [];
    for (const r of list) {
      const src = r.source_row && typeof r.source_row === "object" ? r.source_row : {};
      for (const key of Object.keys(src)) if (!original.includes(key)) original.push(key);
      if (original.length >= 60) break;
    }

    const lines = [[...original, ...CSV_HEADERS].map(csvCell).join(",")];
    for (const r of list) {
      const src = (r.source_row ?? {}) as Record<string, unknown>;
      lines.push(
        [
          ...original.map((k) => src[k] ?? ""),
          r.neq,
          r.company_name,
          employeeBandFromSourceRow(src) ?? "N",
          r.executive_name,
          r.title,
          r.email,
          r.phone,
          r.domain,
          r.address,
          r.city,
          r.postal_code,
          r.verification_status,
          r.confidence,
          r.source,
          r.email_type,
          Array.isArray(r.verification_details?.reasons)
            ? r.verification_details.reasons.join(" | ")
            : "",
          r.linkedin_url,
          r.facebook_url,
          r.registry_url,
          r.company_status,
          sourceScoreOf(r),
          scoreLabel(sourceScoreOf(r)),
          referencesOf(r)[0]?.url ?? "",
          referencesOf(r)
            .map((ref) => `${ref.url} (${ref.host} — ${ref.score}/100)`)
            .join("\n"),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return { csv: list.length ? lines.join("\n") : "", count: list.length };
  });

export const dashboardStats = createServerFn({ method: "GET" })

  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const uid = context.userId;
    const [contacts, verified, jobs, running] = await Promise.all([
      context.supabase.from("contacts").select("id", { count: "exact", head: true }).eq("user_id", uid),
      context.supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", uid)
        .in("verification_status", ["Verified", "MX Verified"]),
      context.supabase.from("batch_jobs").select("id", { count: "exact", head: true }).eq("user_id", uid),
      context.supabase
        .from("batch_jobs")
        .select("*")
        .eq("user_id", uid)
        .in("status", ["running", "paused"])
        .order("created_at", { ascending: false })
        .limit(5),
    ]);
    return {
      contacts: contacts.count ?? 0,
      verified: verified.count ?? 0,
      jobs: jobs.count ?? 0,
      active: running.data ?? [],
    };
  });


/** Aggregated discovery performance: success rate plus day/week/month volume. */
export const contactStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const uid = context.userId;
    const { data: rows } = await context.supabase
      .from("contacts")
      .select("verification_status,email,confidence,company_status,created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(50000);

    const list = (rows ?? []) as any[];
    const now = Date.now();
    const since = (ms: number) => list.filter((r) => now - new Date(r.created_at).getTime() <= ms);
    const dissolvedRe = /dissol|radi|struck|inactive/i;

    const found = list.filter((r) => Boolean(r.email));
    const verified = list.filter((r) =>
      ["Verified", "MX Verified"].includes(r.verification_status),
    );
    const strong = list.filter((r) => (r.confidence ?? 0) >= 4);

    return {
      total: list.length,
      found: found.length,
      notFound: list.length - found.length,
      verified: verified.length,
      strong: strong.length,
      dissolved: list.filter((r) => dissolvedRe.test(String(r.company_status ?? ""))).length,
      active: list.filter((r) => /active|immatricul/i.test(String(r.company_status ?? "")) && !dissolvedRe.test(String(r.company_status ?? ""))).length,
      unknownStatus: list.filter((r) => !r.company_status).length,
      successRate: list.length ? Math.round((found.length / list.length) * 100) : 0,
      verifiedRate: list.length ? Math.round((verified.length / list.length) * 100) : 0,
      day: since(86_400_000).length,
      week: since(7 * 86_400_000).length,
      month: since(30 * 86_400_000).length,
      /** 14-day series for the dashboard charts. */
      daily: (() => {
        const days: { date: string; total: number; found: number; verified: number }[] = [];
        for (let i = 13; i >= 0; i--) {
          const start = new Date(now - i * 86_400_000);
          start.setUTCHours(0, 0, 0, 0);
          const end = start.getTime() + 86_400_000;
          const bucket = list.filter((r) => {
            const t = new Date(r.created_at).getTime();
            return t >= start.getTime() && t < end;
          });
          days.push({
            date: start.toISOString().slice(5, 10),
            total: bucket.length,
            found: bucket.filter((r) => Boolean(r.email)).length,
            verified: bucket.filter((r) => ["Verified", "MX Verified"].includes(r.verification_status)).length,
          });
        }
        return days;
      })(),
      /** Confidence 0-5 histogram. */
      confidence: [0, 1, 2, 3, 4, 5].map((score) => ({
        score: String(score),
        count: list.filter((r) => (r.confidence ?? 0) === score).length,
      })),
      statuses: ["Verified", "MX Verified", "Unverified", "Invalid"].map((label) => ({
        label,
        count: list.filter((r) => r.verification_status === label).length,
      })),
      dayVerified: since(86_400_000).filter((r) => Boolean(r.email)).length,
      weekVerified: since(7 * 86_400_000).filter((r) => Boolean(r.email)).length,
      monthVerified: since(30 * 86_400_000).filter((r) => Boolean(r.email)).length,
    };
  });

type BandBucket = { total: number; found: number; mxVerified: number; highConfidence: number };

const BAND_GROUPS = [
  { key: "O", label: "Code O (0 employees)", codes: ["O"] },
  { key: "A-B", label: "Codes A–B (1–10)", codes: ["A", "B"] },
  { key: "C-E", label: "Codes C–E (11–99)", codes: ["C", "D", "E"] },
  { key: "F-H", label: "Codes F–H (100+)", codes: ["F", "G", "H"] },
  { key: "N", label: "Code N / Unknown", codes: [] as string[] },
] as const;

/** Funnel breakdown by REQ employee-size code. Reporting only — never changes the pipeline. */
function computeBandFunnel(list: any[]) {
  const empty = (): BandBucket => ({ total: 0, found: 0, mxVerified: 0, highConfidence: 0 });
  const buckets = new Map<string, BandBucket>(BAND_GROUPS.map((g) => [g.key, empty()]));
  const codeToGroup = new Map<string, string>();
  for (const g of BAND_GROUPS) for (const c of g.codes) codeToGroup.set(c, g.key);

  for (const r of list) {
    const src = r.source_row && typeof r.source_row === "object" ? (r.source_row as Record<string, unknown>) : {};
    const band = employeeBandFromSourceRow(src);
    const groupKey = (band && codeToGroup.get(band)) || "N";
    const b = buckets.get(groupKey)!;
    b.total += 1;
    if (r.email) b.found += 1;
    if (["Verified", "MX Verified"].includes(String(r.verification_status ?? ""))) b.mxVerified += 1;
    if ((r.confidence ?? 0) >= 4) b.highConfidence += 1;
  }

  const groups = BAND_GROUPS.map((g) => ({ key: g.key, label: g.label, ...buckets.get(g.key)! }));
  const totals = groups.reduce(
    (acc, g) => ({
      total: acc.total + g.total,
      found: acc.found + g.found,
      mxVerified: acc.mxVerified + g.mxVerified,
      highConfidence: acc.highConfidence + g.highConfidence,
    }),
    empty(),
  );
  const o = buckets.get("O")!;
  const others = groups
    .filter((g) => g.key !== "O")
    .reduce(
      (acc, g) => ({
        total: acc.total + g.total,
        found: acc.found + g.found,
        mxVerified: acc.mxVerified + g.mxVerified,
        highConfidence: acc.highConfidence + g.highConfidence,
      }),
      empty(),
    );
  return { groups, totals, oVsOthers: { o, others } };
}

/** Employee-size funnel for the dashboard table. */
export const bandFunnelStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows } = await context.supabase
      .from("contacts")
      .select("source_row,email,verification_status,confidence")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(50000);
    return computeBandFunnel((rows ?? []) as any[]);
  });

/**
 * Everything the Excel snapshot needs in one call: dashboard counts, the
 * employee-size funnel, and every contact found so far as flat rows.
 */
export const dashboardSnapshot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const uid = context.userId;
    const [contactsRes, jobsRes] = await Promise.all([
      context.supabase
        .from("contacts")
        .select("*")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(50000),
      context.supabase.from("batch_jobs").select("id", { count: "exact", head: true }).eq("user_id", uid),
    ]);
    const list = (contactsRes.data ?? []) as any[];
    const funnel = computeBandFunnel(list);
    const found = list.filter((r) => Boolean(r.email));
    const verified = list.filter((r) => ["Verified", "MX Verified"].includes(String(r.verification_status ?? "")));
    const strong = list.filter((r) => (r.confidence ?? 0) >= 4);

    const contacts = list.map((r) => ({
      company_name: r.company_name ?? "",
      neq: r.neq ?? "",
      employee_code: employeeBandFromSourceRow(
        r.source_row && typeof r.source_row === "object" ? (r.source_row as Record<string, unknown>) : {},
      ) ?? "",
      executive_name: r.executive_name ?? "",
      title: r.title ?? "",
      email: r.email ?? "",
      phone: r.phone ?? "",
      domain: r.domain ?? "",
      address: r.address ?? "",
      city: r.city ?? "",
      postal_code: r.postal_code ?? "",
      verification_status: r.verification_status ?? "",
      confidence: r.confidence ?? 0,
      company_status: r.company_status ?? "",
      source: r.source ?? "",
      found_at: r.created_at ?? "",
    }));

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        contacts: list.length,
        found: found.length,
        verified: verified.length,
        highConfidence: strong.length,
        jobs: jobsRes.count ?? 0,
      },
      funnel,
      contacts,
    };
  });
