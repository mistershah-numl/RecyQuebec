import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createServerFn } from "@tanstack/react-start";
import { mergeDataFor, renderTemplate, textToHtml } from "./template";
import { sendSmtpMessage, smtpConfigFrom, testSmtpConnection } from "./smtp.server";

// ---------------------------------------------------------------- settings

export const getEmailSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    const row = (data ?? {}) as Record<string, any>;
    const mask = (v: string | null) => (v ? `••••••${String(v).slice(-3)}` : null);
    return {
      smtp_host: row["smtp_host"] ?? null,
      smtp_port: row["smtp_port"] ?? null,
      smtp_user: row["smtp_user"] ?? null,
      smtp_password: mask(row["smtp_password"] ?? null),
      smtp_secure: row["smtp_secure"] ?? "starttls",
      smtp_from_email: row["smtp_from_email"] ?? null,
      smtp_verified_at: row["smtp_verified_at"] ?? null,
      email_sender_domain: row["email_sender_domain"] ?? null,
      email_from_local: row["email_from_local"] ?? null,
      email_sender_name: row["email_sender_name"] ?? null,
      email_reply_to: row["email_reply_to"] ?? null,
      email_dry_run: row["email_dry_run"] ?? true,
      email_daily_cap: row["email_daily_cap"] ?? null,
      email_throttle_seconds: row["email_throttle_seconds"] ?? null,
      worker_configured: Boolean(row["osint_worker_url"]),
    };
  });

export const saveSmtpSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, string | null>) => input)
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = { user_id: context.userId };
    if ("smtp_host" in data) {
      const host = (data["smtp_host"] ?? "").toString().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      patch["smtp_host"] = host || null;
    }
    if ("smtp_port" in data) {
      const raw = (data["smtp_port"] ?? "").toString().trim();
      if (!raw) patch["smtp_port"] = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("SMTP port must be between 1 and 65535.");
        patch["smtp_port"] = n;
      }
    }
    if ("smtp_user" in data) patch["smtp_user"] = (data["smtp_user"] ?? "").toString().trim() || null;
    if ("smtp_password" in data) {
      const pw = (data["smtp_password"] ?? "").toString();
      if (pw && !pw.includes("•")) patch["smtp_password"] = pw;
      if (data["smtp_password"] === null) patch["smtp_password"] = null;
    }
    if ("smtp_secure" in data) {
      const sec = (data["smtp_secure"] ?? "starttls").toString();
      if (!["ssl", "starttls", "none"].includes(sec)) throw new Error("Invalid SMTP security mode.");
      patch["smtp_secure"] = sec;
    }
    if ("smtp_from_email" in data) {
      const from = (data["smtp_from_email"] ?? "").toString().trim();
      if (from && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(from)) throw new Error("Enter a valid sender email address.");
      patch["smtp_from_email"] = from || null;
    }
    const { error } = await context.supabase.from("user_settings").upsert(patch as any, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testSmtp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    const { config, problem } = smtpConfigFrom(data as any);
    if (!config) return { ok: false, message: problem ?? "SMTP is not configured." };
    const res = await testSmtpConnection(config);
    if (res.ok) {
      await context.supabase
        .from("user_settings")
        .upsert({ user_id: context.userId, smtp_verified_at: new Date().toISOString() } as any, {
          onConflict: "user_id",
        });
    }
    return res;
  });

