-- Tech Stack Scout v8: real sign-in (invite-only team list), outreach tracking, and the write lockdown.
-- Public read stays open so reviewers can see the product; every write needs a signed-in, approved teammate.

create table if not exists team_members (
  email text primary key, name text, role text not null default 'ae' check (role in ('admin','ae')),
  active boolean not null default true, added_by text, created_at timestamptz not null default now());
alter table team_members enable row level security;
create policy tm_read on team_members for select to authenticated using (true);

create table if not exists outreach (
  id uuid primary key default gen_random_uuid(), account_id uuid references watchlist(id) on delete cascade,
  brief_id uuid, hook_type text, opener text, channel text not null default 'manual' check (channel in ('email','manual')),
  to_email text, subject text, body text, sent_by text, resend_id text, note text,
  status text not null default 'sent' check (status in ('sent','replied','meeting','no_reply')),
  sent_at timestamptz not null default now(), replied_at timestamptz);
alter table outreach enable row level security;
create policy outreach_read on outreach for select to anon, authenticated using (true);

-- Membership check. Service role and the database's own cron jobs count as members; a browser with only the anon key does not.
create or replace function is_member() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (session_user in ('postgres','supabase_admin') and coalesce(current_setting('role', true), 'none') in ('none','postgres','supabase_admin',''))
      or exists (select 1 from team_members where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and active) $$;
create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (select 1 from team_members where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and active and role = 'admin') $$;
create or replace function me() returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(t) from (select email, name, role from team_members where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and active) t $$;

create or replace function team_add(p_email text, p_name text, p_role text default 'ae') returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'only an admin can add teammates'; end if;
  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email'; end if;
  insert into team_members (email, name, role, added_by) values (lower(trim(p_email)), nullif(trim(p_name), ''), case when p_role = 'admin' then 'admin' else 'ae' end, auth.jwt() ->> 'email')
  on conflict (email) do update set name = coalesce(nullif(trim(p_name), ''), team_members.name), role = excluded.role, active = true;
end $$;
create or replace function team_set_active(p_email text, p_on boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'only an admin can change the team'; end if;
  if not p_on and lower(p_email) = lower(coalesce(auth.jwt() ->> 'email', '')) then raise exception 'you cannot deactivate yourself'; end if;
  update team_members set active = p_on where lower(email) = lower(p_email);
end $$;

create or replace function outreach_log(p_account uuid, p_channel text default 'manual', p_note text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare b record; v uuid;
begin
  if not is_member() then raise exception 'sign in as a team member to log outreach'; end if;
  select id, opener, hook_type into b from briefs where account_id = p_account order by created_at desc limit 1;
  insert into outreach (account_id, brief_id, hook_type, opener, channel, sent_by, note)
  values (p_account, b.id, b.hook_type, b.opener, case when p_channel = 'email' then 'email' else 'manual' end, auth.jwt() ->> 'email', nullif(trim(coalesce(p_note, '')), ''))
  returning id into v; return v;
end $$;
create or replace function outreach_set_status(p_id uuid, p_status text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member() then raise exception 'sign in as a team member to update outreach'; end if;
  if p_status not in ('sent','replied','meeting','no_reply') then raise exception 'unknown status'; end if;
  update outreach set status = p_status, replied_at = case when p_status in ('replied','meeting') then coalesce(replied_at, now()) else null end where id = p_id;
end $$;
-- Aggregate only, no personal data, so reviewers can see the reply rate without signing in.
create or replace function outreach_stats() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('sent', (select count(*) from outreach),
    'replied', (select count(*) from outreach where status in ('replied','meeting')),
    'meetings', (select count(*) from outreach where status = 'meeting'),
    'email', (select count(*) from outreach where channel = 'email'),
    'by_hook', coalesce((select jsonb_agg(jsonb_build_object('hook', coalesce(hook_type,'none'), 'sent', n, 'replied', r) order by n desc)
       from (select hook_type, count(*) n, count(*) filter (where status in ('replied','meeting')) r from outreach group by hook_type) h), '[]'::jsonb)) $$;

-- First admin (change to your email). That person creates an account on the sign-in page and is approved automatically.
-- insert into team_members (email, name, role) values ('you@company.com', 'Your Name', 'admin');

-- LOCKDOWN (run last, applied in production): write policies move from "anyone" to "approved teammates".
alter policy "add feedback" on feedback to authenticated with check (is_member());
alter policy "add playbooks" on hook_playbooks to authenticated with check (is_member());
alter policy "edit playbooks" on hook_playbooks to authenticated using (is_member()) with check (is_member());
alter policy "add overrides" on overrides to authenticated with check (is_member());
alter policy "add profile" on seller_profile to authenticated with check (is_member());
alter policy "edit profile" on seller_profile to authenticated using (is_member()) with check (is_member());
alter policy "add sources" on sources to authenticated with check (is_member() and kind = 'custom');
alter policy "edit sources" on sources to authenticated using (is_member()) with check (is_member());
alter policy "add dict" on tech_dictionary to authenticated with check (is_member());
alter policy "edit dict" on tech_dictionary to authenticated using (is_member()) with check (is_member());
alter policy "add watchlist" on watchlist to authenticated with check (is_member());
alter policy "edit watchlist" on watchlist to authenticated using (is_member()) with check (is_member());
-- Write RPCs (activate_prompt, approve_lead, delete_output_target, dismiss_lead, queue_refresh_now, run_discovery, save_discovery_config,
-- save_output_target, save_prompt, tech_set, toggle_output_target, recompute_radar): each original was renamed to <name>_impl with all
-- access revoked, and a wrapper with the old name checks is_member() and then calls it. anon cannot execute the wrappers at all.
-- Pattern: create function f(args) returns T language plpgsql security definer set search_path = public as $$
--   begin if not public.is_member() then raise exception 'sign in as a team member to do this'; end if; return public.f_impl(args); end $$;

-- Solution lenses (hypothetical products). Fit is computed from stored evidence; rules are JSON, editable in Settings.
create table if not exists solution_lenses (id text primary key, name text not null, tagline text, pitch text not null, color text default '#7c6cf0',
  base numeric not null default 0.1, rules jsonb not null default '[]'::jsonb, enabled boolean not null default true, position int not null default 0,
  hypothetical boolean not null default true, updated_at timestamptz not null default now());
alter table solution_lenses enable row level security;
create policy "read lenses" on solution_lenses for select to anon, authenticated using (true);
create policy "add lenses" on solution_lenses for insert to authenticated with check (is_member());
create policy "edit lenses" on solution_lenses for update to authenticated using (is_member()) with check (is_member());
create table if not exists lens_openers (id uuid primary key default gen_random_uuid(), account_id uuid not null references watchlist(id) on delete cascade,
  lens_id text not null references solution_lenses(id) on delete cascade, snapshot_id bigint, opener text not null, cites text[] default '{}',
  verifier_passed boolean, used_fallback boolean default false, model text, created_by text, created_at timestamptz not null default now());
alter table lens_openers enable row level security;
create policy "read lens openers" on lens_openers for select to anon, authenticated using (true);
-- Seed lenses: see the solution_lenses rows in production (build-cache, preview-envs, platform-pilot, signal-desk, code-copilot).
-- Dictionary additions for AI and security tools: openai, langchain, pytorch, tensorflow, huggingface, mlflow, snyk, trivy, sonarqube.
