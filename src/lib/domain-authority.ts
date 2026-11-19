// Client-safe domain trust rating used to score where a contact was found.
// The score is a 0–100 "how authoritative is this source" rating, derived from
// curated tiers (official registries > business registries > directories >
// social > unknown), the TLD and a few obvious low-trust patterns.

export type DomainRating = {
  host: string;
  score: number;
  tier: string;
};

const TIERS: { score: number; tier: string; hosts: RegExp }[] = [
  {
    score: 98,
    tier: "Official government registry",
    hosts: /(^|\.)(gouv\.qc\.ca|registreentreprises\.gouv\.qc\.ca|canada\.ca|ic\.gc\.ca|gc\.ca|gov)$|(^|\.)(gouv\.qc\.ca|canada\.ca|gc\.ca)$/i,
  },
  {
    score: 88,
    tier: "Business registry mirror",
    hosts: /(^|\.)(opencorporates\.com|opengovca\.com|can1business\.com|companies-canada\.ca|b2bhint\.com|northdata\.com)$/i,
  },
  {
    score: 74,
    tier: "Major business directory",
    hosts: /(^|\.)(pagesjaunes\.ca|yellowpages\.ca|canada411\.ca|411\.ca|yelp\.(com|ca)|bbb\.org|dnb\.com|kompass\.com|europages\.[a-z.]+|manta\.com|cylex[a-z-]*\.[a-z.]+)$/i,
  },
  {
    score: 70,
    tier: "Professional network",
    hosts: /(^|\.)linkedin\.com$/i,
  },
  {
    score: 62,
    tier: "Maps / local listing",
    hosts: /(^|\.)(google\.[a-z.]+|maps\.google\.[a-z.]+|apple\.com|bing\.com|foursquare\.com)$/i,
  },
  {
    score: 55,
    tier: "Social profile",
    hosts: /(^|\.)(facebook\.com|mbasic\.facebook\.com|instagram\.com|x\.com|twitter\.com)$/i,
  },
  {
    score: 40,
    tier: "Aggregator / scraped listing",
    hosts: /(^|\.)(zoominfo\.com|rocketreach\.co|signalhire\.com|lead411\.com|apollo\.io|leadiq\.com|contactout\.com|hunter\.io)$/i,
  },
  {
    score: 25,
    tier: "Low-trust content farm",
    hosts: /(^|\.)(blogspot\.com|wordpress\.com|medium\.com|pinterest\.[a-z.]+|scribd\.com)$/i,
  },
];

/** Normalises any URL or hostname to a bare host. */
export function toHost(input: string): string {
  const raw = (input || "").trim();
  try {
    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./, "").toLowerCase();
  }
}

/**
 * Rates a source domain 0–100. `companyDomain` gets the highest rating because
 * data published on the company's own website is first-party evidence.
 */
export function rateDomain(input: string, companyDomain?: string | null): DomainRating {
  const host = toHost(input);
  if (!host) return { host: "", score: 0, tier: "Unknown" };

  const own = companyDomain ? toHost(companyDomain) : "";
  if (own && (host === own || host.endsWith(`.${own}`))) {
    return { host, score: 95, tier: "Company's own website" };
  }

  for (const t of TIERS) {
    if (t.hosts.test(host)) return { host, score: t.score, tier: t.tier };
  }

  // Unknown host: start from a neutral base and adjust on cheap signals.
  let score = 50;
  if (/\.(gouv|gov|gc)\.[a-z.]+$/.test(host)) score += 25;
  if (/\.(ca|com|org|net)$/.test(host)) score += 5;
  if (/\.(edu|ac\.[a-z]{2})$/.test(host)) score += 10;
  if (/\.(xyz|top|click|info|biz|tk|ml|ga|cf|gq|buzz)$/.test(host)) score -= 20;
  if (host.split(".").length > 3) score -= 5;
  if (host.length > 32) score -= 3;
  return { host, score: Math.max(5, Math.min(90, score)), tier: "Unclassified website" };
}

