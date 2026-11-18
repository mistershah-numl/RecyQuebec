// Server-only enrichment worker. Bounded, idempotent, lease-protected.
import { buildReferences, collectiveScore, scoreLabel } from "./domain-authority";
import { cleanCompanyName } from "./req";
import { guardRow, sharedDomainAllowed } from "./domain-guard";

const DEFAULT_BATCH_SIZE = 2; // system default: one bounded concurrent wave per invocation
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 25;
const MAX_ROW_ATTEMPTS = 5;

type AnySupabase = {
  from: (t: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

export type EnrichResult = {
  executive_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  domain: string | null;
  verification_status: "Verified" | "MX Verified" | "Unverified" | "Invalid";
  confidence: number;
  source: string;
  address: string | null;
  linkedin_url: string | null;
  facebook_url: string | null;
  registry_url: string | null;
  company_status: string | null;
  email_type: "executive" | "company" | "personal" | "unknown";
  verification_details: Record<string, unknown>;
};


/** DNS-over-HTTPS MX lookup (the Worker runtime has no dns/promises). */
export async function hasMx(domain: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: "application/dns-json" }, signal: signal ?? null },
    );
    if (!res.ok) return false;
    const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return Boolean(json.Answer?.some((a) => a.type === 15));
  } catch {
    return false;
  }
}

type ProviderConfig = { url: string; headers: Record<string, string>; model: string };

function resolveProvider(model: string, keys: Record<string, string | null>): ProviderConfig {
  // One of the saved OpenAI-compatible services: svc:<service id>:<model>
  const saved = /^svc:([^:]+):(.+)$/.exec(model);
  if (saved) {
    const base = (keys[`svc:${saved[1]}:url`] ?? "").replace(/\/+$/, "");
    const key = keys[`svc:${saved[1]}:key`];
    if (!base || !key) throw new Error("That AI service is no longer configured — check API Settings.");
    return {
      url: `${base}/chat/completions`,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      model: saved[2]!,
    };
  }
  // Any OpenAI-compatible service the user configured (e.g. Mammouth AI).
  if (model.startsWith("custom/")) {
    const key = keys["custom_ai_key"];
    if (!key) throw new Error("Custom AI service key missing — add it in API Settings.");
    const base = (keys["custom_ai_base_url"] || "https://api.mammouth.ai/v1").replace(/\/+$/, "");
    return {
      url: `${base}/chat/completions`,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      model: model.replace("custom/", ""),
    };
  }
  if (model.startsWith("perplexity/")) {

    const key = keys["perplexity_key"];
    if (!key) throw new Error("Perplexity API key missing — add it in API Settings.");
    return {
      url: "https://api.perplexity.ai/chat/completions",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      model: model.replace("perplexity/", ""),
    };
  }
  if (model.startsWith("anthropic/") && keys["anthropic_key"]) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": keys["anthropic_key"]!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      model: "claude-sonnet-4-20250514",
    };
  }
  if (model.startsWith("openai/") && keys["openai_key"]) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: `Bearer ${keys["openai_key"]}`, "content-type": "application/json" },
      model: model.replace("openai/", ""),
    };
  }
  // Explicit "gemini/" prefix = always the user's own Google AI Studio key.
  if (model.startsWith("gemini/")) {
    const key = keys["gemini_key"];
    if (!key) throw new Error("Google Gemini API key missing — add it in API Settings.");
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      model: model.replace("gemini/", ""),
    };
  }
  if (model.startsWith("google/") && keys["gemini_key"]) {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      headers: { authorization: `Bearer ${keys["gemini_key"]}`, "content-type": "application/json" },
      model: model.replace("google/", ""),
    };
  }
  const fallbackKey = process.env["AI_GATEWAY_KEY"] || process.env["GEMINI_API_KEY"] || process.env["OPENAI_API_KEY"];
  if (!fallbackKey) throw new Error("No AI key configured. Please configure your Gemini, OpenAI, or custom LLM key in Settings.");
  return {
    url: process.env["AI_GATEWAY_URL"] || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    headers: { authorization: `Bearer ${fallbackKey}`, "content-type": "application/json" },
    model,
  };
}

export class BlockedError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const SYSTEM_PROMPT = `You are an OSINT B2B contact researcher for Quebec (Canada) companies.
Your job: independently find this company's accurate details from everything you can reach
or recall. You may also be shown what an OSINT scraper already found — treat it only as a
reference to compare against; return your own values when they are more accurate.
You are asked about a real, registered Quebec business. Recall everything you actually know
about it from public sources: its own website, Pages Jaunes / Yellow Pages / Canada411,
Zone Réno, RBQ / CMEQ / VériBât licence pages, the Registraire des entreprises (NEQ),
LinkedIn, Facebook and local directories.
Return: the official web domain, the company's public street address, its main phone number,
a business email address, and a senior person (owner, president, CEO, general manager) with
their title, when you know them.
Rules:
- Report facts you actually recall for THIS exact company in this exact city. Do not fabricate.
- A generic company mailbox (info@, contact@, ventes@ on the company's OWN domain) is a good
  answer when you know the domain and no named mailbox is public — say so in "source".
- Phone: Canadian format, e.g. 514-371-9485. Address: full street, city, province, postal code.
- Never return a mailbox, domain or phone belonging to a marketplace, hosting provider,
  directory or unrelated business (amazon.com, google.com, wix, shopify, godaddy…).
- Return null only for the fields you genuinely do not know; still fill the ones you do.
- "source" must describe where each value comes from (e.g. "company website + CMEQ licence page").
Answer with STRICT JSON only: {"domain":string|null,"website":string|null,"executive_name":string|null,"title":string|null,"email":string|null,"phone":string|null,"address":string|null,"source":string}`;


/** Cache of "requested Gemini model -> model that actually exists on this key". */
const geminiModelFix = new Map<string, string>();

/** Ask Google AI Studio which models this key can use, and pick the closest match. */
async function resolveGeminiModel(
  key: string,
  requested: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: signal ?? null },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    const names = (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((n) => n.startsWith("gemini") && !/embedding|vision|aqa|image|tts|live/i.test(n));
    if (!names.length) return null;
    const wantsPro = /pro/i.test(requested);
    const rank = (n: string) => {
      let score = 0;
      if (wantsPro === /pro/i.test(n)) score += 40;
      if (/latest/.test(n)) score += 12;
      if (/flash/i.test(n) && !wantsPro) score += 8;
      if (/preview|exp/i.test(n)) score -= 15;
      const version = Number.parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? "0");
      return score + version * 3;
    };
    return names.sort((a, b) => rank(b) - rank(a))[0] ?? null;
  } catch {
    return null;
  }
}

