/** Merge fields available in mass-email subjects and bodies. */
export const MERGE_FIELDS = [
  "company",
  "contact_name",
  "first_name",
  "title",
  "email",
  "phone",
  "city",
  "domain",
] as const;

export type MergeData = Partial<Record<(typeof MERGE_FIELDS)[number], string | null | undefined>>;

/** Replaces {{field}} placeholders; unknown fields render as an empty string. */
export function renderTemplate(input: string, data: MergeData): string {
  return String(input ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => {
    const value = (data as Record<string, unknown>)[key.toLowerCase()];
    return value == null ? "" : String(value);
  });
}

export function mergeDataFor(contact: {
  company_name?: string | null;
  contact_name?: string | null;
  executive_name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  domain?: string | null;
}): MergeData {
  const name = contact.contact_name ?? contact.executive_name ?? "";
  return {
    company: contact.company_name ?? "",
    contact_name: name,
    first_name: name.split(/\s+/)[0] ?? "",
    title: contact.title ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    city: contact.city ?? "",
    domain: contact.domain ?? "",
  };
}

/** Very small text → HTML conversion so plain-text templates still look fine. */
export function textToHtml(body: string): string {
  const escaped = String(body ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
  );
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827">${withLinks
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("")}</div>`;
}

export const DEFAULT_TEMPLATE = {
  name: "Intro — recycling partnership",
  subject: "Partnership opportunity for {{company}}",
  body: `Hello {{first_name}},

I'm reaching out to {{company}} about a recycling and materials recovery partnership in your area.

We work with companies like yours to divert waste, cut disposal costs and stay compliant with Quebec regulations. If this is relevant, I'd be glad to share a short overview.

Would a 15-minute call this week work?

Best regards,`,
};
