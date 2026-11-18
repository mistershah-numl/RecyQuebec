// Server-only OSINT collection: multi-engine web search, social profile
// discovery (LinkedIn / Facebook), direct domain probing, sitemap + contact
// page scraping, and email-pattern generation.
//
// NOTE: Playwright / Scrapy are Python / Node-native tools that cannot run in
// the edge worker runtime this app is deployed to. Everything below is plain
// HTTP fetching + HTML parsing, which is exactly what those tools end up doing
// for these mostly static pages — just without a browser process.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const SOCIAL_DOMAINS = ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com"];

const BAD_DOMAINS = [
  "duckduckgo.com",
  "bing.com",
  "google.com",
  "mojeek.com",
  "search.marcia.com",
  ...SOCIAL_DOMAINS,
  "youtube.com",
  "tiktok.com",
  "yelp.com",
  "pagesjaunes.ca",
  "yellowpages.ca",
  "canada411.ca",
  "wikipedia.org",
  "registreentreprises.gouv.qc.ca",
  "quebec.ca",
  "opencorporates.com",
  "gouv.qc.ca",
  "indeed.com",
  "glassdoor.com",
  "bloomberg.com",
  "dnb.com",
  "kompass.com",
  "amazon.com",
  "apple.com",
  "yahoo.com",
  "search.yahoo.com",
  "brave.com",
  "ecosia.org",
  "gc.ca",
  "canada.ca",
  "quebec.qc.ca",
  "reddit.com",
  "pinterest.com",
  "kijiji.ca",
  "ebay.com",
  "bizapedia.com",
  "b2bhint.com",
  "quebeccompanies.com",
  "societe.com",
  "manta.com",
  "crunchbase.com",
  "zoominfo.com",
  "cylex-canada.ca",
  "ourbis.ca",
  "rbq.qc.ca",
  "cmeq.qc.ca",
  "veribat.qc.ca",
  "zone-reno.com",
  "zone-renovation.com",
  "construction.qc.ca",
  "entrepri-renov.qc.ca",
];

// Executive title patterns for more accurate detection
const EXECUTIVE_TITLE_PATTERNS = [
  // English titles
  "CEO", "CFO", "COO", "CTO", "CMO", "CAO", "CRO",
  "President", "Pres.", "Chairman", "Chairperson",
  "General Manager", "GM", "Managing Director", "MD",
  "Director", "Vice President", "VP", "Executive Director",
  "Owner", "Proprietor", "Founder", "Co-Founder",
  "Principal", "Partner", "Associate",
  // French titles (Quebec-specific)
  "PDG", "Président", "Présidente",
  "Directeur Général", "Directrice Générale", "DG",
  "Directeur", "Directrice",
  "Vice-Président", "Vice-Présidente", "VP",
  "Secrétaire", "Trésorier", "Administrateur", "Administratrice",
  "Gérant", "Gérante", "Gestionnaire",
  "Chef de projet", "Project Manager",
  "Conseiller", "Consultant",
  "Responsable", "Manager",
  "Coordinateur", "Coordonnatrice",
];

// Common executive name patterns in Quebec companies
const EXECUTIVE_NAME_PATTERNS = [
  // Last name followed by title
  /([A-ZÀ-ÿ][a-zà-ÿ]+)\s+(?:[A-Z][a-zà-ÿ]+\s+)?(?:Pr[ée]sident(?:e)?|Directeur|Directrice|DG|PDG|Fondateur|Propriétaire|Gérant|Gérante|CEO|CFO|COO|GM|MD|VP|Directeur Général|Vice[- ]Pr[ée]sident|Secrétaire|Trésorier|Administrateur|Associate|Partner)\b/gi,
  // Title followed by last name
  /(?:(?:Pr[ée]sident(?:e)?|Directeur|Directrice|DG|PDG|Fondateur|Propriétaire|Gérant|Gérante|CEO|CFO|COO|GM|MD|VP|Directeur Général|Vice[- ]Pr[ée]sident|Secrétaire|Trésorier|Administrateur)\s*[:,–—-]\s*)?([A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-ÿ][a-zà-ÿ]+)?)\b/gi,
];

/**
 * How close a hostname is to the company name. Used so we only ever treat a
 * site as "the company website" when its domain really looks like the company.
 */
