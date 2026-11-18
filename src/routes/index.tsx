import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Database, Radar, ShieldCheck, Terminal, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RECYC-Contact-OSINT — REQ executive contact enrichment" },
      {
        name: "description",
        content:
          "Upload Quebec REQ files, enrich executive contacts with AI, verify emails by MX lookup and export verified leads.",
      },
      { property: "og:title", content: "RECYC-Contact-OSINT — REQ contact enrichment" },
      {
        property: "og:description",
        content: "Batch OSINT pipeline for Quebec REQ data: AI discovery, MX verification, CSV export.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  { icon: Upload, title: "Bulk REQ ingestion", body: "Drag in CSV or Excel files with 18,000+ rows and pick the exact range to run." },
  { icon: Terminal, title: "Live execution feed", body: "Progress bar, counters, ETA and a streaming terminal log for every batch." },
  { icon: ShieldCheck, title: "MX verification", body: "Every discovered email is checked against live DNS MX records before it counts." },
  { icon: Database, title: "Durable queue", body: "Rows are queued server-side and processed in bounded batches, so nothing is lost." },
  { icon: CheckCircle2, title: "Confidence scoring", body: "Each contact carries a 0–5 confidence score and its discovery source." },
  { icon: Radar, title: "Your own keys", body: "Bring Gemini, Perplexity, OpenAI or Anthropic keys, or use the built-in models." },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-primary" />
          <span className="font-semibold">RECYC-Contact-OSINT</span>
        </div>
        <Button asChild size="sm">
          <Link to="/auth">Sign in</Link>
        </Button>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Turn Quebec REQ registries into verified executive contacts
          </h1>
          <p className="mt-5 text-lg text-muted-foreground">
            A batch OSINT pipeline that discovers decision-maker names, emails and phone numbers,
            verifies deliverability via DNS MX lookups, and exports clean, scored leads.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/auth">Get started</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/dashboard">Open dashboard</Link>
            </Button>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 pb-24">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <Card key={title}>
                <CardContent className="pt-6">
                  <Icon className="mb-3 h-5 w-5 text-primary" />
                  <h2 className="text-sm font-semibold">{title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
