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

-- LOCKDOWN (run last): write policies move from "anyone" to "approved teammates".
-- For each of: watchlist, feedback, overrides, seller_profile, tech_dictionary, hook_playbooks, sources
--   alter policy "<existing write policy>" on <table> to authenticated using (is_member()) with check (is_member());
-- and: revoke execute on function <write RPCs> from anon; (queue_refresh_now, run_discovery_now, lead actions, output target saves, etc.)
