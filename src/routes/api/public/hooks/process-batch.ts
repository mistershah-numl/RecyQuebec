import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled worker. Picks up running jobs and processes one bounded batch each,
 * so very large files keep progressing even when nobody has the dashboard open.
 */
export const Route = createFileRoute("/api/public/hooks/process-batch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        const expected =
          process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? "";
        if (!apikey || !expected || apikey !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { processDueJobs } = await import("@/lib/enrich.server");
        const results = await processDueJobs(supabaseAdmin as never, 3);
        return Response.json({ ok: true, results });
      },
    },
  },
});
