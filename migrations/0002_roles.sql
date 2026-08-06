-- KontextMind 0002_roles.sql
-- Request-path role: RLS applies to km_app (non-superuser). The superuser
-- connection is reserved for migrations + indexer writes. If km_app queries
-- ran as superuser, RLS would silently not apply — the isolation harness
-- asserts no-claims-no-access, which fails loudly on a superuser connection.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'km_app') then
    create role km_app login;
  end if;
end $$;

grant usage on schema public to km_app;
grant select, insert, update, delete on all tables in schema public to km_app;
grant usage on all sequences in schema public to km_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to km_app;
alter default privileges in schema public
  grant usage on sequences to km_app;
