-- KontextMind 0012_consent.sql
-- OAuth consent records + pending authorization requests (hosted mode).
-- Consent is granted once per (client, owner) and remembered; each
-- authorization attempt that needs consent parks its parameters in
-- oauth_pending_authz until the owner approves or denies.
-- Trust lane: same as 0009/0010/0011 — RLS enabled, NO policies.

create table if not exists oauth_consents (
  client_id  text not null references oauth_clients(client_id) on delete cascade,
  email      text not null,
  granted_at timestamptz not null default now(),
  primary key (client_id, email)
);

create table if not exists oauth_pending_authz (
  id           text primary key,        -- azr_<hex>, embedded in the consent form
  client_id    text not null references oauth_clients(client_id) on delete cascade,
  email        text not null,           -- owner the request was authenticated as
  redirect_uri text not null,
  challenge    text not null,
  resource     text not null,
  state        text,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

alter table oauth_consents enable row level security;
alter table oauth_consents force row level security;
alter table oauth_pending_authz enable row level security;
alter table oauth_pending_authz force row level security;
-- No policies: deny-all for km_app.
