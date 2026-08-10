-- KontextMind 0006_webhook_evidence.sql
-- Server-side join of Agent Evidence Trailers v1 (docs/session-spine.md,
-- docs/webhooks.md). Two changes:
--  1. git_evidence becomes multi-session: the spine spec allows "multiple
--     sessions may touch one commit" (repeated KM-Session trailers), which a
--     (repo_id, sha) primary key cannot represent. session_id also becomes
--     NOT NULL — git_evidence holds session-attributed commits only; a commit
--     with no resolvable trailer is not evidence for anyone.
--  2. km_unresolved_trailers records trailers that fail to resolve (unknown
--     IDs, cross-org claims). Integrity rule: never silently dropped — they
--     feed the coverage metric.

-- Pre-existing unattributed rows (schema left over from phase 0) carry no
-- session attribution and cannot be migrated forward.
delete from git_evidence where session_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = 'git_evidence' and c.contype = 'p'
      and array_length(c.conkey, 1) = 3
  ) then
    alter table git_evidence drop constraint if exists git_evidence_pkey;
    alter table git_evidence alter column session_id set not null;
    alter table git_evidence add constraint git_evidence_pkey
      primary key (repo_id, sha, session_id);
  end if;
end $$;

create table if not exists km_unresolved_trailers (
  id          bigserial primary key,
  repo_id     text not null references repos(id) on delete cascade,
  sha         text not null,
  trailer     text not null,
  received_at timestamptz not null default now()
);
create index if not exists km_unresolved_trailers_repo_idx
  on km_unresolved_trailers (repo_id, received_at);

-- Org-scoped read (same shape as git_evidence in 0001). Writes happen on the
-- webhook path via the superuser connection — never via claims.
alter table km_unresolved_trailers enable row level security;
alter table km_unresolved_trailers force row level security;
drop policy if exists km_unresolved_org on km_unresolved_trailers;
create policy km_unresolved_org on km_unresolved_trailers for select
  using (repo_id in (select id from repos where org_id = km_claims() ->> 'org'));