function nameMatchesHost(token: string, host: string): boolean {
  if (!token || token.length < 4) return false;
  const base = (host.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
  if (!base || base.length < 3) return false;
  const flat = host.replace(/[^a-z0-9]/g, "");
  if (flat.includes(token) || token.includes(base)) return true;
  const head = token.slice(0, Math.max(5, Math.min(8, token.length)));
  return base.startsWith(head) || token.startsWith(base.slice(0, 6));
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/g;

const TITLE_WORDS =
  "(?:pr[ée]sident(?:e)?(?:[- ]directeur[- ]g[ée]n[ée]ral)?|vice[- ]pr[ée]sident(?:e)?|directeur(?:trice)?(?:\\s+g[ée]n[ée]ral(?:e)?)?|propri[ée]taire|fondateur|fondatrice|associ[ée]|g[ée]rant(?:e)?|chief executive officer|ceo|cfo|coo|president|owner|founder|general manager|managing director|partner)";

export type OsintOptions = {
  /** Search engines + snippet mining (always on). */
  web?: boolean | undefined;
  /** Look for the company's LinkedIn page and mine it for contacts. */
  linkedin?: boolean | undefined;
  /** Look for the company's Facebook page (public "about" data often exposes an email). */
  facebook?: boolean | undefined;
  /** Guess the domain directly (name.com / name.ca) when search finds nothing. */
  domainGuess?: boolean | undefined;
  /** Crawl sitemap.xml + common contact/about/team paths. */
  deepCrawl?: boolean | undefined;
  /** Build first.last@domain style candidates from an executive name. */
  patternEmails?: boolean | undefined;
  /** Query public company-registry mirrors (b2bhint, opencorporates…) by NEQ. */
  registry?: boolean | undefined;
  /** Mine business directories (pages jaunes, yelp, canada411…). */
  directories?: boolean | undefined;
  /** Extra free-text keywords the user wants included in every search query. */
  keywords?: string | undefined;
  /** Geographic scope appended to every query, e.g. "Canada" or "Québec, Canada". */
  region?: string | undefined;
  /** Reject results hosted on foreign country domains (keeps .ca/.com/.net/.org). */
  countryLock?: boolean | undefined;
  /** Extra sites the user wants searched and crawled thoroughly (hostnames). */
  customSites?: string[] | undefined;
  /** Accept generic mailboxes (info@, contact@) when no executive email exists. */
  allowGenericEmail?: boolean | undefined;
  /** Cancels outstanding work when this company reaches its deadline. */
  signal?: AbortSignal | undefined;
};

export type Evidence = {
  /** Generic mailbox candidates (info@, contact@…) on the company's own domain. */
  genericCandidates: string[];
  domain: string | null;
  emails: string[];
  phones: string[];
  people: { name: string; title: string }[];
  snippets: string[];
  pagesScraped: number;
  socials: { linkedin: string | null; facebook: string | null };
  patternCandidates: string[];
  trail: string[];
  address: string | null;
  registryUrl: string | null;
  registryName: string | null;
  /** Legal status from a public registry mirror, e.g. "DISSOLVED". */
  companyStatus: string | null;
  /** Hosts that agreed on the legal status above. */
  statusSources: string[];
  /** How many independent hosts confirmed the status (0 = unconfirmed). */
  statusConfirmations: number;
  /** Every raw status reading, including the discarded ones. */
  statusVotes: StatusVote[];
  /** Every page URL that was successfully read while building this evidence. */
  sourceUrls: string[];
};

export type StatusVote = {
  /** Normalised verdict. */
  status: "ACTIVE" | "DISSOLVED" | "INACTIVE";
  /** The literal text the verdict was read from. */
  raw: string;
  host: string;
  /** True when it came from an explicit "Status: …" field, not loose prose. */
  labeled: boolean;
};

const DISSOLVED_RE = /\b(dissolved|dissoute|dissolution\s+(?:completed|date)|radi[ée]e?(?:\s+d'?office)?|struck\s+off|cancelled|annul[ée]e)\b/i;
const INACTIVE_RE = /\b(inactive|inactif|suspended|suspendue|non\s+conforme)\b/i;
const ACTIVE_RE = /\b(active|actif|immatricul[ée]e?|in\s+good\s+standing|en\s+vigueur)\b/i;
// "Dissolution date: —" / "Date de dissolution : " with nothing after it is the
// single biggest source of false "DISSOLVED" readings on registry mirrors.
const EMPTY_DISSOLUTION_RE = /(dissolution[^:\n]{0,20}[:\-–]\s*(?:—|-|n\/?a|none|aucune|null)?\s*(?:$|[\n<|]))/i;

const STATUS_LABEL_RE =
  /(?:statut(?:\s+juridique)?|[ée]tat(?:\s+de\s+l'?entreprise)?|legal\s*status|company\s*status|current\s*status|status|standing)\s*[:\-–]{1,2}\s*([^\n<>|;]{2,60})/gi;

function classify(text: string): StatusVote["status"] | null {
  if (DISSOLVED_RE.test(text) && !EMPTY_DISSOLUTION_RE.test(text)) return "DISSOLVED";
  if (INACTIVE_RE.test(text)) return "INACTIVE";
  if (ACTIVE_RE.test(text)) return "ACTIVE";
  return null;
}

/** Reads every legal-status signal out of a page, keeping its provenance. */
export function collectStatusVotes(text: string, host: string): StatusVote[] {
  const votes: StatusVote[] = [];
  const body = text.slice(0, 20_000);

  STATUS_LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATUS_LABEL_RE.exec(body))) {
    const raw = (m[1] ?? "").replace(/\s+/g, " ").trim();
    const verdict = classify(raw);
    if (verdict) votes.push({ status: verdict, raw: raw.slice(0, 60), host, labeled: true });
  }

  if (votes.length === 0) {
    const verdict = classify(body.slice(0, 4000));
    if (verdict) {
      const raw = body.match(verdict === "DISSOLVED" ? DISSOLVED_RE : verdict === "INACTIVE" ? INACTIVE_RE : ACTIVE_RE)?.[0] ?? verdict;
      votes.push({ status: verdict, raw: raw.slice(0, 60), host, labeled: false });
    }
  }
  return votes;
}

/**
 * Turns raw readings into a verdict. A destructive verdict (DISSOLVED /
 * INACTIVE) needs either an explicit "Status: …" field on a registry page, or
 * two independent hosts saying the same thing. Anything weaker stays unknown,
 * because loose prose on directory pages says "dissolved" far too often.
 */
export function resolveStatus(votes: StatusVote[]): {
  status: string | null;
  sources: string[];
  confirmations: number;
} {
  const groups = new Map<string, StatusVote[]>();
  for (const v of votes) {
    const list = groups.get(v.status) ?? [];
    list.push(v);
    groups.set(v.status, list);
  }
  const scored = Array.from(groups.entries()).map(([status, list]) => {
    const hosts = Array.from(new Set(list.map((v) => v.host).filter(Boolean)));
    const labeledHosts = Array.from(new Set(list.filter((v) => v.labeled).map((v) => v.host).filter(Boolean)));
    return { status, hosts, labeledHosts, weight: labeledHosts.length * 2 + hosts.length };
  });
  scored.sort((a, b) => b.weight - a.weight);
  const top = scored[0];
  if (!top) return { status: null, sources: [], confirmations: 0 };

  const destructive = top.status !== "ACTIVE";
  const confirmed = destructive
    ? top.labeledHosts.length >= 1 || top.hosts.length >= 2
    : top.labeledHosts.length >= 1 || top.hosts.length >= 1;
  if (!confirmed) return { status: null, sources: top.hosts, confirmations: 0 };

  return {
    status: top.status,
    sources: top.hosts.slice(0, 5),
    confirmations: Math.max(top.hosts.length, top.labeledHosts.length),
  };
}

/** Back-compat single-page reader. */
export function extractStatus(text: string): string | null {
  return resolveStatus(collectStatusVotes(text, "page")).status;
}



/**
 * Optional external render worker (local/self-hosted Playwright + Scrapy service).
 * When OSINT_WORKER_URL is set, every page load in the pipeline is routed through
 * it so JS-rendered and bot-protected pages become readable. Falls back silently
 * to plain HTTP when the worker is absent or fails.
 */
let runtimeWorker: { url: string | null; secret: string | null } = { url: null, secret: null };

/** Set per-user worker config (from user_settings) before running a batch. */
export function setWorkerConfig(cfg: { url?: string | null; secret?: string | null }) {
  runtimeWorker = { url: cfg.url?.trim() || null, secret: cfg.secret?.trim() || null };
}

async function workerFetch(url: string, timeoutMs: number, parentSignal?: AbortSignal): Promise<string | null> {
  const base = runtimeWorker.url ?? process.env["OSINT_WORKER_URL"];
  const secret = runtimeWorker.secret ?? process.env["OSINT_WORKER_SECRET"];
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), Math.min(Math.max(timeoutMs, 8_000), 25_000));
    const res = await fetch(`${base.replace(/\/$/, "")}/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "user-agent": "RECYC-OSINT/1.0",
        ...(secret ? { "x-worker-secret": secret } : {}),
      },
      body: JSON.stringify({ url }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
    if (!res.ok) return null;
    const data = (await res.json()) as { html?: string; text?: string };
    const body = data.html ?? data.text ?? null;
    return body ? body.slice(0, 400_000) : null;
  } catch {
    return null;
  }
}

export type WorkerOsintResult = {
  emails: string[];
  trustedEmails: string[];
  phones: string[];
  people: { name: string; title: string }[];
  domain: string | null;
  address: string | null;
  linkedin: string | null;
  facebook: string | null;
  texts: string[];
  trail: string[];
};

/**
 * Full-context OSINT handoff: instead of asking the worker to render one URL,
 * we hand it the whole company context and let the local toolchain
 * (theHarvester / SpiderFoot / holehe / custom spiders) do the discovery.
 * Optional — silently skipped when the worker has no /osint endpoint.
 */
export async function workerOsint(input: {
  company_name: string;
  neq: string | null;
  city: string | null;
  postal_code: string | null;
  region: string;
  keywords: string;
  sites: string[];
}, parentSignal?: AbortSignal): Promise<WorkerOsintResult | null> {
  const base = runtimeWorker.url ?? process.env["OSINT_WORKER_URL"];
  const secret = runtimeWorker.secret ?? process.env["OSINT_WORKER_SECRET"];
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 75_000);
    const res = await fetch(`${base.replace(/\/$/, "")}/osint`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "user-agent": "RECYC-OSINT/1.0",
        ...(secret ? { "x-worker-secret": secret } : {}),
      },
      // Send every alias the local worker might expect (company / company_name,
      // sites / extra_sites) so schema differences never cause a 422.
      body: JSON.stringify({
        ...input,
        company: input.company_name,
        extra_sites: input.sites,
        province: "Quebec",
        country: "Canada",
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<WorkerOsintResult> & { ok?: boolean; trusted_emails?: string[] };
    if (d.ok === false) return null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      emails: (d.emails ?? []).filter((e) => typeof e === "string").slice(0, 60),
      trustedEmails: (d.trusted_emails ?? []).filter((e) => typeof e === "string").slice(0, 20),
      phones: (d.phones ?? []).filter((e) => typeof e === "string").slice(0, 40),
      people: (d.people ?? [])
        .filter((p) => p && typeof p.name === "string")
        .map((p) => ({ name: p.name, title: p.title ?? "" }))
        .slice(0, 25),
      domain: str(d.domain),
      address: str(d.address),
      linkedin: str(d.linkedin),
      facebook: str(d.facebook),
      texts: (d.texts ?? []).filter((t) => typeof t === "string").map((t) => t.slice(0, 12_000)).slice(0, 25),
      trail: (d.trail ?? []).filter((t) => typeof t === "string").slice(0, 25),
    };
  } catch {
    return null;
  }
}

async function safeFetch(url: string, timeoutMs = 8000, parentSignal?: AbortSignal): Promise<string | null> {
  // Fast path first. Playwright is reserved for blocked/JS-only pages instead
  // of opening Chromium for every ordinary HTML response.
  try {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml,*/*",
        "accept-language": "fr-CA,fr;q=0.9,en;q=0.8",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
    if (!res.ok) return await workerFetch(url, timeoutMs, parentSignal);
    const type = res.headers.get("content-type") ?? "";
    if (type && !/(html|text|xml|json)/i.test(type)) return null;
    const text = (await res.text()).slice(0, 400_000);
    if (text.length >= 600 && !/just a moment|cf-challenge|challenge-platform/i.test(text)) return text;
  } catch {
    // Browser fallback below.
  }
  return await workerFetch(url, timeoutMs, parentSignal);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isUsableHost(h: string | null): boolean {
  return Boolean(h && !BAD_DOMAINS.some((b) => h === b || h.endsWith(`.${b}`)));
}

/**
 * ccTLDs that mean the page is about a company in another country. Canadian
 * businesses live on .ca or on the neutral gTLDs, so anything else is noise
 * from a similarly named foreign company.
 */
const FOREIGN_TLDS =
  /\.(fr|uk|co\.uk|us|au|in|de|es|it|nl|be|ch|br|mx|za|ie|nz|pl|pt|ru|cn|jp|se|no|dk|fi|at|gr|tr|ae|sg|hk|ph|my|id|il|ar|cl|co|pe|ma|dz|tn|lu)$/i;

function inRegion(host: string | null, countryLock: boolean): boolean {
  if (!host || !countryLock) return true;
  return !FOREIGN_TLDS.test(host);
}

const CANADA_MARKER = /\b(canada|canadian|qu[ée]bec|montreal|montr[ée]al|ottawa|toronto|vancouver|calgary|edmonton|winnipeg|halifax|\b(?:QC|ON|BC|AB|MB|SK|NB|NS|PE|NL|YT|NT|NU)\b|[A-Z]\d[A-Z][ -]?\d[A-Z]\d)\b/i;

function evidenceMatchesCompany(text: string, company: string, neq: string | null): boolean {
  return mentionsCompany(text, companyTokens(company), neq, null);
}

function isCanadianEvidence(text: string, url: string): boolean {
  return (hostOf(url) ?? "").endsWith(".ca") || CANADA_MARKER.test(text);
}

async function duckduckgo(query: string) {
  const html = await safeFetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=ca-fr`,
  );
  if (!html) return { links: [] as string[], snippets: [] as string[] };
  const links: string[] = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class="result-link"/gi)) {
    let href = m[1]!.replace(/&amp;/g, "&");
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    if (href.startsWith("http") && links.length < 15) links.push(href);
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)) {
    const text = stripHtml(m[1]!);
    if (text && snippets.length < 8) snippets.push(text.slice(0, 300));
  }
  return { links, snippets };
}