/**
 * Collective score for a row: weighted toward the best source, with a bonus for
 * having several independent hosts agreeing. Returns 0–100.
 */
export function collectiveScore(ratings: DomainRating[]): number {
  const hosts = new Map<string, DomainRating>();
  for (const r of ratings) if (r.host && !hosts.has(r.host)) hosts.set(r.host, r);
  const list = [...hosts.values()].sort((a, b) => b.score - a.score);
  if (!list.length) return 0;
  const best = list[0]!.score;
  const rest = list.slice(1, 5);
  const avgRest = rest.length ? rest.reduce((s, r) => s + r.score, 0) / rest.length : 0;
  const breadth = Math.min(12, (list.length - 1) * 4);
  return Math.round(Math.max(0, Math.min(100, best * 0.7 + avgRest * 0.3 + breadth)));
}

export function scoreLabel(score: number): string {
  if (score >= 85) return "Very strong";
  if (score >= 70) return "Strong";
  if (score >= 55) return "Moderate";
  if (score >= 35) return "Weak";
  return "Very weak";
}

/** Builds the reference list stored on the contact and replayed in exports. */
export function buildReferences(
  urls: (string | null | undefined)[],
  companyDomain?: string | null,
): { url: string; host: string; score: number; tier: string }[] {
  const seen = new Set<string>();
  const out: { url: string; host: string; score: number; tier: string }[] = [];
  for (const u of urls) {
    if (!u || typeof u !== "string") continue;
    const url = u.trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const rating = rateDomain(url, companyDomain);
    if (!rating.host) continue;
    out.push({ url, host: rating.host, score: rating.score, tier: rating.tier });
    if (out.length >= 25) break;
  }
  return out.sort((a, b) => b.score - a.score);
}

export type EvidenceRubricItem = {
  score: number;
  criteria: string;
  action: string;
  label: string;
};

export const EVIDENCE_RUBRIC: Record<number, EvidenceRubricItem> = {
  0: {
    score: 0,
    criteria: "Domain unresolved, DNS check fails, or no usable web presence is identified.",
    action: "Record purged from the active discovery pool.",
    label: "Domain Unresolved",
  },
  1: {
    score: 1,
    criteria: "Domain resolves, but no corroborated email address, telephone number, or executive record is identified.",
    action: "Record logged without contact information.",
    label: "Domain Only / No Contact",
  },
  2: {
    score: 2,
    criteria: "Only a generic role-based email address is identified, without a verified link to an executive.",
    action: "Flagged as a secondary institutional contact option.",
    label: "Generic Role Account",
  },
  3: {
    score: 3,
    criteria: "Executive name and corporate domain are identified, and a candidate email passes the passive MX check but lacks public confirmation.",
    action: "Retained as an internal hypothesis and excluded from the proposed outreach list.",
    label: "Candidate Executive (Unconfirmed)",
  },
  4: {
    score: 4,
    criteria: "A named decision-maker is identified, and the associated email address is published on the company’s website or an official registry.",
    action: "Eligible for further outreach review.",
    label: "Published Decision-Maker",
  },
  5: {
    score: 5,
    criteria: "The executive’s name, title, telephone number, and email address are corroborated across at least two independent public sources.",
    action: "Eligible for further outreach review.",
    label: "Corroborated Executive (Multi-Source)",
  },
};

export function getEvidenceRubric(score: number, hasPhoneOrAddress?: boolean): EvidenceRubricItem {
  const s = Math.max(0, Math.min(5, Math.round(score)));
  if (s === 0 && hasPhoneOrAddress) {
    return {
      score: 1,
      criteria: "No verified email discovered, but verified telephone and/or civic location corroborated.",
      action: "Eligible for telephone outreach or manual review.",
      label: "Phone / Location Verified",
    };
  }
  return EVIDENCE_RUBRIC[s] ?? EVIDENCE_RUBRIC[0]!;
}