/** Probes a provider key so the user knows it works before saving it for real. */
export const testAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { provider: string; key?: string | null }) => input)
  .handler(async ({ data, context }) => {
    const provider = data.provider;
    let key = (data.key ?? "").trim();
    if (!key || key.includes("•")) {
      const { data: row } = await context.supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", context.userId)
        .maybeSingle();
      key = ((row as any)?.[provider] ?? "").toString();
    }
    if (!key) return { ok: false, message: "No key to test — type a key first." };

    const timeout = AbortSignal.timeout(20_000);
    try {
      if (provider === "gemini_key") {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
          signal: timeout,
        });
        if (!r.ok) return { ok: false, message: `Gemini rejected the key (${r.status}).` };
        const body = (await r.json()) as { models?: { name?: string }[] };
        const usable = (body.models ?? [])
          .map((m) => (m.name ?? "").replace(/^models\//, ""))
          .filter((n) => n.startsWith("gemini") && !/embedding|image|tts|live/i.test(n));
        return {
          ok: true,
          message: usable.length
            ? `Gemini key works. Available models include: ${usable.slice(0, 4).join(", ")}.`
            : "Gemini key works.",
        };
      }
      if (provider === "openai_key") {
        const r = await fetch("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${key}` },
          signal: timeout,
        });
        return r.ok ? { ok: true, message: "OpenAI key works." } : { ok: false, message: `OpenAI rejected the key (${r.status}).` };
      }
      if (provider === "anthropic_key") {
        const r = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: timeout,
        });
        return r.ok
          ? { ok: true, message: "Anthropic key works." }
          : { ok: false, message: `Anthropic rejected the key (${r.status}).` };
      }
      if (provider === "perplexity_key") {
        const r = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
          signal: timeout,
        });
        return r.ok || r.status === 400
          ? { ok: true, message: "Perplexity key works." }
          : { ok: false, message: `Perplexity rejected the key (${r.status}).` };
      }
      if (provider === "custom_ai_key") {
        const { data: row } = await context.supabase
          .from("user_settings")
          .select("*")
          .eq("user_id", context.userId)
          .maybeSingle();
        const base = (((row as any)?.custom_ai_base_url as string) || "https://api.mammouth.ai/v1").replace(/\/+$/, "");
        const r = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: timeout,
        });
        if (!r.ok) return { ok: false, message: `The service rejected the key (${r.status}).` };
        const body = (await r.json().catch(() => ({}))) as { data?: { id?: string }[] };
        const ids = (body.data ?? []).map((m) => m.id).filter(Boolean).slice(0, 5);
        return {
          ok: true,
          message: ids.length ? `Key works. Models include: ${ids.join(", ")}.` : "Key works.",
        };
      }
      return { ok: false, message: "Unknown provider." };

    } catch (e) {
      return { ok: false, message: `Could not reach the provider: ${(e as Error).message}` };
    }
  });

// ------------------------------------------------------------ CRM contacts

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

export const listCrmContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { search?: string; job_id?: string | null; limit?: number; offset?: number }) => input)
  .handler(async ({ data, context }) => {
    const limit = Math.min(Math.max(Number(data.limit ?? 50), 1), 200);
    const offset = Math.max(Number(data.offset ?? 0), 0);
    let q = (context.supabase as any)
      .from("crm_contacts")
      .select("*", { count: "exact" })
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (data.search?.trim()) {
      const s = data.search.trim().replace(/[%,]/g, " ");
      q = q.or(`company_name.ilike.%${s}%,email.ilike.%${s}%,contact_name.ilike.%${s}%`);
    }
    if (data.job_id) q = q.eq("source_job_id", data.job_id);
    const { data: rows, count, error } = await q;
    if (error) throw new Error(error.message);

    // Attach a minimal "emailed" marker for each row — details live on the Outreach page.
    const list = (rows ?? []) as any[];
    const emails = Array.from(
      new Set(list.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean)),
    );
    const marks = new Map<string, { last_sent_at: string; last_send_status: string }>();
    if (emails.length) {
      const { data: sends } = await (context.supabase as any)
        .from("email_sends")
        .select("to_email, status, created_at")
        .eq("user_id", context.userId)
        .in("to_email", emails)
        .order("created_at", { ascending: false })
        .limit(1000);
      for (const s of (sends ?? []) as any[]) {
        const key = (s.to_email ?? "").trim().toLowerCase();
        if (!key || marks.has(key)) continue;
        marks.set(key, { last_sent_at: s.created_at, last_send_status: s.status });
      }
    }
    const withMarks = list.map((r) => {
      const m = marks.get((r.email ?? "").trim().toLowerCase());
      return { ...r, last_sent_at: m?.last_sent_at ?? null, last_send_status: m?.last_send_status ?? null };
    });

    return { rows: withMarks, count: count ?? 0 };
  });