/** Brave HTML SERP — currently the most reliable non-API engine here. */
async function brave(query: string) {
  const html = await safeFetch(
    `https://search.brave.com/search?q=${encodeURIComponent(query)}&country=ca`,
    10_000,
  );
  if (!html) return { links: [] as string[], snippets: [] as string[] };
  const links: string[] = [];
  for (const m of html.matchAll(
    /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*svelte-14r20fy[^"]*"/gi,
  )) {
    const href = m[1]!.replace(/&amp;/g, "&");
    if (!/search\.brave\.com|imgs\.search\.brave/.test(href) && links.length < 20) {
      links.push(href);
    }
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(
    /<div class="snippet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
  )) {
    const text = stripHtml(m[1]!);
    if (text && snippets.length < 10) snippets.push(text.slice(0, 300));
  }
  return { links, snippets };
}

/** Bing: results live in <li class="b_algo"> blocks, sometimes behind /ck/a. */
async function bing(query: string) {
  const html = await safeFetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=CA&setlang=fr`,
  );
  if (!html) return { links: [] as string[], snippets: [] as string[] };
  const links: string[] = [];
  const push = (href: string) => {
    if (
      href.startsWith("http") &&
      !/(^|\.)(bing\.com|microsoft\.com|msn\.com|r\.bing\.com)/.test(hostOf(href) ?? "") &&
      links.length < 25
    ) {
      links.push(href);
    }
  };
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const head = block.slice(0, 3000);
    const direct = head.match(/href="(https?:\/\/[^"]+)"/i);
    if (direct) push(direct[1]!.replace(/&amp;/g, "&"));
    const ck = head.match(/[?&]u=a1([A-Za-z0-9_-]{16,})/);
    if (ck) {
      try {
        const decoded = Buffer.from(
          ck[1]!.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
        ).toString("utf8");
        push(decoded);
      } catch {
        /* skip */
      }
    }
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(m[1]!);
    if (text && snippets.length < 8) snippets.push(text.slice(0, 300));
  }
  return { links, snippets };
}

/** Yahoo: every result link is an r.search.yahoo.com redirect carrying RU=<url>. */
async function yahoo(query: string) {
  const html = await safeFetch(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`);
  if (!html) return { links: [] as string[], snippets: [] as string[] };
  const links: string[] = [];
  for (const m of html.matchAll(/\/RU=([^/]+)\/R[KS]=/g)) {
    try {
      const url = decodeURIComponent(m[1]!);
      if (url.startsWith("http") && links.length < 20) links.push(url);
    } catch {
      /* skip */
    }
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(/<div class="compText[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const text = stripHtml(m[1]!);
    if (text && snippets.length < 8) snippets.push(text.slice(0, 300));
  }
  return { links, snippets };
}

async function mojeek(query: string) {
  const html = await safeFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`);
  if (!html) return { links: [] as string[], snippets: [] as string[] };
  const links: string[] = [];
  for (const m of html.matchAll(/<a[^>]+class="ob"[^>]+href="(https?:\/\/[^"]+)"/gi)) {
    if (links.length < 15) links.push(m[1]!.replace(/&amp;/g, "&"));
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(/<p class="s">([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(m[1]!);
    if (text && snippets.length < 8) snippets.push(text.slice(0, 300));
  }
  return { links, snippets };
}

/** Multi-engine HTML search — returns result links + snippets. */
export async function webSearch(query: string): Promise<{ links: string[]; snippets: string[] }> {
  const engines = await Promise.all([
    brave(query),
    bing(query),
    yahoo(query),
    duckduckgo(query),
    mojeek(query),
  ]);
  return {
    links: Array.from(new Set(engines.flatMap((e) => e.links))),
    snippets: engines.flatMap((e) => e.snippets),
  };
}

function collectEmails(text: string, domainHint: string | null): string[] {
  return Array.from(new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())))
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e))
    .filter(
      (e) =>
        !/(sentry|example|domain\.com|wixpress|godaddy|squarespace|wordpress|shopify|cloudflare|email\.com|yourdomain|schema\.org)/.test(
          e,
        ),
    )
    .sort((a, b) => {
      const score = (x: string) => {
        const lx = x.split("@")[0] || "";
        let s = 0;

        // Domain match gets highest priority
        if (domainHint && x.endsWith(`@${domainHint}`)) s -= 8;
        else if (domainHint) s += 2;

        // Executive keywords (Quebec/France/Belgium)
        if (/^(direction|president|pdg|proprietaire|fondateur|dirigeant|directeur|directrice|gerant|gerante|ceo|cf|coo|cto|cmo|cro|gm|md|vp|responsable|manager|chef|ex\.)/.test(lx)) s -= 5;
        if (/^(info|contact|admin|ventes|sales|service|support|bureau|accueil|comptabilite|accounting|courriel|email)@/.test(lx)) s -= 1;
        if (/^(noreply|no-reply|donotreply|webmaster|postmaster|privacy|abuse|adresse|courriel)@/.test(lx)) s += 6;

        // Personal email indicators (first.last, flast, first, etc.)
        if (/^[a-z]{2,}[._-][a-z]{2,}$/.test(lx)) s -= 2; // first.last pattern
        if (/^[a-z]{4,}$/.test(lx)) s -= 1; // plain name

        // Free email providers
        if (/^(gmail|hotmail|outlook|yahoo|icloud|aol|protonmail|gmx|mail|zoho|live|msn|sympatico)@/.test(lx)) s += 3;

        return s;
      };
      return score(a) - score(b);
    })
    .slice(0, 15);
}

function collectPhones(text: string): string[] {
  return Array.from(
    new Set((text.match(PHONE_RE) ?? []).map((p) => p.replace(/\s+/g, " ").trim())),
  ).slice(0, 4);
}

/** Heuristic executive extraction: "Jean Tremblay, Président" / "Président : Jean Tremblay". */
function collectPeople(text: string): { name: string; title: string }[] {
  const out: { name: string; title: string }[] = [];
  const NAME = "([A-ZÀ-Ý][\\p{L}'’-]+(?:\\s+[A-ZÀ-Ý][\\p{L}'’-]+){1,2})";
  const patterns = [
    new RegExp(`${NAME}\\s*[,–—-]\\s*(${TITLE_WORDS})`, "giu"),
    new RegExp(`(${TITLE_WORDS})\\s*[:,–—-]\\s*${NAME}`, "giu"),
  ];
  for (const [i, re] of patterns.entries()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < 6) {
      const name = (i === 0 ? m[1] : m[2])
        ?.trim()
        .replace(/\s+(vice|pr[ée]sident(e)?|directeur|directrice|president|ceo|owner|fondateur|associ[ée]|g[ée]rant(e)?|chief)$/i, "")
        .trim();
      const title = (i === 0 ? m[2] : m[1])?.trim();
      if (name && title && !out.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        out.push({ name, title });
      }
    }
  }
  return out;
}

const CONTACT_HINT =
  /(contact|nous-joindre|nous_joindre|joindre|coordonnees|coordonn[ée]es|a-propos|apropos|about|equipe|[ée]quipe|team|direction|notre-entreprise|staff|leadership|management)/i;

const COMMON_PATHS = [
  "/contact",
  "/contact.html",
  "/contactez-nous",
  "/nous-joindre",
  "/a-propos",
  "/about",
  "/equipe",
  "/team",
  "/coordonnees",
];

function slugToken(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeName(name: string) {
  const parts = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  return { first: parts[0] ?? "", last: parts[parts.length - 1] ?? "" };
}

/** first.last@ / flast@ / first@ candidates for a known executive on a known domain. */
export function emailPatterns(personName: string, domain: string): string[] {
  const { first, last } = normalizeName(personName);
  if (!first || !last || first === last) return [];
  return [
    `${first}.${last}@${domain}`,
    `${first[0]}${last}@${domain}`,
    `${first}@${domain}`,
    `${first}${last}@${domain}`,
  ];
}

async function probeDomainGuess(token: string): Promise<string | null> {
  if (token.length < 4) return null;
  const tlds = [".com", ".ca", ".qc.ca", ".net"];
  for (const tld of tlds) {
    const host = `${token}${tld}`;
    const html = await safeFetch(`https://${host}`, 5000);
    if (html && html.length > 500) return host;
  }
  return null;
}

