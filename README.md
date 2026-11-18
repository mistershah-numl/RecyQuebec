# RECYC Contact OSINT

An advanced B2B Open-Source Intelligence (OSINT) and executive contact enrichment platform specifically tailored for Quebec (Canada) enterprises.

## Key Features

- **Automated Enterprise Discovery**: Integrates Donnees Québec open data (REQ) and multi-engine live search to identify registered companies, trade names, official domains, and business addresses.
- **Executive Contact Extraction**: Mines management and team pages for high-level executives (Présidents, Directeurs Généraux, CEOs, Owners, Founders, Partners) using French and English corporate title heuristics.
- **Smart Email Synthesis & Verification**:
  - Automatically synthesizes executive permutations (`first.last@domain`, `flast@domain`, `first@domain`).
  - RFC compliance checks, disposable domain filtering, and live DNS MX resolution.
  - Deep SMTP handshake verification and reverse correlation analysis.
- **AI-Powered Fallback**: Multi-provider support for Google Gemini, OpenAI, Anthropic Claude, and custom OpenAI-compatible endpoints to extract structured data from unstructured corporate websites.
- **Batch Processing & Queue Management**: Distributed job queue with lease-based claiming, heartbeats, and automatic stale job recovery.
- **Integrated Outreach & CRM**: Curated lead database, personalized email templating, dry-run simulations, and direct SMTP dispatching.

## Tech Stack

- **Framework**: TanStack Start (SSR), React 19, TanStack Router
- **Styling**: Tailwind CSS, Radix UI primitives, Lucide Icons
- **Database & Auth**: Supabase PostgreSQL with Row Level Security (RLS)
- **Deployment**: Vercel / Node.js

## Getting Started

### Prerequisites

- Node.js >= 20.x
- npm >= 10.x

### Installation

```bash
git clone https://github.com/mistershah-numl/RecyQuebec.git
cd RecyQuebec
npm install
```

### Environment Configuration

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

### Development

```bash
npm run dev
```

The application will start at `http://localhost:8080/`.

### Production Build

```bash
npm run build
```

## Deployment

### Vercel Deployment

1. Import this repository into Vercel.
2. In Project Settings, set `NITRO_PRESET=vercel`.
3. Add the environment variables listed in `.env.example`.
4. Deploy.