async function callModel(
  model: string,
  keys: Record<string, string | null>,
  prompt: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const cfg = resolveProvider(model, keys);
  const isAnthropic = cfg.url.includes("anthropic.com");
  const isGoogleDirect = cfg.url.includes("generativelanguage.googleapis.com");

  const buildBody = (modelId: string) =>
    isAnthropic
      ? {
          model: modelId,
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }
      : {
          model: modelId,
          ...(modelId.startsWith("gpt-5.6") ? { reasoning_effort: "none" } : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        };

  let modelId = (isGoogleDirect && geminiModelFix.get(cfg.model)) || cfg.model;

  const post = (id: string) =>
    fetch(cfg.url, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify(buildBody(id)),
      signal: signal ?? null,
    });

  let res = await post(modelId);

  // Google retires model aliases regularly: discover a live one and retry once.
  if (!res.ok && res.status === 404 && isGoogleDirect && keys["gemini_key"]) {
    const replacement = await resolveGeminiModel(keys["gemini_key"]!, modelId, signal);
    if (replacement && replacement !== modelId) {
      geminiModelFix.set(cfg.model, replacement);
      modelId = replacement;
      res = await post(modelId);
    }
  }

  if (!res.ok) {
    const text = await res.text();
    if ([402, 403].includes(res.status)) throw new BlockedError(text.slice(0, 300), res.status);
    if (res.status === 429) throw new BlockedError("Rate limited by the AI provider.", 429);
    if (res.status === 404 && isGoogleDirect) {
      throw new Error(
        `AI error 404: model "${modelId}" is not available on your Gemini key. Pick "Gemini Flash (latest)" in API Settings.`,
      );
    }
    throw new Error(`AI error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as any;
  const content: string = isAnthropic
    ? (json.content?.[0]?.text ?? "")
    : (json.choices?.[0]?.message?.content ?? "");
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

const DISPOSABLE = /(mailinator|guerrillamail|10minutemail|yopmail|tempmail|trashmail)\./;

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "hotmail.com", "hotmail.ca",
  "outlook.com", "live.com", "live.ca", "msn.com", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "gmx.com", "mail.com", "videotron.ca", "sympatico.ca",
  "bell.net", "globetrotter.net", "hotmail.fr", "yahoo.fr",
]);

const ROLE_LOCAL = /^(info|contact|admin|sales|support|service|ventes|bureau|reception|accueil|hello|office|comptabilite|accounting)$/i;

/** Generic DNS-over-HTTPS lookup (the Worker runtime has no dns/promises). */
async function dns(name: string, type: "MX" | "A" | "TXT", signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: signal ?? null },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { Answer?: { data: string }[] };
    return (json.Answer ?? []).map((a) => a.data);
  } catch {
    return [];
  }
}

/**
 * Big platform / vendor domains. An address on one of these is a support or
 * notification mailbox scraped from a cookie banner, hosting page or error
 * screen — never the contact of a small Quebec business.
 */
const VENDOR_DOMAINS =
  /^(?:.*\.)?(amazon|amazonaws|aws|google|googlemail|gstatic|youtube|microsoft|office365|outlook365|live|msn|apple|icloud|meta|facebook|instagram|whatsapp|linkedin|twitter|x|tiktok|paypal|stripe|shopify|wix|wixpress|squarespace|wordpress|automattic|godaddy|cloudflare|namecheap|hostinger|bluehost|mailchimp|sendgrid|mailgun|hubspot|salesforce|zendesk|intercom|sentry|adobe|oracle|ibm|yelp|indeed|glassdoor|tripadvisor|kijiji|pagesjaunes|yellowpages|canada411|bell|videotron|telus|rogers|例)\.[a-z.]{2,}$/i;

export function isVendorDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && VENDOR_DOMAINS.test(domain.toLowerCase()));
}

export type EmailAssessment = {
  status: "Verified" | "MX Verified" | "Unverified" | "Invalid";
  confidence: number;
  email_type: "executive" | "company" | "personal" | "unknown";
  signals: Record<string, boolean | number | string>;
  reasons: string[];
};

export type AssessContext = {
  /** How this address was obtained. */
  origin: "own-domain" | "web" | "pattern" | "generic" | "ai";
  /** The company's confirmed web domain, when known. */
  companyDomain?: string | null;
  /** Executive name the address is supposed to belong to. */
  personName?: string | null;
  /** Raw page text collected during OSINT, used to count corroborating sources. */
  corpus?: string[];
};

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Multi-signal verification. An address is only "Verified" when the mail
 * domain really accepts mail AND the address is corroborated by independent
 * public evidence (own-domain page, name match, or several sources).
 */
export async function assessEmail(email: string, ctx: AssessContext, signal?: AbortSignal): Promise<EmailAssessment> {
  const reasons: string[] = [];
  const signals: Record<string, boolean | number | string> = { origin: ctx.origin };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { status: "Invalid", confidence: 0, email_type: "unknown", signals, reasons: ["Malformed address"] };
  }
  const [local, domain] = [email.split("@")[0]!.toLowerCase(), email.split("@")[1]!.toLowerCase()];

  // A big-platform mailbox (amazon.com, google.com, wixpress…) is never this
  // company's contact, no matter how healthy its DNS looks.
  if (isVendorDomain(domain) && domain !== (ctx.companyDomain ?? "").toLowerCase()) {
    return {
      status: "Invalid",
      confidence: 0,
      email_type: "unknown",
      signals: { ...signals, vendor_domain: true },
      reasons: [`${domain} is a third-party platform mailbox, not this company's address`],
    };
  }

  if (DISPOSABLE.test(domain)) {
    return { status: "Invalid", confidence: 0, email_type: "unknown", signals, reasons: ["Disposable mail domain"] };
  }

  const [mxRecords, aRecords, txt, dmarc] = await Promise.all([
    dns(domain, "MX", signal),
    dns(domain, "A", signal),
    dns(domain, "TXT", signal),
    dns(`_dmarc.${domain}`, "TXT", signal),
  ]);
  const mx = mxRecords.length > 0;
  const spf = txt.some((t) => t.toLowerCase().includes("v=spf1"));
  const hasDmarc = dmarc.some((t) => t.toLowerCase().includes("v=dmarc1"));
  signals["mx"] = mx;
  signals["a_record"] = aRecords.length > 0;
  signals["spf"] = spf;
  signals["dmarc"] = hasDmarc;
  signals["mx_host"] = mxRecords[0]?.split(" ").pop() ?? "";

  if (!mx) {
    reasons.push("Domain has no mail server (MX) — mail cannot be delivered");
    return { status: "Invalid", confidence: 0, email_type: "unknown", signals, reasons };
  }
  reasons.push(`Mail server found: ${String(signals["mx_host"] ?? domain)}`);
  if (spf) reasons.push("Domain publishes an SPF sender policy");
  if (hasDmarc) reasons.push("Domain publishes a DMARC policy");

  const freemail = FREEMAIL.has(domain);
  const role = ROLE_LOCAL.test(local.replace(/[._-].*$/, "")) || ROLE_LOCAL.test(local);
  signals["freemail"] = freemail;
  signals["role_account"] = role;

  const onCompanyDomain = Boolean(ctx.companyDomain && domain === ctx.companyDomain.toLowerCase());
  signals["on_company_domain"] = onCompanyDomain;
  if (onCompanyDomain) reasons.push("Address is on the company's own web domain");
  if (freemail) reasons.push("Free consumer mailbox — ownership cannot be proven by domain");

  // Corroboration: how many distinct scraped documents literally contain it.
  const corpus = ctx.corpus ?? [];
  const mentions = corpus.filter((doc) => doc.toLowerCase().includes(email)).length;
  signals["source_mentions"] = mentions;
  if (mentions > 0) reasons.push(`Published on ${mentions} scraped page${mentions > 1 ? "s" : ""}`);

  // Name match: does the local part actually match the executive's name?
  let nameMatch = false;
  if (ctx.personName) {
    const tokens = nameTokens(ctx.personName);
    const flat = local.replace(/[^a-z]/g, "");
    nameMatch = tokens.some((t) => flat.includes(t));
    const initialsMatch =
      tokens.length >= 2 && flat.startsWith(tokens[0]![0]!) && flat.includes(tokens[1]!);
    nameMatch = nameMatch || initialsMatch;
  }
  signals["name_match"] = nameMatch;
  if (nameMatch) reasons.push(`Local part matches ${ctx.personName}`);

  const email_type: EmailAssessment["email_type"] = freemail
    ? "personal"
    : role
      ? "company"
      : nameMatch || ctx.origin === "pattern"
        ? "executive"
        : "unknown";

  // Scoring — evidence, not just DNS.
  let score = 1; // MX only
  if (spf || hasDmarc) score += 0.5;
  if (onCompanyDomain) score += 1.5;
  if (mentions >= 1) score += 1;
  if (mentions >= 2) score += 0.5;
  if (nameMatch) score += 1;
  if (ctx.origin === "pattern" && mentions === 0) score -= 1; // guessed, never seen published
  if (ctx.origin === "ai" && mentions === 0) score -= 1.5; // model output with no public trace
  if (freemail && !nameMatch && mentions === 0) score -= 1;
  const confidence = Math.max(0, Math.min(5, Math.round(score)));

  let status: EmailAssessment["status"];
  if (mentions >= 1 && (onCompanyDomain || nameMatch || mentions >= 2)) {
    status = "Verified";
    reasons.push("Cross-checked: deliverable and publicly attributed to this company/person");
  } else if (mentions >= 1 || onCompanyDomain) {
    status = "MX Verified";
    reasons.push("Deliverable and seen publicly, but not attributed to a named person");
  } else {
    status = "Unverified";
    reasons.push("Deliverable domain, but the exact mailbox was never seen published — treat as a guess");
  }

  return { status, confidence, email_type, signals, reasons };
}

