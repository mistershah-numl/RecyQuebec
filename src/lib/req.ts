// Shared, client-safe helpers for the Quebec REQ pipeline.

export const LEGAL_SUFFIXES = [
  "inc",
  "inc.",
  "ltee",
  "ltée",
  "ltd",
  "ltd.",
  "limited",
  "limitee",
  "limitée",
  "senc",
  "s.e.n.c.",
  "sencrl",
  "srl",
  "s.a.r.l",
  "corp",
  "corp.",
  "corporation",
  "co",
  "co.",
  "enr",
  "enr.",
  "cie",
  "llc",
  "lp",
];

/** Strips legal suffixes / punctuation so the name is searchable. */
export function cleanCompanyName(raw: string): string {
  let name = (raw || "").normalize("NFKC").replace(/["“”']/g, " ").replace(/\s+/g, " ").trim();
  let changed = true;
  while (changed) {
    changed = false;
    const parts = name.split(/[\s,]+/).filter(Boolean);
    if (parts.length > 1) {
      const last = parts[parts.length - 1]!.toLowerCase().replace(/[.,]/g, "");
      if (LEGAL_SUFFIXES.includes(last) || LEGAL_SUFFIXES.includes(last + ".")) {
        parts.pop();
        name = parts.join(" ").replace(/[,\s]+$/, "");
        changed = true;
      }
    }
  }
  return name.trim() || raw.trim();
}

export type ReqRow = {
  row_index: number;
  neq: string | null;
  company_name: string;
  postal_code: string | null;
  city: string | null;
  /** REQ employee-count range code (O, A, B, ...) when the file provides one. */
  employee_band: string | null;
  /** Verbatim copy of the uploaded spreadsheet row, so exports can replay it. */
  source_row: Record<string, string>;
};


const HEADER_MAP: Record<string, keyof Omit<ReqRow, "row_index">> = {
  neq: "neq",
  "numero d'entreprise": "neq",
  "numéro d'entreprise": "neq",
  company: "company_name",
  "company name": "company_name",
  nom: "company_name",
  nom_principal: "company_name",
  "nom principal": "company_name",
  "nom de l'entreprise": "company_name",
  entreprise: "company_name",
  "raison sociale": "company_name",
  "postal code": "postal_code",
  postal: "postal_code",
  "code postal": "postal_code",
  code_postal: "postal_code",
  cp: "postal_code",
  zip: "postal_code",
  city: "city",
  ville: "city",
  municipalite: "city",
  municipalité: "city",
  adr_domcl_lign2_adr: "city",
  "employee count": "employee_band",
  "employee count range code": "employee_band",
  employees: "employee_band",
  "nb employes": "employee_band",
  "nb employés": "employee_band",
  nb_empl: "employee_band",
  nb_employes: "employee_band",
  "nombre d'employes": "employee_band",
  "nombre d'employés": "employee_band",
  effectif: "employee_band",
  effectifs: "employee_band",
  "tranche effectif": "employee_band",
  cd_nb_empl: "employee_band",
  cd_nb_employe: "employee_band",
  "code nb employes": "employee_band",
  cod_intval_emplo_que: "employee_band",
  cod_intval_emploi_que: "employee_band",
  cod_intval_emplo: "employee_band",
  "code intervalle emplois": "employee_band",
  "code intervalle employes": "employee_band",
  "intervalle emplois quebec": "employee_band",
  "intervalle emplois québec": "employee_band",
};

/** Header names (normalised) that carry the REQ employee-size code. */
const EMPLOYEE_HEADER_KEYS = new Set(
  Object.entries(HEADER_MAP)
    .filter(([, field]) => field === "employee_band")
    .map(([header]) => header),
);

/**
 * Reads the employee-size code straight from a stored source_row, using the
 * same header aliases as upload. Returns the normalised band (O, A … H) or
 * null when the row has no code (REQ "N" / unspecified).
 */
export function employeeBandFromSourceRow(src: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(src ?? {})) {
    const norm = key.toString().replace(/^\uFEFF/, "").trim().toLowerCase();
    if (!EMPLOYEE_HEADER_KEYS.has(norm)) continue;
    const band = normaliseEmployeeBand(value);
    if (band) return band;
  }
  return null;
}

/** REQ employee-count range codes and what they mean. */
export const EMPLOYEE_BANDS = [
  { code: "O", label: "O — 0 employees / not declared", tiny: true },
  { code: "A", label: "A — 1 to 5 employees", tiny: true },
  { code: "B", label: "B — 6 to 10 employees", tiny: true },
  { code: "C", label: "C — 11 to 25 employees", tiny: false },
  { code: "D", label: "D — 26 to 50 employees", tiny: false },
  { code: "E", label: "E — 51 to 100 employees", tiny: false },
  { code: "F", label: "F — 101 to 200 employees", tiny: false },
  { code: "G", label: "G — 201 to 500 employees", tiny: false },
  { code: "H", label: "H — 501 employees and more", tiny: false },
] as const;

export type EmployeeBandCode = (typeof EMPLOYEE_BANDS)[number]["code"];

/**
 * Normalises whatever the file holds into a single band code.
 * Accepts letter codes (o/a/b...), plain counts (0, 3, 40) and ranges ("6-10").
 * Returns null when the row carries no employee information at all.
 */
export function normaliseEmployeeBand(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const letter = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[OABCDEFGH]$/.test(letter)) return letter;
  const nums = s.match(/\d+/g);
  if (!nums) return null;
  const n = Number(nums[0]);
  if (!isFinite(n)) return null;
  if (n <= 0) return "O";
  if (n <= 5) return "A";
  if (n <= 10) return "B";
  if (n <= 25) return "C";
  if (n <= 50) return "D";
  if (n <= 100) return "E";
  if (n <= 200) return "F";
  if (n <= 500) return "G";
  return "H";
}

