# Tech Stack Scout

AI-powered tech stack intelligence for an enterprise AE's target-account watchlist (Mesa Cohort C4 · Section 1 · Problem Statement 5).

For every company on the Supabase `watchlist`, the system reads **live public data** every week — GitHub repos, public job boards and engineering blog feeds — stores each finding as a quoted, linked fact, and uses **Gemini Flash** to write a two-paragraph engineering context summary and one tailored outreach opening line. Nikhil adds or removes companies in the Supabase table (or the console) without touching code.

**Live app:** _see the repo's About link_ · **Stack:** Supabase (Postgres, Edge Functions, pg_cron, pg_net) · Gemini Flash · Vercel (static console) · GitHub API

## Components map

| # | Component | Where | What it does |
|---|-----------|-------|--------------|
| 1 | Watchlist | Supabase table `watchlist` | Companies to research. Insert a row (or use the console, or bulk import) and a trigger/queue calls the refresh function within seconds. |
| 2 | Scheduler | `pg_cron` | `scout-weekly-refresh` Mon 03:17 UTC, `scout-drain-queue` every minute (3 at a time), `scout-hot-refresh` daily 03:41, `scout-radar` Mon 03:47, `scout-discovery` Mon 02:31, `scout-weekly-digest` Mon 08:03. |
| 3 | Website reader | `scout-refresh.ts` → `collectWebsite` | Polite crawl (robots.txt, identifying UA) of homepage, careers, engineering, security pages. Source of linked GitHub orgs, job boards and RSS feeds. |
| 4 | Resolver | `resolve()` | Verifies GitHub org, ATS board and blog feed found by link; name-guessing is a lower-confidence fallback. Overridable in the "Fix sources" panel. |
| 5 | Collectors | `collectGitHub`, `collectJobs` (9 ATS + JSON-LD), `collectBlog`, `collectFingerprint`, `collectNews`, custom `sources` | GitHub languages, configs, measured CI run times; job posts; blog titles; headers/DNS/CT fingerprint (hedged); Google News triggers. |
| 6 | Extractor (P1) | Gemini Flash, JSON schema, temp 0 | Tech with verbatim quotes from job posts and careers pages; code drops quotes that are not exact substrings. A dictionary pass runs alongside. |
| 7 | Evidence ledger | tables `signals`, `snapshots`, `overrides` | One fact per tech × source with state, confidence, URL, quote. Human overrides applied every run. `watchlist.coverage` records which sources worked. |
| 8 | Scoring + diff | `refresh()` | Evidence tier A/B/C (first-party sources only), ICP fit, why-now, pain hypotheses from `hook_playbooks`, diff vs last snapshot. |
| 9 | Writer (P2) + Verifier (P3) | Gemini Flash + `verify()` in code | Writes only from the numbered fact sheet; code rejects unknown tech, uncited sentences, unsupported numbers, banned phrases, long openers; one repair, then a template. Tier C gets discovery questions. |
| 10 | Config | tables `seller_profile`, `tech_dictionary`, `hook_playbooks`, `sources`, `prompt_versions` | Everything the function reads each run; edited in Settings, no code. |
| 11 | Window Radar | `scout-radar` job, table `radar` | Phase, weeks in decision window, gap, play, closest won account, peer outcome. No AI. |
| 12 | Ask the ledger | Edge Function `scout-ask` (`scout-ask.ts`) | Gemini answers from stored evidence only; each sentence cites ledger ids and code drops anything that does not verify. |
| 13 | Outputs | Edge Functions `scout-push` (`scout-push.ts`), `scout-digest` (`scout-digest.ts`); tables `output_targets`, `push_log` | Slack webhook, generic webhook, HubSpot note (untested), Monday digest, alerts on material change. Gmail compose link in the console. |
| 14 | Lead discovery | Edge Function `scout-discover` (`scout-discover.ts`); tables `discovery_config`, `leads` | Finds and scores new accounts; auto-adds above a threshold up to a weekly cap, queues borderline ones for review, prunes weak auto-adds. |
| 15 | Sign-in + team list | Supabase Auth, tables `team_members`, functions `is_member()`, `is_admin()` | Anyone can read; only approved teammates can change anything. Admins add teammates in Settings → Team. Owners on accounts are signed-in people. |
| 16 | Outreach tracking | table `outreach`, RPCs `outreach_log`, `outreach_set_status`, `outreach_stats` | "Mark as sent" and "Got a reply / Meeting booked / No reply" buttons on each opener; dashboard shows sent, reply rate and reply rate per hook. Feeds Nine checks 04 and 05 with real numbers. |
| 17 | Email sending | Edge Function `scout-email` (`scout-email.ts`), Resend | Compose from the opener, confirm, send from the platform; reply-to is the signed-in teammate; every send is logged. API key only in the `RESEND_API_KEY` secret. |
| 18 | Solution lenses | tables `solution_lenses`, `lens_openers`; Edge Function `scout-lens` (`scout-lens.ts`) | Five hypothetical products (BuildCache, Previewly, PlatformPilot, SignalDesk, CodePilot Teams). Pick one on Accounts to re-rank by fit with cited "why it fits" reasons, or see the best entry product per account on the dashboard. Fit is computed by code from stored evidence; only the product-specific opener uses Gemini and it passes a verifier. Rules are editable in Settings → Solution lenses. |
| 19 | Console | `index.html` on Vercel | Dashboard, accounts with cited briefs and coverage, watchlist, Window Radar, Discovery, Ask, signal ledger, pipeline health, Settings, feedback. |