/** Backwards-compatible thin check used for quick MX gating. */
export async function verifyEmail(email: string): Promise<{ ok: boolean; mx: boolean }> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, mx: false };
  const domain = email.split("@")[1]!;
  if (DISPOSABLE.test(domain)) return { ok: false, mx: false };
  const mx = await hasMx(domain);
  return { ok: mx, mx };
}


export type EnrichTargets = {
  email?: boolean;
  phone?: boolean;
  domain?: boolean;
  linkedin?: boolean;
  facebook?: boolean;
  domainGuess?: boolean;
  deepCrawl?: boolean;
  patternEmails?: boolean;
  registry?: boolean;
  directories?: boolean;
  address?: boolean;
  useAiFallback?: boolean;
  /** Skip the OSINT crawl entirely and rely on the AI agent only. */
  skipOsint?: boolean;
  /**
   * Minimum OSINT confidence (0-5) that is good enough to skip the AI agent.
   * 0 = only call AI when OSINT found nothing usable (default).
   * 5 = always call AI unless OSINT is perfectly verified.
   */
  aiFallbackMinScore?: number;

  keywords?: string;
  /** Geographic scope, e.g. "Canada" or "Québec, Canada". */
  region?: string;
  /** Ignore results hosted on foreign country domains. */
  countryLock?: boolean;
  /** Extra websites to search and crawl thoroughly (one host per line). */
  customSites?: string[];
  /** Accept a generic company mailbox when no executive email is found. */
  allowGenericEmail?: boolean;
  /** Record the registry legal status (active / dissolved). Default on. */
  companyStatus?: boolean;
};


export type StepLogger = (message: string, level?: "info" | "success" | "warn" | "error") => Promise<void>;

/**
 * Plausible own-domain bases for a company name (no TLD), e.g.
 * "Les Plastiques Gagnon inc." -> ["plastiquesgagnon", "plastiques-gagnon", "gagnon"].
 */
export function domainGuesses(companyName: string): string[] {
  const stop = new Set([
    "le", "la", "les", "l", "de", "des", "du", "the", "and", "et",
    "inc", "inc.", "ltee", "ltée", "ltd", "limited", "llc", "co", "corp",
    "enr", "enr.", "srl", "sencrl", "senc", "cie", "group", "groupe",
  ]);
  const words = companyName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w && !stop.has(w));
  if (!words.length) return [];
  const joined = words.join("");
  const hyphen = words.join("-");
  const initials = words.length >= 2 ? words.map((w) => w[0]).join("") : "";
  const out = [joined, hyphen, words[0]!, words[words.length - 1]!, initials];
  return dedupeList(out.filter((w) => w.length >= 3), 5);
}

/** Dedupe + cap a list of short strings so prompts stay small. */
function dedupeList(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = String(raw).trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/** Normalised fingerprint used to drop near-identical extracts. */
function shingle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9@. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

const SIGNAL_RE =
  /([\w.+-]+@[\w-]+\.[a-z]{2,})|((\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})|(pr[ée]sident|directeur|directrice|propri[ée]taire|fondateur|fondatrice|g[ée]rant|owner|ceo|cfo|vice-pr[ée]sident|associ[ée])/i;

/**
 * Token-efficient sampling (v2). Instead of shipping 320-char raw chunks, we
 * split each page into sentences, keep only the *sentence windows* that carry a
 * contact or executive signal, drop near-duplicates, rank them, and hard-cap
 * the result. Typical prompt payload: ~1.2k chars instead of ~10k.
 */
function sampleSnippets(snippets: string[], companyName: string, maxChars = 1200): string {
  const tokens = companyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);

  const seen = new Set<string>();
  const scored: { s: string; score: number }[] = [];

  for (const raw of snippets.slice(0, 12)) {
    const sentences = String(raw)
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?;•|])\s+|\s{2,}/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 25 && x.length <= 240);

    for (const [i, sentence] of sentences.entries()) {
      if (!SIGNAL_RE.test(sentence)) continue;
      // keep one neighbouring sentence for context (names often sit next door)
      const neighbour = sentences[i + 1];
      const window = neighbour && neighbour.length < 120 ? `${sentence} ${neighbour}` : sentence;
      const key = shingle(window);
      if (seen.has(key)) continue;
      seen.add(key);

      const low = window.toLowerCase();
      let score = 0;
      if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(window)) score += 5;
      if (/(pr[ée]sident|directeur|directrice|propri[ée]taire|fondateur|owner|ceo|associ[ée]|g[ée]rant)/i.test(low))
        score += 4; // executive lines are what we are actually after
      if (/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(window)) score += 2;
      if (/\b(info|contact|ventes|sales|service)@/i.test(window)) score -= 2; // generic mailbox noise
      score += tokens.filter((t) => low.includes(t)).length;
      if (score > 0) scored.push({ s: window, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const parts: string[] = [];
  let used = 0;
  for (const { s } of scored) {
    if (used + s.length > maxChars) continue;
    parts.push(s);
    used += s.length;
    if (parts.length >= 10) break;
  }
  return parts.join("\n---\n");
}

/** Does this mailbox local-part look like a real person (vs a department)? */
function looksPersonal(email: string, people: { name: string }[]): boolean {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  if (!local || ROLE_LOCAL.test(local.replace(/[._-].*$/, ""))) return false;
  const bare = local.replace(/[^a-z]/g, "");
  for (const p of people) {
    const parts = p.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/\s+/)
      .map((x) => x.replace(/[^a-z]/g, ""))
      .filter((x) => x.length >= 3);
    if (parts.some((x) => bare.includes(x))) return true;
  }
  // first.last / f.last shapes without a matching known person
  return /^[a-z]{2,}[._-][a-z]{2,}$/.test(local);
}

/** Higher tier = closer to a named executive; generic mailboxes rank last. */
function candidateTier(
  email: string,
  origin: AssessContext["origin"],
  domain: string | null,
  people: { name: string }[],
): number {
  const onOwn = !!domain && email.endsWith(`@${domain}`);
  if (origin === "generic") return 0;
  if (looksPersonal(email, people)) return onOwn ? 5 : 4;
  if (origin === "pattern") return 4;
  if (onOwn) return 2;
  return 1;
}


