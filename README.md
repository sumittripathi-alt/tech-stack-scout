# Tech Stack Scout

AI-powered tech stack intelligence for an enterprise AE's target-account watchlist (Mesa Cohort C4 · Section 1 · Problem Statement 5).

For every company on the Supabase `watchlist`, the system reads **live public data** every week — GitHub repos, public job boards and engineering blog feeds — stores each finding as a quoted, linked fact, and uses **Gemini Flash** to write a two-paragraph engineering context summary and one tailored outreach opening line. Nikhil adds or removes companies in the Supabase table (or the console) without touching code.

**Live app:** _see the repo's About link_ · **Stack:** Supabase (Postgres, Edge Functions, pg_cron, pg_net) · Gemini Flash · Vercel (static console) · GitHub API

## Components map

| # | Component | Where | What it does |
|---|-----------|-------|--------------|
| 1 | Watchlist | Supabase table `watchlist` | Companies to research. Insert a row → trigger calls the refresh function within seconds. |
| 2 | Scheduler | `pg_cron` job `scout-weekly-refresh` | Mondays 03:17 UTC (08:47 IST) calls `refresh_all()` → one `pg_net` request per active account. |
| 3 | Resolver | `scout-refresh.ts` → `resolve()` | Finds the GitHub org (verified against the company domain), the ATS board (Greenhouse / Ashby / Lever) and the blog RSS feed. |
| 4 | Collectors | `collectGitHub`, `collectJobs`, `collectBlog` | GitHub: languages, root config files, workflow files, **measured GitHub Actions run times**. Jobs: engineering + platform roles and full descriptions. Blog: latest post titles. |
| 5 | Extractor (P1) | Gemini Flash, JSON schema, temp 0 | Pulls technologies with verbatim quotes from job posts. Code drops any quote that is not an exact substring of the posting. A deterministic dictionary pass runs alongside. |
| 6 | Evidence ledger | tables `signals`, `snapshots` | One fact per tech × source with state (active / hiring_only / migrating_to / noise), confidence, URL and quote. Human overrides (`overrides`) are applied every run. |
| 7 | Scoring + diff | `refresh()` | Evidence tier A/B/C, ICP fit, why-now score, pain hypotheses (primitive + scale threshold → friction), diff vs last snapshot. Unchanged accounts skip generation. |
| 8 | Writer (P2) | Gemini Flash, JSON schema, temp 0 | Writes the summary and opener **only from the numbered fact sheet**; every sentence cites fact IDs. |
| 9 | Verifier + repair (P3) | `verify()` in code | Rejects unknown technologies, uncited sentences, unsupported numbers, banned phrases, long openers. One repair round, then a safe template. Tier C accounts get discovery questions instead of an opener. |
| 10 | Console | `index.html` on Vercel | Dashboard, accounts with cited briefs and evidence ledger, watchlist editor, signal ledger, pipeline health, feedback buttons. |

## Files

- `index.html` — the console (static; talks to Supabase REST with the public anon key, which only has the RLS rights above).
- `scout-refresh.ts` — Supabase Edge Function `scout-refresh` (deploy with `supabase functions deploy scout-refresh`).
- `supabase-schema.sql` — tables, RLS, view, trigger, cron.
- `vercel.json` — static hosting config.

## Secrets

Keys never ship to the browser. The function reads `GEMINI_API_KEY` / `GITHUB_TOKEN` from Edge Function secrets, or from the private `app_config` table (RLS on, no policies).

## Why the copy stays true

Code collects and checks the facts; Gemini only extracts and phrases them. The opener can only name what is in the fact sheet, and a reviewer can click any citation to see the source quote.

## Demo workspace

`demo-seed.sql` loads 20 fictional companies with 8 weeks of history so every feature can be shown without waiting for real data. Open the console with `?workspace=demo` or use the **Live / Demo** toggle in the top bar.

| Feature | Demo company |
|---|---|
| Migration hook (Jenkins → GitHub Actions), top why-now | Northwind Pay |
| Container migration (EC2 → EKS) | Helio Freight |
| Measured CI pain from Actions run times | Quarry Labs, Atlas Biotech |
| Platform hiring surge + AE "mark wrong" override | Lattice Health |
| Monorepo scale threshold | Orbitform |
| Blog-reference hook, incumbent competitor | Kestrel Security |
| Tier B (jobs only) hedged copy | Meridian Retail Group |
| Tier C: no opener, discovery questions instead | Silverline Insurance |
| Low-confidence GitHub org mapping | Cobalt Ledger |
| Failed refresh isolated in the run log | Fernway Travel |
| Verifier fallback to template | Tidewater Analytics |
| Verifier repair pass | Aurora Robotics |
| Open-source project hook | Halcyon AI |
| Removed from watchlist (inactive) | Saffron Telecom |
| Won / Lost stages, feedback loop | Vantage Mobility, Pebble Payroll |

Demo rows have `watchlist.is_demo = true`; the weekly cron and the Edge Function never touch them.
