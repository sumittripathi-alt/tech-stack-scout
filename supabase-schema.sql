-- Tech Stack Scout · Supabase schema (Postgres 17). Applied to project tsrjxkuqqqivoygaskng.
-- Then deploy scout-refresh.ts as Edge Function "scout-refresh" and add rows to app_config (see README).
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table public.watchlist (
  id uuid primary key default gen_random_uuid(), name text not null, domain text not null unique, segment text,
  github_org text, ats_provider text check (ats_provider in ('greenhouse','ashby','lever')), ats_slug text, blog_feed text,
  mapping_confidence numeric(3,2) default 0, persona text not null default 'VP Engineering', stage text not null default 'Prospect',
  active boolean not null default true, notes text, created_at timestamptz not null default now(),
  last_refreshed_at timestamptz, refresh_status text default 'queued', refresh_error text);

create table public.snapshots (
  id bigserial primary key, account_id uuid not null references public.watchlist(id) on delete cascade,
  taken_at timestamptz not null default now(), week date not null default (date_trunc('week', now()))::date,
  languages jsonb default '{}'::jsonb, tech jsonb default '[]'::jsonb, ci_median_min numeric, ci_runs_sampled int, ci_repo text,
  eng_roles int, platform_roles int, active_repos_30d int, public_repos int, blog_posts jsonb default '[]'::jsonb,
  evidence_tier text check (evidence_tier in ('A','B','C')), icp_fit numeric(3,2), why_now numeric(3,2),
  hypotheses jsonb default '[]'::jsonb, fact_sheet_hash text, material boolean default true, diff jsonb default '[]'::jsonb);
create index on public.snapshots (account_id, taken_at desc);

create table public.signals (
  id bigserial primary key, account_id uuid not null references public.watchlist(id) on delete cascade,
  snapshot_id bigint references public.snapshots(id) on delete cascade, fid text not null, tech text not null, category text,
  state text check (state in ('active','legacy','emerging','hiring_only','migrating_from','migrating_to','contested','noise')),
  confidence numeric(3,2), source text, strength text, source_url text, quote text, observed_at timestamptz default now());
create index on public.signals (snapshot_id);

create table public.briefs (
  id uuid primary key default gen_random_uuid(), account_id uuid not null references public.watchlist(id) on delete cascade,
  snapshot_id bigint references public.snapshots(id) on delete cascade, created_at timestamptz not null default now(),
  summary jsonb, opener text, opener_cites text[], hook_type text, persona text, discovery jsonb, model text, prompt_version text,
  verifier_passed boolean, verifier_errors jsonb, repaired boolean default false, used_fallback boolean default false);
create index on public.briefs (account_id, created_at desc);

create table public.feedback (id uuid primary key default gen_random_uuid(), brief_id uuid references public.briefs(id) on delete cascade,
  account_id uuid references public.watchlist(id) on delete cascade, action text check (action in ('used_as_is','edited_tone','edited_fact','rejected')),
  edited_opener text, note text, created_at timestamptz not null default now());
create table public.overrides (account_id uuid references public.watchlist(id) on delete cascade, tech text not null, forced_state text not null,
  note text, created_at timestamptz default now(), primary key (account_id, tech));
create table public.pipeline_runs (id bigserial primary key, account_id uuid references public.watchlist(id) on delete cascade,
  started_at timestamptz not null default now(), finished_at timestamptz, trigger text, status text, github_calls int default 0, gemini_calls int default 0,
  material boolean, verifier_failed boolean, repaired boolean, used_fallback boolean, error text, duration_ms int);
create table public.events (id bigserial primary key, account_id uuid references public.watchlist(id) on delete cascade,
  created_at timestamptz not null default now(), kind text, detail text);
create table public.app_config (key text primary key, value text not null); -- private: RLS on, no policies

alter table public.watchlist enable row level security; alter table public.snapshots enable row level security;
alter table public.signals enable row level security; alter table public.briefs enable row level security;
alter table public.feedback enable row level security; alter table public.overrides enable row level security;
alter table public.pipeline_runs enable row level security; alter table public.events enable row level security;
alter table public.app_config enable row level security;
create policy "read watchlist" on public.watchlist for select to anon, authenticated using (true);
create policy "add watchlist" on public.watchlist for insert to anon, authenticated with check (true);
create policy "edit watchlist" on public.watchlist for update to anon, authenticated using (true) with check (true);
create policy "read snapshots" on public.snapshots for select to anon, authenticated using (true);
create policy "read signals" on public.signals for select to anon, authenticated using (true);
create policy "read briefs" on public.briefs for select to anon, authenticated using (true);
create policy "read feedback" on public.feedback for select to anon, authenticated using (true);
create policy "add feedback" on public.feedback for insert to anon, authenticated with check (true);
create policy "read overrides" on public.overrides for select to anon, authenticated using (true);
create policy "add overrides" on public.overrides for insert to anon, authenticated with check (true);
create policy "read runs" on public.pipeline_runs for select to anon, authenticated using (true);
create policy "read events" on public.events for select to anon, authenticated using (true);

create or replace view public.v_accounts with (security_invoker = true) as
select w.*, s.id as snapshot_id, s.taken_at, s.languages, s.tech, s.ci_median_min, s.ci_repo, s.eng_roles, s.platform_roles,
  s.active_repos_30d, s.public_repos, s.blog_posts, s.evidence_tier, s.icp_fit, s.why_now, s.hypotheses, s.diff, s.material,
  b.id as brief_id, b.summary, b.opener, b.opener_cites, b.hook_type, b.discovery, b.verifier_passed, b.repaired, b.used_fallback, b.model, b.created_at as brief_at
from public.watchlist w
left join lateral (select * from public.snapshots x where x.account_id = w.id order by taken_at desc limit 1) s on true
left join lateral (select * from public.briefs y where y.account_id = w.id order by created_at desc limit 1) b on true;

create or replace function public.request_refresh(p_account uuid, p_trigger text default 'manual')
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_key text; v_id bigint;
begin
  select value into v_url from app_config where key = 'function_url';
  select value into v_key from app_config where key = 'anon_key';
  if v_url is null then return null; end if;
  update watchlist set refresh_status = 'queued' where id = p_account;
  select net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('account_id', p_account, 'trigger', p_trigger), timeout_milliseconds := 150000) into v_id;
  return v_id;
end $$;
create or replace function public.on_watchlist_insert() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.request_refresh(new.id, 'added'); return new; end $$;
create trigger trg_watchlist_insert after insert on public.watchlist for each row execute function public.on_watchlist_insert();
create or replace function public.refresh_all(p_trigger text default 'weekly') returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin for r in select id from watchlist where active loop perform public.request_refresh(r.id, p_trigger); n := n + 1; end loop; return n; end $$;
revoke all on function public.refresh_all(text) from public, anon, authenticated;

-- config (fill in your own values)
-- insert into public.app_config values ('function_url','https://<ref>.supabase.co/functions/v1/scout-refresh'), ('anon_key','<anon jwt>'),
--   ('gemini_api_key','<key>'), ('github_token','<read-only token, optional>');
select cron.schedule('scout-weekly-refresh', '17 3 * * 1', $$select public.refresh_all('weekly')$$); -- Mondays 08:47 IST
