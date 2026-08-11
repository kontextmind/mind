-- KontextMind 0001_initial.sql
-- Domain schema + RLS. Better Auth core tables (user, session, account,
-- verification, oauth clients/tokens, organization plugin tables) are managed
-- by the Better Auth CLI (`bunx @better-auth/cli generate`) and live alongside.
-- Requires: PostgreSQL 15+. pgvector is OPTIONAL: without it the schema
-- degrades to FTS-only search (embedded tier, decision: honest degradation
-- over a hard dependency). Vector bits are created conditionally below.

create extension if not exists pgcrypto;
do $$
begin
  create extension if not exists vector;
exception when others then
  raise notice 'pgvector unavailable — hybrid search degrades to FTS-only';
end $$;

-- ---------------------------------------------------------------------------
-- Orgs & namespaces (instance = org boundary; namespaces = RLS boundary)
-- ---------------------------------------------------------------------------

create table if not exists orgs (
  id          text primary key,
  slug        text not null unique,
  name        text not null,
  trust_mode  text not null default 'standard' check (trust_mode in ('relaxed','standard','strict')),
  created_at  timestamptz not null default now()
);

create table if not exists namespaces (
  id             text primary key,
  org_id         text not null references orgs(id) on delete cascade,
  slug           text not null,
  kind           text not null check (kind in ('project','evergreen','personal')),
  trust_override text check (trust_override in ('relaxed','standard','strict')),
  override_by    text,
  override_at    timestamptz,
  tracker_config jsonb not null default '{}',  -- read-through: {linear_team?, github_repos?}
  created_at     timestamptz not null default now(),
  unique (org_id, slug)
);

