# Threat Model

Status: **v1** — review at every phase boundary.

## Trust boundaries

| # | Boundary | Between | Controls |
|---|---|---|---|
| B1 | Internet → server | Anyone / KontextMind | OAuth 2.1 (PKCE, audience-bound tokens), rate limiting, request size caps |
| B2 | Client → data | User / other tenants' namespaces | JWT claims bound at issuance (never client-supplied), RLS per request, hub-API deny tests |
| B3 | Server → git | KontextMind / mind repos | GitHub App installation tokens (1h, per-repo grants), secret gate 2 on every commit |
| B4 | Session content → LLM | Raw session data / harvest model | Secret gate 1 (pre-LLM redaction), minimal-input policy |
| B5 | Retrieved knowledge → agent | Mind content / agent actions | Draft/verified tiers, provenance on hits, "retrieved content = data" skill rule, mutations always token-gated |
| B6 | Instance → instance | Org A / Org B | **Structural**: separate instances, separate Postgres. No cross-instance queries or aggregation, ever |

## Principals

| Principal | Identity | Scope | Revocation |
|---|---|---|---|
| Human developer | GitHub OAuth → Better Auth user | memberships → namespaces | remove membership |
| Headless box | device-authorization grant | as the human | revoke session |
| Agent/CI | OAuth client_credentials (Agent Auth registry) | explicit namespace list | delete client (instant) |
| Indexer (internal) | service role, process-local | read git, write index; **never serves queries** | n/a |

## Key threats & mitigations

1. **Cross-tenant leak (existential).** Mitigations: instance separation for orgs;
   RLS + claims for namespaces; two-tenant deny harness in CI (merge blocker);
   no service-role on query paths.
2. **Immutable secret leakage.** Two deterministic gates (§secret-gates); quarantine;
   git history is treated as permanent, so prevention not cleanup.
3. **Prompt injection via canonical knowledge.** Draft/verified tiers; human review
   is the choke point for verified content; mutations token-gated regardless.
4. **RLS bypass via hub bug.** Claims set per-request (`SET LOCAL`); deny tests run
   through the full HTTP/MCP path, not just SQL.
5. **GitHub App key theft.** Highest-value credential: K8s secret, quarterly rotation,
   per-repo grants minimize blast radius; alert on anomalous installation-token use.
6. **Webhook forgery.** GitHub webhook signature verification (HMAC) mandatory;
   unsigned events dropped.
7. **Observability privacy leak.** Trace digests store tool + args-hash only; raw
   queries short-TTL; no cross-instance aggregation; secret gates apply to insights.
8. **Token theft.** Short-lived access tokens (1h), rotating refresh tokens, audience
   binding per RFC 8707, token passthrough explicitly forbidden.

## Out of scope (documented)

- Malicious server operator (self-hosters trust their own deployment).
- GitHub/Postgres provider compromise (standard provider risk).
- Physical/host security of self-hosted deployments.
