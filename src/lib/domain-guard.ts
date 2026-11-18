// Post-processing guard for company websites and emails (pure, client-safe).
// Rules: never save a free-mail provider as a website; drop marketplaces,
// foreign/government/education/media/directory sites; never block a site just
// because its name differs from the REQ legal name (trade names are common);
// cross-row reuse is only rejected when the site resembles neither company.

export const FREE_MAIL =
  /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|aol|icloud|me|mac|videotron|sympatico|bell|globetrotter|cgocable|cogeco|telus|shaw|rogers|videotron\.qc|qc\.aira|proton|protonmail|gmx|mail|zoho|yandex|laposte|orange|free|sfr|wanadoo)\.[a-z.]+$/i;

export const BLOCKED_SITES =
  /(^|\.)(lightinthebox|miniinthebox|aliexpress|alibaba|temu|shein|wish|dhgate|ebay|etsy|walmart|bestbuy|costco|homedepot|rona|canadiantire|amazon|wayfair|overstock|target|newegg|zuoyebang|baidu|qq|163|weibo|taobao|tmall|jd|rakuten|kijiji|craigslist|marketplace|shopify|myshopify|wix|wixsite|wixpress|squarespace|weebly|godaddy|wordpress|blogspot|medium|pinterest|reddit|quora|wikipedia|youtube|facebook|instagram|linkedin|twitter|x|tiktok|google|bing|yahoo|duckduckgo|yelp|pagesjaunes|yellowpages|canada411|411|indeed|glassdoor|zoominfo|opencorporates|b2bhint|can1business|opengovca|dnb|bbb|cylex|tripadvisor|sentry|cloudflare|lapresse|ledevoir|journaldemontreal|radio-canada|cbc|ctvnews|globalnews|uqam|umontreal|ulaval|usherbrooke|mcgill|concordia)\.[a-z.]+$|(^|\.)(quebec\.ca|gouv\.qc\.ca|gc\.ca|canada\.ca)$|\.(gov|gouv\.fr|edu|cn|ru)$|\.gov\.[a-z.]+$|\.(sc|ny|ca|tx)\.us$/i;

const STOP = new Set([
  "inc", "ltee", "ltd", "limitee", "limitée", "enr", "senc", "s.e.n.c", "corp", "corporation", "compagnie", "cie",
  "les", "le", "la", "des", "du", "de", "d", "et", "and", "the", "quebec", "canada", "groupe",
  "group", "services", "service", "entreprises", "entreprise", "construction", "co",
]);

/** Extracts a clean host, fixing glued text such as "gmail.comthis". */
export function cleanDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#\s,;]/)[0] ?? "";
  if (s.includes("@")) s = s.split("@")[1] ?? "";
  const m = s.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)*?\.(?:qc\.ca|ca|com|net|org|info|biz|io|co|fr|us|gov|edu|quebec))(?:[a-z]+)?$/);
  const host = m?.[1] ?? null;
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

export const isFreeMailDomain = (d: string | null | undefined) => Boolean(d && FREE_MAIL.test(d.toLowerCase().trim()));
export const isBlockedSite = (d: string | null | undefined) => Boolean(d && BLOCKED_SITES.test(d.toLowerCase().trim()));

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

/**
 * Checks whether an email address directly matches a company name.
 * Small businesses in Quebec frequently communicate using branded mailboxes on
 * free consumer/ISP providers (e.g. gourmandelice30@gmail.com, plomberietremblay@videotron.ca).
 */
export function emailMatchesCompany(email: string, companyName: string): boolean {
  if (!email || !companyName) return false;
  const rawLocal = email.split("@")[0]?.toLowerCase() ?? "";
  const local = rawLocal.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!local) return false;

  // Clean common role prefixes and numeric suffixes (e.g. gourmandelice30 -> gourmandelice)
  const cleanedLocal = local
    .replace(/^(info|contact|admin|ventes|sales|service|direction|accueil|bureau|reception)[._-]?/, "")
    .replace(/\d+$/, "");

  const toks = nameTokens(companyName);
  if (!toks.length) return false;

  // 1. Direct token match
  for (const t of toks) {
    if (t.length >= 3) {
      if (cleanedLocal.includes(t) || local.includes(t)) return true;
      if (cleanedLocal.length >= 4 && t.includes(cleanedLocal)) return true;
    }
  }

  // 2. Combined company tokens (e.g. company "Boulangerie Gourmande" -> "boulangeriegourmande")
  const combined = toks.join("");
  if (combined.length >= 4 && (local.includes(combined) || combined.includes(cleanedLocal))) {
    return true;
  }

  return false;
}

/** True when the site's name shares a word (or the initials) with the company name. */
export function domainResemblesName(domain: string, companyName: string): boolean {
  const base = domain.split(".")[0]!.replace(/-/g, "");
  const toks = nameTokens(companyName);
  if (toks.some((t) => base.includes(t) || (base.length >= 4 && t.includes(base)))) return true;
  const initials = toks.map((t) => t[0]).join("");
  return initials.length >= 2 && base.startsWith(initials);
}

export type GuardInput = { company_name: string; domain: string | null; email: string | null };
export type GuardResult = {
  domain: string | null;
  email: string | null;
  notes: string[];
  freeMail: boolean;
};

/** Applies the per-row rules (no database access). */
export function guardRow(r: GuardInput): GuardResult {
  const notes: string[] = [];
  let domain = cleanDomain(r.domain);
  if (r.domain && !domain) notes.push(`website "${r.domain}" was unreadable — cleared`);
  if (domain && r.domain && domain !== r.domain.trim().toLowerCase().replace(/^www\./, ""))
    notes.push(`website cleaned "${r.domain}" → ${domain}`);
  if (domain && isFreeMailDomain(domain)) {
    notes.push(`${domain} is an email provider, not a company website — cleared`);
    domain = null;
  }
  if (domain && isBlockedSite(domain)) {
    notes.push(`${domain} is a marketplace/directory/government/foreign site — cleared`);
    domain = null;
  }
  let email = r.email?.trim().toLowerCase() || null;
  if (email) {
    const at = email.split("@");
    const ed = cleanDomain(at[1]) || at[1]?.trim().toLowerCase() || null;
    if (!at[0] || !ed) {
      notes.push(`email "${r.email}" was malformed — cleared`);
      email = null;
    } else {
      email = `${at[0]}@${ed}`;
      if (!isFreeMailDomain(ed) && isBlockedSite(ed)) {
        notes.push(`email ${email} belongs to an unrelated platform — cleared`);
        email = null;
      }
    }
  }
  const freeMail = Boolean(email && isFreeMailDomain(email.split("@")[1]));
  return { domain, email, notes, freeMail };
}

/**
 * Cross-row rule: a website already saved for another company is kept when
 * either company's name resembles it, or both share a phone (same owner /
 * franchise). Otherwise it is generic noise and dropped.
 */
export function sharedDomainAllowed(
  domain: string,
  thisName: string,
  others: { company_name: string; phone: string | null }[],
  thisPhone: string | null,
): boolean {
  if (domainResemblesName(domain, thisName)) return true;
  const digits = (p: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
  return others.some(
    (o) => domainResemblesName(domain, o.company_name) || (thisPhone && digits(o.phone) === digits(thisPhone)),
  );
}