async function fetchSitemapPages(origin: string): Promise<string[]> {
  const xml = await safeFetch(`${origin}/sitemap.xml`, 6000);
  if (!xml) return [];
  const urls = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]!);
  return urls.filter((u) => CONTACT_HINT.test(u)).slice(0, 4);
}

/**
 * Accepts only real profile/company URLs — bare `facebook.com`, login pages and
 * share links are useless as a "source", so they are rejected outright.
 */
function isSocialProfileUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\.|^mbasic\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return false;
  const junk =
    /^\/(login|recover|sharer|share|help|policies|privacy|terms|legal|business|marketplace|watch|pages\/create|signup|reg|dialog|tr|plugins|feed|search|hashtag|events|groups\/discover|directory|company-beta|pulse|jobs|learning|checkpoint)/i;
  if (junk.test(path)) return false;
  if (host === "facebook.com" && /^\/(profile\.php|people|pages|[^/]+)/i.test(path)) return true;
  if (host === "linkedin.com" && /^\/(company|in|school|showcase)\/[^/]+/i.test(path)) return true;
  return false;
}

async function findSocials(clean: string, city: string | null) {
  const where = city ? ` ${city}` : " Québec";
  const [li, fb] = await Promise.all([
    webSearch(`"${clean}"${where} site:linkedin.com/company`),
    webSearch(`"${clean}"${where} site:facebook.com`),
  ]);
  const pick = (links: string[], host: string) =>
    links.find((l) => (hostOf(l) ?? "").endsWith(host) && isSocialProfileUrl(l)) ?? null;
  return {
    linkedin: pick(li.links, "linkedin.com"),
    facebook: pick(fb.links, "facebook.com"),
    snippets: [...li.snippets, ...fb.snippets],
  };
}