/** Batches of contacts saved into the curated database, grouped by source batch job. */
export const listCrmBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await (context.supabase as any)
      .from("crm_contacts")
      .select("source_job_id, created_at, batch_jobs:source_job_id(name)")
      .eq("user_id", context.userId)
      .limit(5000);
    if (error) throw new Error(error.message);
    const map = new Map<string, { job_id: string | null; name: string; count: number; last: string }>();
    for (const r of (data ?? []) as any[]) {
      const key = r.source_job_id ?? "manual";
      const entry = map.get(key) ?? {
        job_id: r.source_job_id ?? null,
        name: r.batch_jobs?.name ?? (r.source_job_id ? "Batch" : "Manual / imported"),
        count: 0,
        last: r.created_at,
      };
      entry.count += 1;
      if (r.created_at > entry.last) entry.last = r.created_at;
      map.set(key, entry);
    }
    return { batches: [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1)) };
  });

type CrmInput = {
  company_name: string;
  contact_name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  domain?: string | null;
  city?: string | null;
  neq?: string | null;
  notes?: string | null;
  extra?: Record<string, unknown>;
};

export const addCrmContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { contacts: CrmInput[]; source?: string; source_job_id?: string | null }) => input)
  .handler(async ({ data, context }) => {
    const incoming = (data.contacts ?? []).filter((c) => c && c.company_name?.trim());
    if (!incoming.length) throw new Error("Nothing to add — every row needs at least a company name.");
    if (incoming.length > 5000) throw new Error("Add at most 5000 contacts at a time.");

    const emails = incoming
      .map((c) => (c.email ?? "").trim().toLowerCase())
      .filter((e) => e && EMAIL_RE.test(e));
    const existing = new Set<string>();
    if (emails.length) {
      for (let i = 0; i < emails.length; i += 500) {
        const { data: found } = await (context.supabase as any)
          .from("crm_contacts")
          .select("email")
          .eq("user_id", context.userId)
          .in("email", emails.slice(i, i + 500));
        for (const r of (found ?? []) as any[]) existing.add(String(r.email).toLowerCase());
      }
    }

    const seen = new Set<string>();
    const rows = incoming
      .map((c) => {
        const email = (c.email ?? "").trim().toLowerCase();
        const valid = email && EMAIL_RE.test(email) ? email : null;
        return {
          user_id: context.userId,
          company_name: c.company_name.trim().slice(0, 300),
          contact_name: c.contact_name?.trim() || null,
          title: c.title?.trim() || null,
          email: valid,
          phone: c.phone?.trim() || null,
          domain: c.domain?.trim() || null,
          city: c.city?.trim() || null,
          neq: c.neq?.trim() || null,
          notes: c.notes?.trim() || null,
          source: data.source ?? "manual",
          source_job_id: data.source_job_id ?? null,
          extra: c.extra ?? {},
        };
      })
      .filter((r) => {
        if (!r.email) return true;
        if (existing.has(r.email) || seen.has(r.email)) return false;
        seen.add(r.email);
        return true;
      });

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await (context.supabase as any).from("crm_contacts").insert(chunk);
      if (error) throw new Error(error.message);
      inserted += chunk.length;
    }
    return { inserted, skipped: incoming.length - inserted };
  });

