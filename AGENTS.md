# RECYC Contact OSINT Platform

This repository contains the full-stack web application for the RECYC Contact OSINT intelligence platform.

### Architecture Overview
- **Frontend / SSR**: TanStack Start + React 19 + TanStack Router + Tailwind CSS + Lucide Icons.
- **Backend / Database**: Supabase PostgreSQL with Row Level Security (RLS) and real-time subscription support.
- **Queue & Batch Engine**: Server functions with automated lease claiming (`claim_job_rows`) and heartbeat tracking.
- **OSINT Pipeline**: Multi-query SERP discovery, Donnees Québec REQ open data integration, heuristic French & English executive parser, domain permutation generator, and MX / SMTP validation.
- **AI Fallback**: Google Gemini, OpenAI, Anthropic Claude, and custom OpenAI-compatible models.
- **Outreach & CRM**: Curated lead database, templating engine, and outbound SMTP integration.
