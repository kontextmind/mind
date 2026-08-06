-- KontextMind 0004_rls_fix.sql
-- Fixes a critical policy-composition bug: km_deny_service was PERMISSIVE, so
-- for any human/agent principal it evaluated true and OR-allowed EVERY row,
-- bypassing namespace scoping entirely. Deny-service policies must be
-- RESTRICTIVE (AND-composed with the permissive scope policies).
--
-- Per table: rows pass IFF (not service kind) AND (scope policy matches).

-- namespace-scoped tenant tables
do $$
declare t text;
begin
  foreach t in array array[
    'pages','chunks','graph_edges','review_items',
    'checkpoints','handoffs','insights'
  ] loop
    execute format('drop policy if exists km_deny_service on %I', t);
    execute format('drop policy if exists km_ns on %I', t);
    execute format('create policy km_deny_service on %I as restrictive for all using (not km_is_service())', t);
    execute format('create policy km_ns on %I for all using (km_ns_allowed(namespace_id::text))', t);
  end loop;
end $$;

-- org-scoped event tables
do $$
declare t text;
begin
  foreach t in array array['km_event','skill_use'] loop
    execute format('drop policy if exists km_deny_service on %I', t);
    execute format('drop policy if exists km_event_org on %I', t);
    execute format('create policy km_deny_service on %I as restrictive for all using (not km_is_service())', t);
    execute format('create policy km_event_org on %I for all using (org_id = km_claims() ->> ''org'')', t);
  end loop;
end $$;

-- namespaces
drop policy if exists km_ns_deny_service on namespaces;
drop policy if exists km_ns_org on namespaces;
create policy km_ns_deny_service on namespaces as restrictive for all using (not km_is_service());
create policy km_ns_org on namespaces for all using (org_id = km_claims() ->> 'org');

-- orgs
drop policy if exists km_org on orgs;
drop policy if exists km_org_deny_service on orgs;
create policy km_org_deny_service on orgs as restrictive for all using (not km_is_service());
create policy km_org on orgs for select using (id = km_claims() ->> 'org');

-- memberships
drop policy if exists km_member_org on memberships;
drop policy if exists km_member_deny_service on memberships;
create policy km_member_deny_service on memberships as restrictive for all using (not km_is_service());
create policy km_member_org on memberships for select using (org_id = km_claims() ->> 'org');

-- repos
drop policy if exists km_repo_org on repos;
drop policy if exists km_repo_deny_service on repos;
create policy km_repo_deny_service on repos as restrictive for all using (not km_is_service());
create policy km_repo_org on repos for select using (org_id = km_claims() ->> 'org');

-- ingest_cache
drop policy if exists km_cache_org on ingest_cache;
drop policy if exists km_cache_deny_service on ingest_cache;
create policy km_cache_deny_service on ingest_cache as restrictive for all using (not km_is_service());
create policy km_cache_org on ingest_cache for select
  using (repo_id in (select id from repos where org_id = km_claims() ->> 'org'));

-- doc_claims
drop policy if exists km_claims_ns on doc_claims;
drop policy if exists km_claims_deny_service on doc_claims;
create policy km_claims_deny_service on doc_claims as restrictive for all using (not km_is_service());
create policy km_claims_ns on doc_claims for select
  using (page_id in (select id from pages where km_ns_allowed(namespace_id::text)));

-- git_evidence
drop policy if exists km_evidence_org on git_evidence;
drop policy if exists km_evidence_deny_service on git_evidence;
create policy km_evidence_deny_service on git_evidence as restrictive for all using (not km_is_service());
create policy km_evidence_org on git_evidence for select
  using (repo_id in (select id from repos where org_id = km_claims() ->> 'org'));

-- km_sessions
drop policy if exists km_sessions_org on km_sessions;
drop policy if exists km_sessions_deny_service on km_sessions;
create policy km_sessions_deny_service on km_sessions as restrictive for all using (not km_is_service());
create policy km_sessions_org on km_sessions for all
  using (org_id = km_claims() ->> 'org');
