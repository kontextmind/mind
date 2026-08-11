-- KontextMind 0010_owner_sessions.sql
-- Native GitHub OAuth at the owner seam (docs/decisions/0001).
--  - oauth_states: CSRF state for the GitHub authorization redirect (10m TTL,
--    consumed on callback).
--  - oauth_owner_sessions: owner-session cookies issued after a successful
--    GitHub login (8h). sha256-hashed tokens; plaintext never stored.
-- Trust lane: same as 0009 — RLS enabled, NO policies, admin lane only.

create table if not exists oauth_states (
  state      text primary key,
  return_to  text not null,
  expires_at timestamptz not null
);

create table if not exists oauth_owner_sessions (
  token_hash text primary key,
  email      text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table oauth_states enable row level security;
alter table oauth_states force row level security;
alter table oauth_owner_sessions enable row level security;
alter table oauth_owner_sessions force row level security;
-- No policies: deny-all for km_app.
