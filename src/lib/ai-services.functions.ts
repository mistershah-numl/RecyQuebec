import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createServerFn } from "@tanstack/react-start";

function cleanBase(raw: unknown): string {
  const base = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("The service address must start with http:// or https:// (e.g. https://api.mammouth.ai/v1)");
  }
  return base;
}

/** Saved AI services for the signed-in user (keys never leave the server). */
export const listAiServices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("ai_services")
      .select("id, name, base_url, models, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    return (data ?? []) as { id: string; name: string; base_url: string; models: string[] }[];
  });

/** Asks the service which models the key can run. */
export const fetchServiceModels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id?: string | null; base_url: string; api_key?: string | null }) => input)
  .handler(async ({ data, context }) => {
    const base = cleanBase(data.base_url);
    let key = (data.api_key ?? "").trim();
    if ((!key || key.includes("•")) && data.id) {
      const { data: row } = await context.supabase
        .from("ai_services")
        .select("api_key")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .maybeSingle();
      key = (row?.api_key ?? "").toString();
    }
    if (!key) return { ok: false, message: "Enter the service key first.", models: [] as string[] };
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, message: `The service rejected the key (${res.status}).`, models: [] };
      const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] };
      const models = [
        ...(body.data ?? []).map((m) => m.id),
        ...(body.models ?? []).map((m) => m.id ?? m.name),
      ]
        .filter((m): m is string => Boolean(m && m.trim()))
        .map((m) => m.replace(/^models\//, ""))
        .filter((m, i, all) => all.indexOf(m) === i)
        .sort();
      return {
        ok: true,
        message: models.length ? `Found ${models.length} model(s).` : "Key works, but the service listed no models.",
        models,
      };
    } catch (e) {
      return { ok: false, message: `Could not reach the service: ${(e as Error).message}`, models: [] };
    }
  });

/** Creates or updates one service. */
export const saveAiService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { id?: string | null; name: string; base_url: string; api_key?: string | null; models: string[] }) => input,
  )
  .handler(async ({ data, context }) => {
    const base = cleanBase(data.base_url);
    const name = (data.name ?? "").trim().slice(0, 80) || "AI service";
    const models = (data.models ?? [])
      .map((m) => String(m).trim())
      .filter(Boolean)
      .filter((m, i, all) => all.indexOf(m) === i)
      .slice(0, 40);
    if (!models.length) throw new Error("Pick at least one model for this service.");
    const key = (data.api_key ?? "").trim();

    if (data.id) {
      const patch: {
        name: string;
        base_url: string;
        models: string[];
        updated_at: string;
        api_key?: string;
      } = { name, base_url: base, models, updated_at: new Date().toISOString() };
      if (key && !key.includes("•")) patch.api_key = key;
      const { error } = await context.supabase
        .from("ai_services")
        .update(patch)
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { ok: true, id: data.id };
    }

    if (!key) throw new Error("Enter the service key.");
    const { data: row, error } = await context.supabase
      .from("ai_services")
      .insert({ user_id: context.userId, name, base_url: base, api_key: key, models })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, id: row.id };
  });

export const deleteAiService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("ai_services")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
