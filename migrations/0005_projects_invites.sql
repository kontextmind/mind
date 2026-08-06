-- KontextMind 0005_projects_invites.sql
-- Projects: a project = a mind repo registered under an org (repos row).
-- display_name/local_path make repos addressable by humans and reindexable
-- on demand (km_reindex, km_project_add).
-- Invites: org membership invites issued via km_invite. Link-only delivery in
-- 1a (no SMTP); hosted mode adds email delivery. RLS: org-scoped, same shape
-- as 0004 (restrictive deny-service AND-composed with the org policy).

alter table repos add column if not exists display_name text;
alter table repos add column if not exists local_path text;

-- 0004 only granted SELECT on repos; km_project_add registers repos through
-- the claims-bound request connection, so org-scoped write policies are
-- needed (the restrictive deny-service policy from 0004 still applies).
drop policy if exists km_repo_org_insert on repos;
drop policy if exists km_repo_org_update on repos;
create policy km_repo_org_insert on repos for insert
  with check (org_id = km_claims() ->> 'org');
create policy km_repo_org_update on repos for update
  using (org_id = km_claims() ->> 'org')
  with check (org_id = km_claims() ->> 'org');

create table if not exists invites (
  id          text primary key,
  org_id      text not null references orgs(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('member','steward','owner')),
  token       text not null unique,
  invited_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  unique (org_id, email)
);

alter table invites enable row level security;
alter table invites force row level security;
drop policy if exists km_invites_deny_service on invites;
drop policy if exists km_invites_org on invites;
create policy km_invites_deny_service on invites as restrictive for all using (not km_is_service());
create policy km_invites_org on invites for all using (org_id = km_claims() ->> 'org');