export async function enrichCompany(
  row: { company_name: string; city: string | null; postal_code: string | null; neq: string | null },
  model: string,
  keys: Record<string, string | null>,
  targets: EnrichTargets,
  onStep: StepLogger = async () => {},
  signal?: AbortSignal,
): Promise<EnrichResult> {
  const clean = cleanCompanyName(row.company_name);

  // ---------- STAGE 1 — OSINT: search engines, socials, site crawl ----------
  await onStep(`OSINT search started · "${clean}" · ${targets.region ?? "Canada"}${row.city ? ` · ${row.city}` : ""}`);
  const { gatherEvidence } = await import("./osint.server");
  let evidence = {
    domain: null as string | null,
    emails: [] as string[],
    phones: [] as string[],
    people: [] as { name: string; title: string }[],
    snippets: [] as string[],
    pagesScraped: 0,
    socials: { linkedin: null as string | null, facebook: null as string | null },
    patternCandidates: [] as string[],
    genericCandidates: [] as string[],
    trail: [] as string[],
    address: null as string | null,
    registryUrl: null as string | null,
    registryName: null as string | null,
    companyStatus: null as string | null,
    statusSources: [] as string[],
    statusConfirmations: 0,
    statusVotes: [] as { status: string; raw: string; host: string; labeled: boolean }[],
    sourceUrls: [] as string[],
  };
  if (targets.skipOsint) {
    await onStep("AI-only mode — skipping OSINT crawling, asking the AI agent directly", "warn");
  } else {
  try {
    evidence = await gatherEvidence(
      {
        company_name: row.company_name,
        clean_name: clean,
        city: row.city,
        neq: row.neq,
        postal_code: row.postal_code,
      },
      {
        registry: targets.registry,
        directories: targets.directories,
        linkedin: targets.linkedin,
        facebook: targets.facebook,
        domainGuess: targets.domainGuess,
        deepCrawl: targets.deepCrawl,
        patternEmails: targets.patternEmails,
        keywords: targets.keywords,
        region: targets.region,
        countryLock: targets.countryLock,
        customSites: targets.customSites,
        allowGenericEmail: targets.allowGenericEmail,
        signal,
      },
    );
  } catch (err) {
    await onStep(`OSINT crawl error: ${err instanceof Error ? err.message : String(err)}`, "warn");
  }
  }


  if (!targets.skipOsint)
    await onStep(
      `OSINT done · ${evidence.pagesScraped} pages · domain ${evidence.domain ?? "not found"} · ` +
        `${evidence.emails.length} email(s) · ${evidence.phones.length} phone(s) · ${evidence.people.length} people`,
      evidence.pagesScraped ? "info" : "warn",
    );
  if (evidence.trail.length) await onStep(`Sources: ${evidence.trail.join(" · ")}`);
  if (evidence.socials.linkedin) await onStep(`LinkedIn: ${evidence.socials.linkedin}`);
  if (evidence.socials.facebook) await onStep(`Facebook: ${evidence.socials.facebook}`);
  if (evidence.registryUrl) await onStep(`Registry record: ${evidence.registryUrl}`);
  if (evidence.address) await onStep(`Address: ${evidence.address}`);

  // Legal status is opt-in and only kept when independent registry sources agree.
  const wantStatus = targets.companyStatus !== false;
  const statusConfirmed = Boolean(evidence.companyStatus) && evidence.statusConfirmations >= 1;
  if (wantStatus) {
    if (statusConfirmed) {
      await onStep(
        `Legal status: ${evidence.companyStatus} — confirmed by ${evidence.statusConfirmations} source(s): ${evidence.statusSources.join(", ")}`,
      );
    } else if (evidence.statusVotes.length) {
      await onStep(
        `Legal status left unknown — only a weak single mention (${evidence.statusVotes
          .map((v) => `${v.status}@${v.host}`)
          .slice(0, 3)
          .join(", ")}) and it was not corroborated`,
        "warn",
      );
    }
  }

  // Rate every page the data came from and derive one collective trust score.
  const references = buildReferences(
    [
      ...(evidence.sourceUrls ?? []),
      evidence.registryUrl,
      evidence.socials.linkedin,
      evidence.socials.facebook,
      evidence.domain ? `https://${evidence.domain}` : null,
    ],
    evidence.domain,
  );
  const sourceScore = collectiveScore(references);
  const sourceMeta = {
    references,
    source_score: sourceScore,
    source_score_label: scoreLabel(sourceScore),
  };
  if (references.length) {
    await onStep(
      `Source trust ${sourceScore}/100 (${scoreLabel(sourceScore)}) from ${references.length} reference(s): ${references
        .slice(0, 4)
        .map((r) => `${r.host} ${r.score}`)
        .join(", ")}`,
      sourceScore >= 70 ? "success" : "info",
    );
  }

  const extra = {
    address: targets.address === false ? null : evidence.address,
    linkedin_url: evidence.socials.linkedin,
    facebook_url: evidence.socials.facebook,
    registry_url: evidence.registryUrl,
    company_status: wantStatus && statusConfirmed ? evidence.companyStatus : null,
  };


  const person = evidence.people[0] ?? null;
  if (person) await onStep(`Executive candidate: ${person.name}${person.title ? ` — ${person.title}` : ""}`);
  const corpus = [...evidence.snippets, ...evidence.emails];
  // Drop platform/support mailboxes (amazon.com, wixpress.com…) that leak in
  // from error pages, cookie banners and hosting boilerplate.
  const scrapedEmails = evidence.emails.filter((e) => !isVendorDomain(e.split("@")[1] ?? ""));
  const droppedVendor = evidence.emails.length - scrapedEmails.length;
  if (droppedVendor > 0)
    await onStep(`Ignored ${droppedVendor} third-party platform address(es) found on scraped pages`, "warn");
  const ownDomainEmail =
    (evidence.domain ? scrapedEmails.find((e) => e.endsWith(`@${evidence.domain}`)) : null) ?? null;
  const scrapedEmail = ownDomainEmail ?? scrapedEmails[0] ?? null;

  const baseCtx = {
    companyDomain: evidence.domain,
    personName: person?.name ?? null,
    corpus,
  };

  type Candidate = { email: string; origin: AssessContext["origin"]; source: string; tier: number };
  const raw: { email: string; origin: AssessContext["origin"]; source: string }[] = [];
  if (ownDomainEmail)
    raw.push({ email: ownDomainEmail, origin: "own-domain", source: `Company website (${evidence.domain})` });
  for (const e of scrapedEmails) {
    if (e !== ownDomainEmail) raw.push({ email: e, origin: "web", source: "Public web / directory / social" });
  }
  if (targets.patternEmails !== false) {
    for (const c of evidence.patternCandidates.slice(0, 4))
      raw.push({ email: c, origin: "pattern", source: `Name pattern on ${evidence.domain}` });
  }

  if (targets.allowGenericEmail !== false) {
    for (const g of evidence.genericCandidates.slice(0, 2))
      raw.push({ email: g, origin: "generic", source: `Company mailbox on ${evidence.domain}` });
  }

  // Executive-first ordering: named-person mailboxes are evaluated before
  // department mailboxes, so a generic info@ can never win when a personal
  // address exists for the same company.
  const candidates: Candidate[] = raw
    .map((c) => ({ ...c, tier: candidateTier(c.email, c.origin, evidence.domain, evidence.people) }))
    .filter((c, i, arr) => arr.findIndex((o) => o.email.toLowerCase() === c.email.toLowerCase()) === i)
    .sort((a, b) => b.tier - a.tier);

  const STATUS_RANK = { Verified: 3, "MX Verified": 2, Unverified: 1, Invalid: 0 } as const;
  let best: { cand: Candidate; assessment: EmailAssessment } | null = null;
  const assessedEmails: { email: string; status: EmailAssessment["status"]; confidence: number; source: string }[] = [];

  for (const cand of candidates.slice(0, 8)) {
    // Stop paying for department mailboxes once a personal one already worked.
    if (cand.tier <= 1 && best && best.cand.tier >= 4 && best.assessment.status !== "Unverified") {
      await onStep(`Skipped ${cand.email} — an executive-level address was already confirmed`);
      continue;
    }
    const assessment = await assessEmail(cand.email, { ...baseCtx, origin: cand.origin }, signal);
    assessedEmails.push({ email: cand.email, status: assessment.status, confidence: assessment.confidence, source: cand.source });
    await onStep(
      `Verifying ${cand.email} (${cand.origin}, tier ${cand.tier}) → ${assessment.status} · score ${assessment.confidence}/5 · ${assessment.reasons.join("; ")}`,
      assessment.status === "Verified" ? "success" : assessment.status === "Invalid" ? "warn" : "info",
    );
    if (assessment.status === "Invalid") continue;
    const better =
      !best ||
      cand.tier > best.cand.tier ||
      (cand.tier === best.cand.tier &&
        (STATUS_RANK[assessment.status] > STATUS_RANK[best.assessment.status] ||
          (STATUS_RANK[assessment.status] === STATUS_RANK[best.assessment.status] &&
            assessment.confidence > best.assessment.confidence)));
    if (better) best = { cand, assessment };
    if (cand.tier >= 4 && assessment.status === "Verified" && assessment.confidence >= 5) break;
  }


  // ---------- STAGE 1b — Reverse cross-check (no AI) ----------
  // Take what OSINT found and search the web for that exact email / phone to
  // see which business it is actually attached to.
  const { reverseLookup } = await import("./osint.server");
  const companyRef = { name: row.company_name, neq: row.neq, domain: evidence.domain };
  let reverseEmail: Awaited<ReturnType<typeof reverseLookup>> | null = null;
  let phone = targets.phone === false ? null : (evidence.phones[0] ?? null);
  let reversePhone: Awaited<ReturnType<typeof reverseLookup>> | null = null;

  if (best) {
    await onStep(`Cross-checking ${best.cand.email} across the open web (reverse lookup)…`);
    try {
      reverseEmail = await reverseLookup(best.cand.email, "email", companyRef, signal);
      const a = best.assessment;
      a.signals["reverse_confirmations"] = reverseEmail.confirmations;
      a.signals["reverse_unrelated"] = reverseEmail.unrelated;
      if (reverseEmail.matched) {
        // A match with the target company wins outright: the same address also
        // showing up under unrelated businesses (shared agency / directory
        // spam) does not weaken a direct hit.
        a.confidence = Math.min(5, a.confidence + (reverseEmail.confirmations >= 2 ? 2 : 1));
        if (a.status !== "Verified") a.status = "Verified";
        a.reasons.push(
          `Reverse lookup: ${reverseEmail.confirmations} independent page(s) publish this address for this company${reverseEmail.sources.length ? ` (${reverseEmail.sources.join(", ")})` : ""}${reverseEmail.unrelated ? ` — also seen under ${reverseEmail.unrelated} unrelated listing(s), which does not disqualify it` : ""}`,
        );
        await onStep(
          `Reverse check passed → ${best.cand.email} confirmed for THIS company by ${reverseEmail.confirmations} source(s)${reverseEmail.sources.length ? `: ${reverseEmail.sources.join(", ")}` : ""}`,
          "success",
        );
      } else if (reverseEmail.conflicting) {
        a.confidence = Math.max(0, a.confidence - 1);
        if (a.status === "Verified") a.status = "MX Verified";
        a.reasons.push(
          "Reverse lookup: address is published online but only under other businesses — kept, flagged as unconfirmed",
        );
        await onStep(
          `Reverse check conflict → ${best.cand.email} appears only under other businesses (kept, flagged)`,
          "warn",
        );
      } else {
        a.reasons.push("Reverse lookup: no independent page links this address to the company");
        await onStep(`Reverse check inconclusive for ${best.cand.email}`, "warn");
      }
    } catch {
      await onStep("Reverse email check failed (network) — keeping original score", "warn");
    }
  }

  if (phone) {
    try {
      reversePhone = await reverseLookup(phone, "phone", companyRef, signal);
      if (reversePhone.matched) {
        await onStep(
          `Phone ${phone} confirmed for this company by ${reversePhone.confirmations} source(s)${reversePhone.sources.length ? `: ${reversePhone.sources.join(", ")}` : ""}`,
          "success",
        );
      } else if (reversePhone.conflicting) {
        // Prefer an alternative number that is not tied to someone else, but
        // never leave the row phoneless just because of a shared listing.
        const alt = evidence.phones.slice(1).find(Boolean) ?? null;
        if (alt) {
          await onStep(`Phone ${phone} is listed for other businesses — trying ${alt} instead`, "warn");
          phone = alt;
        } else {
          await onStep(`Phone ${phone} also appears under other businesses — kept, flagged as unconfirmed`, "warn");
        }
      } else {
        await onStep(`Phone ${phone} kept, but no independent confirmation found`, "warn");
      }

    } catch {
      /* best effort */
    }
  }

  const aiMinScore = Math.max(0, Math.min(5, Number(targets.aiFallbackMinScore ?? 0) || 0));
  const osintGoodEnough =
    !!best && best.assessment.status !== "Unverified" && best.assessment.confidence >= aiMinScore;
  if (best && best.assessment.status !== "Unverified" && !osintGoodEnough) {
    await onStep(
      `OSINT score ${best.assessment.confidence}/5 is below the AI threshold (${aiMinScore}/5) — escalating to the AI agent`,
      "warn",
    );
  }
  if (osintGoodEnough) {
    await onStep(
      `Accepted without AI: ${best!.cand.email} (${best!.assessment.status} · ${best!.assessment.confidence}/5 ≥ threshold ${aiMinScore}/5)`,
      "success",
    );

    return {
      executive_name: person?.name ?? null,
      title: person?.title ?? null,
      email: best!.cand.email,
      phone,
      domain: targets.domain === false ? null : (evidence.domain ?? best!.cand.email.split("@")[1]!),
      verification_status: best!.assessment.status,
      confidence: best!.assessment.confidence,
      source: `${best!.cand.source} · ${evidence.trail.join("; ") || "search"}`,
      email_type: best!.assessment.email_type,
      verification_details: {
        ...sourceMeta,
        signals: best!.assessment.signals,
        reasons: best!.assessment.reasons,
        reverse_email: reverseEmail ?? undefined,
        reverse_phone: reversePhone ?? undefined,
        alternate_emails: assessedEmails
          .filter((item) => item.email !== best?.cand.email && item.status !== "Invalid")
          .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || b.confidence - a.confidence)
          .slice(0, 9),
      },
      ...extra,
    };
  }


  // ---------- STAGE 2 — AI fallback, grounded on the OSINT evidence ----------
  if (targets.useAiFallback === false) {
    await onStep("AI fallback disabled — returning OSINT-only result", "warn");
    const mx = evidence.domain ? await hasMx(evidence.domain, signal) : false;
    return {
      executive_name: person?.name ?? null,
      title: person?.title ?? null,
      email: best?.cand.email ?? null,
      phone,
      domain: targets.domain === false ? null : evidence.domain,
      verification_status: best ? best.assessment.status : "Unverified",
      confidence: best ? best.assessment.confidence : mx ? 1 : 0,
      source: `OSINT only (${evidence.trail.join("; ") || "no signals"})`,
      email_type: best?.assessment.email_type ?? "unknown",
      verification_details: best
        ? { ...sourceMeta, signals: best.assessment.signals, reasons: best.assessment.reasons, alternate_emails: assessedEmails.filter((item) => item.email !== best?.cand.email && item.status !== "Invalid").slice(0, 9) }
        : { ...sourceMeta, reasons: ["No email discovered by OSINT"] },
      ...extra,
    };
  }

  const need = [
    targets.email !== false && "email",
    targets.phone !== false && "phone",
    targets.domain !== false && "domain",
  ]
    .filter(Boolean)
    .join(", ");

  const header = `Company: ${clean}
Legal name: ${row.company_name}
NEQ: ${row.neq ?? "unknown"}
City: ${row.city ?? "Quebec"}
Postal code: ${row.postal_code ?? "unknown"}
Country: Canada
Needed: ${need}`;

  const guessBases = domainGuesses(clean);

  // ---- Live web sweep: always search the open web right before calling the model,
  // so even AI-only mode and empty scrapes get fresh internet facts in the prompt.
  const { webSearch } = await import("./osint.server");
  const city = row.city ?? "Québec";
  const queries = [
    `"${clean}" ${city} Québec`,
    `"${clean}" ${city} téléphone adresse contact`,
    `"${clean}" courriel OR email OR contact`,
    `"${clean}" site officiel OR website`,
    row.neq ? `"${row.neq}" ${clean}` : `"${clean}" pagesjaunes OR canada411 OR linkedin`,
  ];
  let liveLinks: string[] = [];
  let liveSnippets: string[] = [];
  try {
    const results = await Promise.all(
      queries.map((q) => webSearch(q).catch(() => ({ links: [], snippets: [] }))),
    );
    liveLinks = dedupeList(results.flatMap((r) => r.links), 12);
    liveSnippets = dedupeList(results.flatMap((r) => r.snippets), 40);
  } catch {
    /* search is best effort */
  }
  // ---- Map listings (like the Google Maps side panel): business name, address, phone, website.
  const mapLines = await mapListings(clean, row.city, row.postal_code).catch(() => [] as string[]);
  await onStep(
    `Live web sweep for the AI: ${liveLinks.length} link(s), ${liveSnippets.length} snippet(s), ${mapLines.length} map listing(s)`,
    liveLinks.length || mapLines.length ? "info" : "warn",
  );
  const mapBlock = mapLines.length ? `\nMAP LISTINGS (business listing on maps — trust phone/address/website if the name matches):\n${mapLines.join("\n")}` : "";
  const liveBlock = liveLinks.length || liveSnippets.length || mapLines.length
    ? `LIVE WEB SEARCH (run seconds ago — highest priority, use it over your memory):${mapBlock}
Pages (URLs only, cheap — use these as leads; 12 max): ${liveLinks.join(" | ") || "none"}
Extracts (short samples from the most relevant pages):
${sampleSnippets(liveSnippets, clean, 1100) || "none"}`
    : `LIVE WEB SEARCH: the search engines and maps returned nothing for this company.`;


  const prompt = targets.skipOsint
    ? `${header}

${liveBlock}

No pages were deep-scraped for this row (AI-only mode).
Priority order: (1) the live web search above, (2) any other public record you know of this
company — its own website, Pages Jaunes / Canada411, RBQ / CMEQ / VériBât licence pages, the
Quebec enterprise register, LinkedIn, Facebook.
If the company's site no longer exists online, still report the last public details you know
and say so in "source".
Likely own-domain shapes to consider: ${guessBases.join(", ")} (with .ca / .com / .qc.ca).
Fill every field you genuinely know; use null only for the ones you do not.
Never return a value belonging to a marketplace, hosting provider or unrelated business.`
    : `${header}

${liveBlock}

DEEP SCRAPE EVIDENCE (may be noisy or incomplete):
Likely domain: ${evidence.domain ?? "unknown"}
Registry: ${evidence.registryUrl ?? "none"} ${evidence.registryName ?? ""}
Scraper trail (${evidence.pagesScraped} pages): ${evidence.trail.slice(0, 8).join(" | ") || "none"}
Address: ${evidence.address ?? "unknown"}
LinkedIn: ${evidence.socials.linkedin ?? "none"} | Facebook: ${evidence.socials.facebook ?? "none"}
Emails found: ${dedupeList(scrapedEmails, 8).join(", ") || "none"}
Phones found: ${dedupeList(evidence.phones, 5).join(", ") || "none"}
People found: ${evidence.people.slice(0, 5).map((p) => `${p.name} (${p.title})`).join("; ") || "none"}
Page extracts (most relevant only):
${sampleSnippets(evidence.snippets, clean) || "none"}

TASK: research ${clean} (${row.city ?? "Quebec"}) YOURSELF, independently, as if nothing had been
found — use the live search results and everything you know (its own site, Pages Jaunes,
Canada411, RBQ/CMEQ, Registraire des entreprises, LinkedIn, Facebook, Google Maps listing).
The scrape block above is only what OSINT already has; do not just repeat or summarise it.
Return your OWN best values. For each field: if your value is more accurate/specific than the
OSINT one, return yours; if OSINT's is correct, return it; if neither is reliable, null.
Accuracy over completeness — never guess or return a value tied to another business, hosting
provider, marketplace or cookie tool. Name the website even if unsure of the email.
Likely own-domain shapes: ${guessBases.join(", ")} (with .ca / .com / .qc.ca).`;


  await onStep(`No corroborated email from OSINT — asking AI (${model}) on the scraped evidence`, "warn");
  const ai = await callModel(model, keys, prompt, signal);
  const aiText = (field: string): string | null => {
    const v = ai[field];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const rawAiEmail = aiText("email")?.toLowerCase() ?? null;
  let aiEmail = rawAiEmail && !isVendorDomain(rawAiEmail.split("@")[1] ?? "") ? rawAiEmail : null;
  if (rawAiEmail && !aiEmail)
    await onStep(`AI returned a third-party platform address (${rawAiEmail}) — rejected`, "warn");
  const aiDomain =
    (aiText("domain") ?? aiText("website"))
      ?.toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "") || null;

  // AI-directed scraping: if the model names a website the scraper never read,
  // go read it now and take contact details straight from that site.
  let siteFound: { pages: number; emails: string[]; phones: string[]; address: string | null } | null = null;
  if (aiDomain && !isVendorDomain(aiDomain) && aiDomain !== evidence.domain) {
    const { scrapeProposedSite } = await import("./osint.server");
    siteFound = await scrapeProposedSite(aiDomain, row.postal_code ?? null, signal).catch(() => null);
    await onStep(
      siteFound?.pages
        ? `Read AI-suggested site ${aiDomain}: ${siteFound.emails.length} email(s), ${siteFound.phones.length} phone(s)${siteFound.address ? ", address" : ""}`
        : `AI-suggested site ${aiDomain} could not be opened`,
      siteFound?.pages ? "info" : "warn",
    );
    if (siteFound?.emails.length && (!aiEmail || !siteFound.emails.includes(aiEmail))) aiEmail = siteFound.emails[0]!;
  }
  const siteConfirmsAi = Boolean(siteFound?.pages);
  const email = scrapedEmail || aiEmail || best?.cand.email || null;

  // The company's own domain is only what OSINT or the model asserted — never
  // the domain of the proposed mailbox, which would self-confirm any address.
  const companyDomain = evidence.domain || (isVendorDomain(aiDomain) || !(siteConfirmsAi || aiDomain) ? null : aiDomain);
  const domain = companyDomain || (email?.includes("@") ? email.split("@")[1]! : null);

  let verification: EnrichResult["verification_status"] = "Unverified";
  let confidence = 0;
  let emailType: EnrichResult["email_type"] = "unknown";
  let details: Record<string, unknown> = { reasons: ["No email produced"] };

  if (email) {
    const assessment = await assessEmail(email, {
      ...baseCtx,
      companyDomain,
      origin: email === aiEmail && email !== scrapedEmail && !siteFound?.emails.includes(email) ? "ai" : "web",
    }, signal);
    verification = assessment.status;
    confidence = assessment.confidence;
    emailType = assessment.email_type;
    details = { signals: assessment.signals, reasons: assessment.reasons };
    await onStep(
      `AI proposed ${email} → ${assessment.status} · score ${assessment.confidence}/5 · ${assessment.reasons.join("; ")}`,
      assessment.status === "Invalid" ? "warn" : "info",
    );
    // Never trust an AI address without an independent web trace.
    if (assessment.status !== "Invalid") {
      try {
        const rev = await reverseLookup(email, "email", { ...companyRef, domain: domain ?? evidence.domain }, signal);
        details = { ...details, reverse_email: rev };
        if (rev.matched) {
          confidence = Math.min(5, confidence + (rev.confirmations >= 2 ? 2 : 1));
          verification = "Verified";
          await onStep(`Reverse check confirmed AI email via ${rev.sources.join(", ") || "web search"}`, "success");
        } else if (rev.conflicting) {
          confidence = Math.max(0, confidence - 2);
          verification = "Unverified";
          await onStep("Reverse check: AI email is used by other businesses — downgraded", "warn");
        } else if (email === aiEmail && email !== scrapedEmail && !siteFound?.emails.includes(email)) {
          // AI-proposed address with no independent web trace: keep it, but never
          // present it as verified or high-confidence.
          confidence = Math.min(confidence, 2);
          verification = "Unverified";
          await onStep("Reverse check: no public page links the AI email to this company — kept as unverified", "warn");
        } else {
          await onStep("Reverse check: no public page links this email to this company", "warn");
        }
      } catch {
        /* best effort */
      }
    }

  } else if (domain) {
    const mx = await hasMx(domain, signal);
    confidence = mx ? 1 : 0;
    await onStep(`AI returned no email; domain ${domain} MX=${mx}`, "warn");
  }

  await onStep(
    `AI answer — domain ${aiDomain ?? "none"} · phone ${aiText("phone") ?? "none"} · address ${aiText("address") ?? "none"} · ${aiText("source") ?? "no source"}`,
  );

  return {
    ...extra,
    address:
      targets.address === false ? null : (evidence.address ?? siteFound?.address ?? aiText("address")),
    executive_name: aiText("executive_name") ?? person?.name ?? null,
    title: aiText("title") ?? person?.title ?? null,
    email: verification === "Invalid" ? null : email,
    phone: phone ?? (targets.phone === false ? null : (siteFound?.phones[0] ?? aiText("phone"))),
    domain: targets.domain === false ? null : domain,
    verification_status: verification,
    confidence,
    source:
      email && email === scrapedEmail
        ? `OSINT scrape: ${evidence.domain ?? "web"}`
        : `AI (${model})${evidence.pagesScraped ? " + OSINT context" : ""}`,
    email_type: emailType,
    verification_details: { ...sourceMeta, ...details, ai_source: aiText("source") },
  };

}