// ---------------------------------------------------------------------------
// Public company-registry mirrors. These republish the official Registraire
// des entreprises du Québec data (legal address, status, officers) and are
// plain HTML, so they can be fetched and parsed directly.
// ---------------------------------------------------------------------------
const REGISTRY_HOSTS = [
  "can1business.com",
  "opengovca.com",
  "b2bhint.com",
  "opencorporates.com",
  "quebeccompanies.com",
  "canadacompanyregistry.com",
  "companiesincanada.ca",
  "bizapedia.com",
  "ic.gc.ca",
  "canadabusiness.ca",
  "ourbis.ca",
];

const CA_ADDRESS_RE =
  /\d{1,6}[\w-]*\s+[^,;|<>\n]{3,60},\s*[^,;|<>\n]{2,40}(?:,\s*(?:QC|Qu[ée]bec)[^,;|<>\n]{0,20})?,?\s*[A-Z]\d[A-Z]\s?\d[A-Z]\d/gi;
const POSTAL_RE = /[A-Z]\d[A-Z]\s?\d[A-Z]\d/i;

function extractAddress(text: string, postalHint: string | null): string | null {
  const matches = Array.from(text.matchAll(CA_ADDRESS_RE)).map((m) =>
    m[0].replace(/\s+/g, " ").trim(),
  );
  if (matches.length === 0) return null;
  if (postalHint) {
    const p = postalHint.replace(/\s+/g, "").toUpperCase();
    const hit = matches.find((a) => a.replace(/\s+/g, "").toUpperCase().includes(p));
    if (hit) return hit.slice(0, 200);
  }
  return matches[0]!.slice(0, 200);
}

/** Looks the company up on public registry mirrors (by NEQ first, then name). */
async function registryLookup(
  clean: string,
  neq: string | null,
  city: string | null,
  postal: string | null,
): Promise<{
  url: string | null;
  name: string | null;
  address: string | null;
  phones: string[];
  emails: string[];
  people: { name: string; title: string }[];
  status: string | null;
  statusVotes: StatusVote[];
  statusSources: string[];
  statusConfirmations: number;
  texts: string[];
}> {
  const out = {
    url: null as string | null,
    status: null as string | null,
    statusVotes: [] as StatusVote[],
    statusSources: [] as string[],
    statusConfirmations: 0,
    name: null as string | null,
    address: null as string | null,
    phones: [] as string[],
    emails: [] as string[],
    people: [] as { name: string; title: string }[],
    texts: [] as string[],
  };

  const queries = [
    neq ? `"${neq}" site:can1business.com` : null,
    neq ? `"${neq}" b2bhint OR opencorporates OR registre` : null,
    `"${clean}" site:can1business.com`,
    neq ? `"${neq}" adresse entreprise Québec` : null,
    `"${clean}"${city ? ` ${city}` : ""} NEQ registre entreprises adresse`,
  ].filter((q): q is string => Boolean(q));

  const results = await Promise.all(queries.map((q) => webSearch(q)));
  const links = Array.from(new Set(results.flatMap((r) => r.links)));
  out.texts.push(...results.flatMap((r) => r.snippets));

  const registryLinks = links
    .filter((l) => REGISTRY_HOSTS.some((h) => (hostOf(l) ?? "").endsWith(h)))
    .slice(0, 4);

  const pages = await Promise.all(registryLinks.map((u) => safeFetch(u, 9000)));
  pages.forEach((html, i) => {
    if (!html) return;
    const url = registryLinks[i]!;
    const text = stripHtml(html);
    // Search engines sometimes fabricate plausible registry slugs or return a
    // different company. Never expose a registry reference unless the fetched
    // page itself contains this company/NEQ and Canadian evidence.
    if (!evidenceMatchesCompany(text, clean, neq) || !isCanadianEvidence(text, url)) return;
    out.url ??= url;
    out.texts.push(text.slice(0, 12_000));
    out.address ??= extractAddress(text, postal);
    // One vote per registry host — never a verdict from a single loose word.
    out.statusVotes.push(...collectStatusVotes(text, hostOf(url) ?? url));
    out.phones.push(...collectPhones(text));
    out.emails.push(...collectEmails(text, null));
    out.people.push(...collectPeople(text));
    const title = html.match(/<title>([\s\S]{3,140}?)<\/title>/i)?.[1];
    if (title && !out.name) out.name = stripHtml(title).split("·")[0]!.trim().slice(0, 120);
  });

  // Registry mirrors are often rate-limited; search snippets can still carry an
  // explicit "Status: …" field, but only labeled hits from them are trusted.
  if (out.statusVotes.length === 0) {
    const snippetVotes = results
      .flatMap((r) => r.snippets)
      .flatMap((s) => collectStatusVotes(s, "search-snippet"))
      .filter((v) => v.labeled);
    out.statusVotes.push(...snippetVotes);
  }

  const resolved = resolveStatus(out.statusVotes);
  out.status = resolved.status;
  out.statusSources = resolved.sources;
  out.statusConfirmations = resolved.confirmations;

  return out;
}


