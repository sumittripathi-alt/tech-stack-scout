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

## v2: the live system runs on any company, and the team edits it without code

**Any company.** Add one on the Watchlist (paste a website in any form: `https://www.stripe.com/blog` becomes `stripe.com`) or bulk import a list, one `Name, domain` per line. New rows go into a queue that researches three at a time. Companies with no public GitHub or job board are still added; they get a "limited public signal" brief with discovery questions and no invented opener.

**Config, not code.** Settings edits tables the Edge Function reads on every run: `seller_profile` (what you sell, banned phrases, scoring weights, decision window), `tech_dictionary` (the closed vocabulary), `hook_playbooks` (pattern → hypothesis rules), `sources` (switch built-ins off, add any RSS or web page with a `{domain}` URL), `prompt_versions` (writer prompt with versions and rollback). The code verifier still checks every sentence, so editing a prompt cannot make output untrue.

**Window Radar.** A computed layer on weekly history, no AI. For each account: phase (decision, building, post-decision, quiet), weeks into an assumed decision window, the gap between pain and investment, a suggested play, the closest account you already won, and an earlier peer that looked the same and what happened to it next. A "what's working" table compares hooks and phases against your logged outcomes.

**Ask the ledger.** Questions answered only from stored evidence; every sentence carries source ids and unsupported claims are dropped by code.

**Outputs.** Gmail compose link, Slack incoming webhook, generic webhook (Zapier/Make → HubSpot), native HubSpot note (built, untested against a real portal), a Monday digest, and alerts on material change. Targets are stored server-side; the browser can't read URLs or tokens back.

**Hot accounts** refresh daily. **Owner** is a label with a filter, not a login.

Edge Functions: `scout-refresh`, `scout-push`, `scout-digest`, `scout-ask`. Cron: weekly refresh, per-minute queue drain, daily hot refresh, weekly radar, Monday digest.

## Collection v7: robust sources for any company

Scout no longer depends on a company having a public GitHub org. For every account it now:

1. **Reads the website politely** (robots.txt respected, identifying user agent): homepage plus careers, engineering and security pages found by link. Only those pages feed tech evidence; marketing pages are ignored.
2. **Discovers sources by link, not by guess**: GitHub orgs, job boards and RSS feeds linked from the site are verified before use. Name-based guessing stays as a lower-confidence fallback.
3. **Reads more job boards**: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio, BambooHR, Workday, plus schema.org JobPosting on the careers page.
4. **Fingerprints infrastructure** from response headers, script hosts, DNS and certificate-transparency subdomains (confidence 0.55, always hedged).
5. **Watches the news** (Google News RSS) for funding, hires, launches and migrations; a new `news_trigger` playbook uses it.
6. **Shows coverage**: each account lists which sources worked, hints for the ones that did not, and a "Fix sources" panel (GitHub org, job board, careers URL, blog feed) that saves and refreshes.

Evidence tiers count only first-party sources (GitHub, job boards, website, blog). Fingerprints and news never lift an account to Tier A or B on their own, and an account with thin evidence gets discovery questions instead of an invented opener.
