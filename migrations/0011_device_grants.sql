-- KontextMind 0011_device_grants.sql
-- Device-authorization grant (RFC 8628) for headless boxes
-- (docs/threat-model.md principals). A box with no browser gets a
-- device_code; a human approves the user_code through the hosted UI
-- (owner-authenticated); the box polls /token until approved.
-- Trust lane: same as 0009/0010 — RLS enabled, NO policies, admin lane only.

create table if not exists oauth_device_grants (
  device_code  text primary key,        -- dvc_<48hex>, shown to the box only
  user_code    text not null unique,    -- XXXX-XXXX, typed by the human
  client_id    text not null references oauth_clients(client_id) on delete cascade,
  resource     text not null,
  status       text not null default 'pending'
               check (status in ('pending','approved','denied','consumed')),
  approved_by  text,                    -- owner email at approval time
  interval_s   int not null default 5,
  last_poll    timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

alter table oauth_device_grants enable row level security;
alter table oauth_device_grants force row level security;
-- No policies: deny-all for km_app.
