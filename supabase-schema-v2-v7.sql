-- Tech Stack Scout: schema additions after the base supabase-schema.sql (v2 outputs, v7 collection, lead discovery).
-- Run after supabase-schema.sql and config-seed.sql. Secrets/app_config values are not included.

-- v7 collection
alter table public.watchlist add column if not exists careers_url text, add column if not exists blog_feed text,
  add column if not exists coverage jsonb, add column if not exists hot boolean default false, add column if not exists owner text;
alter table public.watchlist drop constraint if exists watchlist_ats_provider_check;
alter table public.watchlist add constraint watchlist_ats_provider_check check (ats_provider is null or ats_provider in
  ('greenhouse','ashby','lever','workable','smartrecruiters','recruitee','personio','bamboohr','workday','none'));

-- outputs (read only by the Edge Functions; the browser cannot read urls or tokens back)
create table if not exists public.output_targets (
  id uuid primary key default gen_random_uuid(), kind text, label text, url text, token text,
  enabled boolean default true, last_status text, last_at timestamptz, created_at timestamptz default now());
create table if not exists public.push_log (
  id bigint generated always as identity primary key, account_id uuid, target_id uuid, kind text, status text, detail text,
  created_at timestamptz default now());
alter table public.output_targets enable row level security;
alter table public.push_log enable row level security;

-- lead discovery
alter table public.watchlist add column if not exists lead_source text, add column if not exists lead_score numeric;
create table if not exists public.discovery_config (
  id text primary key default 'default', enabled boolean default true,
  auto_threshold numeric default 0.65, review_threshold numeric default 0.50, weekly_cap int default 5, min_keep numeric default 0.25,
  sources jsonb default '{"oss": true, "hiring": true, "lookalike": true, "competitor": true}'::jsonb,
  extra_terms text[] default '{}', exclude_domains text[] default '{}', last_run_at timestamptz, last_summary jsonb);
insert into public.discovery_config (id) values ('default') on conflict do nothing;
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(), name text, domain text unique, source text,
  evidence jsonb default '{}'::jsonb, fit_score numeric default 0,
  status text default 'review' check (status in ('auto_added','review','approved','dismissed','rejected','pruned')),
  reason text, found_at timestamptz default now(), decided_at timestamptz, watchlist_id uuid);
alter table public.discovery_config enable row level security;
alter table public.leads enable row level security;
create policy "anon read discovery_config" on public.discovery_config for select to anon using (true);
create policy "anon read leads" on public.leads for select to anon using (true);

create or replace function public.dismiss_lead(p_id uuid) returns void language sql security definer set search_path to 'public' as $$
  update leads set status = 'dismissed', decided_at = now() where id = p_id; $$;

create or replace function public.approve_lead(p_id uuid) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare l record; w uuid;
begin
  select * into l from leads where id = p_id;
  if l.id is null then raise exception 'lead not found'; end if;
  select id into w from watchlist where domain = l.domain;
  if w is null then
    insert into watchlist (name, domain, persona, stage, active, notes, lead_source, lead_score)
    values (l.name, l.domain, 'VP Engineering', 'Prospect', true, 'Approved from discovery: ' || coalesce(l.reason, l.source), l.source, l.fit_score)
    returning id into w;
    perform public.queue_refresh_now(w);
  end if;
  update leads set status = 'approved', decided_at = now(), watchlist_id = w where id = p_id;
  return w;
end $$;

create or replace function public.save_discovery_config(p jsonb) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update discovery_config set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    auto_threshold = least(1, greatest(0, coalesce((p->>'auto_threshold')::numeric, auto_threshold))),
    review_threshold = least(1, greatest(0, coalesce((p->>'review_threshold')::numeric, review_threshold))),
    weekly_cap = least(50, greatest(0, coalesce((p->>'weekly_cap')::int, weekly_cap))),
    sources = coalesce(p->'sources', sources),
    extra_terms = coalesce(array(select jsonb_array_elements_text(p->'extra_terms')), extra_terms),
    exclude_domains = coalesce(array(select jsonb_array_elements_text(p->'exclude_domains')), exclude_domains)
  where id = 'default';
end $$;

-- run scout-discover through pg_net (function_url's 'scout-refresh' is swapped for 'scout-discover')
create or replace function public.run_discovery_weekly() returns bigint language plpgsql security definer set search_path to 'public','extensions' as $$
declare v_url text; v_key text; v_id bigint;
begin
  select replace(value, 'scout-refresh', 'scout-discover') into v_url from app_config where key = 'function_url';
  select value into v_key from app_config where key = 'anon_key';
  if v_url is null then return null; end if;
  select net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('trigger', 'weekly'), timeout_milliseconds := 150000) into v_id;
  return v_id;
end $$;
create or replace function public.run_discovery() returns bigint language plpgsql security definer set search_path to 'public','extensions' as $$
declare v_url text; v_key text; v_id bigint;
begin
  select replace(value, 'scout-refresh', 'scout-discover') into v_url from app_config where key = 'function_url';
  select value into v_key from app_config where key = 'anon_key';
  if v_url is null then return null; end if;
  select net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('trigger', 'manual'), timeout_milliseconds := 150000) into v_id;
  return v_id;
end $$;
revoke all on function public.run_discovery_weekly() from public, anon, authenticated;
grant execute on function public.approve_lead(uuid), public.dismiss_lead(uuid), public.save_discovery_config(jsonb), public.run_discovery() to anon;

-- cron (UTC)
select cron.schedule('scout-discovery',     '31 2 * * 1', $$select public.run_discovery_weekly()$$);
-- also in the live project: scout-radar '47 3 * * 1', scout-weekly-digest '3 8 * * 1', scout-hot-refresh '41 3 * * *', scout-drain-queue '* * * * *'