/** REQ exports NEQ as "1173047888.00" — normalise to a clean digit string. */
export function cleanNeq(raw: string): string {
  const s = raw.trim().replace(/\.0+$/, "");
  return /^\d+$/.test(s) ? s : raw.trim();
}

/** "Québec (Québec)" -> "Québec" */
export function cleanCity(raw: string): string {
  return raw.replace(/\s*\(.*\)\s*$/, "").trim();
}

/** Maps an arbitrary spreadsheet record to a REQ row. */
export function mapRecord(record: Record<string, unknown>, index: number): ReqRow | null {
  const out: Record<string, string | null> = {
    neq: null,
    company_name: "",
    postal_code: null,
    city: null,
    employee_band: null,
  };
  for (const [key, value] of Object.entries(record)) {
    const norm = key.toString().replace(/^\uFEFF/, "").trim().toLowerCase();
    const field = HEADER_MAP[norm];
    if (!field) continue;
    const v = value == null ? "" : String(value).trim();
    if (v) out[field] = v;
  }
  if (!out["company_name"]) {
    // fall back to the first non-empty, non-numeric string column
    const first = Object.values(record).find(
      (v) => typeof v === "string" && v.trim().length > 1 && !/^[\d.,\s]+$/.test(v.trim()),
    );
    if (!first) return null;
    out["company_name"] = String(first).trim();
  }
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const label = key.toString().replace(/^\uFEFF/, "").trim();
    if (!label) continue;
    source[label] = value == null ? "" : String(value).trim().slice(0, 500);
  }

  return {
    row_index: index,
    neq: out["neq"] ? cleanNeq(out["neq"]) : null,
    company_name: out["company_name"]!,
    postal_code: out["postal_code"] ?? null,
    city: out["city"] ? cleanCity(out["city"]) : null,
    employee_band: normaliseEmployeeBand(out["employee_band"]),
    source_row: source,
  };
}

/** Column names of the uploaded file, in their original order. */
export function sourceHeaders(records: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const rec of records.slice(0, 50)) {
    for (const key of Object.keys(rec)) {
      const label = key.replace(/^\uFEFF/, "").trim();
      if (label && !seen.includes(label)) seen.push(label);
    }
  }
  return seen.slice(0, 60);
}


export type ModelOption = {
  value: string;
  label: string;
  /** Which stored key unlocks it; null = built-in Lovable AI (always available). */
  requiresKey: "gemini_key" | "openai_key" | "perplexity_key" | "anthropic_key" | "custom_ai_key" | null;
};

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "google/gemini-3.1-flash-lite", label: "Lovable AI — Gemini Flash Lite (fastest / cheapest)", requiresKey: null },
  { value: "google/gemini-3.6-flash", label: "Lovable AI — Gemini Flash (balanced, default)", requiresKey: null },
  { value: "google/gemini-2.5-pro", label: "Lovable AI — Gemini Pro (deepest reasoning)", requiresKey: null },
  { value: "openai/gpt-5.6-luna", label: "Lovable AI — GPT-5.6 Luna (fast)", requiresKey: null },
  { value: "gemini/gemini-flash-latest", label: "Your Gemini key — Gemini Flash (latest)", requiresKey: "gemini_key" },
  { value: "gemini/gemini-pro-latest", label: "Your Gemini key — Gemini Pro (latest)", requiresKey: "gemini_key" },
  { value: "gemini/gemini-3.6-flash", label: "Your Gemini key — Gemini 3.6 Flash", requiresKey: "gemini_key" },
  { value: "openai/gpt-4o-mini", label: "Your OpenAI key — GPT-4o mini", requiresKey: "openai_key" },
  { value: "openai/gpt-4o", label: "Your OpenAI key — GPT-4o", requiresKey: "openai_key" },
  { value: "perplexity/sonar-pro", label: "Your Perplexity key — Sonar Pro (live web)", requiresKey: "perplexity_key" },
  { value: "anthropic/claude-sonnet", label: "Your Anthropic key — Claude Sonnet", requiresKey: "anthropic_key" },
];