/** Business directories: phone books and local listings (non-AI, public HTML). */
async function directoryLookup(clean: string, city: string | null) {
  const where = city ? ` ${city}` : " Québec";
  const results = await Promise.all([
    webSearch(`"${clean}"${where} site:pagesjaunes.ca OR site:yellowpages.ca`),
    webSearch(`"${clean}"${where} téléphone adresse courriel`),
  ]);
  const links = Array.from(new Set(results.flatMap((r) => r.links)))
    .filter((l) => /pagesjaunes|yellowpages|canada411|yelp|cylex|goldbook|411/.test(hostOf(l) ?? ""))
    .slice(0, 3);
  const pages = await Promise.all(links.map((u) => safeFetch(u, 8000)));
  const texts = [
    ...results.flatMap((r) => r.snippets),
    ...pages.filter(Boolean).map((p) => stripHtml(p!).slice(0, 8000)),
  ];
  return { texts, pages: pages.filter(Boolean).length };
}

/**
 * Runs a bounded OSINT pass across the open web, social profiles and the
 * company's own site, and returns every raw signal it can extract.
 */
export async function gatherEvidence(
  company: {
    company_name: string;
    clean_name: string;
    city: string | null;
    neq: string | null;
    postal_code?: string | null;
  },
  options: OsintOptions = {},
): Promise<Evidence> {
  const opt: Required<Omit<OsintOptions, "keywords" | "region" | "customSites" | "signal">> & {
    keywords: string;
    region: string;
    customSites: string[];
  } = {
    web: options.web !== false,
    linkedin: options.linkedin !== false,
    facebook: options.facebook !== false,
    domainGuess: options.domainGuess !== false,
    deepCrawl: options.deepCrawl !== false,
    patternEmails: options.patternEmails !== false,
    registry: options.registry !== false,
    directories: options.directories !== false,
    keywords: options.keywords?.trim() ?? "",
    region: options.region?.trim() || "Canada",
    countryLock: options.countryLock !== false,
    customSites: (options.customSites ?? [])
      .map((sIn) => sIn.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase())
      .filter(Boolean)
      .slice(0, 12),
    allowGenericEmail: options.allowGenericEmail !== false,
  };

  const trail: string[] = [];
  const sourceUrls: string[] = [];
  const region = opt.region;

  // ---- Stage 0: hand the whole context to the local OSINT toolchain ----
  const tool = await workerOsint({
    company_name: company.company_name,
    neq: company.neq,
    city: company.city,
    postal_code: company.postal_code ?? null,
    region,
    keywords: opt.keywords,
    sites: opt.customSites,
  }, options.signal);
  if (tool) {
    trail.push(
      `osint worker: ${tool.emails.length} emails, ${tool.phones.length} phones, ${tool.people.length} people${tool.domain ? `, domain ${tool.domain}` : ""}`,
    );
    for (const t of tool.trail) trail.push(`worker: ${t}`);
  }

  const where = `${company.city ? ` ${company.city}` : ""} ${region}`;
  const kw = opt.keywords ? ` ${opt.keywords}` : "";
  const queries = [
    `"${company.clean_name}"${where} contact courriel${kw}`,
    `${company.clean_name}${where} site officiel${kw}`,
    `"${company.clean_name}" (président OR propriétaire OR directeur) courriel`,
  ];
  if (company.neq) queries.push(`"${company.neq}" ${company.clean_name}`);

  const results = opt.web ? await Promise.all(queries.map((q) => webSearch(q))) : [];
  const links = Array.from(new Set(results.flatMap((r) => r.links)));
  const snippets = results.flatMap((r) => r.snippets);
  if (opt.web) trail.push(`web search: ${links.length} links, ${snippets.length} snippets`);

  // ---- Registry mirrors (official address, officers, legal name) ----
  let address: string | null = null;
  let registryUrl: string | null = null;
  let registryName: string | null = null;
  let companyStatus: string | null = null;
  let statusSources: string[] = [];
  let statusConfirmations = 0;
  let statusVotes: StatusVote[] = [];
  const registryTexts: string[] = [];
  const registryPeople: { name: string; title: string }[] = [];
  if (opt.registry) {
    try {
      const reg = await registryLookup(
        company.clean_name,
        company.neq,
        company.city,
        company.postal_code ?? null,
      );
      address = reg.address;
      companyStatus = reg.status;
      statusSources = reg.statusSources;
      statusConfirmations = reg.statusConfirmations;
      statusVotes = reg.statusVotes;
      registryUrl = reg.url;
      registryName = reg.name;
      if (reg.url) sourceUrls.push(reg.url);
      registryTexts.push(...reg.texts);
      registryPeople.push(...reg.people);
      trail.push(
        `registry: ${reg.url ? new URL(reg.url).hostname : "no page"}${reg.address ? " + address" : ""}${
          reg.status
            ? ` + status ${reg.status} (${reg.statusConfirmations} source${reg.statusConfirmations === 1 ? "" : "s"}: ${reg.statusSources.join(", ")})`
            : reg.statusVotes.length
              ? " + status unconfirmed (single weak mention, ignored)"
              : ""
        }`,
      );
    } catch {

      /* best effort */
    }
  }

  // ---- Business directories (phones, addresses, sometimes emails) ----
  const directoryTexts: string[] = [];
  if (opt.directories) {
    try {
      const dir = await directoryLookup(company.clean_name, company.city);
      directoryTexts.push(...dir.texts);
      trail.push(`directories: ${dir.pages} pages`);
    } catch {
      /* best effort */
    }
  }

  // ---- User-specified sites: searched with site: and crawled thoroughly ----
  const customTexts: string[] = [];
  const customLinks: string[] = [];
  if (opt.customSites.length > 0) {
    try {
      const perSite = await Promise.all(
        opt.customSites.map(async (site) => {
          const res = await webSearch(
            `site:${site} "${company.clean_name}"${company.neq ? ` OR "${company.neq}"` : ""}`,
          );
          const hits = res.links.filter((l) => (hostOf(l) ?? "").endsWith(site)).slice(0, 3);
          const pages = await Promise.all(hits.map((u) => safeFetch(u, 9000)));
          return {
            links: hits,
            texts: [
              ...res.snippets,
              ...pages.filter(Boolean).map((h) => stripHtml(h!).slice(0, 12_000)),
              ...pages.filter(Boolean).map((h) => (h!.match(/mailto:[^"'>\s]+/gi) ?? []).join(" ")),
            ],
          };
        }),
      );
      for (const r of perSite) {
        customTexts.push(...r.texts);
        customLinks.push(...r.links);
        sourceUrls.push(...r.links);
      }
      trail.push(`custom sites: ${opt.customSites.length} targeted, ${customLinks.length} pages`);
    } catch {
      /* best effort */
    }
  }

  const socials: { linkedin: string | null; facebook: string | null } = {
    linkedin: links.find((l) => (hostOf(l) ?? "").endsWith("linkedin.com") && isSocialProfileUrl(l)) ?? null,
    facebook: links.find((l) => (hostOf(l) ?? "").endsWith("facebook.com") && isSocialProfileUrl(l)) ?? null,
  };
  const texts: string[] = [
    ...(tool?.texts ?? []),
    ...(tool ? [tool.emails.join(" "), tool.phones.join(" ")] : []),
    ...snippets,
    ...registryTexts,
    ...directoryTexts,
    ...customTexts,
  ];


  if (opt.linkedin || opt.facebook) {
    const found = await findSocials(company.clean_name, company.city);
    if (opt.linkedin) socials.linkedin ??= found.linkedin;
    if (opt.facebook) socials.facebook ??= found.facebook;
    texts.push(...found.snippets);
    trail.push(
      `social: linkedin=${socials.linkedin ? "found" : "none"} facebook=${socials.facebook ? "found" : "none"}`,
    );
  }

  // Public social pages: LinkedIn/Facebook often expose the website + an email
  // in their public meta description even when the full page needs a login.
  let pagesScraped = 0;
  const socialUrls = [
    opt.linkedin ? socials.linkedin : null,
    opt.facebook ? socials.facebook?.replace("www.facebook.com", "mbasic.facebook.com") ?? null : null,
    opt.facebook && socials.facebook ? `${socials.facebook.replace(/\/$/, "")}/about` : null,
  ].filter((u): u is string => Boolean(u));
  const socialPages = await Promise.all(socialUrls.map((u) => safeFetch(u, 7000)));
  for (const [i, page] of socialPages.entries()) {
    if (!page) continue;
    const url = socialUrls[i]!;
    const text = stripHtml(page);
    if (!evidenceMatchesCompany(text, company.clean_name, company.neq) || !isCanadianEvidence(text, url)) {
      if (url.includes("facebook.com")) socials.facebook = null;
      if (url.includes("linkedin.com")) socials.linkedin = null;
      trail.push(`social rejected (company/Canada mismatch): ${url}`);
      continue;
    }
    sourceUrls.push(url);
    pagesScraped++;
    texts.push(text.slice(0, 6000));
    texts.push((page.match(/mailto:[^"'>\s]+/gi) ?? []).join(" "));
  }

  // ---- Pick the most likely official site ----
  const token = slugToken(company.clean_name);
  const candidates = links.filter(
    (l) => isUsableHost(hostOf(l)) && inRegion(hostOf(l), opt.countryLock !== false),
  );
  candidates.sort((a, b) => {
    const s = (u: string) => {
      const host = hostOf(u) ?? "";
      const base = slugToken(host.split(".")[0] ?? "");
      let score = 0;
      if (token && base && (token.startsWith(base) || base.startsWith(token.slice(0, 6)))) score -= 6;
      if (token && base && token.includes(base) && base.length > 4) score -= 3;
      if (/\.(ca|com)$/.test(host)) score -= 1;
      return score;
    };
    return s(a) - s(b);
  });

  // Only accept a site whose hostname actually resembles the company name —
  // otherwise we would "enrich" a company with a random directory or portal.
  let candidate = candidates.find((l) => nameMatchesHost(token, hostOf(l) ?? "")) ?? null;
  let domain = candidate ? hostOf(candidate) : null;
  if (!domain && tool?.domain) {
    const workerDomain = tool.domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (nameMatchesHost(token, workerDomain) && inRegion(workerDomain, opt.countryLock !== false)) {
      domain = workerDomain;
      candidate = `https://${domain}`;
      trail.push(`validated domain from worker: ${domain}`);
    } else {
      trail.push(`worker domain rejected (company/region mismatch): ${workerDomain}`);
    }
  }

  if (!domain && opt.domainGuess) {
    const guessed = await probeDomainGuess(token);
    if (guessed) {
      domain = guessed;
      candidate = `https://${guessed}`;
      trail.push(`domain guess: ${guessed}`);
    }
  }

  if (candidate && domain) {
    trail.push(`site: ${domain}`);
    const origin = new URL(candidate).origin;
    const home = await safeFetch(candidate);
    const internal = new Set<string>();

    if (home) {
      pagesScraped++;
      sourceUrls.push(candidate);
      texts.push(stripHtml(home).slice(0, 10_000));
      texts.push((home.match(/mailto:[^"'>\s]+/gi) ?? []).join(" "));

      for (const m of home.matchAll(/href="([^"#]+)"/gi)) {
        const href = m[1]!.replace(/&amp;/g, "&");
        if (!CONTACT_HINT.test(href)) continue;
        try {
          const abs = new URL(href, candidate).toString();
          if (hostOf(abs) === domain) internal.add(abs);
        } catch {
          /* ignore */
        }
      }
    }

    if (opt.deepCrawl) {
      for (const p of COMMON_PATHS) internal.add(`${origin}${p}`);
      for (const u of await fetchSitemapPages(origin)) internal.add(u);
    }

    const urls = Array.from(internal).slice(0, 8);
    const pages = await Promise.all(urls.map((u) => safeFetch(u, 7000)));
    pages.forEach((page, i) => {
      if (page && urls[i]) sourceUrls.push(urls[i]!);
    });
    for (const page of pages) {
      if (!page) continue;
      pagesScraped++;
      texts.push(stripHtml(page).slice(0, 10_000));
      texts.push((page.match(/mailto:[^"'>\s]+/gi) ?? []).join(" "));
    }
    trail.push(`crawled ${pagesScraped} pages`);
  }

  const joined = texts.join("\n");
  const people = [...(tool?.people ?? []), ...registryPeople, ...collectPeople(joined)].filter(
    (p, i, arr) => arr.findIndex((q) => q.name.toLowerCase() === p.name.toLowerCase()) === i,
  );
  const emails = collectEmails(joined, domain);
  const finalAddress =
    address ?? tool?.address ?? extractAddress(joined, company.postal_code ?? null) ?? null;

  const GENERIC_PREFIXES = ["info", "contact"];
  const genericCandidates =
    opt.allowGenericEmail && domain ? GENERIC_PREFIXES.map((g) => `${g}@${domain}`) : [];

  // Build name patterns for every executive we found, not just the first one:
  // this is what produces personal addresses instead of department mailboxes.
  const patternCandidates =
    opt.patternEmails && domain
      ? Array.from(new Set(people.slice(0, 3).flatMap((p) => emailPatterns(p.name, domain)))).slice(0, 12)
      : [];


  return {
    domain,
    genericCandidates,
    emails,
    phones: collectPhones(joined),
    people,
    snippets: texts.filter(Boolean).map((t) => t.slice(0, 800)).slice(0, 10),
    pagesScraped,
    socials,
    patternCandidates,
    trail,
    address: finalAddress,
    registryUrl,
    registryName,
    companyStatus,
    statusSources,
    statusConfirmations,
    statusVotes,
    sourceUrls: Array.from(new Set([...sourceUrls, ...(socials.linkedin ? [socials.linkedin] : []), ...(socials.facebook ? [socials.facebook] : [])])).slice(0, 30),
  };
}


// ---------------------------------------------------------------------------
// Reverse verification — no AI.
// Takes an identifier that OSINT already found (email or phone) and searches
// the open web for that literal string. We then read the pages that come back
// and check WHICH business they attach the identifier to. If those pages point
// back at the same company / domain, the identifier is corroborated. If they
// consistently point at some other business, it is flagged as conflicting.
// ---------------------------------------------------------------------------

export type ReverseCheck = {
  value: string;
  kind: "email" | "phone";
  /** Number of independent pages that contain the identifier AND the company. */
  confirmations: number;
  /** Pages that contain the identifier but never mention the company. */
  unrelated: number;
  /** True when at least one independent page ties it to this company. */
  matched: boolean;
  /** True when the identifier is published widely but never with this company. */
  conflicting: boolean;
  sources: string[];
  notes: string[];
};

function companyTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(inc|incorporee|ltee|limitee|corp|corporation|enr|senc|snc|cie|company|co)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

function mentionsCompany(text: string, tokens: string[], neq: string | null, domain: string | null): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (neq && t.includes(neq.toLowerCase())) return true;
  if (domain && t.includes(domain.toLowerCase())) return true;
  if (!tokens.length) return false;
  const hits = tokens.filter((tok) => t.includes(tok)).length;
  return hits >= Math.min(2, tokens.length);
}

/** Search the literal identifier and see which business the web attaches it to. */
export async function reverseLookup(
  value: string,
  kind: "email" | "phone",
  company: { name: string; neq: string | null; domain: string | null },
  signal?: AbortSignal,
): Promise<ReverseCheck> {
  const out: ReverseCheck = {
    value,
    kind,
    confirmations: 0,
    unrelated: 0,
    matched: false,
    conflicting: false,
    sources: [],
    notes: [],
  };
  const tokens = companyTokens(company.name);
  const digits = value.replace(/\D/g, "");
  const queries =
    kind === "email"
      ? [`"${value}"`]
      : [`"${value}"`, digits.length >= 10 ? `"${digits.slice(-10, -7)}-${digits.slice(-7, -4)}-${digits.slice(-4)}"` : ""];

  const results = await Promise.all(queries.filter(Boolean).map((q) => webSearch(q)));
  const links = Array.from(new Set(results.flatMap((r) => r.links)))
    .filter((l) => isUsableHost(hostOf(l)))
    .slice(0, 6);
  const snippets = results.flatMap((r) => r.snippets);

  // Snippets alone can already tie the identifier to the company.
  for (const s of snippets) {
    if (s.toLowerCase().includes(value.toLowerCase()) || (digits.length >= 10 && s.replace(/\D/g, "").includes(digits.slice(-10)))) {
      if (mentionsCompany(s, tokens, company.neq, company.domain)) {
        out.confirmations += 1;
        out.notes.push("search snippet ties it to the company");
        break;
      }
    }
  }

  const pages = await Promise.all(links.map((l) => safeFetch(l, 8000, signal).then((h) => ({ url: l, html: h }))));
  for (const p of pages) {
    if (!p.html) continue;
    const text = stripHtml(p.html);
    const hasValue =
      text.toLowerCase().includes(value.toLowerCase()) ||
      (kind === "phone" && digits.length >= 10 && text.replace(/\D/g, "").includes(digits.slice(-10)));
    if (!hasValue) continue;
    const host = hostOf(p.url) ?? p.url;
    if (mentionsCompany(text, tokens, company.neq, company.domain) || (company.domain && host === company.domain)) {
      out.confirmations += 1;
      out.sources.push(host);
      out.notes.push(`${host} publishes it together with the company`);
    } else {
      out.unrelated += 1;
      out.notes.push(`${host} publishes it but never names the company`);
    }
  }

  out.matched = out.confirmations > 0;
  out.conflicting = out.confirmations === 0 && out.unrelated >= 2;
  if (!out.matched && !out.conflicting) out.notes.push("no independent page links this identifier to the company");
  return out;
}

/**
 * Follow-up scrape of a website the AI proposed: reads the home + contact pages
 * and returns only emails on that domain, phones and an address found there.
 */
export async function scrapeProposedSite(
  domain: string,
  postalHint: string | null,
  signal?: AbortSignal,
): Promise<{ pages: number; emails: string[]; phones: string[]; address: string | null }> {
  const d = domain.toLowerCase().replace(/^www\./, "");
  const urls = [`https://${d}`, `https://${d}/contact`, `https://${d}/nous-joindre`, `https://${d}/contactez-nous`];
  const pages = await Promise.all(urls.map((u) => safeFetch(u, 8000, signal).catch(() => null)));
  const text = pages.filter(Boolean).map((p) => stripHtml(p!).slice(0, 15000)).join("\n");
  if (!text) return { pages: 0, emails: [], phones: [], address: null };
  return {
    pages: pages.filter(Boolean).length,
    emails: collectEmails(text, d).filter((e) => e.endsWith(`@${d}`) || e.endsWith(`.${d}`)).slice(0, 5),
    phones: collectPhones(text).slice(0, 3),
    address: extractAddress(text, postalHint),
  };
}
