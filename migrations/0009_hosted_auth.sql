-- KontextMind 0009_hosted_auth.sql
-- Hosted-mode auth (docs/threat-model.md B1): OAuth 2.1 authorization
-- server surface — DCR clients, authorization codes, audience-bound tokens.
--
-- Trust lane: these tables are service-managed. RLS is enabled with NO
-- permissive policies — km_app can never read clients/codes/tokens. The
-- server resolves tokens on the admin lane and constructs claims itself
-- (B2: claims bound at issuance, never client-supplied).

create table if not exists users (
  id         text primary key,          -- user_<24hex>
  email      text not null unique,
  name       text,
  created_at timestamptz not null default now()
);

create table if not exists oauth_clients (
  client_id     text primary key,       -- kmc_<24hex>, public client
  client_name   text,
  redirect_uris jsonb not null,
  created_at    timestamptz not null default now()
);

create table if not exists oauth_codes (
  code         text primary key,        -- one-time, 60s TTL
  client_id    text not null references oauth_clients(client_id) on delete cascade,
  user_id      text not null references users(id) on delete cascade,
  redirect_uri text not null,
  challenge    text not null,           -- S256(code_challenge) hex
  resource     text not null,           -- RFC 8707 audience binding
  expires_at   timestamptz not null,
  used_at      timestamptz
);

create table if not exists oauth_tokens (
  token_hash  text primary key,         -- sha256(token); plaintext never stored
  kind        text not null check (kind in ('access','refresh')),
  client_id   text not null references oauth_clients(client_id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  audience    text not null,            -- canonical resource URL
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists oauth_tokens_user_idx on oauth_tokens (user_id);

alter table users enable row level security;
alter table users force row level security;
alter table oauth_clients enable row level security;
alter table oauth_clients force row level security;
alter table oauth_codes enable row level security;
alter table oauth_codes force row level security;
alter table oauth_tokens enable row level security;
alter table oauth_tokens force row level security;
-- No policies: deny-all for km_app. Service lane only.