async function log(db: AnySupabase, jobId: string, userId: string, message: string, level = "info") {
  await db.from("job_logs").insert({ job_id: jobId, user_id: userId, message, level });
}

/**
 * Processes ONE bounded batch for a job. Safe to call concurrently:
 * a database lease makes extra callers exit immediately.
 */
export async function processJobBatch(
  db: AnySupabase,
  jobId: string,
): Promise<{ ok: boolean; reason?: string; processed: number; status: string }> {
  const { data: job } = await db.from("batch_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, reason: "not_found", processed: 0, status: "missing" };
  if (job.status !== "running") return { ok: true, reason: "not_running", processed: 0, status: job.status };

  const { data: settings } = await db
    .from("user_settings")
    .select("*")
    .eq("user_id", job.user_id)
    .maybeSingle();
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(
      MIN_BATCH_SIZE,
      Number((settings as { batch_size?: number | null } | null)?.batch_size ?? DEFAULT_BATCH_SIZE) ||
        DEFAULT_BATCH_SIZE,
    ),
  );
  const rowTimeoutSeconds = Math.min(3600, Math.max(30, Number(settings?.row_timeout_seconds ?? 120)));

  // Recover rows abandoned by a crashed/timed-out invocation. They are retried
  // before new work, up to a fixed cap, so no CSV row is silently left behind.
  const staleBefore = new Date(Date.now() - (rowTimeoutSeconds + 45) * 1000).toISOString();
  const { data: recovered } = await db.rpc("recover_stale_job_rows", {
    p_job_id: jobId,
    p_stale_before: staleBefore,
    p_max_attempts: MAX_ROW_ATTEMPTS,
  });
  const recovery = Array.isArray(recovered) ? recovered[0] : recovered;
  if ((recovery?.requeued ?? 0) > 0 || (recovery?.failed ?? 0) > 0) {
    await log(
      db,
      jobId,
      job.user_id,
      `Recovery check · ${recovery?.requeued ?? 0} timed-out row(s) re-queued · ${recovery?.failed ?? 0} reached retry limit`,
      (recovery?.failed ?? 0) > 0 ? "warn" : "info",
    );
  }

  // Short single-flight lease covers one concurrent wave. Row claims remain
  // authoritative and stale claims are independently recoverable.
  const now = new Date();
  if (job.lease_until && new Date(job.lease_until) > now) {
    return { ok: true, reason: "leased", processed: 0, status: job.status };
  }
  const leaseUntil = new Date(now.getTime() + (rowTimeoutSeconds + 60) * 1000).toISOString();
  const { data: leased } = await db
    .from("batch_jobs")
    .update({ lease_until: leaseUntil })
    .eq("id", jobId)
    .eq("status", "running")
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id")
    .maybeSingle();
  if (!leased) return { ok: true, reason: "leased", processed: 0, status: job.status };

  try {
    const keys = {
      gemini_key: settings?.gemini_key ?? null,
      perplexity_key: settings?.perplexity_key ?? null,
      openai_key: settings?.openai_key ?? null,
      anthropic_key: settings?.anthropic_key ?? null,
      custom_ai_key: (settings as Record<string, string | null> | null)?.["custom_ai_key"] ?? null,
      custom_ai_base_url:
        (settings as Record<string, string | null> | null)?.["custom_ai_base_url"] ?? null,
    } as Record<string, string | null>;

    // Credentials of every OpenAI-compatible service the user saved.
    const { data: savedServices } = await db
      .from("ai_services")
      .select("id, base_url, api_key")
      .eq("user_id", job.user_id);
    for (const svc of (savedServices ?? []) as { id: string; base_url: string; api_key: string }[]) {
      keys[`svc:${svc.id}:url`] = svc.base_url;
      keys[`svc:${svc.id}:key`] = svc.api_key;
    }



    const { setWorkerConfig } = await import("./osint.server");
    setWorkerConfig({
      url: (settings as { osint_worker_url?: string | null } | null)?.osint_worker_url ?? null,
      secret: (settings as { osint_worker_secret?: string | null } | null)?.osint_worker_secret ?? null,
    });


    const { data: rows, error: claimError } = await db.rpc("claim_job_rows", {
      p_job_id: jobId,
      p_limit: batchSize,
    });
    if (claimError) throw new Error(claimError.message);

    if (!rows || rows.length === 0) {
      const { count } = await db
        .from("job_rows")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId)
        .in("status", ["queued", "processing"]);
      if (!count) {
        await db
          .from("batch_jobs")
          .update({ status: "completed", completed_at: new Date().toISOString(), lease_until: null })
          .eq("id", jobId);
        await log(db, jobId, job.user_id, "Batch completed.", "success");
        return { ok: true, processed: 0, status: "completed" };
      }
      await db.from("batch_jobs").update({ lease_until: null }).eq("id", jobId);
      return { ok: true, processed: 0, status: "running" };
    }

    const runRow = async (row: any) => {
      const label = `[${row.row_index + 1}] ${cleanCompanyName(row.company_name)}`;
      const step: StepLogger = async (message, level = "info") => {
        await db.from("job_rows").update({ heartbeat_at: new Date().toISOString() }).eq("id", row.id);
        await log(db, jobId, job.user_id, `${label} · ${message}`, level);
      };
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const abortController = new AbortController();
      const heartbeatHandle = setInterval(() => {
        void db.from("job_rows").update({ heartbeat_at: new Date().toISOString() }).eq("id", row.id);
      }, 15_000);
      try {
        await step(`Record picked up from queue · attempt ${row.attempts}/${MAX_ROW_ATTEMPTS} · deadline ${rowTimeoutSeconds}s`);
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            abortController.abort();
            reject(new Error(`Company deadline exceeded after ${rowTimeoutSeconds}s`));
          }, rowTimeoutSeconds * 1000);
        });
        const result = await Promise.race([
          enrichCompany(row, job.model, keys, job.targets ?? {}, step, abortController.signal),
          timeout,
        ]);

        // ---- Website / email post-processing guard ------------------------
        {
          const g = guardRow({ company_name: row.company_name, domain: result.domain, email: result.email });
          for (const n of g.notes) await step(n, "warn");
          if (result.email && !g.email) {
            result.verification_status = "Unverified";
            result.confidence = Math.min(result.confidence, 1);
          }
          result.domain = g.domain;
          result.email = g.email;
          if (g.freeMail) {
            result.confidence = Math.min(result.confidence, 3);
            result.verification_details = { ...(result.verification_details ?? {}), free_mail_contact: true };
          }
          if (result.domain) {
            const { data: sameSite } = await db
              .from("contacts")
              .select("company_name, phone")
              .eq("user_id", job.user_id)
              .eq("domain", result.domain)
              .neq("company_name", row.company_name)
              .limit(20);
            if (sameSite?.length && !sharedDomainAllowed(result.domain, row.company_name, sameSite, result.phone)) {
              await step(
                `${result.domain} is already used by "${sameSite[0]!.company_name}" and matches neither company — dropped`,
                "warn",
              );
              const dropped = result.domain;
              result.verification_details = { ...(result.verification_details ?? {}), duplicate_domain: dropped };
              result.domain = null;
              if (result.email?.endsWith(`@${dropped}`)) {
                result.email = null;
                result.verification_status = "Unverified";
                result.confidence = Math.min(result.confidence, 1);
              }
            }
          }
        }

        // ---- Cross-row duplicate guard ------------------------------------
        // The same shared mailbox / switchboard often shows up for many
        // companies (mall directories, franchise pages, web agencies). Keep it
        // only for the first company it was proven for.
        if (result.email) {
          const { data: dupe } = await db
            .from("contacts")
            .select("company_name, email")
            .eq("user_id", job.user_id)
            .eq("email", result.email)
            .neq("company_name", row.company_name)
            .limit(1);
          const other = dupe?.[0];
          if (other) {
            await step(
              `${result.email} is already recorded for "${other.company_name}" — dropped as a shared/duplicate mailbox`,
              "warn",
            );
            result.verification_details = {
              ...(result.verification_details ?? {}),
              duplicate_of: other.company_name,
              duplicate_email: result.email,
            };
            result.email = null;
            result.verification_status = "Unverified";
            result.confidence = Math.min(result.confidence, 1);
          }
        }
        if (result.phone) {
          const { data: dupePhone } = await db
            .from("contacts")
            .select("company_name, phone")
            .eq("user_id", job.user_id)
            .eq("phone", result.phone)
            .neq("company_name", row.company_name)
            .limit(1);
          const otherPhone = dupePhone?.[0];
          if (otherPhone) {
            await step(
              `Phone ${result.phone} already belongs to "${otherPhone.company_name}" — dropped as duplicate`,
              "warn",
            );
            result.verification_details = {
              ...(result.verification_details ?? {}),
              duplicate_phone_of: otherPhone.company_name,
              duplicate_phone: result.phone,
            };
            result.phone = null;
          }
        }

        await db.from("contacts").insert({

          user_id: job.user_id,
          job_id: jobId,
          neq: row.neq,
          company_name: row.company_name,
          city: row.city,
          postal_code: row.postal_code,
          source_row: (row as { source_row?: Record<string, string> }).source_row ?? {},

          executive_name: result.executive_name,
          title: result.title,
          email: result.email,
          phone: result.phone,
          domain: result.domain,
          verification_status: result.verification_status,
          confidence: result.confidence,
          source: result.source,
          address: result.address,
          linkedin_url: result.linkedin_url,
          facebook_url: result.facebook_url,
          registry_url: result.registry_url,
          company_status: result.company_status,
          email_type: result.email_type,
          verification_details: result.verification_details,
        });
        await db
          .from("job_rows")
          .update({ status: "done", processed_at: new Date().toISOString(), error: null, heartbeat_at: new Date().toISOString() })
          .eq("id", row.id);
        await step(
          `Saved → ${result.email ?? "no email"} · ${result.verification_status} · score ${result.confidence}/5`,
          result.verification_status === "Verified" || result.verification_status === "MX Verified"
            ? "success"
            : "warn",
        );

        return { valid: result.verification_status === "Verified" || result.verification_status === "MX Verified", failed: false };
      } catch (err) {
        if (err instanceof BlockedError) {
          await db.from("job_rows").update({ status: "queued", claimed_at: null, heartbeat_at: null }).eq("id", row.id);
          const paused = err.status === 429 ? "rate_limited" : "blocked";
          await db
            .from("batch_jobs")
            .update({
              status: "paused",
              paused_reason: paused,
              error: err.message,
              lease_until: null,
            })
            .eq("id", jobId);
          await log(db, jobId, job.user_id, `Paused: ${err.message}`, "error");
          return { valid: false, failed: false, blocked: paused };
        }
        const message = err instanceof Error ? err.message : String(err);
        const failed = (row.attempts ?? 1) >= MAX_ROW_ATTEMPTS;
        await db
          .from("job_rows")
          .update({
            status: failed ? "failed" : "queued",
            error: message,
            claimed_at: null,
            heartbeat_at: null,
            ...(failed ? { processed_at: new Date().toISOString() } : {}),
          })
          .eq("id", row.id);
        await log(
          db,
          jobId,
          job.user_id,
          `${label} · ${message}${failed ? " · retry limit reached" : " · queued for automatic retry"}`,
          failed ? "error" : "warn",
        );
        return { valid: false, failed };
      } finally {
        clearInterval(heartbeatHandle);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    };

    const outcomes: { valid: boolean; failed: boolean; blocked?: string }[] = [];
    for (let i = 0; i < rows.length; i += batchSize) {
      outcomes.push(...(await Promise.all(rows.slice(i, i + batchSize).map(runRow))));
    }
    const blocked = outcomes.find((outcome) => outcome.blocked);
    if (blocked?.blocked) {
      return { ok: false, reason: blocked.blocked, processed: 0, status: "paused" };
    }

    const { count: remaining } = await db
      .from("job_rows")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .in("status", ["queued", "processing"]);

    const { count: finished } = await db
      .from("job_rows")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .in("status", ["done", "failed"]);
    const { count: validCount } = await db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .in("verification_status", ["Verified", "MX Verified"]);
    const { count: failedCount } = await db
      .from("job_rows")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("status", "failed");
    const processedRows = finished ?? 0;
    const done = (remaining ?? 0) === 0;
    await db
      .from("batch_jobs")
      .update({
        processed_rows: processedRows,
        valid_emails: validCount ?? 0,
        invalid_count: failedCount ?? 0,
        lease_until: null,
        ...(done ? { status: "completed", completed_at: new Date().toISOString() } : {}),
      })
      .eq("id", jobId);
    if (done) await log(db, jobId, job.user_id, "Batch completed.", "success");

    return { ok: true, processed: rows.length, status: done ? "completed" : "running" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("batch_jobs")
      .update({ status: "paused", paused_reason: "error", error: message, lease_until: null })
      .eq("id", jobId);
    await log(db, jobId, job.user_id, `Worker error: ${message}`, "error");
    return { ok: false, reason: "error", processed: 0, status: "paused" };
  }
}

