-- KontextMind 0007_repo_namespace_link.sql
-- Workflow Intelligence insights are namespace-scoped (tenant RLS), but the
-- evidence spine is repo-scoped. Registering a project already binds it to the
-- caller's namespace by convention (km_project_add, bootDemo); this column
-- records that binding so detectors can attribute insights deterministically.
-- Nullable: metadata-only registrations may predate the link, and detectors
-- fall back to the namespaces of the repo's indexed pages.

alter table repos add column if not exists default_namespace_id text
  references namespaces(id) on delete set null;