/** Copies enriched batch results into the curated contact database. */
export const addVerifiedToCrm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ids: string[] }) => input)
  .handler(async ({ data, context }) => {
    const ids = (data.ids ?? []).slice(0, 2000);
    if (!ids.length) throw new Error("Select at least one contact.");
    const { data: rows, error } = await context.supabase
      .from("contacts")
      .select("*")
      .eq("user_id", context.userId)
      .in("id", ids);
    if (error) throw new Error(error.message);

    const emails = (rows ?? []).map((r: any) => (r.email ?? "").toLowerCase()).filter(Boolean);
    const existing = new Set<string>();
    if (emails.length) {
      const { data: found } = await (context.supabase as any)
        .from("crm_contacts")
        .select("email")
        .eq("user_id", context.userId)
        .in("email", emails);
      for (const r of (found ?? []) as any[]) existing.add(String(r.email).toLowerCase());
    }

    const seen = new Set<string>();
    const payload = (rows ?? [])
      .map((r: any) => ({
        user_id: context.userId,
        company_name: r.company_name,
        contact_name: r.executive_name,
        title: r.title,
        email: r.email ? String(r.email).toLowerCase() : null,
        phone: r.phone,
        domain: r.domain,
        city: r.city,
        neq: r.neq,
        source: r.source ?? "batch",
        source_job_id: r.job_id,
        source_contact_id: r.id,
        extra: r.source_row ?? {},
      }))
      .filter((r) => {
        if (!r.email) return true;
        if (existing.has(r.email) || seen.has(r.email)) return false;
        seen.add(r.email);
        return true;
      });

    if (payload.length) {
      const { error: insErr } = await (context.supabase as any).from("crm_contacts").insert(payload);
      if (insErr) throw new Error(insErr.message);
    }
    return { inserted: payload.length, skipped: ids.length - payload.length };
  });

export const deleteCrmContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ids?: string[]; job_id?: string | null; all?: boolean }) => input)
  .handler(async ({ data, context }) => {
    let q = (context.supabase as any).from("crm_contacts").delete().eq("user_id", context.userId);
    if (data.ids?.length) q = q.in("id", data.ids.slice(0, 2000));
    else if (data.job_id) q = q.eq("source_job_id", data.job_id);
    else if (data.job_id === null && data.all !== true) q = q.is("source_job_id", null);
    else if (!data.all) throw new Error("Nothing selected.");
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Deletes a batch's enrichment results, optionally purging its saved contacts too. */
export const deleteBatchResults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { job_id: string; also_database: boolean }) => input)
  .handler(async ({ data, context }) => {
    const { count } = await (context.supabase as any)
      .from("crm_contacts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("source_job_id", data.job_id);
    if (data.also_database) {
      const { error } = await (context.supabase as any)
        .from("crm_contacts")
        .delete()
        .eq("user_id", context.userId)
        .eq("source_job_id", data.job_id);
      if (error) throw new Error(error.message);
    }
    const { error: cErr } = await context.supabase
      .from("contacts")
      .delete()
      .eq("user_id", context.userId)
      .eq("job_id", data.job_id);
    if (cErr) throw new Error(cErr.message);
    return { ok: true, database_contacts: count ?? 0, database_deleted: data.also_database };
  });

// -------------------------------------------------------------- templates

export const listTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await (context.supabase as any)
      .from("email_templates")
      .select("*")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { rows: data ?? [] };
  });