create table if not exists memberships (
  id          text primary key,
  org_id      text not null references orgs(id) on delete cascade,
  user_id     text not null,           -- Better Auth user id
  role        text not null default 'member' check (role in ('member','steward','owner')),
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create table if not exists namespace_grants (
  namespace_id text not null references namespaces(id) on delete cascade,
  principal    text not null,           -- user_id or agent client_id
  can_write    boolean not null default false,
  primary key (namespace_id, principal)
);

-- ---------------------------------------------------------------------------
-- Knowledge plane (index projection; git is canonical)
-- ---------------------------------------------------------------------------

create table if not exists repos (
  id            text primary key,
  org_id        text not null references orgs(id) on delete cascade,
  github_full   text not null unique,   -- e.g. agenticbits/mind-agenticbits
  head_sha      text,
  indexed_at    timestamptz,
  unique (org_id, github_full)
);

create table if not exists pages (
  id           text primary key,
  repo_id      text not null references repos(id) on delete cascade,
  namespace_id text not null references namespaces(id) on delete cascade,
  path         text not null,
  title        text,
  status       text not null default 'draft' check (status in ('draft','verified','suspect','tombstone')),
  commit_sha   text not null,
  author       text,
  sources      jsonb not null default '[]',
  checks       jsonb not null default '[]',   -- executable doc probes
  indexed_at   timestamptz not null default now(),
  unique (repo_id, path)
);

create table if not exists chunks (
  id            text primary key,
  page_id       text not null references pages(id) on delete cascade,
  namespace_id  text not null references namespaces(id) on delete cascade,
  ord           int not null,
  content       text not null,
  embedder_version text not null default 'v1',
  commit_sha    text not null,
  unique (page_id, ord)
);
-- Vector column + HNSW index only when pgvector is present (see header).
do $$
begin
  alter table chunks add column if not exists embedding vector(1536);
  create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
exception when others then
  raise notice 'chunks.embedding skipped (no pgvector) — FTS-only search';
end $$;
create index if not exists chunks_fts_idx on chunks using gin (to_tsvector('english', content));

create table if not exists graph_edges (
  id           text primary key,
  repo_id      text not null references repos(id) on delete cascade,
  namespace_id text not null references namespaces(id) on delete cascade,
  from_page    text not null,
  to_page      text not null,
  kind         text not null default 'wikilink',
  commit_sha   text not null,
  unique (repo_id, from_page, to_page, kind)
);

create table if not exists ingest_cache (
  repo_id    text not null references repos(id) on delete cascade,
  path       text not null,
  sha256     text not null,
  commit_sha text not null,
  primary key (repo_id, path)
);

create table if not exists doc_claims (
  id          text primary key,
  page_id     text not null references pages(id) on delete cascade,
  claim_type  text not null check (claim_type in ('file_exists','symbol_exists','command_declared','code_search')),
  target      jsonb not null,
  status      text not null default 'ok' check (status in ('ok','broken','moved')),
  verified_against_repo text,
  verified_against_sha  text,
  last_checked timestamptz
);

-- ---------------------------------------------------------------------------
-- Review queue
-- ---------------------------------------------------------------------------

create table if not exists review_items (
  id           text primary key,
  namespace_id text not null references namespaces(id) on delete cascade,
  kind         text not null check (kind in ('learning','drift','contradiction','loop','gap','suspicious','process')),
  title        text not null,
  body         jsonb not null default '{}',
  author       text not null,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  text,
  verdict      text check (verdict in ('promote','research','skip','suspicious')),
  verdict_reason text,
  promoted_to  text   -- page path or skill identity (insight->artifact compounding)
);

-- ---------------------------------------------------------------------------
-- Work context (checkpoints + claimable handoffs only)
-- ---------------------------------------------------------------------------

create table if not exists checkpoints (
  id           text primary key,
  namespace_id text not null references namespaces(id) on delete cascade,
  task_ref     text,                    -- external_ref: linear/github id or free text
  author_id    text not null,
  session_id   text,
  note         text not null,
  learning_refs jsonb not null default '[]',
  expires_at   timestamptz not null default now() + interval '90 days',
  created_at   timestamptz not null default now()
);

create table if not exists handoffs (
  id             text primary key,
  namespace_id   text not null references namespaces(id) on delete cascade,
  task_ref       text,
  author_id      text not null,
  state          jsonb not null,
  next_steps     jsonb not null default '[]',
  idempotency_key text,
  claimed_by     text,
  claimed_at     timestamptz,
  lease_expires  timestamptz,
  created_at     timestamptz not null default now(),
  unique (namespace_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- Workflow Intelligence (evidence spine)
-- ---------------------------------------------------------------------------

create table if not exists km_sessions (
  id            text primary key,       -- km_ses_<ulid>
  org_id        text not null references orgs(id) on delete cascade,
  principal     text not null,          -- user or agent client id
  agent_kind    text,                   -- claude|codex|grok|kimi|gemini|opencode|cursor|other
  repo_id       text references repos(id),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create table if not exists km_event (
  id         bigserial primary key,
  session_id text not null references km_sessions(id) on delete cascade,
  org_id     text not null references orgs(id) on delete cascade,
  kind       text not null,             -- search|read|append|touch|checkpoint|handoff_claim|...
  payload    jsonb not null default '{}' -- low-cardinality; tool+args-hash only, never raw args
);

create table if not exists git_evidence (
  session_id     text references km_sessions(id) on delete cascade,
  repo_id        text not null references repos(id) on delete cascade,
  sha            text not null,
  pr_number      int,
  ci_status      text,
  first_green_at timestamptz,
  rework_commits int not null default 0,
  merged_at      timestamptz,
  primary key (repo_id, sha)
);

create table if not exists skill_use (
  id          bigserial primary key,
  session_id  text references km_sessions(id) on delete cascade,
  org_id      text not null references orgs(id) on delete cascade,
  skill       text not null,
  skill_hash  text,
  provenance  text not null check (provenance in ('beacon','harvest','inferred')),
  weight      numeric not null default 1.0,
  at          timestamptz not null default now()
);

create table if not exists insights (
  id           text primary key,
  namespace_id text not null references namespaces(id) on delete cascade,
  kind         text not null check (kind in ('routing','loop','drift','contradiction','gap','process')),
  title        text not null,
  evidence     jsonb not null default '{}',
  confidence   numeric not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  verdict      text not null default 'pending' check (verdict in ('pending','accepted','dismissed','snoozed','expired')),
  verdict_reason text,
  promoted_to  text
);

-- ---------------------------------------------------------------------------
-- RLS (claims set per request: SET LOCAL km.claims = '<json>')
-- ---------------------------------------------------------------------------

create or replace function km_claims() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('km.claims', true), '')::jsonb, '{}'::jsonb) $$;

create or replace function km_ns_allowed(ns text) returns boolean language sql stable as
$$ select ns = any(select jsonb_array_elements_text(km_claims() -> 'namespaces')) $$;

create or replace function km_is_service() returns boolean language sql stable as
$$ select km_claims() ->> 'kind' = 'service' $$;

-- Tenant tables: deny service kind outright; require namespace membership.
do $$
declare t text;
begin
  foreach t in array array[
    'pages','chunks','graph_edges','review_items',
    'checkpoints','handoffs','insights'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy km_deny_service on %I for all using (not km_is_service())', t);
    execute format('create policy km_ns on %I for all using (km_ns_allowed(namespace_id::text))', t);
  end loop;
end $$;

-- Org-scoped event tables (no namespace column)
do $$
declare t text;
begin
  foreach t in array array['km_event','skill_use'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy km_deny_service on %I for all using (not km_is_service())', t);
    execute format('create policy km_event_org on %I for all using (org_id = km_claims() ->> ''org'')', t);
  end loop;
end $$;

-- namespaces: org-scoped via claims.org
alter table namespaces enable row level security;
alter table namespaces force row level security;
create policy km_ns_deny_service on namespaces for all using (not km_is_service());
create policy km_ns_org on namespaces for all using (org_id = km_claims() ->> 'org');

alter table orgs enable row level security;
alter table orgs force row level security;
create policy km_org on orgs for select using (id = km_claims() ->> 'org');

alter table memberships enable row level security;
alter table memberships force row level security;
create policy km_member_org on memberships for select using (org_id = km_claims() ->> 'org');

-- repos: org-scoped
alter table repos enable row level security;
alter table repos force row level security;
create policy km_repo_org on repos for select using (org_id = km_claims() ->> 'org');

-- ingest_cache + doc_claims + git_evidence + km_sessions: via parent org/namespace
alter table ingest_cache enable row level security;
alter table ingest_cache force row level security;
create policy km_cache_org on ingest_cache for select
  using (repo_id in (select id from repos where org_id = km_claims() ->> 'org'));

alter table doc_claims enable row level security;
alter table doc_claims force row level security;
create policy km_claims_ns on doc_claims for select
  using (page_id in (select id from pages where km_ns_allowed(namespace_id::text)));

alter table git_evidence enable row level security;
alter table git_evidence force row level security;
create policy km_evidence_org on git_evidence for select
  using (repo_id in (select id from repos where org_id = km_claims() ->> 'org'));

alter table km_sessions enable row level security;
alter table km_sessions force row level security;
create policy km_sessions_org on km_sessions for all
  using (org_id = km_claims() ->> 'org');

-- Indexer writes happen outside RLS via a dedicated role without km.claims set
-- (service kind is denied; the indexer role bypasses RLS by not being subject
-- to FORCE on its own connection role — see server/src/db.ts for wiring).
