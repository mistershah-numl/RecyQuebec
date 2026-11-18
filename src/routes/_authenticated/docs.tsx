import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/docs")({
  head: () => ({
    meta: [
      { title: "How It Works — RECYC Contact OSINT" },
      {
        name: "description",
        content:
          "Full documentation of the RECYC Contact OSINT pipeline: data sources, OSINT layers, email verification, AI fallback, and local Playwright/Scrapy setup.",
      },
      { property: "og:title", content: "How It Works — RECYC Contact OSINT" },
      {
        property: "og:description",
        content: "Every feature, every data source, and how to extend the system locally with Playwright and Scrapy.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DocsPage,
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-semibold text-foreground">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <div className="mt-1 space-y-2">{children}</div>
      </div>
    </div>
  );
}

function DocsPage() {
  return (
    <AppShell
      title="How It Works"
      description="Everything the system does, where the data comes from, and how to extend it locally"
    >
      <div className="mx-auto grid max-w-4xl gap-6">
        <Section title="1. What has been built so far">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">Authentication & profile</span> — email/password sign-up and login with
              no email confirmation step, a per-user profile page, and every table protected by row-level security so a
              user can only ever read their own jobs, rows, logs and contacts.
            </li>
            <li>
              <span className="text-foreground">Batch pipeline</span> — drag-and-drop upload of Quebec REQ CSV/XLSX
              files, header auto-mapping (NEQ, company name, city, postal code), a row-range selector, chunked upload
              so an 18,000-row file is streamed to the database in slices instead of one giant request.
            </li>
            <li>
              <span className="text-foreground">Scalable worker</span> — rows live in a queue table and are claimed with{" "}
              <code>FOR UPDATE SKIP LOCKED</code>, so multiple workers can process the same job concurrently without
              double-processing a row. Work continues in the background through a scheduled cron hook even if you close
              the browser tab, and resumes exactly where it stopped after a pause.
            </li>
            <li>
              <span className="text-foreground">Live feedback</span> — progress bar, processed/found/verified/failed
              counters, ETA, and a monospace terminal that streams a per-row trail ("searching Bing…", "found on
              registry…", "LLM not needed…").
            </li>
            <li>
              <span className="text-foreground">Verified contacts table</span> — search, status filter, confidence
              filter, pagination, per-row and select-all deletion, CSV export, responsive card layout on mobile, and a
              "why?" expander that shows the exact reasons behind each verification score.
            </li>
            <li>
              <span className="text-foreground">Stats</span> — success rate, verified rate, high-confidence count,
              nothing-found count, active vs dissolved companies, and 24h / 7d / 30d discovery volume.
            </li>
            <li>
              <span className="text-foreground">Model settings</span> — bring your own Gemini / OpenAI / Perplexity /
              Anthropic keys; the model dropdown only lists models you actually have a key for, and Lovable AI (Gemini)
              is the default so nothing breaks before you add keys.
            </li>
            <li>
              <span className="text-foreground">Field coverage</span> — NEQ, company name, legal status, executive name,
              title, email, email type (executive / company / personal), phone, address, LinkedIn URL, Facebook URL,
              registry URL, verification status, confidence 0–5, discovery source.
            </li>
          </ul>
        </Section>

        <Section title="2. How data is actually found — the pipeline, stage by stage">
          <p>
            The pipeline is <span className="text-foreground">OSINT-first</span>: AI is only called when free, public
            sources fail. That keeps results factual and keeps credit usage low.
          </p>

          <div className="space-y-4">
            <Step n="1" title="Name cleaning & query building">
              <p>
                Legal suffixes (INC., LTÉE, S.E.N.C.) are stripped, accents normalised, and a token is derived for
                domain guessing. Queries are built from company name + city + your extra keywords, and — with Country
                Lock on — restricted to Canadian results (foreign TLDs are dropped, <code>.ca</code> and Canadian
                directory hosts are preferred).
              </p>
            </Step>

            <Step n="2" title="Multi-engine web search">
              <p>
                Each query is run in parallel against <span className="text-foreground">DuckDuckGo (HTML endpoint),
                Brave, Bing, Yahoo and Mojeek</span>, results deduplicated, and junk hosts (aggregator spam, tracking
                domains, marketplaces) removed. Both the links and the result snippets are kept — snippets alone often
                contain a phone number, an address or a legal status.
              </p>
            </Step>

            <Step n="3" title="Official-site discovery + deep crawl">
              <p>
                The most plausible company domain is picked with a hostname-similarity guard (the host must resemble the
                company name, so <code>facebook.com</code> or a random blog never gets accepted as "the company site").
                Then the site is crawled: the homepage, its sitemap, and the usual contact paths —{" "}
                <code>/contact</code>, <code>/contact-us</code>, <code>/about</code>, <code>/equipe</code>,{" "}
                <code>/nous-joindre</code>, <code>/team</code>, <code>/leadership</code>. Every page is stripped of HTML
                and mined for emails, phone numbers, postal addresses (Canadian street + postal-code regex) and
                person + job-title pairs.
              </p>
            </Step>

            <Step n="4" title="Registry & directory mirrors">
              <p>
                NEQ / company name lookups against public registry mirrors —{" "}
                <span className="text-foreground">b2bhint, OpenCorporates, can1business, opengovca</span> — plus general
                business directories. These give the legal name, the official address, and the{" "}
                <span className="text-foreground">legal status</span> (Active, Dissolved, Radiée, Struck off, Active –
                dissolution pending). When a mirror rate-limits us, the status is still recovered from the search
                snippet.
              </p>
            </Step>

            <Step n="5" title="Social discovery">
              <p>
                LinkedIn company/people pages and Facebook pages are located through search and validated: only real
                profile URLs (<code>/company/…</code>, <code>/in/…</code>, <code>/profile.php?id=…</code>, page slugs)
                are stored — bare <code>facebook.com</code>, login, share and plugin URLs are rejected. Public page text
                and meta description are mined for the same fields (Facebook pages frequently expose the business email
                and phone in plain text).
              </p>
            </Step>

            <Step n="6" title="Pattern generation">
              <p>
                If an executive name and a company domain are known but no address was published, standard corporate
                patterns are generated (<code>first.last@</code>, <code>flast@</code>, <code>first@</code>, …). These
                are candidates only — they must survive verification before they can score highly.
              </p>
            </Step>

            <Step n="7" title="Generic-mailbox fallback">
              <p>
                When no personal mailbox exists anywhere, generic company mailboxes (<code>info@</code>,{" "}
                <code>contact@</code>, <code>admin@</code>, <code>ventes@</code>) found on the site — or generated on the
                confirmed domain — are used and tagged <Badge variant="secondary">company</Badge> so you know it isn't a
                named executive.
              </p>
            </Step>

            <Step n="8" title="AI only if still incomplete">
              <p>
                Only if OSINT came back thin does the LLM run, and it runs{" "}
                <span className="text-foreground">on the collected evidence</span> (snippets, crawled text, registry
                text) rather than from memory — it extracts and structures, it does not invent. Default is Lovable AI
                (Gemini); if you save your own Gemini / OpenAI / Perplexity / Anthropic key in API Settings, that
                provider is used instead. Anything the model returns is then pushed back through verification.
              </p>
            </Step>

            <Step n="9" title="Multi-signal verification & scoring">
              <p>Every candidate email is scored 0–5 from independent signals, not just MX:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>RFC syntax and role/disposable-domain checks</li>
                <li>DNS: MX records, A-record fallback, SPF and DMARC presence</li>
                <li>Domain must match the company's confirmed domain (free-mail domains are downgraded)</li>
                <li>
                  Corroboration: the exact address literally appearing in the crawled corpus (site, registry, social,
                  directory) — and in how many independent sources
                </li>
                <li>Local-part must match the executive's name tokens for an "executive" classification</li>
              </ul>
              <p>
                The result is stored as <Badge>Verified</Badge> (cross-corroborated),{" "}
                <Badge variant="secondary">MX Verified</Badge>, <Badge variant="secondary">Unverified</Badge> or{" "}
                <Badge variant="destructive">Invalid</Badge>, together with the list of reasons you can read under
                "why?" in the table.
              </p>
            </Step>
          </div>

          <p className="rounded-md border border-border p-3">
            <span className="text-foreground">Honest limitation:</span> no public method proves that a mailbox belongs
            to a specific human. A generic personal address like <code>someone@gmail.com</code> can be verified as
            deliverable and can be corroborated (it appears on the company's own contact page next to that person's
            name), but "deliverable + corroborated" is the strongest claim anyone can make without sending mail. That is
            exactly why the score is 0–5 with visible reasons instead of a fake yes/no.
          </p>
        </Section>

        <Section title="3. Are Playwright and Scrapy running here? — the honest answer">
          <p>
            <span className="text-foreground">No.</span> This app is deployed to a serverless edge runtime. There is no
            Python interpreter, so <span className="text-foreground">Scrapy cannot run</span>, and there is no ability to
            launch a Chromium process, so <span className="text-foreground">Playwright cannot run</span> either. Any tool
            that says otherwise about a hosted environment like this is wrong.
          </p>
          <p>What is used instead, and what it costs you:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">Direct HTTP + HTML parsing</span> (the same job Scrapy's downloader and
              selectors do): fetch with a browser user-agent and timeout, strip tags, regex/heuristic extraction, sitemap
              expansion, concurrency limits. For the large majority of SME business sites, registries and directories —
              which are server-rendered HTML — this returns identical data to Scrapy.
            </li>
            <li>
              <span className="text-foreground">What is genuinely lost without a real browser:</span> sites that render
              contact details only via JavaScript, pages behind Cloudflare/bot interstitials, "click to reveal email"
              widgets, and directories that require a session or human-check. Those are the rows that come back empty.
            </li>
            <li>
              <span className="text-foreground">Hosted fix (no local setup):</span> enable the Firecrawl connector — it
              runs a real headless browser on their infrastructure and returns rendered markdown, so JS-only and
              bot-protected pages become readable. It plugs into the same crawl stage. It costs credits per page, so it
              is best switched on as a "second pass, only for rows that failed".
            </li>
          </ul>
        </Section>

        <Section title="4. Running it locally with Playwright and Scrapy">
          <p>
            The clean way is to keep this app as-is and run your own scraper service next to it, exposing one HTTP
            endpoint. The pipeline then calls that endpoint during the crawl stage, and everything else — verification,
            scoring, storage, export — stays unchanged.
          </p>

          <p className="text-foreground">Step 1 — run the app locally</p>
          <Code>{`git clone <your-repo> && cd recyc-contact-osint
npm install
# .env already contains the backend URL + publishable key
npm run dev          # http://localhost:8080`}</Code>

          <p className="text-foreground">Step 2 — a Playwright + Scrapy microservice</p>
          <Code>{`mkdir osint-worker && cd osint-worker
python -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn playwright scrapy beautifulsoup4
playwright install chromium`}</Code>
          <Code>{`# main.py
from fastapi import FastAPI
from pydantic import BaseModel
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

app = FastAPI()

class Req(BaseModel):
    url: str
    wait_for: str | None = None

@app.post("/render")
async def render(req: Req):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(user_agent="Mozilla/5.0")
        await page.goto(req.url, wait_until="networkidle", timeout=30000)
        if req.wait_for:
            await page.wait_for_selector(req.wait_for, timeout=10000)
        # click typical "reveal email" buttons before reading the DOM
        for sel in ["text=Show email", "text=Reveal", ".show-email"]:
            try:
                await page.click(sel, timeout=1500)
            except Exception:
                pass
        html = await page.content()
        await browser.close()
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    return {"html": html, "text": text}`}</Code>
          <Code>{`uvicorn main:app --port 8000`}</Code>
          <p>
            Use Scrapy for the breadth-first side: a spider that walks a directory's pagination and posts each detail
            page's text to the same store, and let Playwright handle only the JS-heavy detail pages (via{" "}
            <code>scrapy-playwright</code> if you want them in one process).
          </p>

          <p className="text-foreground">Step 3 — point the pipeline at it</p>
          <p>
            <span className="text-foreground">This hook is already wired.</span> Set{" "}
            <code>OSINT_WORKER_URL=http://localhost:8000</code> (and optionally{" "}
            <code>OSINT_WORKER_SECRET</code>, sent as the <code>x-worker-secret</code> header) in your environment and
            every page load in the pipeline goes through your worker&apos;s <code>POST /render</code>. If the variable is
            unset, or the worker is down or slow, the pipeline silently falls back to the plain HTTP fetch it uses today
            — so nothing breaks either way. The worker must answer with{" "}
            <code>{"{ html }"}</code> or <code>{"{ text }"}</code>.
          </p>
          <Code>{`// inside safeFetch(url)
const worker = process.env.OSINT_WORKER_URL;
if (worker) {
  const r = await fetch(worker + "/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (r.ok) return (await r.json()).html as string;
}
// …existing plain fetch fallback`}</Code>
          <p>
            Because it is one choke point, every stage — site crawl, registry mirrors, social pages, directories —
            immediately gains JS rendering and bot-check survival, with zero changes elsewhere. Say the word and I'll
            wire that env-var branch in for you.
          </p>
          <p>
            If you go this route in production, host the worker on any box that allows processes (a small VPS, Fly.io,
            Railway, Render), put a shared secret header on it, and set the same variable in the app's server
            environment.
          </p>
        </Section>

        <Section title="5. Day-to-day usage">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <span className="text-foreground">API Settings</span> — optionally paste your Gemini / OpenAI / Perplexity
              keys. Skip this and Lovable AI (Gemini) is used.
            </li>
            <li>
              <span className="text-foreground">Batch Jobs → New batch</span> — drop your REQ CSV/XLSX, confirm the
              detected columns, pick the row range (e.g. 1–2,000 of 18,000 for a trial run).
            </li>
            <li>
              <span className="text-foreground">Choose targets</span> — web search, registry, directories, LinkedIn,
              Facebook, domain guessing, deep crawl, pattern emails; set Country Lock (Canada), extra keywords, and any
              custom sites you want searched.
            </li>
            <li>
              <span className="text-foreground">Start</span> — watch the progress card and terminal. You can pause and
              resume; processing continues server-side if you close the tab.
            </li>
            <li>
              <span className="text-foreground">Verified Contacts</span> — filter by status and confidence, open "why?"
              to audit a row, delete bad rows individually or by select-all, and export the CSV. Every uploaded row is
              present in the output — enriched where possible, blank where nothing was found — so the export mirrors your
              input list.
            </li>
            <li>
              <span className="text-foreground">Dashboard</span> — track success rate, verified rate, active vs
              dissolved, and volume over 24h / 7d / 30d.
            </li>
          </ol>
          <p>
            Practical tip for 18,000 rows: run a 500-row batch first, look at the "why?" reasons on the failures, then
            adjust keywords, custom sites and toggles before committing the full file.
          </p>
        </Section>

        <Section title="6. Status field, statuses and what each value means">
          <p>
            Every contact carries a <span className="text-foreground">verification status</span>, a{" "}
            <span className="text-foreground">confidence score</span> and, optionally, a{" "}
            <span className="text-foreground">legal status</span>. They are three different things:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">Verified</span> — the address passed syntax + MX/SPF/DMARC checks{" "}
              <em>and</em> at least one independent page publishes it for this exact company (reverse lookup matched).
            </li>
            <li>
              <span className="text-foreground">MX Verified</span> — the mail domain accepts mail and the address looks
              right, but no independent page ties it to this company yet.
            </li>
            <li>
              <span className="text-foreground">Unverified</span> — found by pattern generation or a weak source; no
              corroboration.
            </li>
            <li>
              <span className="text-foreground">Invalid</span> — syntax failure, no MX record, disposable/role-blocked
              domain, or the domain does not resolve.
            </li>
            <li>
              <span className="text-foreground">Confidence 0–5</span> — 0–1 guess, 2 single weak source, 3 solid single
              source, 4 two agreeing sources, 5 own-domain address confirmed by two or more independent pages.
            </li>
          </ul>
          <p className="text-foreground">Legal status (active / dissolved) — why it used to say "dissolved" everywhere</p>
          <p>
            The old reader matched the word "dissolved" anywhere on a registry mirror, including boilerplate such as
            "Dissolution date: —" and footer glossaries, so almost every company came back dissolved. It now works by
            voting:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>Only explicit fields count — "Statut : …", "Legal status: …", "État de l'entreprise : …".</li>
            <li>
              Empty dissolution fields ("Dissolution date: —", "Aucune") are ignored instead of being read as a
              dissolution.
            </li>
            <li>
              A destructive verdict (DISSOLVED / INACTIVE) is stored only when a labelled field says so, or when{" "}
              <span className="text-foreground">two independent hosts agree</span>. Otherwise the status stays blank and
              the log says why.
            </li>
            <li>
              The row log records the verdict, how many sources confirmed it, and which hosts they were, so you can audit
              every status.
            </li>
            <li>
              Do not want status at all? Untick{" "}
              <span className="text-foreground">"Legal status (active / dissolved)"</span> under OSINT sources when
              starting a batch and the field is left empty.
            </li>
          </ul>
        </Section>

        <Section title="7. Your original columns are preserved in the export">
          <p>
            When you upload a file, every column of every row is stored verbatim next to the row. The CSV export then
            writes your original columns first, in your original order, followed by the discovered fields (executive,
            title, email, phone, domain, address, status, confidence, source, reasons, LinkedIn, Facebook, registry
            URL, legal status). A 6-column upload comes back as 6 columns + enrichment, so you can drop it straight into
            your existing sheet.
          </p>
        </Section>

        <Section title="8. Shared emails and phones across businesses">
          <p>
            An email or phone that also appears under other businesses is not disqualifying — shared numbers, agencies
            and directory spam are normal. The rule is: if the reverse lookup finds the identifier attached to{" "}
            <span className="text-foreground">the company you are searching for</span>, it is accepted and scored up,
            regardless of the unrelated listings. Only when it appears exclusively under other businesses is it kept but
            flagged (score reduced by 1, status downgraded from Verified to MX Verified) rather than deleted. Phones are
            never dropped: a cleaner alternative number is used when one exists, otherwise the number stays with a
            warning in the log.
          </p>
        </Section>

        <Section title="9. Re-checking rows that were already processed">
          <p>
            Nothing is silently processed twice. The system recognises a row as already checked when a stored
            contact matches its NEQ, or its company name when no NEQ exists.
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">From Verified Contacts</span> — every row has a{" "}
              <span className="text-foreground">Re-check</span> button, and selecting rows adds a{" "}
              <span className="text-foreground">Re-check N selected</span> action. A dialog first reports that the
              row was already checked, when it was checked and its current status, and asks whether to check again
              and replace it. Confirming deletes the previous result, creates a small "Re-check" batch that reuses
              the model, OSINT toggles and preserved columns of the original job, and opens its live progress page.
            </li>
            <li>
              <span className="text-foreground">From Batch Jobs</span> — before a batch starts, the selected range
              is compared against existing contacts. If any were already checked you get three choices: check
              again and replace them, skip them and process only new companies, or cancel. Skipping keeps your old
              data and saves worker time; replacing removes the old rows first so no duplicates appear.
            </li>
            <li>
              A re-check is a full fresh run through all nine stages — it is not a cached lookup, so results can
              legitimately differ if the company website or directory listings changed.
            </li>
          </ul>
        </Section>

        <Section title="10. How this compares to the tool 5redo uses">
          <p>
            Honest comparison, based on what commercial contact-finding suites do:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">Where they win</span> — they resell a licensed contact database of
              hundreds of millions of pre-scraped profiles, plus SMTP mailbox pinging from warmed IP pools. That gives
              instant answers and catch-all detection this system cannot match, because it looks each company up live.
            </li>
            <li>
              <span className="text-foreground">Where this system wins</span> — it is built around the Québec REQ file
              you actually have (NEQ matching, French registry mirrors, Canada country lock), it shows the complete
              evidence trail for every single field, it never charges per lookup, your original columns survive the round
              trip, and you can add your own worker, custom sites and API keys. A commercial tool returns a row; this one
              returns a row plus the reason it believes the row.
            </li>
            <li>
              <span className="text-foreground">Verdict</span> — for raw coverage on large, well-known companies, a
              licensed database is still ahead. For small Québec entities that are not in those databases, and for any
              case where you must justify where a contact came from, this system is better. Running the local
              Playwright/Scrapy worker closes most of the remaining coverage gap.
            </li>
          </ul>
        </Section>

        <Section title="11. Contact Database (your curated list)">
          <p>
            <span className="text-foreground">Verified Contacts</span> is the raw output of each execution batch.
            <span className="text-foreground"> Contact Database</span> is the curated list you actually email. Three ways
            to fill it:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">From a batch</span> — select rows on Verified Contacts and press
              “Add N to database”. The company, contact, title, email, phone, domain, city, NEQ and all of your original
              uploaded columns come along, tagged with the batch they came from.
            </li>
            <li>
              <span className="text-foreground">Manually</span> — type a company and whatever details you already know.
            </li>
            <li>
              <span className="text-foreground">By import</span> — upload a CSV or Excel list. Company name is required;
              Email, Phone, Contact Name, Title, City and NEQ columns are detected automatically (English or French
              headers) and every other column is stored with the contact.
            </li>
          </ul>
          <p>
            Duplicate email addresses are skipped automatically, so re-adding the same batch never creates doubles.
            Contacts are grouped into <span className="text-foreground">batch tables</span> — one card per execution
            batch — which you can filter by or delete. Deleting a batch table from the database removes only those saved
            contacts; the batch’s enrichment results stay on Verified Contacts. When you delete a batch’s results
            instead, you are asked whether the contacts saved from it should also be removed from the main database.
          </p>
        </Section>

        <Section title="12. Email sending — configuration, templates and delivery">
          <p>Everything is configured from the front end, in API Settings:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="text-foreground">SMTP delivery</span> — host, port, security (STARTTLS / SSL / none),
              username, password and an optional From override. “Test connection” opens a real SMTP session, logs in and
              reports the exact server error if anything is wrong; a successful test is timestamped.
            </li>
            <li>
              <span className="text-foreground">Email sending</span> — sender domain, sender address and name, reply-to,
              daily cap, delay between messages and a test-mode switch.
            </li>
            <li>
              <span className="text-foreground">Provider keys</span> — every AI key now has its own “Test connection”
              button that calls the provider; when the key works it is saved for you and appears in the model dropdown.
            </li>
          </ul>
          <p>
            Delivery itself runs through the same local worker as the OSINT pipeline (endpoints
            <code> /smtp/test </code> and <code> /smtp/send </code>), because the hosted runtime cannot open raw SMTP
            sockets. Keep the worker running while you send.
          </p>
          <p>
            <span className="text-foreground">Sending</span> — select contacts on Verified Contacts or in the Contact
            Database and press “Email N”. Pick a saved template or write the message inline, using merge fields
            <code> {"{{company}}"} </code>, <code>{"{{contact_name}}"}</code>, <code>{"{{first_name}}"}</code>,
            <code> {"{{title}}"}</code>, <code>{"{{email}}"}</code>, <code>{"{{phone}}"}</code>,
            <code> {"{{city}}"}</code> and <code>{"{{domain}}"}</code>. A live preview of the first recipient is shown
            before you send. Rows without a usable address are skipped, the daily cap is enforced, and the throttle delay
            is applied between messages.
          </p>
          <p>
            <span className="text-foreground">Test mode</span> renders and logs every message without delivering it — use
            it to proof templates. Turn it off in API Settings for real sends.
          </p>
          <p>
            <span className="text-foreground">Outreach → Email history</span> records every attempt, successful or not:
            recipient, company, subject, status, test/live flag and timestamp. Click any row to open the full message —
            from, reply-to, subject, body and the exact SMTP error when a send failed. Templates are managed on the same
            page.
          </p>
        </Section>

        <Section title="13. Scale and self-healing at 18,000+ rows">
          <p>
            Rows are stored individually and claimed in bounded waves with <code>SKIP LOCKED</code>, so several workers
            can drain the same job without ever picking the same row twice. Each claimed row heartbeats while it works;
            if a worker, browser or tunnel dies, the stale rows are automatically re-queued and retried (up to five
            attempts) and the rest of the queue keeps moving. A scheduled hook keeps jobs progressing even with the
            browser closed, and the per-company deadline plus “rows processed at once” setting let you tune throughput to
            your machine. Email sending inherits the same discipline: each message is logged independently, so a failure
            on one recipient never stops the campaign.
          </p>
        </Section>
      </div>

    </AppShell>
  );
}