export const saveTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id?: string | null; name: string; subject: string; body: string }) => input)
  .handler(async ({ data, context }) => {
    if (!data.name.trim() || !data.subject.trim() || !data.body.trim())
      throw new Error("Name, subject and body are all required.");
    const payload = {
      user_id: context.userId,
      name: data.name.trim().slice(0, 120),
      subject: data.subject.trim().slice(0, 300),
      body: data.body.slice(0, 20000),
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { error } = await (context.supabase as any)
        .from("email_templates")
        .update(payload)
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await (context.supabase as any)
      .from("email_templates")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await (context.supabase as any)
      .from("email_templates")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ------------------------------------------------------------------ sends

type Recipient = {
  email: string;
  company_name?: string | null;
  contact_name?: string | null;
  title?: string | null;
  phone?: string | null;
  city?: string | null;
  domain?: string | null;
  crm_contact_id?: string | null;
  job_id?: string | null;
};

export const sendCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { recipients: Recipient[]; subject: string; body: string; template_id?: string | null }) => input,
  )
  .handler(async ({ data, context }) => {
    const recipients = (data.recipients ?? []).filter((r) => r?.email && EMAIL_RE.test(r.email)).slice(0, 500);
    if (!recipients.length) throw new Error("No valid email addresses in the selection.");
    if (!data.subject.trim() || !data.body.trim()) throw new Error("Subject and body are required.");

    const { data: settingsRow } = await context.supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    const settings = (settingsRow ?? {}) as Record<string, any>;
    const dryRun = settings["email_dry_run"] !== false;
    const { config, problem } = smtpConfigFrom(settings);
    if (!dryRun && !config) throw new Error(problem ?? "SMTP is not configured.");

    // Daily cap
    const cap = settings["email_daily_cap"] ? Number(settings["email_daily_cap"]) : null;
    let remaining = Infinity;
    if (cap && cap > 0) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await (context.supabase as any)
        .from("email_sends")
        .select("id", { count: "exact", head: true })
        .eq("user_id", context.userId)
        .eq("status", "sent")
        .eq("dry_run", false)
        .gte("created_at", since);
      remaining = Math.max(cap - (count ?? 0), 0);
      if (remaining === 0 && !dryRun) throw new Error(`Daily cap of ${cap} emails reached. Try again later.`);
    }

    const throttle = Math.min(Math.max(Number(settings["email_throttle_seconds"] ?? 0) || 0, 0), 60);
    const results: { email: string; status: string; error?: string }[] = [];
    const logs: any[] = [];

    for (const r of recipients) {
      if (!dryRun && results.filter((x) => x.status === "sent").length >= remaining) {
        results.push({ email: r.email, status: "skipped", error: "Daily cap reached" });
        logs.push({
          user_id: context.userId,
          to_email: r.email,
          company_name: r.company_name ?? null,
          contact_name: r.contact_name ?? null,
          from_email: config?.from_email ?? null,
          from_name: config?.from_name ?? null,
          reply_to: config?.reply_to ?? null,
          subject: data.subject,
          body: data.body,
          status: "failed",
          error: "Daily cap reached",
          dry_run: dryRun,
          template_id: data.template_id ?? null,
          job_id: r.job_id ?? null,
          crm_contact_id: r.crm_contact_id ?? null,
        });
        continue;
      }

      const merge = mergeDataFor({ ...r, email: r.email });
      const subject = renderTemplate(data.subject, merge);
      const text = renderTemplate(data.body, merge);
      let status = "sent";
      let error: string | null = null;

      if (!dryRun && config) {
        const res = await sendSmtpMessage(config, { to: r.email, subject, text, html: textToHtml(text) });
        if (!res.ok) {
          status = "failed";
          error = res.message;
        }
      }

      results.push({ email: r.email, status, ...(error ? { error } : {}) });
      logs.push({
        user_id: context.userId,
        to_email: r.email,
        company_name: r.company_name ?? null,
        contact_name: r.contact_name ?? null,
        from_email: config?.from_email ?? null,
        from_name: config?.from_name ?? null,
        reply_to: config?.reply_to ?? null,
        subject,
        body: text,
        status,
        error,
        dry_run: dryRun,
        template_id: data.template_id ?? null,
        job_id: r.job_id ?? null,
        crm_contact_id: r.crm_contact_id ?? null,
      });

      if (throttle && !dryRun) await new Promise((res) => setTimeout(res, throttle * 1000));
    }

    for (let i = 0; i < logs.length; i += 200) {
      await (context.supabase as any).from("email_sends").insert(logs.slice(i, i + 200));
    }

    const sent = results.filter((r) => r.status === "sent").length;
    return { sent, failed: results.length - sent, dry_run: dryRun, results };
  });

export const listEmailSends = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { search?: string; status?: string; limit?: number; offset?: number }) => input)
  .handler(async ({ data, context }) => {
    const limit = Math.min(Math.max(Number(data.limit ?? 50), 1), 200);
    const offset = Math.max(Number(data.offset ?? 0), 0);
    let q = (context.supabase as any)
      .from("email_sends")
      .select("*", { count: "exact" })
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    if (data.search?.trim()) {
      const s = data.search.trim().replace(/[%,]/g, " ");
      q = q.or(`to_email.ilike.%${s}%,company_name.ilike.%${s}%,subject.ilike.%${s}%`);
    }
    const { data: rows, count, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [], count: count ?? 0 };
  });