/** Picks up running jobs (used by the scheduled worker). */
export async function processDueJobs(db: AnySupabase, maxJobs = 3) {
  const { data: jobs } = await db
    .from("batch_jobs")
    .select("id")
    .eq("status", "running")
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
    .order("started_at", { ascending: true })
    .limit(maxJobs);
  const results = [];
  for (const job of jobs ?? []) {
    results.push({ job: job.id, ...(await processJobBatch(db, job.id)) });
  }
  return results;
}

/** Looks the business up on map listings: Google Places (if connected) then OpenStreetMap. Max 3 compact lines. */
async function mapListings(name: string, city: string | null, postal: string | null): Promise<string[]> {
  const q = [name, city, postal, "Québec, Canada"].filter(Boolean).join(", ");
  const out: string[] = [];
  const gk = process.env["GOOGLE_MAPS_API_KEY"];
  if (gk) {
    try {
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "X-Goog-Api-Key": gk,
          "Content-Type": "application/json",
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri",
        },
        body: JSON.stringify({ textQuery: q, regionCode: "CA", maxResultCount: 3 }),
        signal: AbortSignal.timeout(12_000),
      });
      if (r.ok) {
        const b = (await r.json()) as { places?: { displayName?: { text?: string }; formattedAddress?: string; nationalPhoneNumber?: string; websiteUri?: string }[] };
        for (const p of b.places ?? []) out.push(`Google Maps: ${p.displayName?.text ?? ""} | ${p.formattedAddress ?? ""} | ${p.nationalPhoneNumber ?? "no phone"} | ${p.websiteUri ?? "no site"}`);
      }
    } catch { /* best effort */ }
  }
  if (!out.length) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=ca&extratags=1&q=${encodeURIComponent(q)}`, {
        headers: { "User-Agent": "RECYC-Contact-OSINT/1.0 (research)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const b = (await r.json()) as { display_name?: string; extratags?: Record<string, string> }[];
        for (const p of b) {
          const t = p.extratags ?? {};
          out.push(`OpenStreetMap: ${p.display_name ?? ""} | ${t["phone"] ?? t["contact:phone"] ?? "no phone"} | ${t["website"] ?? t["contact:website"] ?? "no site"}`);
        }
      }
    } catch { /* best effort */ }
  }
  return out.slice(0, 3).map((l) => l.slice(0, 260));
}