/** Default model list for a custom OpenAI-compatible service (e.g. Mammouth AI). */
export const DEFAULT_CUSTOM_MODELS = "gemini-3.8-flash";
export const CUSTOM_PROVIDER_PREFIX = "custom/";

/** Turns the comma/newline separated model list into selectable options. */
export function customModelOptions(raw: unknown, serviceLabel = "Custom service"): ModelOption[] {
  return String(raw ?? "")
    .split(/[\n,]+/)
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((m) => ({
      value: `${CUSTOM_PROVIDER_PREFIX}${m}`,
      label: `${serviceLabel} — ${m}`,
      requiresKey: "custom_ai_key" as const,
    }));
}

/** A saved OpenAI-compatible service with the models the user picked from it. */
export type SavedAiService = { id: string; name: string; base_url: string; models: string[] };

/** Model value encoding for a saved service: svc:<service id>:<model name>. */
export const SERVICE_PREFIX = "svc:";
export function serviceModelValue(serviceId: string, model: string): string {
  return `${SERVICE_PREFIX}${serviceId}:${model}`;
}
export function parseServiceModel(value: string): { serviceId: string; model: string } | null {
  const m = /^svc:([^:]+):(.+)$/.exec(value);
  return m ? { serviceId: m[1]!, model: m[2]! } : null;
}

export function serviceModelOptions(services: SavedAiService[]): ModelOption[] {
  return services.flatMap((s) =>
    (s.models ?? []).map((m) => ({
      value: serviceModelValue(s.id, m),
      label: `${s.name} — ${m}`,
      requiresKey: null,
    })),
  );
}

/** Models the user can actually run: built-ins plus anything their keys/services unlock. */
export function availableModels(
  keys: Record<string, unknown>,
  services: SavedAiService[] = [],
): ModelOption[] {
  const base = MODEL_OPTIONS.filter((m) => !m.requiresKey || Boolean(keys[m.requiresKey]));
  const custom = keys["custom_ai_key"]
    ? customModelOptions(keys["custom_ai_models"] ?? DEFAULT_CUSTOM_MODELS, "Your custom AI service")
    : [];
  return [...base, ...custom, ...serviceModelOptions(services)];
}


export const OSINT_SOURCES = [
  { key: "registry", label: "Company registry mirrors", hint: "b2bhint / opencorporates style pages: legal address, officers, NEQ match" },
  { key: "directories", label: "Business directories", hint: "Pages Jaunes, Yellow Pages, Canada411, Yelp listings" },
  { key: "address", label: "Capture postal address", hint: "Extract and save the company's street address" },
  { key: "linkedin", label: "LinkedIn company page", hint: "Find the company on LinkedIn and mine its public page" },
  { key: "facebook", label: "Facebook page", hint: "Public Facebook / mbasic about page often exposes an email" },
  { key: "domainGuess", label: "Direct domain probing", hint: "Try name.com / name.ca when search finds no site" },
  { key: "deepCrawl", label: "Deep site crawl", hint: "sitemap.xml + /contact, /nous-joindre, /equipe pages" },
  { key: "patternEmails", label: "Email pattern guessing", hint: "first.last@domain candidates, MX-checked" },
  { key: "companyStatus", label: "Legal status (active / dissolved)", hint: "Only saved when two independent registry sources agree — untick to ignore status entirely" },
  { key: "useAiFallback", label: "AI fallback", hint: "Only call the AI model when OSINT finds nothing" },

] as const;

export type OsintSourceKey = (typeof OSINT_SOURCES)[number]["key"];

/** When to escalate a record to the AI agent, based on the OSINT confidence score. */
export const AI_FALLBACK_THRESHOLDS = [
  { value: 0, label: "Only when OSINT finds nothing", hint: "Any verified OSINT email is accepted as-is" },
  { value: 1, label: "Score below 1/5", hint: "Escalate records with no usable confidence" },
  { value: 2, label: "Score below 2/5", hint: "Escalate weakly corroborated records" },
  { value: 3, label: "Score below 3/5", hint: "Recommended — escalate anything not solidly corroborated" },
  { value: 4, label: "Score below 4/5", hint: "Escalate unless the email is strongly corroborated" },
  { value: 5, label: "Score below 5/5", hint: "Escalate everything that is not perfectly verified" },
] as const;


export function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\n");
  return `${head}\n${body}`;
}

export function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
