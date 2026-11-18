import { createFileRoute } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/report")({
  head: () => ({
    meta: [
      { title: "Progress Report — RECYC Contact OSINT" },
      {
        name: "description",
        content:
          "Formal progress report on the RECYC Contact OSINT platform: architecture, discovery pipeline, verification model, performance, costs, limitations and next steps.",
      },
      { property: "og:title", content: "Progress Report — RECYC Contact OSINT" },
      {
        property: "og:description",
        content:
          "Technical and methodological progress report for the REQ executive-contact discovery platform.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ReportPage,
});

function H({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-foreground">{children}</h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function UL({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function Sheet({ children }: { children: ReactNode }) {
  return (
    <Card className="mx-auto w-full max-w-4xl">
      <CardContent className="space-y-4 p-6 md:p-10">{children}</CardContent>
    </Card>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="bg-muted/50">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold text-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 text-muted-foreground">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportPage() {
  return (
    <AppShell
      title="Progress report"
      description="Formal write-up of the RECYC-Contact-OSINT platform, its methodology, results and limitations."
      actions={
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" />
          Print / Save as PDF
        </Button>
      }
    >
      <Sheet>
        <header className="space-y-1 border-b border-border pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Progress report — Contact discovery platform
          </p>
          <h1 className="text-2xl font-semibold text-foreground">
            RECYC-Contact-OSINT — automated executive contact acquisition over the REQ population
          </h1>
          <p className="text-xs text-muted-foreground">Internal / Confidential — engineering & methodology report</p>
        </header>

        <H>1. Objectives and context</H>
        <P>
          The project constitutes a contact database of top executives — or, as fallback, organisational contacts —
          across the Quebec Enterprise Register (REQ) population, representative by sector, size and legal form. With a
          conservative 5% survey response rate, roughly 40,000 high-fidelity emails are needed to reach ~2,000 completed
          responses.
        </P>
        <P>
          No integrated database indexes REQ companies by NEQ together with administrator contact information.
          RECYC-Contact-OSINT was therefore built as an in-house acquisition platform: it ingests raw REQ exports and
          returns the same list, enriched, scored and auditable, at a throughput compatible with tens of thousands of
          rows.
        </P>

        <H>2. System overview</H>
        <P>
          The platform is a full-stack TypeScript web application (TanStack Start, React 19, Tailwind CSS, shadcn/ui)
          backed by a PostgreSQL database with row-level security. Every user only ever sees their own jobs and
          contacts. Enrichment runs server-side as durable background work, not in the browser, so a batch continues
          even if the operator closes the tab.
        </P>
        <UL
          items={[
            <>
              <b>Authentication & profile</b> — email/password sessions, no email confirmation step, per-user profile
              and settings records created on signup.
            </>,
            <>
              <b>Batch pipeline</b> — drag-and-drop upload of REQ CSV/Excel exports, header auto-detection (NEQ, legal
              name, alternate names, postal code, sector, employee count), batch range selector, model selector,
              execution-target toggles, start/pause/stop control.
            </>,
            <>
              <b>Real-time feedback</b> — live progress bar, processed / found / failed counters, ETA, and a monospace
              terminal window streaming per-row reasoning (which engine was queried, what was found, why a candidate was
              rejected).
            </>,
            <>
              <b>Verified contacts table</b> — filterable, responsive (card layout on mobile), per-row verification
              rationale, bulk selection and deletion, and CSV export of the enriched list.
            </>,
            <>
              <b>Dashboard analytics</b> — success percentages, high-confidence counts, active vs dissolved vs unknown
              legal status, and 24h / 7d / 30d volume with success rates.
            </>,
            <>
              <b>API settings</b> — operators may store their own Gemini / Perplexity / OpenAI keys; the model dropdown
              only lists models whose key is actually available, otherwise the platform-provided Gemini model is used.
            </>,
          ]}
        />

        <H>3. Scalability model</H>
        <P>
          An 18,000-row REQ file is not processed in a single request. The upload is chunked client-side and streamed
          into a <code>job_rows</code> queue table. A server-side worker claims rows in small batches using{" "}
          <code>SELECT … FOR UPDATE SKIP LOCKED</code>, which allows several workers to drain the same queue
          concurrently without double-processing. Each row is independently retried and independently logged, so a
          single failing target cannot stall the batch. A scheduled database job re-triggers the worker, meaning
          processing continues while nobody is connected. Pausing flips a job state that workers observe between claims.
        </P>
        <P>
          Practical consequence: throughput scales with worker concurrency and with the politeness delays imposed by the
          upstream sources, not with browser or request limits. The binding constraint is external rate-limiting, not
          the architecture.
        </P>

        <H>4. Discovery methodology</H>
        <P>
          The pipeline is deliberately <b>OSINT-first and AI-last</b>. Language models are only invoked when
          deterministic collection has failed or is ambiguous, which both reduces cost and removes the main source of
          fabricated contacts. The nine stages are:
        </P>
        <UL
          items={[
            <>
              <b>Name normalisation</b> — legal suffixes, accents, numbered-company artefacts and alternate names for
              the same NEQ are reconciled into a query set.
            </>,
            <>
              <b>Multi-engine search</b> — five independent search front-ends (DuckDuckGo, Brave, Bing, Yahoo, and a
              lite endpoint) are queried with targeted operators, geographically locked to Canada. Custom target sites
              supplied by the operator are queried too.
            </>,
            <>
              <b>Official site identification and deep crawl</b> — a candidate domain is accepted only if the hostname
              plausibly corresponds to the company name; the crawler then walks contact / about / team / leadership
              pages and extracts mailto links, obfuscated addresses, phones and postal addresses.
            </>,
            <>
              <b>Registry mirrors</b> — b2bhint, opencorporates, can1business and opengovca are probed by NEQ and name
              for administrators, addresses and legal status; when a mirror rate-limits, the search snippet is parsed
              instead.
            </>,
            <>
              <b>Social discovery</b> — LinkedIn company/person URLs and Facebook page URLs are resolved and their
              public meta descriptions mined; bare or login/share/plugin URLs are rejected so no placeholder link is
              ever stored as a source.
            </>,
            <>
              <b>Pattern generation</b> — when an executive name and a verified corporate domain are both known, common
              address patterns are generated as candidates, never as confirmed results.
            </>,
            <>
              <b>Generic fallback</b> — where no executive address exists, role addresses (info@, contact@) are captured
              deliberately, on the reasoning that in a small company the general inbox reaches the owner.
            </>,
            <>
              <b>AI on evidence only</b> — the model receives the collected corpus and is asked to extract and attribute,
              not to recall. Gemini is the default; operator-supplied Perplexity or other keys are used
              when present.
            </>,
            <>
              <b>Scoring and persistence</b> — every field is written with its discovery source and a 0–5 confidence.
            </>,
          ]}
        />

        <H>5. Email verification model</H>
        <P>
          Deliverability and identity are treated as two different questions. The platform is explicit about which one
          it can answer. Each candidate address is scored on independent signals:
        </P>
        <Table
          head={["Signal", "What it proves", "Weight"]}
          rows={[
            ["Syntax and role detection", "Well-formed; distinguishes personal from role address", "Gate"],
            ["Disposable / free-provider check", "Rejects throwaway domains; flags gmail-type as non-corporate", "Negative"],
            ["MX record", "The domain can receive mail at all", "Necessary"],
            ["A / SPF / DMARC records", "The domain is a real, configured mail sender", "Supporting"],
            ["Domain–company correspondence", "The address belongs to the target company, not a lookalike", "Strong"],
            ["Corpus corroboration", "The exact string appears on the official site or a trusted source", "Decisive"],
            ["Cross-source agreement", "Two independent sources returned the same address", "Decisive"],
          ]}
        />
        <P>
          The honest limitation, stated plainly: an MX record proves the mail domain exists, never that a specific
          mailbox belongs to a specific person. Only corpus corroboration — the address literally published on the
          company's own site or registry entry — supports a 5. Everything else is capped lower, and the reasons are
          stored per row and shown in the table, so a reviewer can audit any score rather than trust it.
        </P>

        <H>6. Confidence scale</H>
        <Table
          head={["Score", "Meaning"]}
          rows={[
            ["5", "Published directly on the official company website or official registry entry"],
            ["4", "Two independent trusted sources agree, corporate domain, full mail configuration"],
            ["3", "Single trusted source, or verified generic/role address on the corporate domain"],
            ["2", "Directory or low-trust source, domain plausible, no corroboration"],
            ["1", "Pattern-generated or weakly inferred candidate — treat as a hypothesis"],
            ["0", "No result"],
          ]}
        />

        <H>7. Output and completeness</H>
        <P>
          The export mirrors the uploaded list one-to-one: every input row produces an output row, filled with whatever
          was found and empty where nothing was. Fields returned are NEQ, company name, company legal status (including
          dissolved / radiée), executive name and title, email, email type, verification status and rationale,
          confidence, phone, postal address, LinkedIn URL, Facebook URL, registry URL and discovery source. This
          preserves the sampling frame — non-findings are data, and dropping them would bias the sample.
        </P>

        <H>8. Observed behaviour and limitations</H>
        <UL
          items={[
            "Coverage is strongly conditioned by online presence. Companies with an official website yield executive-level data at a far higher rate than those with none; numbered companies with no trading name are close to unrecoverable by any automated means.",
            "Phone numbers surface more readily than emails, consistent with the finding in the reference report; SMS outreach may therefore reach segments email cannot.",
            "Registry mirrors rate-limit aggressively. The snippet-fallback path recovers legal status in many of those cases but not the full administrator list.",
            "JavaScript-rendered contact sections, click-to-reveal email widgets and Cloudflare interstitials are the dominant remaining failure mode.",
            "Headless browsing (Playwright) and Python crawlers (Scrapy) do not run inside the hosted runtime. A worker hook is implemented: setting OSINT_WORKER_URL routes every page fetch through an external Playwright service, with silent fallback to plain HTTP. Firecrawl is the hosted alternative.",
          ]}
        />

        <H>9. Cost posture</H>
        <P>
          The deterministic stages cost nothing per row beyond bandwidth. AI is invoked only on rows that deterministic
          collection could not resolve, and only over already-collected evidence, which keeps the token footprint small
          and bounded. Commercial data services are not required for the platform to operate; where purchased data is
          available, it can be ingested as an additional input rather than replacing the pipeline.
        </P>

        <H>10. Comparison with the external agent approach</H>
        <P>
          The reference progress report describes a single-LLM agent (Perplexity Sonar Pro) performing sequential
          prompted search, evaluated on a 293-row REQ sample: online resources identified in 32% of cases (22% official
          websites), executive names in 10%, executive emails in 5%, phones in 8%, company-level email in 8% and phone
          in 12%, with mean confidence 2.25 for executive emails and 3.54 for company contacts.
        </P>
        <Table
          head={["Dimension", "Reference LLM agent", "RECYC-Contact-OSINT"]}
          rows={[
            ["Primary mechanism", "LLM with live search, prompted sequentially", "Deterministic OSINT first, LLM only on unresolved rows"],
            ["Per-row marginal cost", "One or more paid LLM calls on every row", "Zero on resolved rows; LLM only on the remainder"],
            ["Throughput at 18k–40k rows", "Bounded by API rate limits and cost", "Queue with SKIP LOCKED, concurrent workers, resumable"],
            ["Verification", "Confidence assigned by source trust", "Same, plus MX/SPF/DMARC, domain match, corpus corroboration, stored rationale"],
            ["Auditability", "Model-reported confidence", "Per-row log of every engine, hit and rejection"],
            ["Legal status / address", "Not covered", "Captured (active / dissolved / radiée, postal address)"],
            ["Operator control", "Fixed prompt chain", "Country lock, custom target sites, per-source toggles, own API keys"],
            ["JS-heavy / protected pages", "Handled by the vendor's crawler", "Current gap — needs Playwright worker or Firecrawl"],
            ["Data ownership", "Vendor-mediated", "Self-hosted database, exportable, no vendor lock-in"],
          ]}
        />
        <P>
          <b>Assessment.</b> As a system, this platform is the stronger instrument for the stated objective: it is
          built for the scale actually required, it is resumable and auditable, it captures fields the agent does not
          (legal status, address, social URLs, verification rationale), and its cost does not grow linearly with the
          size of the sample. The reference agent is a better-characterised <i>measurement</i> — it has a clean 293-row
          benchmark with reported rates; this platform does not yet have an equivalent published figure.
        </P>
        <P>
          The one dimension where the reference approach currently has a real edge is retrieval from
          JavaScript-rendered and bot-protected pages, which Sonar Pro's hosted crawler handles and this platform does
          not until the Playwright worker or Firecrawl is enabled. That gap is a configuration item, not an
          architectural one.
        </P>
        <P>
          Neither approach is a golden bullet, and the conclusion of the reference report holds here: the highest yield
          comes from combining channels — a repository providing administrator names and domains, this platform
          resolving and verifying contacts at scale, and an email-finder service used selectively on the residual.
        </P>

        <H>11. Latest release — corroborated status, column passthrough, charts</H>
        <UL
          items={[
            "Legal status is now vote-based: only explicit \"Statut / Legal status\" fields count, empty dissolution fields are ignored, and a DISSOLVED/INACTIVE verdict requires a labelled registry field or two independent hosts in agreement. This removes the false \"everything is dissolved\" readings caused by boilerplate text.",
            "Every status decision is logged with its verdict, confirmation count and the hosts that supplied it; unconfirmed readings are discarded and reported as such.",
            "Legal status capture is an operator toggle under OSINT sources — untick it and the field is left empty for the whole batch.",
            "Shared identifiers: an email or phone that also appears under unrelated businesses is accepted whenever the reverse lookup ties it to the target company. Exclusive third-party attribution now downgrades and flags instead of deleting, and phones are never dropped without a replacement.",
            "Column passthrough: each uploaded row is stored verbatim; exports emit the original columns in the original order, followed by all discovered fields.",
            "Dashboard charts: 14-day processed vs found volume, confidence 0–5 histogram, and verification outcome mix.",
          ]}
        />

        <H>12. Duplicate awareness and re-checks</H>
        <UL
          items={[
            "A row counts as already checked when a stored contact matches its NEQ, or its company name when the NEQ is absent.",
            "Verified Contacts exposes a per-row Re-check action and a bulk Re-check for the current selection. The first call is a dry run: it returns how many rows were already checked, when, and with which status, and the UI asks whether to replace them.",
            "Confirming creates a dedicated Re-check batch that inherits the model, OSINT toggles and preserved columns of the original job, deletes the superseded contacts, and starts immediately with live per-record logging.",
            "Batch Jobs performs the same duplicate scan before launching a range, offering replace, skip-already-checked, or cancel — so a re-uploaded file never silently duplicates work or rows.",
            "Re-checks always execute the full nine-stage pipeline; results are recomputed live rather than served from cache.",
          ]}
        />

        <H>13. Suggested next steps</H>
        <UL
          items={[
            "Run a benchmark on the same 293-row sample used for the reference agent, to produce directly comparable found-rates and confidence distributions.",
            "Enable a headless-rendering pass (Playwright worker or Firecrawl) restricted to rows that failed the deterministic pipeline, to close the JS/Cloudflare gap at minimal cost.",
            "Manually validate a random subsample of returned emails to calibrate the confidence scale against ground truth and quantify the false-positive rate.",
            "Ingest any purchased repository (administrator names + domains) as a pre-seed input; found names measurably improve downstream email resolution.",
            "Add per-source yield reporting so low-value sources can be pruned and politeness budgets reallocated.",
          ]}
        />

      </Sheet>
    </AppShell>
  );
}
