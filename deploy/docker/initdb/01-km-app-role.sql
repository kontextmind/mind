-- Runs on first container boot (docker-entrypoint-initdb.d), as superuser.
-- Creates the request-path role with the demo password. 0002_roles.sql is
-- idempotent and only adds grants if the role already exists.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'km_app') then
    create role km_app login password 'km-demo-local';
  end if;
end $$;