## Files

- `index.html` — the console (static; talks to Supabase REST with the public anon key, which only has the RLS rights above).
- `scout-refresh.ts`, `scout-push.ts`, `scout-digest.ts`, `scout-ask.ts`, `scout-discover.ts`, `scout-email.ts`, `scout-lens.ts` — the seven Supabase Edge Functions (deploy each with `supabase functions deploy <name>`; JWT verification on).
- `supabase-schema.sql` — base tables, RLS, view, trigger, cron. `supabase-schema-v8-auth-outreach.sql` — team list, sign-in checks, outreach, lockdown. `supabase-schema-v2-v7.sql` — outputs, v7 columns, lead discovery tables, RPCs and cron. `config-seed.sql` — default config rows.
- `vercel.json` — static hosting config.

## Secrets

Edge Function secrets: `GEMINI_API_KEY`, `GITHUB_TOKEN`, `RESEND_API_KEY` (email), optional `RESEND_FROM` (defaults to Resend's test sender `onboarding@resend.dev`, which only delivers to the Resend account owner until a domain is verified).

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

## Lead discovery (auto-add)
`scout-discover` (weekly cron, or "Run discovery now" on the Discovery page) finds new target accounts from: lookalikes of won/opportunity accounts' tech, hiring signals (HN "Who is hiring"), open-source orgs (GitHub topics), news headlines, and competitor mentions. Each candidate is scored for fit (0-1). Score >= auto threshold (default 0.65) is auto-added to the watchlist up to a weekly cap (default 5); >= review threshold (0.5) goes to a review queue (Add / Dismiss); lower is rejected. Auto-added leads that refresh to Tier C with low ICP fit are paused, never deleted. All thresholds, sources, extra terms and excluded domains are editable in the UI (tables `discovery_config`, `leads`).

## Sign-in, outreach and email (v8)
Reading is public so reviewers can see the product. Changing anything needs an account whose email is on the team list (`team_members`); the first admin is seeded, admins add others in Settings → Team. Enforced in the database (row-level security and `is_member()` checks inside the RPCs) and again inside `scout-push` and `scout-email`, not only in the browser. Cron jobs and service-role calls are exempt. Every opener has **Send email** (compose, confirm, send via Resend) and **Mark as sent**, then **Got a reply / Meeting booked / No reply**. The dashboard shows the real reply rate and the rate per hook type.

Known limits: `scout-refresh`, `scout-discover` and `scout-ask` still accept the public key; there is no audit log yet; sending uses Resend's test sender until a domain is verified.
